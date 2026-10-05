import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createAttendanceFixture } from "../attendance/readiness-test-fixture.js";
import { readAttendanceReadiness } from "../attendance/readiness.js";
import { luckyWheelAdminRoutes } from "./routes.js";

test("attendance setup route uses strict input, active authenticated admin and durable replay", async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  const app = Fastify(); t.after(() => app.close());
  await app.register(rateLimit, { global: false });
  let actor: { id: number; role: string; email?: string } | null = f.admin;
  app.addHook("onRequest", async request => { (request as unknown as { user: typeof actor }).user = actor; });
  await app.register(luckyWheelAdminRoutes, { prefix: "/api/backoffice/lucky-wheel", database: f.database });
  const url = `/api/backoffice/lucky-wheel/events/${f.eventId}/attendance-setup`;
  const body = { mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Reviewed setup", idempotencyKey: crypto.randomUUID() };
  const submit = (payload = body) => app.inject({ method: "POST", url, payload });
  actor = null; assert.equal((await submit()).statusCode, 401);
  actor = { ...f.admin, role: "staff" }; assert.equal((await submit()).statusCode, 403);
  actor = f.admin;
  await f.client`UPDATE backoffice_users SET is_active=false WHERE id=${f.admin.id}`;
  assert.equal((await submit()).statusCode, 403);
  await f.client`UPDATE backoffice_users SET is_active=true WHERE id=${f.admin.id}`;
  for (const payload of [{ ...body, userId: f.userId }, { ...body, reason: " " },
    { ...body, expectedReadinessRevision: "bad" }, { ...body, idempotencyKey: "bad" },
    { ...body, mainSessionId: -1 }, { ...body, checkedInAt: "2026-10-05" }]) {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 400);
  }
  const created = await submit(); assert.equal(created.statusCode, 201);
  assert.equal(created.headers["cache-control"], "no-store");
  assert.equal(created.json().importedCount, 0);
  const replay = await submit(); assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().auditId, created.json().auditId);
  const state = await app.inject({ method: "GET", url: `/api/backoffice/lucky-wheel/events/${f.eventId}` });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().attendanceReadiness.setupComplete, true);
  const [audit] = await f.client`SELECT actor_backoffice_user_id FROM lucky_wheel_audit_events WHERE id=${created.json().auditId}`;
  assert.equal(audit.actor_backoffice_user_id, f.admin.id);
});
