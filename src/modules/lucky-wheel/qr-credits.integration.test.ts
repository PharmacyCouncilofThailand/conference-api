import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../database/schema.js";
import { validatePrisWheelClaimOrigin } from "../../config/env.js";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";
import { editDayWindow } from "./day-schedule.js";
import {
  createQrBatch,
  claimQrCredit,
  previewQrCredit,
  readQrClaims,
  readQrCodes,
  readQrProjection,
  revokeCreditClaim,
  setQrStatus,
} from "./qr-credits.js";
import { WheelError, type WheelDatabase } from "./service.js";

test("admin QR batches are idempotent, independent, event-scoped and individually revocable", { timeout: 120_000 }, async (t) => {
  const url = validateSessionGrantTestDatabaseUrl();
  const setup = openSessionGrantTestDatabase();
  t.after(async () => setup.end({ timeout: 2 }));
  await resetSessionGrantIntegrationSchema(setup);
  await setup.unsafe(`
    CREATE TABLE events (id serial PRIMARY KEY, event_code varchar(50) NOT NULL UNIQUE, website_url varchar(500));
    CREATE TABLE sessions (
      id serial PRIMARY KEY, event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,
      start_time timestamptz NOT NULL, end_time timestamptz NOT NULL
    );
    CREATE TABLE users (
      id serial PRIMARY KEY, status varchar(32) NOT NULL DEFAULT 'active',
      first_name varchar(100) NOT NULL DEFAULT 'Test',
      last_name varchar(100) NOT NULL DEFAULT 'User',
      email varchar(255) NOT NULL DEFAULT 'user@example.invalid'
    );
    CREATE TABLE backoffice_users (
      id serial PRIMARY KEY, email varchar(255) NOT NULL,
      role varchar(32) NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE session_daily_checkins (id uuid PRIMARY KEY);
  `);
  for (const name of ["0034_lucky_wheel.sql", "0035_lucky_wheel_qr_credits.sql", "0036_lucky_wheel_setup_simplification.sql"]) {
    await setup.unsafe((await readFile(resolve(process.cwd(), "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  const [event] = await setup<Array<{ id: number }>>`
    INSERT INTO events (event_code, website_url) VALUES ('LW-QR', 'https://pris.example.com') RETURNING id
  `;
  const [otherEvent] = await setup<Array<{ id: number }>>`
    INSERT INTO events (event_code) VALUES ('LW-OTHER') RETURNING id
  `;
  const [session] = await setup<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${event.id}, true, '2026-10-29T00:00:00Z', '2026-10-30T16:59:59Z') RETURNING id
  `;
  await setup`
    INSERT INTO lucky_wheels (event_id, main_session_id)
    VALUES (${event.id}, ${session.id})
  `;
  const [admin] = await setup<Array<{ id: number; email: string }>>`
    INSERT INTO backoffice_users (email, role)
    VALUES ('qr-admin@example.invalid', 'admin') RETURNING id, email
  `;
  const pool = postgres(url, { max: 5 });
  t.after(async () => pool.end({ timeout: 2 }));
  const database = drizzle(pool, { schema }) as WheelDatabase;
  const actor = { ...admin, role: "admin" as const };
  const date = "2026-10-29";
  await editDayWindow(database, actor, event.id, {
    date, startAt: "2026-10-29T02:00:00Z", endAt: "2026-10-29T12:00:00Z",
    expectedVersion: null, reason: null,
  });
  const batchKey = randomUUID();
  const batch = await createQrBatch(database, actor, event.id, {
    date, names: ["Morning", "Afternoon"], idempotencyKey: batchKey,
  });
  assert.equal(batch.qrCodes.length, 2);
  assert.equal(batch.qrCodes[0].status, "closed");
  const replay = await createQrBatch(database, actor, event.id, {
    date, names: ["Morning", "Afternoon"], idempotencyKey: batchKey,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.qrCodes.map((qr) => qr.id), batch.qrCodes.map((qr) => qr.id));
  await assert.rejects(
    () => createQrBatch(database, actor, event.id, {
      date, names: ["Different"], idempotencyKey: batchKey,
    }),
    (error: unknown) => error instanceof WheelError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const [qrA, qrB] = batch.qrCodes;
  assert.equal((await setQrStatus(database, actor, event.id, qrA.id, {
    status: "open", reason: "Morning finished", idempotencyKey: randomUUID(),
  })).status, "open");
  const qrBOpenKey = randomUUID();
  assert.equal((await setQrStatus(database, actor, event.id, qrB.id, {
    status: "open", idempotencyKey: qrBOpenKey,
  })).status, "open");
  assert.equal((await setQrStatus(database, actor, event.id, qrB.id, {
    status: "open", reason: "", idempotencyKey: qrBOpenKey,
  })).replayed, true);
  const bothOpen = await readQrCodes(database, actor, event.id, { date, page: 1, pageSize: 10 });
  assert.equal(bothOpen.items.filter((qr) => qr.status === "open").length, 2);
  assert.equal(bothOpen.pagination.total, 2);
  await setQrStatus(database, actor, event.id, qrA.id, {
    status: "closed", reason: "Wrong display", idempotencyKey: randomUUID(),
  });
  const afterClose = await readQrCodes(database, actor, event.id, { date, page: 1, pageSize: 10 });
  assert.equal(afterClose.items.find((qr) => qr.id === qrA.id)?.status, "closed");
  assert.equal(afterClose.items.find((qr) => qr.id === qrB.id)?.status, "open");
  const audit = await setup<Array<{ operation: string; reason: string | null }>>`
    SELECT operation, reason FROM lucky_wheel_audit_events
    WHERE event_id = ${event.id} AND operation IN ('qr_open', 'qr_close')
    ORDER BY id
  `;
  assert.deepEqual(audit.map((entry) => entry.operation), ["qr_open", "qr_open", "qr_close"]);
  assert.equal(audit[1].reason, null);
  assert.equal(audit[2].reason, "Wrong display");
  await assert.rejects(
    () => readQrProjection(database, actor, otherEvent.id, qrA.id),
    (error: unknown) => error instanceof WheelError && error.statusCode === 404,
  );
  const projection = await readQrProjection(database, actor, event.id, qrB.id, "https://backoffice.example.com");
  assert.equal(projection.claimUrl, `https://pris.example.com/th/lucky-wheel/claim#${qrB.id}`);
  assert.match(projection.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(projection.currentDeadline, "2026-10-29T12:00:00.000Z");
  await assert.rejects(
    () => readQrProjection(database, actor, event.id, qrB.id, "https://pris.example.com"),
    (error: unknown) => error instanceof WheelError && error.statusCode === 503,
  );
  await setup`UPDATE events SET website_url = NULL WHERE id = ${event.id}`;
  await assert.rejects(
    () => readQrProjection(database, actor, event.id, qrB.id),
    (error: unknown) => error instanceof WheelError && error.statusCode === 503,
  );

  const [user] = await setup<Array<{ id: number }>>`INSERT INTO users DEFAULT VALUES RETURNING id`;
  const attendanceId = randomUUID();
  await setup`INSERT INTO session_daily_checkins (id) VALUES (${attendanceId})`;
  const [credit] = await setup<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_credit_claims (
      qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
    ) VALUES (
      ${qrA.id}, ${event.id}, ${date}::date, ${user.id}, ${attendanceId}, '2026-10-29T12:00:00Z'
    ) RETURNING id
  `;
  const revokeKey = randomUUID();
  const revocation = await revokeCreditClaim(database, actor, event.id, credit.id, {
    reason: "Issued in error", idempotencyKey: revokeKey,
  });
  assert.equal(revocation.claimId, credit.id);
  assert.equal(revocation.revokedBy, actor.id);
  assert.equal((await revokeCreditClaim(database, actor, event.id, credit.id, {
    reason: "Issued in error", idempotencyKey: revokeKey,
  })).replayed, true);
  const [revokedRow] = await setup<Array<{ revoked_at: Date | null; revocation_reason: string | null }>>`
    SELECT revoked_at, revocation_reason FROM lucky_wheel_credit_claims WHERE id = ${credit.id}
  `;
  assert.ok(revokedRow.revoked_at);
  assert.equal(revokedRow.revocation_reason, "Issued in error");

  const [spentUser] = await setup<Array<{ id: number }>>`INSERT INTO users DEFAULT VALUES RETURNING id`;
  const [spent] = await setup<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_credit_claims (
      qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at, spent_at
    ) VALUES (
      ${qrA.id}, ${event.id}, ${date}::date, ${spentUser.id}, ${attendanceId},
      '2026-10-29T12:00:00Z', clock_timestamp()
    ) RETURNING id
  `;
  await assert.rejects(
    () => revokeCreditClaim(database, actor, event.id, spent.id, {
      reason: "Too late", idempotencyKey: randomUUID(),
    }),
    (error: unknown) => error instanceof WheelError && error.statusCode === 409,
  );
  const claims = await readQrClaims(database, actor, event.id, qrA.id, { page: 1, pageSize: 1 });
  assert.equal(claims.pagination.total, 2);
  assert.equal(claims.items.length, 1);
  assert.equal(claims.items[0].recipient.firstName, "Test");
  await assert.rejects(
    () => readQrClaims(database, actor, otherEvent.id, qrA.id, { page: 1, pageSize: 10 }),
    (error: unknown) => error instanceof WheelError && error.statusCode === 404,
  );
});

test("event PRIS website URL rejects arbitrary URLs and permits only local HTTP in development", () => {
  assert.equal(validatePrisWheelClaimOrigin("https://pris.example.com", null, {
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv), "https://pris.example.com");
  for (const value of [
    "http://pris.example.com", "https://pris.example.com/path",
    "https://user:pass@pris.example.com", "https://pris.example.com/?next=evil", "https://pris.example.com/#target",
  ]) {
    assert.throws(() => validatePrisWheelClaimOrigin(value, null, {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv));
  }
  assert.equal(validatePrisWheelClaimOrigin("http://localhost:3003", "http://localhost:3001", {
    NODE_ENV: "development",
  } as NodeJS.ProcessEnv), "http://localhost:3003");
  assert.throws(() => validatePrisWheelClaimOrigin("http://localhost:3001", "http://localhost:3001", {
    NODE_ENV: "development",
  } as NodeJS.ProcessEnv));
});

test("shared QR grants one durable credit per eligible account and QR under concurrent claims", { timeout: 180_000 }, async (t) => {
  const url = validateSessionGrantTestDatabaseUrl();
  const setup = openSessionGrantTestDatabase();
  t.after(async () => setup.end({ timeout: 2 }));
  await resetSessionGrantIntegrationSchema(setup);
  await setup.unsafe(`
    CREATE TABLE events (id serial PRIMARY KEY, event_code varchar(50) NOT NULL UNIQUE, website_url varchar(500));
    CREATE TABLE sessions (
      id serial PRIMARY KEY, event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,
      start_time timestamptz NOT NULL, end_time timestamptz NOT NULL
    );
    CREATE TABLE users (id serial PRIMARY KEY, status varchar(32) NOT NULL);
    CREATE TABLE backoffice_users (
      id serial PRIMARY KEY, email varchar(255) NOT NULL,
      role varchar(32) NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE registrations (
      id serial PRIMARY KEY, event_id integer NOT NULL REFERENCES events(id),
      user_id integer REFERENCES users(id), status varchar(32) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE registration_sessions (
      id serial PRIMARY KEY, registration_id integer NOT NULL REFERENCES registrations(id),
      session_id integer NOT NULL REFERENCES sessions(id)
    );
    CREATE TABLE session_daily_checkins (
      id uuid PRIMARY KEY, registration_session_id integer NOT NULL REFERENCES registration_sessions(id),
      attendance_date date NOT NULL, checked_in_at timestamptz NOT NULL,
      cancelled_at timestamptz
    );
    CREATE UNIQUE INDEX session_daily_checkins_active_day_unique
      ON session_daily_checkins (registration_session_id, attendance_date) WHERE cancelled_at IS NULL;
  `);
  for (const name of ["0034_lucky_wheel.sql", "0035_lucky_wheel_qr_credits.sql", "0036_lucky_wheel_setup_simplification.sql"]) {
    await setup.unsafe((await readFile(resolve(process.cwd(), "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  const [{ day }] = await setup<Array<{ day: string }>>`
    SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS day
  `;
  const startAt = new Date(`${day}T00:00:00.000+07:00`).toISOString();
  const endAt = new Date(new Date(startAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const [event] = await setup<Array<{ id: number }>>`
    INSERT INTO events (event_code) VALUES ('LW-CLAIM') RETURNING id
  `;
  const [otherEvent] = await setup<Array<{ id: number }>>`
    INSERT INTO events (event_code) VALUES ('LW-OTHER') RETURNING id
  `;
  const [session] = await setup<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${event.id}, true, '2020-01-01T00:00:00Z', '2099-12-31T00:00:00Z') RETURNING id
  `;
  const [wheel] = await setup<Array<{ id: string }>>`
    INSERT INTO lucky_wheels (
      event_id, main_session_id, enabled, paused,
      published_configuration, collection_instructions, collection_deadline
    ) VALUES (
      ${event.id}, ${session.id}, true, false,
      '{"segments":[]}'::jsonb, '{"th":"รับที่จุดกิจกรรม","en":"Desk"}'::jsonb,
      '2099-12-31T00:00:00Z'
    ) RETURNING id
  `;
  await setup`
    INSERT INTO lucky_wheel_segments (
      id, wheel_id, kind, name_th, name_en, enabled, position, remaining
    ) VALUES (
      ${randomUUID()}, ${wheel.id}, 'prize', 'ปากกา', 'Pen', true, 0, 250
    )
  `;
  const [admin] = await setup<Array<{ id: number; email: string }>>`
    INSERT INTO backoffice_users (email, role)
    VALUES ('claim-admin@example.invalid', 'admin') RETURNING id, email
  `;
  const pool = postgres(url, { max: 20, idle_timeout: 5 });
  t.after(async () => pool.end({ timeout: 2 }));
  const database = drizzle(pool, { schema }) as WheelDatabase;
  const adminActor = { ...admin, role: "admin" as const };
  await editDayWindow(database, adminActor, event.id, {
    date: day, startAt, endAt, expectedVersion: null, reason: null,
  });
  const batch = await createQrBatch(database, adminActor, event.id, {
    date: day, names: ["A", "B", "C", "D"], idempotencyKey: randomUUID(),
  });
  for (const qr of batch.qrCodes) {
    await setQrStatus(database, adminActor, event.id, qr.id, {
      status: "open", reason: "Share on screen", idempotencyKey: randomUUID(),
    });
  }
  const [qrA, qrB, qrC, qrD] = batch.qrCodes;
  const [user] = await setup<Array<{ id: number }>>`
    INSERT INTO users (status) VALUES ('active') RETURNING id
  `;
  const [registration] = await setup<Array<{ id: number }>>`
    INSERT INTO registrations (event_id, user_id, status)
    VALUES (${event.id}, ${user.id}, 'confirmed') RETURNING id
  `;
  const [registrationSession] = await setup<Array<{ id: number }>>`
    INSERT INTO registration_sessions (registration_id, session_id)
    VALUES (${registration.id}, ${session.id}) RETURNING id
  `;
  const [attendance] = await setup<Array<{ id: string }>>`
    INSERT INTO session_daily_checkins (id, registration_session_id, attendance_date, checked_in_at)
    VALUES (${randomUUID()}, ${registrationSession.id}, ${day}::date, clock_timestamp()) RETURNING id
  `;
  const [secondRegistration] = await setup<Array<{ id: number }>>`
    INSERT INTO registrations (event_id, user_id, status)
    VALUES (${event.id}, ${user.id}, 'confirmed') RETURNING id
  `;
  await setup`
    INSERT INTO registration_sessions (registration_id, session_id)
    VALUES (${secondRegistration.id}, ${session.id})
  `;
  const preview = await previewQrCredit(database, { id: user.id }, event.id, qrA.id);
  assert.equal(preview.name, "A");
  const [{ beforePreviewClaims }] = await setup<Array<{ beforePreviewClaims: number }>>`
    SELECT count(*)::int AS "beforePreviewClaims" FROM lucky_wheel_credit_claims
  `;
  assert.equal(beforePreviewClaims, 0);
  const sameAccount = await Promise.all(
    Array.from({ length: 100 }, () => claimQrCredit(database, { id: user.id }, event.id, qrA.id)),
  );
  assert.equal(sameAccount.filter((result) => result.created).length, 1);
  assert.equal(new Set(sameAccount.map((result) => result.creditId)).size, 1);
  assert.equal(sameAccount[0].state, "spendable");
  assert.equal((await claimQrCredit(database, { id: user.id }, event.id, qrB.id)).created, true);
  await setQrStatus(database, adminActor, event.id, qrA.id, {
    status: "closed", reason: "Morning over", idempotencyKey: randomUUID(),
  });
  assert.equal((await claimQrCredit(database, { id: user.id }, event.id, qrA.id)).created, false);
  await setup`UPDATE session_daily_checkins SET cancelled_at = clock_timestamp() WHERE id = ${attendance.id}`;
  await assert.rejects(
    () => claimQrCredit(database, { id: user.id }, event.id, qrC.id),
    (error: unknown) => error instanceof WheelError && error.code === "CHECKIN_REQUIRED",
  );
  const [replacement] = await setup<Array<{ id: string }>>`
    INSERT INTO session_daily_checkins (id, registration_session_id, attendance_date, checked_in_at)
    VALUES (${randomUUID()}, ${registrationSession.id}, ${day}::date, clock_timestamp()) RETURNING id
  `;
  assert.equal((await claimQrCredit(database, { id: user.id }, event.id, qrC.id)).created, true);
  const [claimC] = await setup<Array<{ attendance_id: string }>>`
    SELECT attendance_id FROM lucky_wheel_credit_claims WHERE qr_id = ${qrC.id} AND user_id = ${user.id}
  `;
  assert.equal(claimC.attendance_id, replacement.id);
  await assert.rejects(
    () => claimQrCredit(database, { id: user.id }, otherEvent.id, qrD.id),
    (error: unknown) => error instanceof WheelError && error.statusCode === 404,
  );

  await setup.unsafe(`
    WITH new_users AS (
      INSERT INTO users (status) SELECT 'active' FROM generate_series(1, 100) RETURNING id
    ), new_regs AS (
      INSERT INTO registrations (event_id, user_id, status)
      SELECT ${event.id}, id, 'confirmed' FROM new_users RETURNING id, user_id
    ), new_rs AS (
      INSERT INTO registration_sessions (registration_id, session_id)
      SELECT id, ${session.id} FROM new_regs RETURNING id
    )
    INSERT INTO session_daily_checkins (id, registration_session_id, attendance_date, checked_in_at)
    SELECT gen_random_uuid(), id, '${day}'::date, clock_timestamp() FROM new_rs
  `);
  const users = await setup<Array<{ user_id: number }>>`
    SELECT user_id FROM registrations WHERE event_id = ${event.id} AND user_id <> ${user.id}
    ORDER BY user_id
  `;
  assert.equal(users.length, 100);
  const distinct = await Promise.all(
    users.map(({ user_id }) => claimQrCredit(database, { id: user_id }, event.id, qrD.id)),
  );
  assert.equal(distinct.filter((result) => result.created).length, 100);
  const [{ duplicateCredits }] = await setup<Array<{ duplicateCredits: number }>>`
    SELECT count(*)::int AS "duplicateCredits" FROM (
      SELECT qr_id, user_id FROM lucky_wheel_credit_claims
      GROUP BY qr_id, user_id HAVING count(*) > 1
    ) duplicates
  `;
  assert.equal(duplicateCredits, 0);

  const [{ closedEnd }] = await setup<Array<{ closedEnd: Date }>>`
    SELECT clock_timestamp() - interval '1 minute' AS "closedEnd"
  `;
  const shortened = await editDayWindow(database, adminActor, event.id, {
    date: day, startAt, endAt: closedEnd.toISOString(),
    expectedVersion: 1, reason: "Pause schedule early",
  });
  assert.equal(shortened.version, 2);
  const heldWhileClosed = await claimQrCredit(database, { id: user.id }, event.id, qrB.id);
  assert.equal(heldWhileClosed.created, false);
  assert.equal(heldWhileClosed.state, "outside_window");
  assert.equal(heldWhileClosed.currentDeadline, closedEnd.toISOString());
  await assert.rejects(
    () => claimQrCredit(database, { id: user.id }, event.id, qrD.id),
    (error: unknown) => error instanceof WheelError && error.statusCode === 409,
  );
  await editDayWindow(database, adminActor, event.id, {
    date: day, startAt, endAt, expectedVersion: 2, reason: "Resume schedule",
  });
  assert.equal((await claimQrCredit(database, { id: user.id }, event.id, qrB.id)).state, "spendable");
  await setup`UPDATE lucky_wheels SET paused = true WHERE id = ${wheel.id}`;
  await assert.rejects(
    () => claimQrCredit(database, { id: user.id }, event.id, qrD.id),
    (error: unknown) => error instanceof WheelError && error.code === "WHEEL_PAUSED",
  );
  await setup`UPDATE lucky_wheels SET paused = false WHERE id = ${wheel.id}`;
  await setup`UPDATE lucky_wheel_segments SET remaining = 0 WHERE wheel_id = ${wheel.id}`;
  await assert.rejects(
    () => claimQrCredit(database, { id: user.id }, event.id, qrD.id),
    (error: unknown) => error instanceof WheelError && error.code === "OUT_OF_STOCK",
  );
  await setup`UPDATE lucky_wheel_segments SET remaining = 10 WHERE wheel_id = ${wheel.id}`;
  assert.equal((await claimQrCredit(database, { id: user.id }, event.id, qrD.id)).created, true);

  const [qrE] = (await createQrBatch(database, adminActor, event.id, {
    date: day, names: ["E"], idempotencyKey: randomUUID(),
  })).qrCodes;
  await setQrStatus(database, adminActor, event.id, qrE.id, {
    status: "open", reason: "Race display", idempotencyKey: randomUUID(),
  });
  const racerId = users[0].user_id;
  const race = await Promise.allSettled([
    setQrStatus(database, adminActor, event.id, qrE.id, {
      status: "closed", reason: "Stop distribution", idempotencyKey: randomUUID(),
    }),
    claimQrCredit(database, { id: racerId }, event.id, qrE.id),
  ]);
  assert.equal(race[0].status, "fulfilled");
  const [{ raceClaims }] = await setup<Array<{ raceClaims: number }>>`
    SELECT count(*)::int AS "raceClaims"
    FROM lucky_wheel_credit_claims WHERE qr_id = ${qrE.id} AND user_id = ${racerId}
  `;
  assert.equal(raceClaims, race[1].status === "fulfilled" ? 1 : 0);
  if (race[1].status === "fulfilled") {
    assert.equal((await claimQrCredit(database, { id: racerId }, event.id, qrE.id)).created, false);
  } else {
    assert.ok(race[1].reason instanceof WheelError);
    await assert.rejects(
      () => claimQrCredit(database, { id: racerId }, event.id, qrE.id),
      (error: unknown) => error instanceof WheelError && error.code === "WHEEL_NOT_READY",
    );
  }
});
