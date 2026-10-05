import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import checkinRoutes from "../../routes/backoffice/checkins.js";
import { createAttendanceFixture } from "../attendance/readiness-test-fixture.js";
import { readAttendanceReadiness } from "../attendance/readiness.js";
import { cancelDailyCheckin } from "../attendance/service.js";
import { bangkokDay } from "../attendance/policy.js";
import { WheelError } from "./access.js";
import { setupWheelAttendance } from "./attendance-setup.js";
import { createSpin, getEligibility, publishWheel, readAdminWheelState, setWheelPaused, adjustStock } from "./service.js";
import { claimQrCredit, createQrBatch, readQrProjection, setQrStatus } from "./qr-credits.js";
import { editDayWindow } from "./day-schedule.js";

const rejectsCode = (operation: Promise<unknown>, code: string) => assert.rejects(operation,
  (error: unknown) => error instanceof WheelError && error.code === code);

async function prepare() {
  const f = await createAttendanceFixture();
  const prizeId = crypto.randomUUID();
  await publishWheel(f.database, f.admin, f.eventId, 1, { segments: [
    { id: prizeId, kind: "prize", name: { th: "ปากกา", en: "Pen" }, imageId: null, enabled: true, position: 0, initialQuantity: 10 },
    { id: crypto.randomUUID(), kind: "no_prize", name: { th: "เสียใจด้วย", en: "Try again" }, imageId: null, enabled: true, position: 1 },
  ] });
  const [clock] = await f.client`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date::text AS day`;
  await editDayWindow(f.database, f.admin, f.eventId, { date: clock.day, startAt: `${clock.day}T00:00:00+07:00`,
    endAt: `${clock.day}T23:59:59.999+07:00`, expectedVersion: null, reason: null });
  const batch = await createQrBatch(f.database, f.admin, f.eventId, { date: clock.day, names: ["QR-A", "QR-B", "QR-C"], idempotencyKey: crypto.randomUUID() });
  const setup = () => readAttendanceReadiness(f.database, f.eventId, f.mainSessionId).then(readiness =>
    setupWheelAttendance(f.database, f.admin, f.eventId, { mainSessionId: f.mainSessionId,
      expectedReadinessRevision: readiness.revision, reason: "Synthetic full flow", idempotencyKey: crypto.randomUUID() }));
  const app = Fastify();
  app.addHook("onRequest", async request => { (request as unknown as { user: typeof f.admin }).user = f.admin; });
  await app.register(checkinRoutes, { prefix: "/checkins", database: f.database });
  const [registration] = await f.client`SELECT reg_code FROM registrations WHERE id=${f.registrationId}`;
  const scan = async () => {
    const response = await app.inject({ method: "POST", url: "/checkins", payload: { regCode: registration.reg_code, sessionId: f.mainSessionId } });
    assert.equal(response.statusCode, 200); return response.json().checkedInSession;
  };
  const actor = { id: f.userId };
  const spin = async () => {
    const state = await readAdminWheelState(f.database, f.admin, f.eventId);
    const [day] = await f.client`SELECT version FROM lucky_wheel_days WHERE wheel_id=${f.wheelId} AND play_date=${clock.day}::date`;
    return createSpin(f.database, actor, { eventId: f.eventId, configurationVersion: state.wheel.version,
      poolRevision: state.wheel.poolRevision, scheduleVersion: day.version, idempotencyKey: crypto.randomUUID() }, () => 0);
  };
  return { ...f, prizeId, day: clock.day, qrs: batch.qrCodes, setup, scan, spin, actor,
    async cleanup() { await app.close(); await f.cleanup(); } };
}

test("audited setup, real scan, two shared QR credits and spins preserve ownership/stock under cancellation", { timeout: 60_000 }, async t => {
  const oldKey = process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
  process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  t.after(() => { if (oldKey === undefined) delete process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY; else process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = oldKey; });
  const f = await prepare(); t.after(() => f.cleanup());
  const [a, b, c] = f.qrs;
  const open = (id: string) => setQrStatus(f.database, f.admin, f.eventId, id, { status: "open", idempotencyKey: crypto.randomUUID() });
  const pause = (paused: boolean) => setWheelPaused(f.database, f.admin, f.eventId, paused, "Synthetic verification", crypto.randomUUID());
  const claim = (id: string) => claimQrCredit(f.database, f.actor, f.eventId, id);
  assert.equal((await getEligibility(f.database, f.actor, f.eventId)).blockCode, "ATTENDANCE_SETUP_REQUIRED");
  await rejectsCode(open(a.id), "ATTENDANCE_SETUP_REQUIRED");
  await rejectsCode(pause(false), "ATTENDANCE_SETUP_REQUIRED");
  await rejectsCode(claim(a.id), "ATTENDANCE_SETUP_REQUIRED");
  await f.setup();
  const [empty] = await f.client`SELECT count(*)::int AS count FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
  assert.equal(empty.count, 0);
  let attendance = await f.scan();
  await pause(false); await open(a.id); await open(b.id);
  const projection = await readQrProjection(f.database, f.admin, f.eventId, c.id);
  assert.equal(projection.status, "closed"); assert.ok(projection.qrDataUrl.startsWith("data:image/png"));
  await rejectsCode(claim(c.id), "WHEEL_NOT_READY");
  await pause(true); await rejectsCode(claim(a.id), "WHEEL_PAUSED"); await pause(false);
  const first = await claim(a.id); assert.equal(first.created, true);
  assert.equal((await claim(a.id)).creditId, first.creditId);
  const second = await claim(b.id); assert.equal(second.created, true);
  const [clock] = await f.client`SELECT extract(hour FROM clock_timestamp() AT TIME ZONE 'Asia/Bangkok')<12 AS morning`;
  await editDayWindow(f.database, f.admin, f.eventId, { date: f.day,
    startAt: `${f.day}T${clock.morning ? "18" : "00"}:00:00+07:00`,
    endAt: `${f.day}T${clock.morning ? "19" : "01"}:00:00+07:00`, expectedVersion: 1, reason: "Synthetic temporary closure" });
  await rejectsCode(f.spin(), "DAY_WINDOW_CLOSED");
  assert.equal((await claim(a.id)).state, "outside_window");
  await rejectsCode(claim(c.id), "SESSION_CLOSED");
  await editDayWindow(f.database, f.admin, f.eventId, { date: f.day, startAt: `${f.day}T00:00:00+07:00`,
    endAt: `${f.day}T24:00:00+07:00`, expectedVersion: 2, reason: "Synthetic resume" });
  assert.equal((await claim(a.id)).creditId, first.creditId);
  await cancelDailyCheckin(f.database, { attendanceId: attendance.attendanceId, actor: f.admin, reason: "Synthetic wrong scan" });
  await rejectsCode(f.spin(), "CHECKIN_REQUIRED");
  attendance = await f.scan();
  assert.equal((await claim(a.id)).creditId, first.creditId);
  const stockBefore = await f.client`SELECT remaining FROM lucky_wheel_segments WHERE id=${f.prizeId}`;
  // Fixture-only exhaustion: production stock API intentionally supports top-ups only.
  await f.client`UPDATE lucky_wheel_segments SET remaining=0 WHERE id=${f.prizeId}`;
  await rejectsCode(f.spin(), "OUT_OF_STOCK");
  await adjustStock(f.database, f.admin, f.eventId, f.prizeId, stockBefore[0].remaining, "Synthetic restock", crypto.randomUUID());
  const spin1 = await f.spin(); const spin2 = await f.spin();
  assert.notEqual(spin1.spin.creditClaimId, spin2.spin.creditClaimId);
  await rejectsCode(f.spin(), "NO_CREDIT");
  await cancelDailyCheckin(f.database, { attendanceId: attendance.attendanceId, actor: f.admin, reason: "Synthetic post-spin cancellation" });
  const [counts] = await f.client`SELECT
    (SELECT count(*) FROM lucky_wheel_spins WHERE event_id=${f.eventId})::int AS spins,
    (SELECT count(*) FROM lucky_wheel_credit_claims WHERE event_id=${f.eventId} AND spent_at IS NOT NULL)::int AS spent,
    (SELECT remaining FROM lucky_wheel_segments WHERE id=${f.prizeId}) AS remaining`;
  assert.deepEqual(counts, { spins: 2, spent: 2, remaining: 8 });
  const duplicates = await f.client`SELECT qr_id,user_id FROM lucky_wheel_credit_claims WHERE event_id=${f.eventId} GROUP BY qr_id,user_id HAVING count(*)>1`;
  assert.equal(duplicates.length, 0);
  const [invariants] = await f.client`SELECT
    (SELECT count(*) FROM (SELECT registration_session_id,attendance_date FROM session_daily_checkins
      WHERE registration_session_id=${f.entitlementId} AND cancelled_at IS NULL GROUP BY 1,2 HAVING count(*)>1) d)::int AS daily_duplicates,
    (SELECT count(*) FROM (SELECT credit_claim_id FROM lucky_wheel_spins WHERE event_id=${f.eventId}
      GROUP BY 1 HAVING count(*)>1) d)::int AS duplicate_spends,
    (SELECT count(*) FROM lucky_wheel_segments WHERE wheel_id=${f.wheelId} AND remaining<0)::int AS negative_stock,
    (SELECT count(*) FROM registration_sessions WHERE registration_id=${f.registrationId})::int AS entitlements`;
  assert.deepEqual(invariants, { daily_duplicates: 0, duplicate_spends: 0, negative_stock: 0, entitlements: 2 });
  const [audit] = await f.client`SELECT count(*)::int AS count FROM lucky_wheel_audit_events WHERE event_id=${f.eventId} AND operation='attendance_setup'`;
  assert.equal(audit.count, 1);
  assert.equal(bangkokDay(new Date("2026-10-05T16:59:59.999Z")), "2026-10-05");
  assert.equal(bangkokDay(new Date("2026-10-05T17:00:00.000Z")), "2026-10-06");
});

test("evidenced legacy import permits owned QR claim without another scan and preserves ticket/source", async t => {
  const f = await prepare(); t.after(() => f.cleanup());
  await f.client`UPDATE registration_sessions SET checked_in_at=clock_timestamp() AT TIME ZONE 'UTC',checked_in_by=${f.admin.id} WHERE id=${f.entitlementId}`;
  const [before] = await f.client`SELECT checked_in_at::text AS instant,checked_in_by,ticket_type_id FROM registration_sessions WHERE id=${f.entitlementId}`;
  const result = await f.setup(); assert.equal(result.importedCount, 1);
  await setWheelPaused(f.database, f.admin, f.eventId, false, "Synthetic imported flow", crypto.randomUUID());
  await setQrStatus(f.database, f.admin, f.eventId, f.qrs[0].id, { status: "open", idempotencyKey: crypto.randomUUID() });
  assert.equal((await claimQrCredit(f.database, f.actor, f.eventId, f.qrs[0].id)).created, true);
  const [after] = await f.client`SELECT checked_in_at::text AS instant,checked_in_by,ticket_type_id FROM registration_sessions WHERE id=${f.entitlementId}`;
  assert.deepEqual(after, before);
});
