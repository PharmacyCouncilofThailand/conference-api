import assert from "node:assert/strict";
import test from "node:test";
import { createAttendanceFixture } from "./readiness-test-fixture.js";
import { lockAttendanceCutover } from "./cutover-lock.js";
import { checkInSession, cancelDailyCheckin } from "./service.js";
import type { WheelDatabase } from "../lucky-wheel/access.js";

test("exclusive cutover queues a scanner before row locks and scanner re-reads daily policy", async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>(resolve => { acquired = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const setup = f.database.transaction(async tx => {
    await lockAttendanceCutover(tx as unknown as WheelDatabase, f.eventId, f.mainSessionId, "exclusive");
    acquired(); await unblock;
    await f.client`INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
      VALUES (${f.eventId},${f.mainSessionId},'daily',true)`;
  });
  await held;
  let settled = false;
  const scan = checkInSession(f.database, { registrationSessionId: f.entitlementId, actor: f.admin })
    .then(value => { settled = true; return value; });
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const [row] = await f.client<{ waiting: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ShareLock' AND NOT granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      ) AS waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "scanner must wait on the fence rather than an entitlement row");
    assert.equal(settled, false);
  } finally { release(); }
  await setup;
  const result = await scan;
  assert.equal(result.state.mode, "daily"); assert.equal(result.created, true);
  const cancelled = await cancelDailyCheckin(f.database, {
    attendanceId: result.state.attendanceId!, actor: f.admin, reason: "Test correction" });
  assert.ok(cancelled.cancelledAt);
  const rescans = await Promise.all(Array.from({ length: 10 }, () =>
    checkInSession(f.database, { registrationSessionId: f.entitlementId, actor: f.admin })));
  assert.equal(rescans.filter(row => row.created).length, 1);
  assert.equal(new Set(rescans.map(row => row.state.attendanceId)).size, 1);
  const workshop = await checkInSession(f.database, { registrationSessionId: f.workshopEntitlementId, actor: f.admin });
  assert.equal(workshop.state.mode, "single");
  assert.equal((await checkInSession(f.database, { registrationSessionId: f.workshopEntitlementId, actor: f.admin })).created, false);
});
