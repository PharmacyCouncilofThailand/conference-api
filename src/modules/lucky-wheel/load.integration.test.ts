import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import test from "node:test";
import Fastify from "fastify";
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
  publishWheel,
  type WheelDatabase,
} from "./service.js";
import {
  luckyWheelAdminRoutes,
  luckyWheelAttendeeRoutes,
} from "./routes.js";

type SqlClient = ReturnType<typeof postgres>;

async function bootstrap(sqlClient: SqlClient) {
  await resetSessionGrantIntegrationSchema(sqlClient);
  await sqlClient.unsafe(`
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
      email varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      role varchar(32) NOT NULL,
      first_name varchar(100) NOT NULL,
      last_name varchar(100) NOT NULL,
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
  const migration = (
    await readFile(resolve(process.cwd(), "drizzle", "0034_lucky_wheel.sql"), "utf8")
  ).replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(migration);
  const creditMigration = (
    await readFile(resolve(process.cwd(), "drizzle", "0035_lucky_wheel_qr_credits.sql"), "utf8")
  ).replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(creditMigration);
  const simplificationMigration = (
    await readFile(resolve(process.cwd(), "drizzle", "0036_lucky_wheel_setup_simplification.sql"), "utf8")
  ).replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(simplificationMigration);
}

async function createAttendees(
  sqlClient: SqlClient,
  eventId: number,
  sessionId: number,
  day: string,
  count: number,
  prefix: string,
) {
  return sqlClient<Array<{ user_id: number }>>`
    WITH new_users AS (
      INSERT INTO users (
        email, password_hash, role, first_name, last_name, status
      )
      SELECT
        ${prefix} || '-' || g::text || '@example.invalid',
        'not-used',
        'general',
        'Load',
        g::text,
        'active'
      FROM generate_series(1, ${count}) AS g
      RETURNING id
    ),
    new_regs AS (
      INSERT INTO registrations (event_id, user_id, status)
      SELECT ${eventId}, id, 'confirmed'
      FROM new_users
      RETURNING id, user_id
    ),
    new_rs AS (
      INSERT INTO registration_sessions (registration_id, session_id)
      SELECT id, ${sessionId}
      FROM new_regs
      RETURNING id, registration_id
    ),
    inserted_checkins AS (
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at
      )
      SELECT
        gen_random_uuid(),
        rs.id,
        ${day}::date,
        clock_timestamp()
      FROM new_rs rs
      RETURNING registration_session_id
    )
    SELECT user_id
    FROM new_regs
    ORDER BY user_id
  `;
}

async function createWheelFixture(
  sqlClient: SqlClient,
  database: WheelDatabase,
  admin: { id: number; role: "admin"; email: string },
  code: string,
  prizeId: string,
  stock: number,
  day: string,
) {
  const [event] = await sqlClient<Array<{ id: number }>>`
    INSERT INTO events (event_code) VALUES (${code}) RETURNING id
  `;
  const [session] = await sqlClient<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${event.id}, true, '2020-01-01 00:00:00', '2099-12-31 23:59:59')
    RETURNING id
  `;
  await sqlClient`
    INSERT INTO lucky_wheels (event_id, main_session_id, enabled, paused)
    VALUES (${event.id}, ${session.id}, false, false)
  `;
  const configuration = {
    segments: [{
      id: prizeId,
      kind: "prize" as const,
      name: { th: "รางวัลโหลด", en: "Load Prize" },
      imageId: null,
      enabled: true,
      position: 0,
    }],
    collectionInstructions: {
      th: "รับที่จุดกิจกรรม PRIS 2026",
      en: "Collect at the PRIS 2026 activity desk",
    },
    collectionDeadline: "2099-12-31T16:59:59.000Z",
  };
  const published = await publishWheel(database, admin, event.id, 1, configuration);
  const stocked = await adjustStock(
    database,
    admin,
    event.id,
    prizeId,
    stock,
    "T12 load fixture",
    randomUUID(),
  );
  const [wheel] = await sqlClient<Array<{ id: string }>>`
    SELECT id FROM lucky_wheels WHERE event_id = ${event.id}
  `;
  const startAt = new Date(`${day}T00:00:00.000+07:00`);
  const endAt = new Date(startAt.getTime() + 24 * 60 * 60 * 1000);
  const [window] = await sqlClient<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
    VALUES (
      ${wheel.id}, ${event.id}, ${day}::date,
      ${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz
    ) RETURNING id
  `;
  const [qr] = await sqlClient<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_qr_codes (
      day_id, event_id, play_date, name, created_by,
      status, opened_by, opened_at, opened_reason
    ) VALUES (
      ${window.id}, ${event.id}, ${day}::date, 'Load QR', ${admin.id},
      'open', ${admin.id}, clock_timestamp(), 'Load test'
    ) RETURNING id
  `;
  return {
    eventId: event.id,
    sessionId: session.id,
    configurationVersion: published.version,
    poolRevision: stocked.poolRevision,
    scheduleVersion: 1,
    qrId: qr.id,
    prizeId,
  };
}

async function grantLoadCredits(
  sqlClient: SqlClient,
  eventId: number,
  sessionId: number,
  day: string,
  qrId: string,
): Promise<void> {
  await sqlClient`
    INSERT INTO lucky_wheel_credit_claims (
      qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
    )
    SELECT
      ${qrId}, ${eventId}, ${day}::date, r.user_id, dc.id, d.end_at
    FROM registrations r
    JOIN registration_sessions rs
      ON rs.registration_id = r.id AND rs.session_id = ${sessionId}
    JOIN session_daily_checkins dc
      ON dc.registration_session_id = rs.id AND dc.attendance_date = ${day}::date
    JOIN lucky_wheel_qr_codes q ON q.id = ${qrId}
    JOIN lucky_wheel_days d ON d.id = q.day_id
    WHERE r.event_id = ${eventId} AND r.status = 'confirmed' AND dc.cancelled_at IS NULL
  `;
}

function statusCounts(responses: Array<{ statusCode: number }>) {
  return responses.reduce<Record<string, number>>((counts, response) => {
    const key = String(response.statusCode);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

test(
  "lucky wheel HTTP load, lost-response recovery and SQL invariants preserve one allocation and stock",
  { timeout: 240_000 },
  async (t) => {
    const originalRewardKey = process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
    process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    t.after(() => {
      if (originalRewardKey === undefined) delete process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
      else process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = originalRewardKey;
    });

    const localEnvPath = resolve(process.cwd(), ".env.lucky-wheel-test.local");
    if (!process.env.TEST_DATABASE_URL && existsSync(localEnvPath)) loadEnvFile(localEnvPath);

    const testUrl = validateSessionGrantTestDatabaseUrl();
    const setupSql = openSessionGrantTestDatabase();
    await bootstrap(setupSql);
    const poolClient = postgres(testUrl, {
      max: 30,
      idle_timeout: 5,
      connect_timeout: 10,
    });
    const database = drizzle(poolClient, { schema }) as WheelDatabase;

    const [adminRow] = await setupSql<Array<{ id: number; email: string }>>`
      INSERT INTO backoffice_users (email, role, is_active)
      VALUES ('t12-wheel-admin@example.invalid', 'admin', true)
      RETURNING id, email
    `;
    const admin = {
      id: adminRow.id,
      role: "admin" as const,
      email: adminRow.email,
    };

    const app = Fastify({ logger: false });
    app.decorate("rateLimit", () => async () => undefined);
    app.addHook("preHandler", async (request) => {
      if (request.headers["x-test-admin"] === "1") {
        (request as any).user = admin;
        return;
      }
      const rawUser = request.headers["x-test-user"];
      const userId = Number(Array.isArray(rawUser) ? rawUser[0] : rawUser);
      if (Number.isInteger(userId) && userId > 0) {
        (request as any).user = {
          id: userId,
          role: "general",
          email: `load-${userId}@example.invalid`,
        };
      }
    });
    await app.register(luckyWheelAdminRoutes, {
      prefix: "/api/backoffice/lucky-wheel",
      database,
    });
    await app.register(luckyWheelAttendeeRoutes, {
      prefix: "/api/lucky-wheel",
      database,
    });
    await app.ready();

    t.after(async () => {
      await app.close();
      await poolClient.end({ timeout: 2 });
      await setupSql.end({ timeout: 2 });
    });

    const [{ day }] = await setupSql<Array<{ day: string }>>`
      SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS day
    `;

    const main = await createWheelFixture(
      setupSql,
      database,
      admin,
      "LW-T12-LOAD",
      "00000000-0000-4000-8000-000000001201",
      250,
      day,
    );
    const attendees = await createAttendees(
      setupSql,
      main.eventId,
      main.sessionId,
      day,
      102,
      "t12-load",
    );
    assert.equal(attendees.length, 102);
    await grantLoadCredits(setupSql, main.eventId, main.sessionId, day, main.qrId);

    const manyStarted = performance.now();
    const manyResponses = await Promise.all(
      attendees.slice(0, 100).map(({ user_id }) =>
        app.inject({
          method: "POST",
          url: `/api/lucky-wheel/events/${main.eventId}/spins`,
          headers: { "x-test-user": String(user_id) },
          payload: {
            eventId: main.eventId,
            configurationVersion: main.configurationVersion,
            poolRevision: main.poolRevision,
            scheduleVersion: main.scheduleVersion,
            idempotencyKey: randomUUID(),
          },
        }),
      ),
    );
    const manyDurationMs = performance.now() - manyStarted;
    assert.deepEqual(statusCounts(manyResponses), { "201": 100 });
    assert.equal(
      new Set(manyResponses.map((response) => response.json().spin.id)).size,
      100,
    );

    const sameUser = attendees[100].user_id;
    const sameKey = randomUUID();
    const sameStarted = performance.now();
    const sameResponses = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.inject({
          method: "POST",
          url: `/api/lucky-wheel/events/${main.eventId}/spins`,
          headers: { "x-test-user": String(sameUser) },
          payload: {
            eventId: main.eventId,
            configurationVersion: main.configurationVersion,
            poolRevision: main.poolRevision,
            scheduleVersion: main.scheduleVersion,
            idempotencyKey: sameKey,
          },
        }),
      ),
    );
    const sameDurationMs = performance.now() - sameStarted;
    assert.deepEqual(statusCounts(sameResponses), { "200": 99, "201": 1 });
    assert.equal(
      new Set(sameResponses.map((response) => response.json().spin.id)).size,
      1,
    );

    const lostUser = attendees[101].user_id;
    const lostKey = randomUUID();
    const lostResponse = await app.inject({
      method: "POST",
      url: `/api/lucky-wheel/events/${main.eventId}/spins`,
      headers: { "x-test-user": String(lostUser) },
      payload: {
        eventId: main.eventId,
        configurationVersion: main.configurationVersion,
        poolRevision: main.poolRevision,
        scheduleVersion: main.scheduleVersion,
        idempotencyKey: lostKey,
      },
    });
    assert.equal(lostResponse.statusCode, 201);
    // Treat the committed POST body as lost; recovery must use owner history.
    const recoveredHistory = await app.inject({
      method: "GET",
      url: `/api/lucky-wheel/events/${main.eventId}/spins?page=1&pageSize=20`,
      headers: { "x-test-user": String(lostUser) },
    });
    assert.equal(recoveredHistory.statusCode, 200);
    const recovered = recoveredHistory.json();
    assert.equal(recovered.pagination.total, 1);
    assert.equal(recovered.items.length, 1);
    const recoveredSpinId = recovered.items[0].spinId as string;

    const ownedProof = await app.inject({
      method: "GET",
      url: `/api/lucky-wheel/events/${main.eventId}/spins/${recoveredSpinId}`,
      headers: { "x-test-user": String(lostUser) },
    });
    assert.equal(ownedProof.statusCode, 200);
    const proof = ownedProof.json();
    assert.match(proof.rewardProof.qrPayload, /^PRIS-REWARD:[a-f0-9]{64}$/);

    const lookup = await app.inject({
      method: "POST",
      url: `/api/backoffice/lucky-wheel/events/${main.eventId}/reward-lookups`,
      headers: { "x-test-admin": "1" },
      payload: { credential: proof.rewardProof.qrPayload },
    });
    assert.equal(lookup.statusCode, 200);
    assert.equal(lookup.json().spinId, recoveredSpinId);

    const [beforeRedemption] = await setupSql<Array<{ remaining: number }>>`
      SELECT remaining FROM lucky_wheel_segments WHERE id = ${main.prizeId}
    `;
    const redemptionKey = randomUUID();
    const redemptionPayload = {
      eventId: main.eventId,
      spinId: recoveredSpinId,
      claimGeneration: 1,
      idempotencyKey: redemptionKey,
      identityChecked: true,
      collectionPoint: "PRIS 2026 activity desk",
      deliveredDetails: "T12 integration handover",
    };
    const redemption = await app.inject({
      method: "PUT",
      url: `/api/backoffice/lucky-wheel/events/${main.eventId}/spins/${recoveredSpinId}/redemption`,
      headers: { "x-test-admin": "1" },
      payload: redemptionPayload,
    });
    assert.equal(redemption.statusCode, 200);
    const replay = await app.inject({
      method: "PUT",
      url: `/api/backoffice/lucky-wheel/events/${main.eventId}/spins/${recoveredSpinId}/redemption`,
      headers: { "x-test-admin": "1" },
      payload: redemptionPayload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().redeemedAt, redemption.json().redeemedAt);
    assert.equal(replay.json().redeemedBy, redemption.json().redeemedBy);

    const correction = await app.inject({
      method: "POST",
      url: `/api/backoffice/lucky-wheel/events/${main.eventId}/spins/${recoveredSpinId}/redemption-corrections`,
      headers: { "x-test-admin": "1" },
      payload: {
        eventId: main.eventId,
        spinId: recoveredSpinId,
        claimGeneration: 1,
        reason: "T12 correction replay check",
        reopen: true,
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(correction.statusCode, 200);
    assert.equal(correction.json().toGeneration, 2);

    const [afterRedemption] = await setupSql<Array<{ remaining: number }>>`
      SELECT remaining FROM lucky_wheel_segments WHERE id = ${main.prizeId}
    `;
    assert.equal(afterRedemption.remaining, beforeRedemption.remaining);

    const [mainCounts] = await setupSql<Array<{
      remaining: number;
      spins: number;
      confirmations: number;
      corrections: number;
    }>>`
      SELECT
        seg.remaining,
        (SELECT count(*)::int FROM lucky_wheel_spins WHERE event_id = ${main.eventId}) AS spins,
        (
          SELECT count(*)::int
          FROM lucky_wheel_redemption_confirmations
          WHERE event_id = ${main.eventId}
        ) AS confirmations,
        (
          SELECT count(*)::int
          FROM lucky_wheel_redemption_corrections
          WHERE event_id = ${main.eventId}
        ) AS corrections
      FROM lucky_wheel_segments seg
      JOIN lucky_wheels w ON w.id = seg.wheel_id
      WHERE seg.id = ${main.prizeId} AND w.event_id = ${main.eventId}
    `;
    assert.deepEqual(mainCounts, {
      remaining: 148,
      spins: 102,
      confirmations: 1,
      corrections: 1,
    });
    assert.equal(250 - mainCounts.remaining, mainCounts.spins);

    const finalUnit = await createWheelFixture(
      setupSql,
      database,
      admin,
      "LW-T12-LAST",
      "00000000-0000-4000-8000-000000001202",
      1,
      day,
    );
    const finalUsers = await createAttendees(
      setupSql,
      finalUnit.eventId,
      finalUnit.sessionId,
      day,
      100,
      "t12-final",
    );
    const finalStarted = performance.now();
    await grantLoadCredits(setupSql, finalUnit.eventId, finalUnit.sessionId, day, finalUnit.qrId);
    const finalResponses = await Promise.all(
      finalUsers.map(({ user_id }) =>
        app.inject({
          method: "POST",
          url: `/api/lucky-wheel/events/${finalUnit.eventId}/spins`,
          headers: { "x-test-user": String(user_id) },
          payload: {
            eventId: finalUnit.eventId,
            configurationVersion: finalUnit.configurationVersion,
            poolRevision: finalUnit.poolRevision,
            scheduleVersion: finalUnit.scheduleVersion,
            idempotencyKey: randomUUID(),
          },
        }),
      ),
    );
    const finalDurationMs = performance.now() - finalStarted;
    const finalStatusCounts = statusCounts(finalResponses);
    assert.equal(finalStatusCounts["201"], 1);
    assert.equal(finalStatusCounts["409"], 99);
    const failureCodes = new Set(
      finalResponses
        .filter((response) => response.statusCode === 409)
        .map((response) => response.json().code),
    );
    assert.ok(
      [...failureCodes].every((code) =>
        code === "WHEEL_UPDATED" || code === "OUT_OF_STOCK"
      ),
    );

    const [finalState] = await setupSql<Array<{ remaining: number; spins: number }>>`
      SELECT
        seg.remaining,
        (SELECT count(*)::int FROM lucky_wheel_spins WHERE event_id = ${finalUnit.eventId}) AS spins
      FROM lucky_wheel_segments seg
      JOIN lucky_wheels w ON w.id = seg.wheel_id
      WHERE seg.id = ${finalUnit.prizeId} AND w.event_id = ${finalUnit.eventId}
    `;
    assert.deepEqual(finalState, { remaining: 0, spins: 1 });

    const [invariants] = await setupSql<Array<{
      duplicate_credit_spends: number;
      duplicate_qr_claims: number;
      negative_stock: number;
      duplicate_checkins: number;
      final_unspent_credits: number;
    }>>`
      SELECT
        (
          SELECT count(*)::int
          FROM (
            SELECT credit_claim_id
            FROM lucky_wheel_spins
            WHERE credit_claim_id IS NOT NULL
            GROUP BY credit_claim_id
            HAVING count(*) > 1
          ) duplicate_spends
        ) AS duplicate_credit_spends,
        (
          SELECT count(*)::int
          FROM (
            SELECT qr_id, user_id
            FROM lucky_wheel_credit_claims
            GROUP BY qr_id, user_id
            HAVING count(*) > 1
          ) duplicate_claims
        ) AS duplicate_qr_claims,
        (
          SELECT count(*)::int
          FROM lucky_wheel_segments
          WHERE kind = 'prize' AND remaining < 0
        ) AS negative_stock,
        (
          SELECT count(*)::int
          FROM (
            SELECT registration_session_id, attendance_date, count(*)
            FROM session_daily_checkins
            WHERE cancelled_at IS NULL
            GROUP BY registration_session_id, attendance_date
            HAVING count(*) > 1
          ) duplicate_checkins
        ) AS duplicate_checkins,
        (
          SELECT count(*)::int FROM lucky_wheel_credit_claims
          WHERE event_id = ${finalUnit.eventId} AND spent_at IS NULL AND revoked_at IS NULL
        ) AS final_unspent_credits
    `;
    assert.deepEqual(invariants, {
      duplicate_credit_spends: 0,
      duplicate_qr_claims: 0,
      negative_stock: 0,
      duplicate_checkins: 0,
      final_unspent_credits: 99,
    });

    console.log(JSON.stringify({
      scenario: "lucky-wheel-shared-qr-load",
      differentUsers: {
        requests: 100,
        statusCounts: statusCounts(manyResponses),
        committedAllocations: 100,
        durationMs: Math.round(manyDurationMs),
      },
      sameUser: {
        requests: 100,
        statusCounts: statusCounts(sameResponses),
        committedAllocations: 1,
        durationMs: Math.round(sameDurationMs),
      },
      finalUnit: {
        requests: 100,
        statusCounts: finalStatusCounts,
        committedAllocations: 1,
        remaining: finalState.remaining,
        durationMs: Math.round(finalDurationMs),
      },
      mainEvent: {
        stockBefore: 250,
        stockAfter: mainCounts.remaining,
        committedAllocations: mainCounts.spins,
        confirmations: mainCounts.confirmations,
        corrections: mainCounts.corrections,
      },
      invariants,
    }));
  },
);
