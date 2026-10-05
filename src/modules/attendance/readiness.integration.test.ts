import assert from "node:assert/strict";
import test from "node:test";
import { createAttendanceFixture } from "./readiness-test-fixture.js";
import { readAttendanceReadiness } from "./readiness.js";

test("readiness is scoped, read-only, complete and stable across previews", async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const read = () => readAttendanceReadiness(f.database, f.eventId, f.mainSessionId);
  const first = await read();
  assert.equal(first.runtimeReady, false);
  assert.equal(first.counts.confirmedRegistrations, 1);
  assert.equal(first.counts.confirmedEntitlements, 1);
  assert.equal(first.counts.missingEntitlements, 0);
  assert.equal(first.counts.pendingLegacyImports, 0);
  assert.equal(first.revision, (await read()).revision);
  await f.client`INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
    VALUES (${f.eventId},${f.workshopId},'daily',true)`;
  assert.equal((await read()).revision, first.revision);
  assert.equal((await read()).runtimeReady, false);
  await f.client`UPDATE registration_sessions SET checked_in_at='2026-10-04 18:00:00.123456',checked_in_by=${f.admin.id} WHERE id=${f.entitlementId}`;
  const legacy = await read();
  assert.notEqual(legacy.revision, first.revision);
  assert.equal(legacy.counts.pendingLegacyImports, 1);
  await f.client`INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
    VALUES (${f.eventId},${f.mainSessionId},'daily',true)`;
  const enabled = await read();
  assert.equal(enabled.runtimeReady, true); assert.equal(enabled.setupComplete, false);
  await f.client`INSERT INTO session_daily_checkins (id,registration_session_id,attendance_date,checked_in_at,checked_in_by)
    VALUES (${crypto.randomUUID()},${f.entitlementId},'2026-10-05','2026-10-04T18:00:00.123456Z',${f.admin.id})`;
  const covered = await read();
  assert.equal(covered.counts.alreadyCovered, 1); assert.equal(covered.setupComplete, true);
  await f.client`UPDATE session_daily_checkins SET cancelled_at=now(),cancelled_by=${f.admin.id},cancellation_reason='test correction'
    WHERE registration_session_id=${f.entitlementId}`;
  const cancelled = await read();
  assert.equal(cancelled.runtimeReady, true); assert.equal(cancelled.setupComplete, false);
  assert.deepEqual(cancelled.blockers, [{ code: 'CANCELLATION_CONFLICT', count: 1 }]);
  assert.notEqual(cancelled.revision, covered.revision);
  await f.client`UPDATE registrations SET user_id=NULL WHERE id=${f.registrationId}`;
  assert.equal((await read()).counts.unlinkedAccounts, 1);
  await f.client`DELETE FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
  await f.client`DELETE FROM registration_sessions WHERE id=${f.entitlementId}`;
  assert.equal((await read()).counts.missingEntitlements, 1);
  assert.equal((await readAttendanceReadiness(f.database, f.eventId, f.workshopId)).runtimeReady, false);
});
