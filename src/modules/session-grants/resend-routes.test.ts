import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { closeDatabase } from "../../database/index.js";
import sessionGrantRoutes, { type SessionGrantRouteOptions } from "./routes.js";
import { GrantError, type GrantDatabase } from "./types.js";

test("resend routes enforce Admin, flag, strict validation, replay status and private errors", async t => {
  const original = process.env.ADMIN_SESSION_GRANTS_ENABLED;
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "true";
  const requestId = randomUUID();
  const invitationId = randomUUID();
  const key = randomUUID();
  let calls = 0;
  const result = { requestId, sessionId: 7, requestedCount: 1, queued: [{ invitationId, itemId: randomUUID() }], skipped: [] };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async request => { if (request.headers["x-role"]) (request as any).user = { id: 12, role: request.headers["x-role"] }; });
  const options: SessionGrantRouteOptions = {
    database: {} as GrantDatabase,
    previewInvitationResendsFn: async () => ({ emails: [], skipped: [] }),
    queueInvitationResendsFn: async (_db, input) => {
      calls++;
      assert.equal(input.actorId, 12);
      if (input.sessionId === 9) throw new GrantError(409, "IDEMPOTENCY_KEY_MISMATCH", "Key mismatch");
      if (input.sessionId === 10) throw new Error("private-token-must-not-escape");
      return { replayed: calls > 1, result };
    },
    getResendOperationFn: async (_db, id, page, limit) => id === requestId ? { result, actorId: 12, createdAt: new Date(0).toISOString(), entries: [],
      summary: { waiting: 1, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 }, pagination: { page, limit, total: 1, totalPages: 1 } } : null,
  };
  await app.register(sessionGrantRoutes, options);
  t.after(async () => { if (original === undefined) delete process.env.ADMIN_SESSION_GRANTS_ENABLED; else process.env.ADMIN_SESSION_GRANTS_ENABLED = original; await app.close(); await closeDatabase(); });
  const body = { sessionId: 7, invitationIds: [invitationId] };
  for (const url of ["/resend", "/resend-preview", `/resends/${requestId}`]) {
    for (const [role, expected] of [[undefined, 401], ["staff", 403]] as const) {
      const response = await app.inject({ method: url.includes("/resends/") ? "GET" : "POST", url, headers: role ? { "x-role": role } : {}, ...(url.includes("/resends/") ? {} : { payload: body }) });
      assert.equal(response.statusCode, expected);
      assert.equal(response.headers["cache-control"], "no-store");
    }
  }
  const headers = { "x-role": "admin", "idempotency-key": key };
  const malformedJson = await app.inject({ method: "POST", url: "/resend", headers: { ...headers, "content-type": "application/json" }, payload: "{" });
  assert.equal(malformedJson.statusCode, 400);
  assert.equal(malformedJson.headers["cache-control"], "no-store");
  for (const payload of [{ ...body, actorId: 99 }, { ...body, invitationIds: [] }, { ...body, invitationIds: ["bad"] }, { ...body, invitationIds: Array(501).fill(invitationId) }]) {
    assert.equal((await app.inject({ method: "POST", url: "/resend", headers, payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: "/resend", headers: { "x-role": "admin" }, payload: body })).statusCode, 400);
  for (const expected of [202, 200]) {
    const response = await app.inject({ method: "POST", url: "/resend", headers, payload: body });
    assert.equal(response.statusCode, expected);
    assert.deepEqual(response.json(), result);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal((await app.inject({ method: "POST", url: "/resend", headers, payload: { ...body, sessionId: 9 } })).statusCode, 409);
  const failure = await app.inject({ method: "POST", url: "/resend", headers, payload: { ...body, sessionId: 10 } });
  assert.equal(failure.statusCode, 500);
  assert.ok(!failure.body.includes("private-token"));
  assert.equal((await app.inject({ method: "POST", url: "/resend-preview", headers, payload: body })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/resends/${requestId}?limit=100&page=2`, headers })).json().pagination.limit, 100);
  for (const suffix of ["?limit=101", "?page=0", "?secret=true"]) assert.equal((await app.inject({ method: "GET", url: `/resends/${requestId}${suffix}`, headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/resends/${randomUUID()}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/resends/bad", headers })).statusCode, 400);
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "false";
  for (const url of ["/resend", "/resend-preview", `/resends/${requestId}`]) {
    const response = await app.inject({ method: url.includes("/resends/") ? "GET" : "POST", url, headers, ...(url.includes("/resends/") ? {} : { payload: body }) });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const status = await app.inject({ method: "GET", url: "/status", headers });
  assert.deepEqual(status.json(), { enabled: false, resendSupported: true });
});


