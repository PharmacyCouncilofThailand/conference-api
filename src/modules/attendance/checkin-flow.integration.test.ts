import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import checkinRoutes from "../../routes/backoffice/checkins.js";
import { createAttendanceFixture } from "./readiness-test-fixture.js";
import { readAttendanceReadiness } from "./readiness.js";
import { setupWheelAttendance } from "../lucky-wheel/attendance-setup.js";

test("real scan routes preserve daily identity, concurrent uniqueness, undo, reports and workshop mode", { timeout: 90_000 }, async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const app = Fastify(); t.after(() => app.close());
  let actor: { id: number; role: string } = f.admin;
  app.addHook("onRequest", async request => { (request as unknown as { user: typeof actor }).user = actor; });
  await app.register(checkinRoutes, { prefix: "/checkins", database: f.database });
  await setupWheelAttendance(f.database, f.admin, f.eventId, { mainSessionId: f.mainSessionId,
    expectedReadinessRevision: (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Synthetic route verification", idempotencyKey: crypto.randomUUID() });
  const [registration] = await f.client`SELECT reg_code FROM registrations WHERE id=${f.registrationId}`;
  const scan = (input: Record<string, unknown>) => app.inject({ method: "POST", url: "/checkins", payload: { regCode: registration.reg_code, ...input } });
  const undo = (attendanceId: string) => app.inject({ method: "POST", url: "/checkins/undo", payload: { attendanceId, reason: "Synthetic cancellation" } });
  const [previous] = await f.client`
    INSERT INTO session_daily_checkins (id,registration_session_id,attendance_date,checked_in_at,checked_in_by)
    VALUES (${crypto.randomUUID()},${f.entitlementId},(clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date-1,clock_timestamp()-interval '1 day',${f.admin.id})
    RETURNING id,attendance_date::text AS date
  `;
  await f.client`UPDATE registration_sessions SET checked_in_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 day',checked_in_by=${f.admin.id} WHERE id=${f.entitlementId}`;
  const results = await Promise.all(Array.from({ length: 100 }, () => scan({ sessionId: f.mainSessionId })));
  assert.equal(results.filter(r => r.statusCode === 200).length, 1);
  assert.equal(results.filter(r => r.statusCode === 409).length, 99);
  const created = results.find(r => r.statusCode === 200)!.json().checkedInSession;
  assert.equal(created.attendanceMode, "daily"); assert.ok(created.attendanceId);
  assert.notEqual(created.attendanceDate, previous.date);
  for (const result of results.filter(r => r.statusCode === 409)) {
    assert.equal(result.json().attendanceId, created.attendanceId);
    assert.equal(result.json().checkedInAt, created.checkedInAt);
  }
  const query = `eventId=${f.eventId}&sessionId=${f.mainSessionId}&date=${created.attendanceDate}`;
  const stats = await app.inject({ method: "GET", url: `/checkins/stats?${query}` });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.json().eligibleRegistrations, 1); assert.equal(stats.json().uniquePeople, 1);
  assert.equal(stats.json().attendanceOccurrences, 2); assert.equal(stats.json().checkedInPeopleOnDate, 1);
  const list = await app.inject({ method: "GET", url: `/checkins?${query}&limit=1` });
  assert.equal(list.statusCode, 200); assert.equal(list.json().checkins[0].attendanceId, created.attendanceId);
  assert.equal(list.json().pagination.total, 1);
  assert.equal((await undo(created.attendanceId)).statusCode, 200);
  const [yesterday] = await f.client`SELECT cancelled_at FROM session_daily_checkins WHERE id=${previous.id}`;
  assert.equal(yesterday.cancelled_at, null);
  const rechecked = (await scan({ sessionId: f.mainSessionId })).json().checkedInSession;
  assert.notEqual(rechecked.attendanceId, created.attendanceId);
  assert.equal((await undo(previous.id)).statusCode, 200);
  assert.equal((await scan({ sessionId: f.mainSessionId })).json().attendanceId, rechecked.attendanceId);
  const cancelled = await app.inject({ method: "GET", url: `/checkins?eventId=${f.eventId}&sessionId=${f.mainSessionId}&date=${previous.date}&history=cancelled` });
  assert.equal(cancelled.json().checkins[0].attendanceId, previous.id);
  const legacyUndo = await app.inject({ method: "POST", url: "/checkins/undo", payload: { registrationSessionId: f.entitlementId } });
  assert.equal(legacyUndo.json().code, "DAILY_ATTENDANCE_ID_REQUIRED");
  assert.equal((await undo(rechecked.attendanceId)).statusCode, 200);
  actor = { id: f.admin.id, role: "staff" };
  assert.equal((await scan({ assignedSessionId: f.mainSessionId })).json().code, "SESSION_NOT_ASSIGNED");
  await f.client`INSERT INTO staff_event_assignments (staff_id,event_id,session_id) VALUES (${f.admin.id},${f.eventId},${f.mainSessionId})`;
  const assigned = await scan({ assignedSessionId: f.mainSessionId });
  assert.equal(assigned.statusCode, 200); assert.equal(assigned.json().checkedInSession.attendanceMode, "daily");
  assert.notEqual(assigned.json().checkedInSession.attendanceId, created.attendanceId);
  actor = f.admin;
  assert.equal((await undo(assigned.json().checkedInSession.attendanceId)).statusCode, 200);
  const all = await scan({ checkInAll: true });
  assert.equal(all.statusCode, 200); assert.equal(all.json().checkedInCount, 2);
  assert.equal(all.json().checkedInSessions.find((s: { sessionId: number }) => s.sessionId === f.mainSessionId).attendanceMode, "daily");
  assert.equal(all.json().checkedInSessions.find((s: { sessionId: number }) => s.sessionId === f.workshopId).attendanceMode, "single");
  assert.equal((await scan({ checkInAll: true })).statusCode, 409);
  const picker = await scan({}); assert.equal(picker.statusCode, 200);
  assert.ok(picker.json().sessions.find((s: { sessionId: number }) => s.sessionId === f.mainSessionId).attendanceId);
  assert.equal((await scan({ sessionId: f.workshopId + 100_000 })).json().code, "NO_ACCESS");
  await f.client`UPDATE registrations SET status='cancelled' WHERE id=${f.registrationId}`;
  assert.equal((await scan({ sessionId: f.mainSessionId })).json().code, "INVALID_STATUS");
  await f.client`UPDATE registrations SET status='confirmed' WHERE id=${f.registrationId}`;
  await f.client`UPDATE sessions SET end_time='2001-01-01' WHERE id=${f.mainSessionId}`;
  assert.equal((await scan({ sessionId: f.mainSessionId })).json().code, "SESSION_ENDED");
  const duplicates = await f.client`SELECT attendance_date FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId} AND cancelled_at IS NULL GROUP BY attendance_date HAVING count(*)>1`;
  assert.equal(duplicates.length, 0);
  const [preserved] = await f.client`SELECT count(*)::int AS count FROM registration_sessions WHERE registration_id=${f.registrationId}`;
  assert.equal(preserved.count, 2);
});
