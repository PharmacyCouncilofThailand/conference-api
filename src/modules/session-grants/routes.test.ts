import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { closeDatabase } from "../../database/index.js";
import sessionGrantRoutes, { type SessionGrantRouteOptions } from "./routes.js";
import type { GrantBatchDto, GrantDatabase } from "./types.js";
import { GrantError } from "./types.js";

function batch(batchId: string, sessionId = 12): GrantBatchDto {
  return {
    batchId,
    sessionId,
    eventId: 3,
    requestedCount: 1,
    addedCount: 1,
    invitedCount: 0,
    skippedCount: 0,
    currentEnrollmentCount: 1,
    reservedCount: 0,
    occupiedCount: 1,
    seatsRemaining: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    results: [],
    emailCounts: {
      not_applicable: 0,
      pending: 1,
      sending: 0,
      sent: 0,
      failed: 0,
      unknown: 0,
      suppressed: 0,
    },
    pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
  };
}

test("session grant routes enforce auth/admin/flag/validation and preserve replay status", async (t) => {
  const originalFlag = process.env.ADMIN_SESSION_GRANTS_ENABLED;
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "true";
  const initialKey = randomUUID();
  const replayKey = randomUUID();
  const missingBatchId = randomUUID();
  const existingBatchId = randomUUID();
  let createCalls = 0;
  let retryCalls = 0;
  let lastActorId: number | null = null;

  const options: SessionGrantRouteOptions = {
    database: {} as GrantDatabase,
    createGrantFn: async (_database, input) => {
      createCalls += 1;
      lastActorId = input.actorId;
      if (input.sessionId === 99) {
        throw new GrantError(409, "SESSION_ENDED", "Session has ended");
      }
      return {
        replayed: input.idempotencyKey === replayKey,
        batch: batch(existingBatchId, input.sessionId),
      };
    },
    getGrantBatchFn: async (_database, batchId) =>
      batchId === missingBatchId ? null : batch(batchId),
    retryGrantEmailsFn: async (_database, input) => {
      retryCalls += 1;
      lastActorId = input.actorId;
      return { queued: input.itemIds, skipped: [] };
    },
  };

  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    const role = request.headers["x-test-role"];
    if (typeof role === "string") {
      (request as any).user = { id: 7, role };
    }
  });
  await app.register(sessionGrantRoutes, options);
  await app.ready();

  t.after(async () => {
    if (originalFlag === undefined) delete process.env.ADMIN_SESSION_GRANTS_ENABLED;
    else process.env.ADMIN_SESSION_GRANTS_ENABLED = originalFlag;
    await app.close();
    await closeDatabase();
  });

  const noAuth = await app.inject({
    method: "POST",
    url: "/",
    headers: { "idempotency-key": initialKey },
    payload: { sessionId: 12, registrationIds: [1] },
  });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(createCalls, 0);

  const nonAdmin = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "editor", "idempotency-key": initialKey },
    payload: { sessionId: 12, registrationIds: [1] },
  });
  assert.equal(nonAdmin.statusCode, 403);
  assert.equal(createCalls, 0);

  process.env.ADMIN_SESSION_GRANTS_ENABLED = "false";
  const disabled = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "admin", "idempotency-key": initialKey },
    payload: { sessionId: 12, registrationIds: [1] },
  });
  assert.equal(disabled.statusCode, 503);
  assert.equal(createCalls, 0);
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "true";

  const badKey = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "admin", "idempotency-key": "not-a-uuid" },
    payload: { sessionId: 12, registrationIds: [1] },
  });
  assert.equal(badKey.statusCode, 400);
  assert.equal(createCalls, 0);

  const spoofActor = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "admin", "idempotency-key": initialKey },
    payload: { sessionId: 12, registrationIds: [1], actorId: 999 },
  });
  assert.equal(spoofActor.statusCode, 400);
  assert.equal(createCalls, 0);

  const initial = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "admin", "idempotency-key": initialKey },
    payload: { sessionId: 12, registrationIds: [1] },
  });
  assert.equal(initial.statusCode, 201);
  assert.equal(lastActorId, 7);
  assert.equal(createCalls, 1);

  const replay = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "admin", "idempotency-key": replayKey },
    payload: { sessionId: 12, registrationIds: [1] },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(createCalls, 2);

  const stale = await app.inject({
    method: "POST",
    url: "/",
    headers: { "x-test-role": "admin", "idempotency-key": randomUUID() },
    payload: { sessionId: 99, registrationIds: [1] },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "SESSION_ENDED");

  const invalidBatch = await app.inject({
    method: "GET",
    url: "/not-a-uuid",
    headers: { "x-test-role": "admin" },
  });
  assert.equal(invalidBatch.statusCode, 400);

  const missingBatch = await app.inject({
    method: "GET",
    url: `/${missingBatchId}`,
    headers: { "x-test-role": "admin" },
  });
  assert.equal(missingBatch.statusCode, 404);

  const foundBatch = await app.inject({
    method: "GET",
    url: `/${existingBatchId}?page=1&limit=50`,
    headers: { "x-test-role": "admin" },
  });
  assert.equal(foundBatch.statusCode, 200);
  assert.equal(foundBatch.json().batchId, existingBatchId);

  const retryItemId = randomUUID();
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "false";
  const disabledRetry = await app.inject({
    method: "POST",
    url: `/${existingBatchId}/retry`,
    headers: { "x-test-role": "admin" },
    payload: { itemIds: [retryItemId], acknowledgeUnknown: false },
  });
  assert.equal(disabledRetry.statusCode, 503);
  assert.equal(retryCalls, 0);

  process.env.ADMIN_SESSION_GRANTS_ENABLED = "true";
  const nonAdminRetry = await app.inject({
    method: "POST",
    url: `/${existingBatchId}/retry`,
    headers: { "x-test-role": "editor" },
    payload: { itemIds: [retryItemId], acknowledgeUnknown: false },
  });
  assert.equal(nonAdminRetry.statusCode, 403);
  assert.equal(retryCalls, 0);

  const retry = await app.inject({
    method: "POST",
    url: `/${existingBatchId}/retry`,
    headers: { "x-test-role": "admin" },
    payload: { itemIds: [retryItemId], acknowledgeUnknown: true },
  });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json().queued, [retryItemId]);
  assert.equal(retryCalls, 1);
  assert.equal(lastActorId, 7);
});
