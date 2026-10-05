import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { events, sessions } from "../../database/schema.js";
import { createAttendanceFixture } from "../attendance/readiness-test-fixture.js";
import { readAttendanceReadiness } from "../attendance/readiness.js";
import { setupWheelAttendance, type AttendanceSetupInput } from "./attendance-setup.js";
import { WheelError } from "./access.js";
import { lockAttendanceCutover } from "../attendance/cutover-lock.js";
import { cancelDailyCheckin, checkInSession } from "../attendance/service.js";
import type { WheelDatabase } from "./access.js";

test("in-flight legacy scan makes setup wait then reject stale evidence until reviewed again", { timeout: 15_000 }, async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const input: AttendanceSetupInput = { mainSessionId: f.mainSessionId,
    expectedReadinessRevision: (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Synthetic cutover preview", idempotencyKey: crypto.randomUUID() };
  let acquired!: () => void; let release!: () => void;
  const held = new Promise<void>(resolve => { acquired = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const scanner = f.database.transaction(async tx => {
    const txDb = tx as unknown as WheelDatabase;
    await lockAttendanceCutover(txDb, f.eventId, f.mainSessionId, "shared");
    const result = await checkInSession(txDb, { registrationSessionId: f.entitlementId, actor: f.admin });
    assert.equal(result.state.mode, "single"); assert.equal(result.created, true);
    acquired(); await unblock;
  });
  await held;
  const setup = setupWheelAttendance(f.database, f.admin, f.eventId, input)
    .then(result => ({ result, error: null }), error => ({ result: null, error }));
  let waiting = false;
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const [row] = await f.client`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock'
        AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  await scanner;
  const outcome = await setup;
  assert.equal(waiting, true, "setup must wait for the in-flight real scanner's shared fence");
  assert.ok(outcome.error instanceof WheelError);
  assert.equal(outcome.error.code, "ATTENDANCE_SETUP_STALE");
  const [untouched] = await f.client`SELECT
    (SELECT count(*)::int FROM session_attendance_policies WHERE event_id=${f.eventId}) AS policies,
    (SELECT count(*)::int FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}) AS imports,
    (SELECT count(*)::int FROM lucky_wheel_audit_events WHERE event_id=${f.eventId}) AS audits`;
  assert.deepEqual(untouched, { policies: 0, imports: 0, audits: 0 });
  const [source] = await f.client`SELECT checked_in_at::text,checked_in_by FROM registration_sessions WHERE id=${f.entitlementId}`;
  assert.ok(source.checked_in_at); assert.equal(source.checked_in_by, f.admin.id);
  const reviewed = { ...input, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    idempotencyKey: crypto.randomUUID() };
  assert.notEqual(reviewed.expectedReadinessRevision, input.expectedReadinessRevision);
  const result = await setupWheelAttendance(f.database, f.admin, f.eventId, reviewed);
  assert.equal(result.importedCount, 1); assert.equal(result.replayed, false);
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, reviewed)).replayed, true);
  const [after] = await f.client`SELECT checked_in_at::text,checked_in_by FROM registration_sessions WHERE id=${f.entitlementId}`;
  assert.deepEqual(after, source);
  const [counts] = await f.client`SELECT
    (SELECT count(*)::int FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}) AS imports,
    (SELECT count(*)::int FROM lucky_wheel_audit_events WHERE event_id=${f.eventId} AND operation='attendance_setup') AS audits`;
  assert.deepEqual(counts, { imports: 1, audits: 1 });
});

test("setup NOWAIT rolls back during grant parent contention and the same request succeeds after release", { timeout: 15_000 }, async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const input: AttendanceSetupInput = { mainSessionId: f.mainSessionId,
    expectedReadinessRevision: (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Reviewed synthetic setup", idempotencyKey: crypto.randomUUID() };
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>(resolve => { acquired = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const owner = f.client.begin(async tx => {
    await tx.unsafe('SELECT id FROM events WHERE id=$1 FOR UPDATE', [f.eventId]);
    acquired(); await unblock;
  });
  await held;
  // Same joined FOR UPDATE shape as the existing session-grants service.
  const grant = f.database.transaction(async tx => {
    await tx.select({ id: sessions.id, eventId: events.id }).from(sessions)
      .innerJoin(events, eq(sessions.eventId, events.id))
      .where(eq(sessions.id, f.mainSessionId)).limit(1).for("update");
  });
  let sessionHeld = false;
  try {
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await f.client`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%sessions%'`;
      if (rows.length) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "grant must reach its event-lock wait");
    try {
      await f.client.begin(async tx => {
        await tx.unsafe('SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT', [f.mainSessionId]);
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "55P03") throw error;
      sessionHeld = true;
    }
    await assert.rejects(() => setupWheelAttendance(f.database, f.admin, f.eventId, input),
      error => error instanceof WheelError && error.code === "ATTENDANCE_SETUP_BUSY");
    const [untouched] = await f.client`SELECT
      (SELECT count(*)::int FROM session_attendance_policies WHERE event_id=${f.eventId}) AS policies,
      (SELECT count(*)::int FROM lucky_wheel_audit_events WHERE event_id=${f.eventId}) AS audits`;
    assert.deepEqual(untouched, { policies: 0, audits: 0 });
  } finally { release(); await owner; await grant; }
  assert.equal(sessionHeld, true, "probe must reproduce the existing inverted grant order");
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, input)).replayed, false);
});

test("setup imports only evidenced dates exactly once under 100 requests and replays after unpause", { timeout: 30_000 }, async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  await f.client`UPDATE registration_sessions SET checked_in_at='2026-10-04 18:00:00.123456',checked_in_by=${f.admin.id} WHERE id=${f.entitlementId}`;
  const input = { mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Enable reviewed daily attendance", idempotencyKey: crypto.randomUUID() };
  const results = await Promise.all(Array.from({ length: 100 }, () => setupWheelAttendance(f.database, f.admin, f.eventId, input)));
  assert.equal(results.filter(row => !row.replayed).length, 1);
  assert.equal(new Set(results.map(row => row.auditId)).size, 1);
  assert.equal(results[0].importedCount, 1);
  const [row] = await f.client`SELECT attendance_date::text AS day,
    to_char(checked_in_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS instant,
    checked_in_by,legacy_source_key FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
  assert.deepEqual(row, { day: "2026-10-05", instant: "2026-10-04 18:00:00.123456",
    checked_in_by: f.admin.id, legacy_source_key: `registration_sessions:${f.entitlementId}` });
  const [source] = await f.client`SELECT checked_in_at::text,checked_in_by FROM registration_sessions WHERE id=${f.entitlementId}`;
  assert.equal(source.checked_in_at, "2026-10-04 18:00:00.123456");
  assert.equal(source.checked_in_by, f.admin.id);
  await f.client`UPDATE lucky_wheels SET paused=false WHERE id=${f.wheelId}`;
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, input)).replayed, true);
  await assert.rejects(() => setupWheelAttendance(f.database, f.admin, f.eventId, { ...input, reason: "Different reason" }),
    error => error instanceof WheelError && error.code === "IDEMPOTENCY_CONFLICT");
});

test("setup rejects unsafe evidence without partial policy or import and does not resurrect a processed cancellation", async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const input = async () => ({ mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Reviewed setup", idempotencyKey: crypto.randomUUID() });
  const reject = async (body: AttendanceSetupInput, code: string, actor = f.admin) => {
    await assert.rejects(() => setupWheelAttendance(f.database, actor, f.eventId, body),
      error => error instanceof WheelError && error.code === code);
    const [count] = await f.client`SELECT count(*)::int AS n FROM session_attendance_policies WHERE event_id=${f.eventId}`;
    assert.equal(count.n, 0);
  };
  await reject(await input(), "ADMIN_REQUIRED", { ...f.admin, id: 999999 });
  await reject({ ...await input(), mainSessionId: f.workshopId }, "ATTENDANCE_SETUP_CONFLICT");
  await f.client`UPDATE lucky_wheels SET paused=false WHERE id=${f.wheelId}`;
  await reject(await input(), "ATTENDANCE_SETUP_REQUIRES_PAUSE");
  await f.client`UPDATE lucky_wheels SET paused=true WHERE id=${f.wheelId}`;
  const stale = await input();
  await f.client`UPDATE registration_sessions SET checked_in_at='2026-10-04 18:00:00',checked_in_by=NULL WHERE id=${f.entitlementId}`;
  await reject(stale, "ATTENDANCE_SETUP_STALE");
  await reject(await input(), "ATTENDANCE_SETUP_CONFLICT");
  await f.client`UPDATE registration_sessions SET checked_in_by=${f.admin.id},checked_in_at='2010-01-01' WHERE id=${f.entitlementId}`;
  await reject(await input(), "ATTENDANCE_SETUP_CONFLICT");
  await f.client`UPDATE registration_sessions SET checked_in_at='2026-10-04 18:00:00' WHERE id=${f.entitlementId}`;
  const attendanceId = crypto.randomUUID();
  await f.client`INSERT INTO session_daily_checkins (id,registration_session_id,attendance_date,checked_in_at,checked_in_by)
    VALUES (${attendanceId},${f.entitlementId},'2026-10-05','2026-10-04T19:00:00Z',${f.admin.id})`;
  await reject(await input(), "ATTENDANCE_SETUP_CONFLICT");
  await f.client`UPDATE session_daily_checkins SET cancelled_at=now(),cancelled_by=${f.admin.id},cancellation_reason='Test cancellation' WHERE id=${attendanceId}`;
  await reject(await input(), "ATTENDANCE_SETUP_CONFLICT");
  await f.client`UPDATE session_daily_checkins SET legacy_source_key=${`registration_sessions:${f.entitlementId}`} WHERE id=${attendanceId}`;
  const result = await setupWheelAttendance(f.database, f.admin, f.eventId, await input());
  assert.equal(result.importedCount, 0); assert.equal(result.alreadyImportedCount, 1);
  const [preserved] = await f.client`SELECT count(*)::int AS n FROM session_daily_checkins
    WHERE registration_session_id=${f.entitlementId} AND cancelled_at IS NOT NULL`;
  assert.equal(preserved.n, 1);
});

test("setup creates no checkin without legacy evidence and refuses missing confirmed entitlement/account links", async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const input = async () => ({ mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Reviewed setup", idempotencyKey: crypto.randomUUID() });
  await f.client`UPDATE registrations SET user_id=NULL WHERE id=${f.registrationId}`;
  await assert.rejects(() => input().then(body => setupWheelAttendance(f.database, f.admin, f.eventId, body)),
    error => error instanceof WheelError && error.code === "ATTENDANCE_SETUP_CONFLICT");
  await f.client`UPDATE registrations SET user_id=${f.userId} WHERE id=${f.registrationId}`;
  await f.client`DELETE FROM registration_sessions WHERE id=${f.entitlementId}`;
  await assert.rejects(() => input().then(body => setupWheelAttendance(f.database, f.admin, f.eventId, body)),
    error => error instanceof WheelError && error.code === "ATTENDANCE_SETUP_CONFLICT");
  await f.client`INSERT INTO registration_sessions (id,registration_id,session_id,ticket_type_id,source)
    VALUES (${f.entitlementId},${f.registrationId},${f.mainSessionId},${f.ticketId},'purchase')`;
  const result = await setupWheelAttendance(f.database, f.admin, f.eventId, await input());
  assert.equal(result.importedCount, 0);
  const [rows] = await f.client`SELECT count(*)::int AS n FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
  assert.equal(rows.n, 0);
});

test("two independently keyed setups from one preview cannot silently reuse stale evidence", async t => {
  const f = await createAttendanceFixture();
  const [other] = await f.client<{ id: number; email: string }[]>`INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
    VALUES (${`second-admin-${crypto.randomUUID()}@example.invalid`},'x','admin','Second','Admin',true) RETURNING id,email`;
  t.after(async () => {
    await f.client`DELETE FROM lucky_wheel_audit_events WHERE event_id=${f.eventId}`;
    await f.client`DELETE FROM backoffice_users WHERE id=${other.id}`;
    await f.cleanup();
  });
  const revision = (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision;
  const requests = Array.from({ length: 2 }, () => ({ mainSessionId: f.mainSessionId,
    expectedReadinessRevision: revision, reason: "Reviewed setup", idempotencyKey: crypto.randomUUID() }));
  const actors = [f.admin, { ...other, role: "admin" as const }];
  const results = await Promise.allSettled(requests.map((input, index) => setupWheelAttendance(f.database, actors[index], f.eventId, input)));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  const rejected = results.find(row => row.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "ATTENDANCE_SETUP_STALE");
});

test("scanner queued behind actual setup re-reads the committed daily policy", { timeout: 15_000 }, async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const input = { mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Synthetic reviewed cutover", idempotencyKey: crypto.randomUUID() };
  let acquired!: () => void; let release!: () => void;
  const held = new Promise<void>(resolve => { acquired = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const setup = f.database.transaction(async tx => {
    const result = await setupWheelAttendance(tx as unknown as WheelDatabase, f.admin, f.eventId, input);
    assert.equal(result.importedCount, 0); acquired(); await unblock;
  });
  await held;
  const scan = checkInSession(f.database, { registrationSessionId: f.entitlementId, actor: f.admin });
  let waiting = false;
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const [row] = await f.client`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
        AND mode='ShareLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  await setup;
  const result = await scan;
  assert.equal(waiting, true); assert.equal(result.state.mode, "daily"); assert.equal(result.created, true);
});

test("in-flight imported-source cancellation makes setup stale and cannot resurrect history", { timeout: 15_000 }, async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  await f.client`UPDATE registration_sessions SET checked_in_at=clock_timestamp() AT TIME ZONE 'UTC',checked_in_by=${f.admin.id} WHERE id=${f.entitlementId}`;
  const command = async () => ({ mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Synthetic cancellation cutover", idempotencyKey: crypto.randomUUID() });
  await setupWheelAttendance(f.database, f.admin, f.eventId, await command());
  const [attendance] = await f.client`SELECT id FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
  const input = await command();
  let acquired!: () => void; let release!: () => void;
  const held = new Promise<void>(resolve => { acquired = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const cancel = f.database.transaction(async tx => {
    await cancelDailyCheckin(tx as unknown as WheelDatabase, {
      attendanceId: attendance.id, actor: f.admin, reason: "Synthetic in-flight cancellation" });
    acquired(); await unblock;
  });
  await held;
  const setup = setupWheelAttendance(f.database, f.admin, f.eventId, input)
    .then(result => ({ result, error: null }), error => ({ result: null, error }));
  let waiting = false;
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const [row] = await f.client`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
        AND mode='ExclusiveLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  await cancel;
  const outcome = await setup;
  assert.equal(waiting, true); assert.equal(outcome.error?.code, "ATTENDANCE_SETUP_STALE");
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, await command())).importedCount, 0);
  const [counts] = await f.client`SELECT count(*)::int AS total,count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active
    FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
  assert.deepEqual(counts, { total: 1, active: 0 });
  const [rejectedWrites] = await f.client`SELECT count(*)::int AS audits FROM lucky_wheel_audit_events
    WHERE event_id=${f.eventId} AND idempotency_key=${input.idempotencyKey}`;
  assert.equal(rejectedWrites.audits, 0);
});
