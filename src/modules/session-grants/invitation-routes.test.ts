import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { closeDatabase } from "../../database/index.js";
import invitationRoutes, {
  redactInvitationRequestUrl,
  type InvitationRouteOptions,
} from "./invitation-routes.js";
import type {
  GrantDatabase,
  InvitationDecision,
  InvitationStatus,
  PublicInvitationDto,
} from "./types.js";
import { GrantError } from "./types.js";

function invitation(status: InvitationStatus = "pending"): PublicInvitationDto {
  return {
    invitationId: "11111111-1111-4111-8111-111111111111",
    status,
    respondedAt: status === "accepted" || status === "declined"
      ? "2026-10-01T00:00:00.000Z"
      : null,
    effectiveDeadline: "2026-10-29T06:00:00.000Z",
    recipientFirstName: "Synthetic",
    session: {
      sessionName: "Policy Innovation Workshop",
      sessionType: "workshop",
      startTime: "2026-10-29T06:00:00.000Z",
      endTime: "2026-10-29T10:00:00.000Z",
      room: "Synthetic Room",
    },
  };
}

test("public invitation routes enforce scoped bearer, strict body, safe errors and no-store", async (t) => {
  let lookupCalls = 0;
  let respondCalls = 0;
  let lastToken: string | null = null;
  let lastDecision: InvitationDecision | null = null;
  const successToken = "a".repeat(64);
  const expiredToken = "b".repeat(64);
  const failureToken = "c".repeat(64);

  const options: InvitationRouteOptions = {
    database: {} as GrantDatabase,
    lookupInvitationFn: async (_database, token) => {
      lookupCalls += 1;
      lastToken = token;
      if (token === expiredToken) {
        const expired = invitation("expired");
        throw new GrantError(
          410,
          "INVITATION_EXPIRED",
          "Invitation has expired",
          { invitation: expired },
        );
      }
      if (token === failureToken) {
        throw new Error(`private failure ${token}`);
      }
      return invitation("pending");
    },
    respondToInvitationFn: async (_database, token, decision) => {
      respondCalls += 1;
      lastToken = token;
      lastDecision = decision;
      if (decision === "declined") {
        const recorded = invitation("accepted");
        throw new GrantError(
          409,
          "RESPONSE_ALREADY_RECORDED",
          "Invitation response was already recorded",
          { invitation: recorded },
        );
      }
      return invitation("accepted");
    },
  };

  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
  });
  await app.register(invitationRoutes, options);
  await app.ready();

  t.after(async () => {
    await app.close();
    await closeDatabase();
  });

  const missing = await app.inject({
    method: "GET",
    url: "/current",
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().code, "INVALID_INVITATION_TOKEN");
  assert.equal(missing.headers["cache-control"], "no-store");
  assert.equal(lookupCalls, 0);

  const normalJwt = await app.inject({
    method: "GET",
    url: "/current",
    headers: { authorization: "Bearer header.payload.signature" },
  });
  assert.equal(normalJwt.statusCode, 401);
  assert.equal(lookupCalls, 0);

  const extraBearer = await app.inject({
    method: "GET",
    url: "/current",
    headers: { authorization: `Bearer ${successToken} extra` },
  });
  assert.equal(extraBearer.statusCode, 401);
  assert.equal(lookupCalls, 0);

  const lookup = await app.inject({
    method: "GET",
    url: "/current",
    headers: { authorization: `Bearer ${successToken}` },
  });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.headers["cache-control"], "no-store");
  assert.equal(lookup.json().status, "pending");
  assert.equal(lastToken, successToken);
  assert.equal(lookupCalls, 1);

  const expired = await app.inject({
    method: "GET",
    url: "/current",
    headers: { authorization: `Bearer ${expiredToken}` },
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.headers["cache-control"], "no-store");
  assert.equal(expired.json().code, "INVITATION_EXPIRED");
  assert.equal(expired.json().invitation.status, "expired");

  const accepted = await app.inject({
    method: "PUT",
    url: "/current/response",
    headers: {
      authorization: `Bearer ${successToken}`,
      "content-type": "application/json",
    },
    payload: { decision: "accepted" },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(accepted.json().status, "accepted");
  assert.equal(lastDecision, "accepted");
  assert.equal(respondCalls, 1);

  const extraBody = await app.inject({
    method: "PUT",
    url: "/current/response",
    headers: {
      authorization: `Bearer ${successToken}`,
      "content-type": "application/json",
    },
    payload: { decision: "accepted", registrationId: 999 },
  });
  assert.equal(extraBody.statusCode, 400);
  assert.equal(extraBody.headers["cache-control"], "no-store");
  assert.equal(respondCalls, 1);

  const conflict = await app.inject({
    method: "PUT",
    url: "/current/response",
    headers: {
      authorization: `Bearer ${successToken}`,
      "content-type": "application/json",
    },
    payload: { decision: "declined" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "RESPONSE_ALREADY_RECORDED");
  assert.equal(conflict.json().invitation.status, "accepted");
  assert.equal(respondCalls, 2);

  const unexpected = await app.inject({
    method: "GET",
    url: "/current",
    headers: { authorization: `Bearer ${failureToken}` },
  });
  assert.equal(unexpected.statusCode, 500);
  assert.equal(unexpected.json().code, "SESSION_INVITATION_REQUEST_FAILED");
  assert.equal(unexpected.body.includes(failureToken), false);
  assert.equal(unexpected.headers["cache-control"], "no-store");

  const oversized = await app.inject({
    method: "PUT",
    url: "/current/response",
    headers: {
      authorization: `Bearer ${successToken}`,
      "content-type": "application/json",
    },
    payload: {
      decision: "accepted",
      padding: "x".repeat(2_000),
    },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.headers["cache-control"], "no-store");
  assert.equal(respondCalls, 2);

  const unsupported = await app.inject({
    method: "POST",
    url: "/current/response",
    headers: { authorization: `Bearer ${successToken}` },
    payload: { decision: "accepted" },
  });
  assert.ok([404,405].includes(unsupported.statusCode));

  assert.equal(
    redactInvitationRequestUrl(
      "/api/session-invitations/current?token=secret-value&foo=1",
    ),
    "/api/session-invitations/current?foo=1",
  );
  assert.equal(
    redactInvitationRequestUrl("/api/events?token=not-invitation-route"),
    "/api/events?token=not-invitation-route",
  );
});

test("public invitation GET and PUT share a 30 per-minute rate-limit budget", async (t) => {
  const token = "d".repeat(64);
  const options: InvitationRouteOptions = {
    database: {} as GrantDatabase,
    lookupInvitationFn: async () => invitation("pending"),
    respondToInvitationFn: async () => invitation("accepted"),
  };
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
  });
  await app.register(invitationRoutes, options);
  await app.ready();
  t.after(async () => app.close());

  const statuses: number[] = [];
  for (let index = 0; index < 31; index += 1) {
    const response =
      index % 2 === 0
        ? await app.inject({
            method: "GET",
            url: "/current",
            headers: { authorization: `Bearer ${token}` },
          })
        : await app.inject({
            method: "PUT",
            url: "/current/response",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            payload: { decision: "accepted" },
          });
    statuses.push(response.statusCode);
    if (response.statusCode === 429) {
      assert.equal(response.headers["cache-control"], "no-store");
    }
  }
  assert.equal(statuses.filter((status) => status === 429).length, 1);
});
