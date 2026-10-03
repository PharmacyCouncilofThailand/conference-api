import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../database/schema.js";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";
import {
  adjustStock,
  createSpin,
  getEligibility,
  publishWheel,
  readAdminSpins,
  readAdminWheelState,
  setWheelPaused,
  validateAdminActor,
  WheelError,
  type WheelDatabase,
} from "./service.js";

async function bootstrap(sql: ReturnType<typeof postgres>) {
  await resetSessionGrantIntegrationSchema(sql);
  await sql.unsafe(`
    CREATE TABLE events (
      id serial PRIMARY KEY,
      event_code varchar(50) NOT NULL UNIQUE
    );
    CREATE TABLE sessions (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,
      start_time timestamp NOT NULL,
      end_time timestamp NOT NULL
    );
    CREATE TABLE users (
      id serial PRIMARY KEY,
      status varchar(32) NOT NULL
    );
    CREATE TABLE backoffice_users (
      id serial PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      role varchar(32) NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE registrations (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      user_id integer REFERENCES users(id),
      status varchar(32) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE registration_sessions (
      id serial PRIMARY KEY,
      registration_id integer NOT NULL REFERENCES registrations(id),
      session_id integer NOT NULL REFERENCES sessions(id)
    );
    CREATE TABLE session_daily_checkins (
      id uuid PRIMARY KEY,
      registration_session_id integer NOT NULL REFERENCES registration_sessions(id),
      attendance_date date NOT NULL,
      checked_in_at timestamptz NOT NULL,
      cancelled_at timestamptz,
      cancelled_by integer,
      cancellation_reason text
    );
    CREATE UNIQUE INDEX session_daily_checkins_active_day_unique
      ON session_daily_checkins (registration_session_id, attendance_date)
      WHERE cancelled_at IS NULL;
  `);
  const migration = (await readFile(resolve(process.cwd(), "drizzle", "0034_lucky_wheel.sql"), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  await sql.unsafe(migration);
}

test(
  "lucky wheel service serializes publication, stock, pause and spin races without duplicate daily awards",
  { timeout: 180_000 },
  async (t) => {
    const originalRewardKey = process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
    process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
    t.after(() => {
      if (originalRewardKey === undefined) delete process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
      else process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = originalRewardKey;
    });

    const testUrl = validateSessionGrantTestDatabaseUrl();
    const setupSql = openSessionGrantTestDatabase();
    await bootstrap(setupSql);

    const poolClient = postgres(testUrl, {
      max: 20,
      idle_timeout: 5,
      connect_timeout: 10,
    });
    const database = drizzle(poolClient, { schema }) as WheelDatabase;

    t.after(async () => {
      await poolClient.end({ timeout: 2 });
      await setupSql.end({ timeout: 2 });
    });

    const [{ day }] = await setupSql<Array<{ day: string }>>`
      SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS day
    `;
    const [admin] = await setupSql<Array<{ id: number; email: string }>>`
      INSERT INTO backoffice_users (email, role, is_active)
      VALUES ('wheel-admin@example.invalid', 'admin', true)
      RETURNING id, email
    `;
    const [disabledAdmin] = await setupSql<Array<{ id: number; email: string }>>`
      INSERT INTO backoffice_users (email, role, is_active)
      VALUES ('wheel-disabled@example.invalid', 'admin', false)
      RETURNING id, email
    `;
    const [event] = await setupSql<Array<{ id: number }>>`
      INSERT INTO events (event_code) VALUES ('LW-T06') RETURNING id
    `;
    const [mainSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
      VALUES (${event.id}, true, '2020-01-01 00:00:00', '2099-12-31 23:59:59')
      RETURNING id
    `;
    await setupSql`
      INSERT INTO lucky_wheels (event_id, main_session_id, enabled, paused)
      VALUES (${event.id}, ${mainSession.id}, false, false)
    `;

    const [user] = await setupSql<Array<{ id: number }>>`
      INSERT INTO users (status) VALUES ('active') RETURNING id
    `;
    const [registration] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registrations (event_id, user_id, status)
      VALUES (${event.id}, ${user.id}, 'confirmed')
      RETURNING id
    `;
    const [registrationSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registration_sessions (registration_id, session_id)
      VALUES (${registration.id}, ${mainSession.id})
      RETURNING id
    `;
    const [attendance] = await setupSql<Array<{ id: string }>>`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at
      ) VALUES (
        ${randomUUID()}, ${registrationSession.id}, ${day}::date, clock_timestamp()
      )
      RETURNING id
    `;

    const claimedAdmin = { id: admin.id, role: "admin", email: admin.email };
    assert.ok(await validateAdminActor(database, claimedAdmin, event.id));
    assert.equal(
      await validateAdminActor(
        database,
        { id: disabledAdmin.id, role: "admin", email: disabledAdmin.email },
        event.id,
      ),
      null,
    );
    assert.equal(
      await validateAdminActor(
        database,
        { id: admin.id, role: "general", email: admin.email },
        event.id,
      ),
      null,
    );
    assert.equal(
      await validateAdminActor(
        database,
        { id: admin.id, role: "admin", email: "wrong@example.invalid" },
        event.id,
      ),
      null,
    );

    const prizeId = "00000000-0000-4000-8000-000000000201";
    const configuration = {
      segments: [{
        id: prizeId,
        kind: "prize" as const,
        name: { th: "ปากกา", en: "Pen" },
        imageId: null,
        enabled: true,
        position: 0,
      }],
      collectionInstructions: { th: "รับที่จุดกิจกรรม", en: "Collect at activity desk" },
      collectionDeadline: "2099-12-31T16:59:59.000Z",
    };

    const published = await publishWheel(database, claimedAdmin, event.id, 1, configuration);
    assert.equal(published.version, 2);
    assert.equal(published.replayed, false);

    const publishReplay = await publishWheel(database, claimedAdmin, event.id, 1, configuration);
    assert.equal(publishReplay.version, 2);
    assert.equal(publishReplay.replayed, true);

    await assert.rejects(
      () =>
        publishWheel(database, claimedAdmin, event.id, 2, {
          ...configuration,
          segments: [{
            ...configuration.segments[0],
            imageId: "00000000-0000-4000-8000-000000000299",
          }],
        }),
      (error: unknown) =>
        error instanceof WheelError &&
        error.code === "INVALID_WHEEL_REQUEST",
    );

    await assert.rejects(
      () =>
        publishWheel(database, claimedAdmin, event.id, 2, {
          ...configuration,
          segments: [
            {
              ...configuration.segments[0],
              kind: "no_prize",
            },
            {
              id: "00000000-0000-4000-8000-000000000298",
              kind: "prize",
              name: { th: "เสื้อ", en: "Shirt" },
              imageId: null,
              enabled: true,
              position: 1,
            },
          ],
        }),
      (error: unknown) =>
        error instanceof WheelError &&
        error.code === "WHEEL_UPDATED",
    );

    const beforeStock = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(beforeStock.blockCode, "OUT_OF_STOCK");

    const stockKey = randomUUID();
    const stocked = await adjustStock(
      database,
      claimedAdmin,
      event.id,
      prizeId,
      101,
      "initial load",
      stockKey,
    );
    assert.deepEqual(
      { before: stocked.before, after: stocked.after, poolRevision: stocked.poolRevision },
      { before: 0, after: 101, poolRevision: 2 },
    );
    const stockReplay = await adjustStock(
      database,
      claimedAdmin,
      event.id,
      prizeId,
      101,
      "initial load",
      stockKey,
    );
    assert.equal(stockReplay.replayed, true);
    assert.equal(stockReplay.after, 101);
    await assert.rejects(
      () => adjustStock(database, claimedAdmin, event.id, prizeId, 102, "initial load", stockKey),
      (error: unknown) => error instanceof WheelError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const eligibility = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.configurationVersion, 2);
    assert.equal(eligibility.poolRevision, 2);

    const sameUserKey = randomUUID();
    const sameUserInput = {
      eventId: event.id,
      configurationVersion: 2,
      poolRevision: 2,
      idempotencyKey: sameUserKey,
    };
    const sameUserResults = await Promise.all(
      Array.from({ length: 100 }, () =>
        createSpin(database, { id: user.id }, sameUserInput),
      ),
    );
    assert.equal(sameUserResults.filter((result) => result.created).length, 1);
    assert.equal(new Set(sameUserResults.map((result) => result.spin.id)).size, 1);
    assert.equal(sameUserResults[0].spin.playDate, day);
    assert.equal(sameUserResults[0].spin.attendanceId, attendance.id);

    await setupSql`
      UPDATE session_daily_checkins
      SET cancelled_at = clock_timestamp(),
          cancellation_reason = 'post-allocation correction'
      WHERE id = ${attendance.id}
    `;
    const replayAfterAttendanceUndo = await createSpin(
      database,
      { id: user.id },
      sameUserInput,
    );
    assert.equal(replayAfterAttendanceUndo.created, false);
    assert.equal(replayAfterAttendanceUndo.spin.id, sameUserResults[0].spin.id);

    await assert.rejects(
      () =>
        createSpin(database, { id: user.id }, {
          ...sameUserInput,
          configurationVersion: 999,
        }),
      (error: unknown) => error instanceof WheelError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const pauseKey = randomUUID();
    const paused = await setWheelPaused(
      database,
      claimedAdmin,
      event.id,
      true,
      "operator pause",
      pauseKey,
    );
    assert.equal(paused.paused, true);
    const pauseReplay = await setWheelPaused(
      database,
      claimedAdmin,
      event.id,
      true,
      "operator pause",
      pauseKey,
    );
    assert.equal(pauseReplay.replayed, true);
    const replayWhilePaused = await createSpin(database, { id: user.id }, sameUserInput);
    assert.equal(replayWhilePaused.spin.id, sameUserResults[0].spin.id);
    await setWheelPaused(
      database,
      claimedAdmin,
      event.id,
      false,
      "resume load",
      randomUUID(),
    );

    await setupSql.unsafe(`
      WITH new_users AS (
        INSERT INTO users (status)
        SELECT 'active'
        FROM generate_series(1, 100)
        RETURNING id
      ),
      new_regs AS (
        INSERT INTO registrations (event_id, user_id, status)
        SELECT ${event.id}, id, 'confirmed'
        FROM new_users
        RETURNING id, user_id
      ),
      new_rs AS (
        INSERT INTO registration_sessions (registration_id, session_id)
        SELECT id, ${mainSession.id}
        FROM new_regs
        RETURNING id
      )
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at
      )
      SELECT
        gen_random_uuid(), id,
        (clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date,
        clock_timestamp()
      FROM new_rs
    `);

    const bulkUsers = await setupSql<Array<{ user_id: number }>>`
      SELECT user_id
      FROM registrations
      WHERE event_id = ${event.id}
        AND user_id <> ${user.id}
      ORDER BY user_id
      LIMIT 100
    `;
    assert.equal(bulkUsers.length, 100);

    const bulkResults = await Promise.all(
      bulkUsers.map(({ user_id }) =>
        createSpin(
          database,
          { id: user_id },
          {
            eventId: event.id,
            configurationVersion: 2,
            poolRevision: 2,
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    );
    assert.equal(bulkResults.filter((result) => result.created).length, 100);
    assert.equal(new Set(bulkResults.map((result) => result.spin.id)).size, 100);

    const [afterLoad] = await setupSql<Array<{
      remaining: number;
      pool_revision: number;
      spin_count: number;
    }>>`
      SELECT
        seg.remaining,
        w.pool_revision,
        (SELECT count(*)::int FROM lucky_wheel_spins WHERE event_id = ${event.id}) AS spin_count
      FROM lucky_wheels w
      JOIN lucky_wheel_segments seg ON seg.wheel_id = w.id AND seg.id = ${prizeId}
      WHERE w.event_id = ${event.id}
    `;
    assert.deepEqual(afterLoad, { remaining: 0, pool_revision: 3, spin_count: 101 });

    await adjustStock(
      database,
      claimedAdmin,
      event.id,
      prizeId,
      20,
      "race preload",
      randomUUID(),
    );
    const configA = {
      ...configuration,
      segments: [{
        ...configuration.segments[0],
        name: { th: "ปากกา A", en: "Pen A" },
      }],
    };
    const configB = {
      ...configuration,
      segments: [{
        ...configuration.segments[0],
        name: { th: "ปากกา B", en: "Pen B" },
      }],
    };
    const raceResults = await Promise.allSettled([
      adjustStock(database, claimedAdmin, event.id, prizeId, 10, "race add", randomUUID()),
      adjustStock(database, claimedAdmin, event.id, prizeId, -5, "race reduce", randomUUID()),
      publishWheel(database, claimedAdmin, event.id, 2, configA),
      publishWheel(database, claimedAdmin, event.id, 2, configB),
      setWheelPaused(database, claimedAdmin, event.id, true, "race pause", randomUUID()),
    ]);
    assert.equal(raceResults[0].status, "fulfilled");
    assert.equal(raceResults[1].status, "fulfilled");
    assert.equal(raceResults[4].status, "fulfilled");
    const publishRace = raceResults.slice(2, 4);
    assert.equal(publishRace.filter((result) => result.status === "fulfilled").length, 1);
    const stalePublish = publishRace.find((result) => result.status === "rejected");
    assert.ok(stalePublish && stalePublish.status === "rejected");
    assert.ok(stalePublish.reason instanceof WheelError);
    assert.equal(stalePublish.reason.code, "WHEEL_UPDATED");

    const [afterAdminRace] = await setupSql<Array<{
      remaining: number;
      version: number;
      pool_revision: number;
      paused: boolean;
    }>>`
      SELECT seg.remaining, w.version, w.pool_revision, w.paused
      FROM lucky_wheels w
      JOIN lucky_wheel_segments seg ON seg.wheel_id = w.id AND seg.id = ${prizeId}
      WHERE w.event_id = ${event.id}
    `;
    assert.deepEqual(afterAdminRace, {
      remaining: 25,
      version: 3,
      pool_revision: 4,
      paused: true,
    });

    await assert.rejects(
      () =>
        adjustStock(
          database,
          claimedAdmin,
          event.id,
          prizeId,
          -1000,
          "must roll back",
          randomUUID(),
        ),
      (error: unknown) => error instanceof WheelError && error.code === "INSUFFICIENT_STOCK",
    );
    const [afterRejectedReduce] = await setupSql<Array<{ remaining: number }>>`
      SELECT remaining
      FROM lucky_wheel_segments
      WHERE id = ${prizeId}
    `;
    assert.equal(afterRejectedReduce.remaining, 25);

    await setWheelPaused(
      database,
      claimedAdmin,
      event.id,
      false,
      "resume after race",
      randomUUID(),
    );

    const [cancelledUser] = await setupSql<Array<{ id: number }>>`
      INSERT INTO users (status) VALUES ('active') RETURNING id
    `;
    const [cancelledRegistration] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registrations (event_id, user_id, status)
      VALUES (${event.id}, ${cancelledUser.id}, 'confirmed')
      RETURNING id
    `;
    const [cancelledRegistrationSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registration_sessions (registration_id, session_id)
      VALUES (${cancelledRegistration.id}, ${mainSession.id})
      RETURNING id
    `;
    await setupSql`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at,
        cancelled_at, cancellation_reason
      ) VALUES (
        ${randomUUID()}, ${cancelledRegistrationSession.id}, ${day}::date,
        clock_timestamp(), clock_timestamp(), 'cancelled before allocation'
      )
    `;
    await assert.rejects(
      () =>
        createSpin(
          database,
          { id: cancelledUser.id },
          {
            eventId: event.id,
            configurationVersion: 3,
            poolRevision: 4,
            idempotencyKey: randomUUID(),
          },
        ),
      (error: unknown) => error instanceof WheelError && error.code === "CHECKIN_REQUIRED",
    );

    const state = await readAdminWheelState(database, claimedAdmin, event.id);
    assert.equal(state.wheel.version, 3);
    assert.equal(state.wheel.poolRevision, 4);
    assert.equal(state.wheel.paused, false);
    assert.equal(state.segments.length, 1);
    assert.equal(state.segments[0].id, prizeId);
    assert.equal(state.segments[0].remaining, 25);
    assert.equal(state.segments[0].allocated, 101);
    assert.equal(state.segments[0].collected, 0);
    assert.ok(state.audit.length >= 8);
    assert.ok(state.audit.some((entry) => entry.operation === "stock_adjust"));

    const [redeemedSpin] = await setupSql<Array<{ spin_id: string }>>`
      SELECT r.spin_id
      FROM lucky_wheel_redemptions r
      WHERE r.event_id = ${event.id}
      ORDER BY r.created_at, r.id
      LIMIT 1
    `;
    await setupSql`
      UPDATE lucky_wheel_redemptions
      SET status = 'redeemed',
          redeemed_at = clock_timestamp(),
          redeemed_by = ${admin.id},
          collection_point = 'Activity desk',
          delivered_details = 'Size L',
          updated_at = clock_timestamp()
      WHERE spin_id = ${redeemedSpin.spin_id}
    `;

    const firstHistoryPage = await readAdminSpins(database, claimedAdmin, event.id);
    assert.equal(firstHistoryPage.spins.length, 20);
    assert.deepEqual(firstHistoryPage.pagination, {
      page: 1,
      pageSize: 20,
      total: 101,
      totalPages: 6,
    });

    const lastHistoryPage = await readAdminSpins(database, claimedAdmin, event.id, {
      page: 6,
      pageSize: 20,
    });
    assert.equal(lastHistoryPage.spins.length, 1);

    const dayHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      date: day,
      page: 1,
      pageSize: 100,
    });
    assert.equal(dayHistory.pagination.total, 101);

    const prizeHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      segmentId: prizeId,
      page: 1,
      pageSize: 100,
    });
    assert.equal(prizeHistory.pagination.total, 101);

    const redeemedHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      claimStatus: "redeemed",
      page: 1,
      pageSize: 20,
    });
    assert.equal(redeemedHistory.pagination.total, 1);
    assert.equal(redeemedHistory.spins[0].id, redeemedSpin.spin_id);
    assert.equal(redeemedHistory.spins[0].claim?.status, "redeemed");
    assert.equal(redeemedHistory.spins[0].claim?.collectionPoint, "Activity desk");

    const openHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      claimStatus: "open",
      page: 1,
      pageSize: 100,
    });
    assert.equal(openHistory.pagination.total, 100);

    const noClaimHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      claimStatus: "none",
      page: 1,
      pageSize: 20,
    });
    assert.equal(noClaimHistory.pagination.total, 0);

    await setupSql`
      UPDATE sessions
      SET end_time = '2021-01-01 00:00:00'
      WHERE id = ${mainSession.id}
    `;
    const replayAfterClose = await createSpin(database, { id: user.id }, sameUserInput);
    assert.equal(replayAfterClose.spin.id, sameUserResults[0].spin.id);

    const [invariants] = await setupSql<Array<{
      negative_stock: number;
      duplicate_days: number;
      audit_rows: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM lucky_wheel_segments WHERE remaining < 0) AS negative_stock,
        (
          SELECT count(*)::int
          FROM (
            SELECT event_id, user_id, play_date
            FROM lucky_wheel_spins
            GROUP BY event_id, user_id, play_date
            HAVING count(*) > 1
          ) duplicates
        ) AS duplicate_days,
        (
          SELECT count(*)::int
          FROM lucky_wheel_audit_events
          WHERE event_id = ${event.id}
        ) AS audit_rows
    `;
    assert.equal(invariants.negative_stock, 0);
    assert.equal(invariants.duplicate_days, 0);
    assert.ok(invariants.audit_rows >= 8);
  },
);
