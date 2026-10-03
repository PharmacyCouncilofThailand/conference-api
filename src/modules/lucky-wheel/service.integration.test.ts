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
import { editDayWindow } from "./day-schedule.js";
import { revokeCreditClaim, setQrStatus } from "./qr-credits.js";

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
  const creditMigration = (await readFile(resolve(process.cwd(), "drizzle", "0035_lucky_wheel_qr_credits.sql"), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  await sql.unsafe(creditMigration);
}

test(
  "lucky wheel service serializes publication, stock, pause and credit spending races",
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

    const claimedAdmin = { id: admin.id, role: "admin" as const, email: admin.email };
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

    const [wheel] = await setupSql<Array<{ id: string }>>`
      SELECT id FROM lucky_wheels WHERE event_id = ${event.id}
    `;
    const dayStart = new Date(`${day}T00:00:00.000+07:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const [currentDay] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
      VALUES (
        ${wheel.id}, ${event.id}, ${day}::date,
        ${dayStart.toISOString()}::timestamptz, ${dayEnd.toISOString()}::timestamptz
      ) RETURNING id
    `;
    for (let index = 0; index < 5; index += 1) {
      const [qr] = await setupSql<Array<{ id: string }>>`
        INSERT INTO lucky_wheel_qr_codes (
          day_id, event_id, play_date, name, created_by
        ) VALUES (
          ${currentDay.id}, ${event.id}, ${day}::date, ${`QR ${index + 1}`}, ${admin.id}
        ) RETURNING id
      `;
      await setupSql`
        INSERT INTO lucky_wheel_credit_claims (
          qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
        ) VALUES (
          ${qr.id}, ${event.id}, ${day}::date, ${user.id},
          ${attendance.id}, ${dayEnd.toISOString()}::timestamptz
        )
      `;
    }
    const priorStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
    const priorDay = new Date(priorStart.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [priorAttendance] = await setupSql<Array<{ id: string }>>`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at
      ) VALUES (
        ${randomUUID()}, ${registrationSession.id}, ${priorDay}::date,
        ${new Date(priorStart.getTime() + 9 * 60 * 60 * 1000).toISOString()}::timestamptz
      ) RETURNING id
    `;
    const [priorDayRow] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
      VALUES (
        ${wheel.id}, ${event.id}, ${priorDay}::date,
        ${priorStart.toISOString()}::timestamptz, ${dayStart.toISOString()}::timestamptz
      ) RETURNING id
    `;
    const [priorQr] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
      VALUES (${priorDayRow.id}, ${event.id}, ${priorDay}::date, 'Yesterday', ${admin.id})
      RETURNING id
    `;
    await setupSql`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      ) VALUES (
        ${priorQr.id}, ${event.id}, ${priorDay}::date, ${user.id},
        ${priorAttendance.id}, ${dayStart.toISOString()}::timestamptz
      )
    `;

    const beforeStock = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(beforeStock.blockCode, "OUT_OF_STOCK");
    assert.equal(beforeStock.unspentCredits, 5);
    assert.equal(beforeStock.spendableCredits, 0);
    assert.equal(beforeStock.hasExpiredPriorDayCredit, true);

    const stockKey = randomUUID();
    const stocked = await adjustStock(
      database,
      claimedAdmin,
      event.id,
      prizeId,
      105,
      "initial load",
      stockKey,
    );
    assert.deepEqual(
      { before: stocked.before, after: stocked.after, poolRevision: stocked.poolRevision },
      { before: 0, after: 105, poolRevision: 2 },
    );
    const stockReplay = await adjustStock(
      database,
      claimedAdmin,
      event.id,
      prizeId,
      105,
      "initial load",
      stockKey,
    );
    assert.equal(stockReplay.replayed, true);
    assert.equal(stockReplay.after, 105);
    await assert.rejects(
      () => adjustStock(database, claimedAdmin, event.id, prizeId, 102, "initial load", stockKey),
      (error: unknown) => error instanceof WheelError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const eligibility = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.configurationVersion, 2);
    assert.equal(eligibility.poolRevision, 2);
    assert.equal(eligibility.unspentCredits, 5);
    assert.equal(eligibility.spendableCredits, 5);
    assert.equal(eligibility.currentWindow?.version, 1);
    assert.equal(eligibility.latestSpin, null);

    const [noCreditUser] = await setupSql<Array<{ id: number }>>`
      INSERT INTO users (status) VALUES ('active') RETURNING id
    `;
    const [noCreditRegistration] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registrations (event_id, user_id, status)
      VALUES (${event.id}, ${noCreditUser.id}, 'confirmed') RETURNING id
    `;
    const [noCreditSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registration_sessions (registration_id, session_id)
      VALUES (${noCreditRegistration.id}, ${mainSession.id}) RETURNING id
    `;
    await setupSql`
      INSERT INTO session_daily_checkins (id, registration_session_id, attendance_date, checked_in_at)
      VALUES (${randomUUID()}, ${noCreditSession.id}, ${day}::date, clock_timestamp())
    `;
    const noCreditEligibility = await getEligibility(database, { id: noCreditUser.id }, event.id);
    assert.equal(noCreditEligibility.blockCode, "NO_CREDIT");
    assert.equal(noCreditEligibility.unspentCredits, 0);
    assert.equal(noCreditEligibility.spendableCredits, 0);

    await setupSql`
      UPDATE lucky_wheel_days
      SET end_at = clock_timestamp() - interval '1 minute', version = 2
      WHERE id = ${currentDay.id}
    `;
    const shortened = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(shortened.blockCode, "DAY_WINDOW_CLOSED");
    assert.equal(shortened.unspentCredits, 5);
    assert.equal(shortened.spendableCredits, 0);
    await setupSql`
      UPDATE lucky_wheel_days
      SET end_at = ${dayEnd.toISOString()}::timestamptz, version = 3
      WHERE id = ${currentDay.id}
    `;
    assert.equal((await getEligibility(database, { id: user.id }, event.id)).spendableCredits, 5);
    await setupSql`
      UPDATE lucky_wheel_days
      SET start_at = clock_timestamp() + interval '1 minute', version = 4
      WHERE id = ${currentDay.id}
    `;
    assert.equal((await getEligibility(database, { id: user.id }, event.id)).blockCode, "DAY_WINDOW_CLOSED");
    await setupSql`
      UPDATE lucky_wheel_days
      SET start_at = ${dayStart.toISOString()}::timestamptz, version = 5
      WHERE id = ${currentDay.id}
    `;

    const [secondRegistration] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registrations (event_id, user_id, status)
      VALUES (${event.id}, ${user.id}, 'confirmed') RETURNING id
    `;
    await setupSql`
      INSERT INTO registration_sessions (registration_id, session_id)
      VALUES (${secondRegistration.id}, ${mainSession.id})
    `;
    assert.equal((await getEligibility(database, { id: user.id }, event.id)).eligible, true);

    await setupSql`
      UPDATE session_daily_checkins
      SET cancelled_at = clock_timestamp(),
          cancellation_reason = 'correct mistaken scan'
      WHERE id = ${attendance.id}
    `;
    const cancelledEligibility = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(cancelledEligibility.blockCode, "CHECKIN_REQUIRED");
    assert.equal(cancelledEligibility.unspentCredits, 5);
    assert.equal(cancelledEligibility.spendableCredits, 0);

    const [replacementAttendance] = await setupSql<Array<{ id: string }>>`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at
      ) VALUES (
        ${randomUUID()}, ${registrationSession.id}, ${day}::date, clock_timestamp()
      ) RETURNING id
    `;
    assert.equal((await getEligibility(database, { id: user.id }, event.id)).eligible, true);
    assert.equal((await getEligibility(database, { id: user.id }, event.id)).spendableCredits, 5);

    const sameUserKey = randomUUID();
    const sameUserInput = {
      eventId: event.id,
      configurationVersion: 2,
      poolRevision: 2,
      scheduleVersion: 5,
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
    assert.equal(sameUserResults[0].spin.attendanceId, replacementAttendance.id);
    const afterFirstSpin = await getEligibility(database, { id: user.id }, event.id);
    assert.equal(afterFirstSpin.latestSpin?.id, sameUserResults[0].spin.id);
    assert.equal(afterFirstSpin.eligible, true);
    const fiveSpins = [sameUserResults[0].spin];
    for (let index = 0; index < 4; index += 1) {
      const next = await createSpin(database, { id: user.id }, {
        ...sameUserInput, idempotencyKey: randomUUID(),
      });
      assert.equal(next.created, true);
      fiveSpins.push(next.spin);
    }
    assert.equal(new Set(fiveSpins.map((spin) => spin.id)).size, 5);
    await assert.rejects(
      () => createSpin(database, { id: user.id }, {
        ...sameUserInput, idempotencyKey: randomUUID(),
      }),
      (error: unknown) => error instanceof WheelError && error.code === "NO_CREDIT",
    );

    await setupSql`
      UPDATE session_daily_checkins
      SET cancelled_at = clock_timestamp(),
          cancellation_reason = 'post-allocation correction'
      WHERE id = ${replacementAttendance.id}
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
        AND user_id <> ${noCreditUser.id}
      ORDER BY user_id
      LIMIT 100
    `;
    assert.equal(bulkUsers.length, 100);
    const [bulkQr] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
      VALUES (${currentDay.id}, ${event.id}, ${day}::date, 'Bulk', ${admin.id})
      RETURNING id
    `;
    await setupSql`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      )
      SELECT
        ${bulkQr.id}, ${event.id}, ${day}::date, r.user_id, dc.id,
        ${dayEnd.toISOString()}::timestamptz
      FROM registrations r
      JOIN registration_sessions rs ON rs.registration_id = r.id AND rs.session_id = ${mainSession.id}
      JOIN session_daily_checkins dc
        ON dc.registration_session_id = rs.id AND dc.attendance_date = ${day}::date
      WHERE r.event_id = ${event.id}
        AND r.user_id <> ${user.id}
        AND r.user_id <> ${noCreditUser.id}
        AND dc.cancelled_at IS NULL
    `;

    const bulkResults = await Promise.all(
      bulkUsers.map(({ user_id }) =>
        createSpin(
          database,
          { id: user_id },
          {
            eventId: event.id,
            configurationVersion: 2,
            poolRevision: 2,
            scheduleVersion: 5,
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
    assert.deepEqual(afterLoad, { remaining: 0, pool_revision: 3, spin_count: 105 });

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
    const [cancelledAttendance] = await setupSql<Array<{ id: string }>>`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at,
        cancelled_at, cancellation_reason
      ) VALUES (
        ${randomUUID()}, ${cancelledRegistrationSession.id}, ${day}::date,
        clock_timestamp(), clock_timestamp(), 'cancelled before allocation'
      )
      RETURNING id
    `;
    await setupSql`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      ) VALUES (
        ${bulkQr.id}, ${event.id}, ${day}::date, ${cancelledUser.id},
        ${cancelledAttendance.id}, ${dayEnd.toISOString()}::timestamptz
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
            scheduleVersion: 5,
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
    assert.equal(state.segments[0].allocated, 105);
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
      total: 105,
      totalPages: 6,
    });

    const lastHistoryPage = await readAdminSpins(database, claimedAdmin, event.id, {
      page: 6,
      pageSize: 20,
    });
    assert.equal(lastHistoryPage.spins.length, 5);

    const dayHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      date: day,
      page: 1,
      pageSize: 100,
    });
    assert.equal(dayHistory.pagination.total, 105);

    const prizeHistory = await readAdminSpins(database, claimedAdmin, event.id, {
      segmentId: prizeId,
      page: 1,
      pageSize: 100,
    });
    assert.equal(prizeHistory.pagination.total, 105);

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
    assert.equal(openHistory.pagination.total, 104);

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
    assert.equal(invariants.duplicate_days, 1);
    assert.ok(invariants.audit_rows >= 8);

    // Closing a QR after its credit is earned does not revoke that credit.
    const [raceQr] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by, status)
      VALUES (${currentDay.id}, ${event.id}, ${day}::date, 'Race A', ${admin.id}, 'open')
      RETURNING id
    `;
    const [raceCredit] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      )
      SELECT ${raceQr.id}, ${event.id}, ${day}::date, ${noCreditUser.id}, c.id,
             ${dayEnd.toISOString()}::timestamptz
      FROM session_daily_checkins c
      WHERE c.registration_session_id = ${noCreditSession.id} AND c.cancelled_at IS NULL
      RETURNING id
    `;
    await setQrStatus(database, claimedAdmin, event.id, raceQr.id, {
      status: "closed", reason: "projection finished", idempotencyKey: randomUUID(),
    });
    const raceInput = {
      eventId: event.id, configurationVersion: 3, poolRevision: 4,
      scheduleVersion: 5, idempotencyKey: randomUUID(),
    };
    await setWheelPaused(database, claimedAdmin, event.id, true, "pause credit race", randomUUID());
    await assert.rejects(
      () => createSpin(database, { id: noCreditUser.id }, raceInput),
      (error: unknown) => error instanceof WheelError && error.code === "WHEEL_PAUSED",
    );
    await setWheelPaused(database, claimedAdmin, event.id, false, "resume credit race", randomUUID());
    const closedWindow = await editDayWindow(database, claimedAdmin, event.id, {
      date: day, startAt: dayStart.toISOString(),
      endAt: new Date(Date.now() - 60_000).toISOString(),
      expectedVersion: 5, reason: "test temporary closure",
    });
    assert.equal(closedWindow.version, 6);
    await assert.rejects(
      () => createSpin(database, { id: noCreditUser.id }, raceInput),
      (error: unknown) => error instanceof WheelError && error.code === "DAY_WINDOW_CLOSED",
    );
    const reopenedWindow = await editDayWindow(database, claimedAdmin, event.id, {
      date: day, startAt: dayStart.toISOString(), endAt: dayEnd.toISOString(),
      expectedVersion: 6, reason: "test same-day reopening",
    });
    assert.equal(reopenedWindow.version, 7);
    await assert.rejects(
      () => createSpin(database, { id: noCreditUser.id }, raceInput),
      (error: unknown) => error instanceof WheelError && error.code === "WHEEL_UPDATED",
    );
    const [unspentBeforeRace] = await setupSql<Array<{ spent_at: Date | null }>>`
      SELECT spent_at FROM lucky_wheel_credit_claims WHERE id = ${raceCredit.id}
    `;
    assert.equal(unspentBeforeRace.spent_at, null);
    const competing = await Promise.allSettled([
      createSpin(database, { id: noCreditUser.id }, {
        ...raceInput, scheduleVersion: 7, idempotencyKey: randomUUID(),
      }),
      createSpin(database, { id: noCreditUser.id }, {
        ...raceInput, scheduleVersion: 7, idempotencyKey: randomUUID(),
      }),
    ]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedCompeting = competing.find((result) => result.status === "rejected");
    assert.ok(rejectedCompeting && rejectedCompeting.status === "rejected");
    assert.ok(rejectedCompeting.reason instanceof WheelError);
    assert.equal(rejectedCompeting.reason.code, "NO_CREDIT");
    const raceWinner = competing.find((result) => result.status === "fulfilled");
    assert.ok(raceWinner && raceWinner.status === "fulfilled");
    assert.equal(raceWinner.value.spin.creditClaimId, raceCredit.id);

    // Revocation and spin take the same lock order; exactly one may claim the credit.
    const [revokeQr] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
      VALUES (${currentDay.id}, ${event.id}, ${day}::date, 'Race B', ${admin.id})
      RETURNING id
    `;
    const [revokeCredit] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      )
      SELECT ${revokeQr.id}, ${event.id}, ${day}::date, ${noCreditUser.id}, c.id,
             ${dayEnd.toISOString()}::timestamptz
      FROM session_daily_checkins c
      WHERE c.registration_session_id = ${noCreditSession.id} AND c.cancelled_at IS NULL
      RETURNING id
    `;
    const revokeRace = await Promise.allSettled([
      revokeCreditClaim(database, claimedAdmin, event.id, revokeCredit.id, {
        reason: "mistaken distribution", idempotencyKey: randomUUID(),
      }),
      createSpin(database, { id: noCreditUser.id }, {
        ...raceInput, scheduleVersion: 7, idempotencyKey: randomUUID(),
      }),
    ]);
    assert.equal(revokeRace.filter((result) => result.status === "fulfilled").length, 1);
    const [revokeState] = await setupSql<Array<{
      spent_at: Date | null; revoked_at: Date | null; spin_count: number;
    }>>`
      SELECT c.spent_at, c.revoked_at,
        (SELECT count(*)::int FROM lucky_wheel_spins s WHERE s.credit_claim_id = c.id) AS spin_count
      FROM lucky_wheel_credit_claims c WHERE c.id = ${revokeCredit.id}
    `;
    assert.equal(Number(revokeState.spent_at !== null) + Number(revokeState.revoked_at !== null), 1);
    assert.equal(revokeState.spin_count, revokeState.spent_at === null ? 0 : 1);

    const [noPrizeQr] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
      VALUES (${currentDay.id}, ${event.id}, ${day}::date, 'No prize', ${admin.id})
      RETURNING id
    `;
    const [noPrizeCredit] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      )
      SELECT ${noPrizeQr.id}, ${event.id}, ${day}::date, ${noCreditUser.id}, c.id,
             ${dayEnd.toISOString()}::timestamptz
      FROM session_daily_checkins c
      WHERE c.registration_session_id = ${noCreditSession.id} AND c.cancelled_at IS NULL
      RETURNING id
    `;
    const currentState = await readAdminWheelState(database, claimedAdmin, event.id);
    assert.ok(currentState.wheel.configuration);
    const withNoPrize = await publishWheel(database, claimedAdmin, event.id, 3, {
      ...currentState.wheel.configuration,
      segments: [
        ...currentState.wheel.configuration.segments,
        { id: randomUUID(), kind: "no_prize", name: { th: "เสียใจด้วย", en: "Try again" },
          imageId: null, enabled: true, position: 1 },
      ],
    });
    assert.equal(withNoPrize.version, 4);
    const [stockBeforeNoPrize] = await setupSql<Array<{ remaining: number }>>`
      SELECT remaining FROM lucky_wheel_segments WHERE id = ${prizeId}
    `;
    const noPrizeResult = await createSpin(database, { id: noCreditUser.id }, {
      ...raceInput, configurationVersion: 4, scheduleVersion: 7,
      idempotencyKey: randomUUID(),
    }, () => 1);
    assert.equal(noPrizeResult.spin.outcomeKind, "no_prize");
    assert.equal(noPrizeResult.spin.creditClaimId, noPrizeCredit.id);
    const [noPrizeState] = await setupSql<Array<{
      spent_at: Date | null; redemption_count: number; remaining: number;
    }>>`
      SELECT c.spent_at,
        (SELECT count(*)::int FROM lucky_wheel_redemptions WHERE spin_id = ${noPrizeResult.spin.id}) AS redemption_count,
        (SELECT remaining FROM lucky_wheel_segments WHERE id = ${prizeId}) AS remaining
      FROM lucky_wheel_credit_claims c WHERE c.id = ${noPrizeCredit.id}
    `;
    assert.ok(noPrizeState.spent_at);
    assert.equal(noPrizeState.redemption_count, 0);
    assert.equal(noPrizeState.remaining, stockBeforeNoPrize.remaining);
  },
);
