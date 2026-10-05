import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { events, sessions } from "../../database/schema.js";
import { createAttendanceFixture } from "../attendance/readiness-test-fixture.js";
import { readAttendanceReadiness } from "../attendance/readiness.js";
import { setupWheelAttendance, type AttendanceSetupInput } from "./attendance-setup.js";
import { WheelError } from "./access.js";

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
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const revision = (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision;
  const requests = Array.from({ length: 2 }, () => ({ mainSessionId: f.mainSessionId,
    expectedReadinessRevision: revision, reason: "Reviewed setup", idempotencyKey: crypto.randomUUID() }));
  const results = await Promise.allSettled(requests.map(input => setupWheelAttendance(f.database, f.admin, f.eventId, input)));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  const rejected = results.find(row => row.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "ATTENDANCE_SETUP_STALE");
});
