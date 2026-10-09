import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { closeDatabase } from "../../database/index.js";
import sessionGrantRoutes from "./routes.js";
import type { GrantDatabase, GrantTrackingDto, GrantTrackingQuery } from "./types.js";

test("tracking requires Admin, validates before reading, and remains readable with grants disabled", async (t) => {
  const original = process.env.ADMIN_SESSION_GRANTS_ENABLED;
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "false";
  let calls = 0;
  let failure = false;
  let received: GrantTrackingQuery | undefined;
  const result: GrantTrackingDto = {
    items: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    summary: {
      total: 0, outcomeCounts: { added: 0, invited: 0, skipped: 0 },
      invitationCounts: { pending: 0, accepted: 0, declined: 0, expired: 0, revoked: 0 },
      emailCounts: { not_applicable: 0, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 },
    },
  };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    const role = request.headers["x-test-role"];
    if (typeof role === "string") (request as any).user = { id: 7, role };
  });
  await app.register(sessionGrantRoutes, {
    database: {} as GrantDatabase,
    getGrantTrackingFn: async (_database: GrantDatabase, query: GrantTrackingQuery) => {
      calls++; received = query;
      if (failure) throw new Error("must-not-leak-internal-details");
      return result;
    },
  });
  t.after(async () => {
    if (original === undefined) delete process.env.ADMIN_SESSION_GRANTS_ENABLED;
    else process.env.ADMIN_SESSION_GRANTS_ENABLED = original;
    await app.close();
    await closeDatabase();
  });
  assert.equal((await app.inject({ method: "GET", url: "/tracking" })).statusCode, 401);
  for (const role of ["organizer", "reviewer", "staff", "verifier", "team_registration_viewer"]) {
    assert.equal((await app.inject({ method: "GET", url: "/tracking", headers: { "x-test-role": role } })).statusCode, 403);
  }
  assert.equal(calls, 0);
  for (const query of ["limit=101", "responseStatus=sent", "eventId=-1", "sessionId=1.5", "emailStatus=delivered"]) {
    const invalid = await app.inject({ method: "GET", url: `/tracking?${query}`, headers: { "x-test-role": "admin" } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, "INVALID_QUERY");
  }
  assert.equal(calls, 0);
  const response = await app.inject({ method: "GET", url: "/tracking?eventId=4&responseStatus=not_required", headers: { "x-test-role": "admin" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), result);
  assert.deepEqual(received, { page: 1, limit: 50, eventId: 4, responseStatus: "not_required" });
  assert.equal((await app.inject({ method: "POST", url: `/${randomUUID()}/retry`, headers: { "x-test-role": "admin" },
    payload: { itemIds: [randomUUID()], acknowledgeUnknown: true } })).statusCode, 503);
  failure = true;
  const failed = await app.inject({ method: "GET", url: "/tracking", headers: { "x-test-role": "admin" } });
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().code, "SESSION_GRANT_TRACKING_FAILED");
  assert.equal(failed.body.includes("must-not-leak"), false);
});
