import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  luckyWheelAdminRoutes,
  luckyWheelAttendeeRoutes,
  type LuckyWheelRouteOptions,
} from "./routes.js";
import type { WheelDatabase } from "./service.js";

const configuration = {
  segments: [{
    id: "00000000-0000-4000-8000-000000000101",
    kind: "prize" as const,
    name: { th: "ปากกา", en: "Pen" },
    imageId: null,
    enabled: true,
    position: 0,
  }],
  collectionInstructions: { th: "รับที่จุดกิจกรรม", en: "Collect at activity desk" },
  collectionDeadline: "2026-10-30T10:00:00.000Z",
};

test("lucky wheel routes use authenticated server actors, strict bodies, admin DB guard and no-store", async (t) => {
  let publishCalls = 0;
  let stockCalls = 0;
  let pauseCalls = 0;
  let stateCalls = 0;
  let historyCalls = 0;
  let lastHistoryQuery: unknown = null;
  let eligibilityCalls = 0;
  let spinCalls = 0;
  let ownHistoryCalls = 0;
  let lastOwnHistory: { userId: number; eventId: number; page: number; pageSize: number } | null = null;
  let ownSpinCalls = 0;
  let lookupCalls = 0;
  let confirmCalls = 0;
  let correctionCalls = 0;
  let lastAttendeeId: number | null = null;

  const options: LuckyWheelRouteOptions = {
    database: {} as WheelDatabase,
    validateAdminActorFn: async (_db, actor) =>
      actor.id === 7 && actor.role === "admin" && actor.email === "admin@example.invalid"
        ? { id: 7, role: "admin", email: actor.email }
        : null,
    publishWheelFn: async (_db, actor, eventId, expectedVersion, supplied) => {
      publishCalls += 1;
      assert.equal(actor.id, 7);
      assert.equal(eventId, 3);
      assert.equal(expectedVersion, 1);
      assert.deepEqual(supplied, configuration);
      return { eventId, version: 2, poolRevision: 1, paused: false, configuration: supplied, replayed: false };
    },
    adjustStockFn: async (_db, actor, eventId, segmentId, delta, reason, idempotencyKey) => {
      stockCalls += 1;
      assert.equal(actor.id, 7);
      return { eventId, segmentId, before: 0, after: delta, delta, reason, idempotencyKey, poolRevision: 2, replayed: false };
    },
    setWheelPausedFn: async (_db, actor, eventId, paused, reason, idempotencyKey) => {
      pauseCalls += 1;
      return { eventId, paused, reason, idempotencyKey: idempotencyKey ?? null, actorId: actor.id, replayed: false };
    },
    readAdminWheelStateFn: async (_db, actor, eventId) => {
      stateCalls += 1;
      return {
        eventId,
        actorId: actor.id,
        wheel: {
          id: "00000000-0000-4000-8000-000000000150",
          mainSessionId: 9,
          enabled: true,
          paused: false,
          version: 2,
          poolRevision: 3,
          configuration,
          collectionInstructions: configuration.collectionInstructions,
          collectionDeadline: configuration.collectionDeadline,
        },
        segments: [],
        audit: [],
      };
    },
    readAdminSpinsFn: async (_db, actor, eventId, query) => {
      historyCalls += 1;
      const parsedQuery = query ?? {};
      lastHistoryQuery = parsedQuery;
      return {
        eventId,
        actorId: actor.id,
        spins: [],
        pagination: {
          page: parsedQuery.page ?? 1,
          pageSize: parsedQuery.pageSize ?? 20,
          total: 0,
          totalPages: 0,
        },
      };
    },
    getEligibilityFn: async (_db, actor, eventId) => {
      eligibilityCalls += 1;
      lastAttendeeId = actor.id;
      return {
        eventId,
        userId: actor.id,
        eligible: true,
        blockCode: null,
        serverNow: "2026-10-29T04:00:00.000Z",
        playDate: "2026-10-29",
        configurationVersion: 2,
        poolRevision: 2,
        paused: false,
        configuration,
        availability: [],
        existingSpin: null,
      };
    },
    createSpinFn: async (_db, actor, input) => {
      spinCalls += 1;
      lastAttendeeId = actor.id;
      return {
        created: true,
        spin: {
          id: "00000000-0000-4000-8000-000000000102",
          eventId: input.eventId,
          userId: actor.id,
          playDate: "2026-10-29",
          attendanceId: "00000000-0000-4000-8000-000000000103",
          attendanceCheckedInAt: "2026-10-29T03:00:00.000Z",
          outcomeKind: "prize",
          segmentId: configuration.segments[0].id,
          awardedName: { th: "ปากกา", en: "Pen" },
          awardedImageKey: null,
          configurationVersion: input.configurationVersion,
          poolRevision: input.poolRevision,
          createdAt: "2026-10-29T04:00:00.000Z",
          configurationSnapshot: configuration,
          outcomeSnapshot: { segmentId: configuration.segments[0].id },
        },
      };
    },
    readOwnedSpinsFn: async (_db, userId, eventId, query) => {
      ownHistoryCalls += 1;
      const parsedQuery = query ?? {};
      lastOwnHistory = {
        userId,
        eventId,
        page: parsedQuery.page ?? 1,
        pageSize: parsedQuery.pageSize ?? 20,
      };
      return {
        eventId,
        items: [{
          spinId: "00000000-0000-4000-8000-000000000102",
          eventId,
          outcomeKind: "prize" as const,
          prize: {
            name: { th: "ปากกา", en: "Pen" },
            imageKey: null,
            awardedAt: "2026-10-29T04:00:00.000Z",
          },
          claimGeneration: 1,
          status: "open" as const,
          redeemedAt: null,
          redeemedBy: null,
          collectionPoint: null,
          deliveredDetails: null,
          collectionInstructions: configuration.collectionInstructions,
          collectionDeadline: configuration.collectionDeadline,
        }],
        pagination: {
          page: parsedQuery.page ?? 1,
          pageSize: parsedQuery.pageSize ?? 20,
          total: 1,
          totalPages: 1,
        },
      };
    },
    readOwnedSpinFn: async (_db, userId, eventId, spinId) => {
      ownSpinCalls += 1;
      return {
        eventId,
        spinId,
        owner: { id: userId, firstName: "Test", lastName: "Owner", email: "person@example.invalid" },
        prize: { name: { th: "ปากกา", en: "Pen" }, imageKey: null, awardedAt: "2026-10-29T04:00:00.000Z" },
        claimGeneration: 1,
        status: "open" as const,
        redeemedAt: null,
        redeemedBy: null,
        collectionPoint: null,
        deliveredDetails: null,
        collectionInstructions: configuration.collectionInstructions,
        collectionDeadline: configuration.collectionDeadline,
        rewardProof: { qrPayload: `PRIS-REWARD:${"a".repeat(64)}`, displayCode: "A1B2-C3D4-E5F6-7890-ABCD" },
      };
    },
    lookupRewardFn: async (_db, actor, eventId, credential) => {
      lookupCalls += 1;
      assert.equal(actor.id, 7);
      assert.match(credential, /^PRIS-REWARD:/);
      return {
        eventId,
        spinId: "00000000-0000-4000-8000-000000000102",
        owner: { id: 21, firstName: "Test", lastName: "Owner", email: "person@example.invalid" },
        prize: { name: { th: "ปากกา", en: "Pen" }, imageKey: null, awardedAt: "2026-10-29T04:00:00.000Z" },
        claimGeneration: 1,
        status: "open" as const,
        redeemedAt: null,
        redeemedBy: null,
        collectionPoint: null,
        deliveredDetails: null,
        collectionInstructions: configuration.collectionInstructions,
        collectionDeadline: configuration.collectionDeadline,
        lookedUpBy: "token" as const,
        actorId: actor.id,
      };
    },
    confirmRedemptionFn: async (_db, actor, input) => {
      confirmCalls += 1;
      return {
        eventId: input.eventId,
        spinId: input.spinId,
        claimGeneration: input.claimGeneration,
        status: "redeemed" as const,
        redeemedAt: "2026-10-29T05:00:00.000Z",
        redeemedBy: actor.id,
        collectionPoint: input.collectionPoint,
        deliveredDetails: input.deliveredDetails,
        idempotencyKey: input.idempotencyKey,
        replayed: false,
      };
    },
    correctRedemptionFn: async (_db, _actor, input) => {
      correctionCalls += 1;
      return {
        eventId: input.eventId,
        spinId: input.spinId,
        fromGeneration: input.claimGeneration,
        toGeneration: input.reopen ? input.claimGeneration + 1 : input.claimGeneration,
        reopen: input.reopen,
        reason: input.reason,
        correctedAt: "2026-10-29T05:30:00.000Z",
        replayed: false,
      };
    },
  };

  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.addHook("preHandler", async (request) => {
    const token = request.headers["x-test-token"];
    if (token === "admin") {
      (request as any).user = { id: 7, role: "admin", email: "admin@example.invalid" };
    } else if (token === "disabled-admin") {
      (request as any).user = { id: 8, role: "admin", email: "disabled@example.invalid" };
    } else if (token === "attendee") {
      (request as any).user = { id: 21, role: "general", email: "person@example.invalid" };
    }
  });
  await app.register(luckyWheelAdminRoutes, { prefix: "/backoffice", ...options });
  await app.register(luckyWheelAttendeeRoutes, { prefix: "/attendee", ...options });
  await app.ready();
  t.after(async () => app.close());

  const attendeePublish = await app.inject({
    method: "PUT",
    url: "/backoffice/events/3/publication",
    headers: { "x-test-token": "attendee" },
    payload: { expectedVersion: 1, configuration },
  });
  assert.equal(attendeePublish.statusCode, 403);
  assert.equal(publishCalls, 0);

  const disabledAdmin = await app.inject({
    method: "POST",
    url: "/backoffice/events/3/stock",
    headers: { "x-test-token": "disabled-admin" },
    payload: {
      segmentId: configuration.segments[0].id,
      delta: 5,
      reason: "เติมสต็อก",
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(disabledAdmin.statusCode, 403);
  assert.equal(stockCalls, 0);

  const attendeeHistory = await app.inject({
    method: "GET",
    url: "/backoffice/events/3/spins",
    headers: { "x-test-token": "attendee" },
  });
  assert.equal(attendeeHistory.statusCode, 403);
  assert.equal(historyCalls, 0);

  const adminState = await app.inject({
    method: "GET",
    url: "/backoffice/events/3",
    headers: { "x-test-token": "admin" },
  });
  assert.equal(adminState.statusCode, 200);
  assert.equal(adminState.headers["cache-control"], "no-store");
  assert.equal(adminState.json().wheel.version, 2);
  assert.equal(stateCalls, 1);

  const filteredHistory = await app.inject({
    method: "GET",
    url: `/backoffice/events/3/spins?date=2026-10-29&segmentId=${configuration.segments[0].id}&claimStatus=open&page=2&pageSize=25`,
    headers: { "x-test-token": "admin" },
  });
  assert.equal(filteredHistory.statusCode, 200);
  assert.equal(historyCalls, 1);
  assert.deepEqual(lastHistoryQuery, {
    date: "2026-10-29",
    segmentId: configuration.segments[0].id,
    claimStatus: "open",
    page: 2,
    pageSize: 25,
  });

  const invalidHistoryQuery = await app.inject({
    method: "GET",
    url: "/backoffice/events/3/spins?claimStatus=unknown&pageSize=1000",
    headers: { "x-test-token": "admin" },
  });
  assert.equal(invalidHistoryQuery.statusCode, 400);
  assert.equal(historyCalls, 1);

  const spoofPublish = await app.inject({
    method: "PUT",
    url: "/backoffice/events/3/publication",
    headers: { "x-test-token": "admin" },
    payload: { expectedVersion: 1, configuration, actorId: 999, remaining: 999 },
  });
  assert.equal(spoofPublish.statusCode, 400);
  assert.equal(publishCalls, 0);

  const publish = await app.inject({
    method: "PUT",
    url: "/backoffice/events/3/publication",
    headers: { "x-test-token": "admin" },
    payload: { expectedVersion: 1, configuration },
  });
  assert.equal(publish.statusCode, 200);
  assert.equal(publish.headers["cache-control"], "no-store");
  assert.equal(publishCalls, 1);

  const stockKey = randomUUID();
  const stock = await app.inject({
    method: "POST",
    url: "/backoffice/events/3/stock",
    headers: { "x-test-token": "admin" },
    payload: {
      segmentId: configuration.segments[0].id,
      delta: 5,
      reason: "เติมสต็อก",
      idempotencyKey: stockKey,
    },
  });
  assert.equal(stock.statusCode, 200);
  assert.equal(stockCalls, 1);

  const pause = await app.inject({
    method: "PUT",
    url: "/backoffice/events/3/pause",
    headers: { "x-test-token": "admin" },
    payload: { paused: true, reason: "พักชั่วคราว", idempotencyKey: randomUUID() },
  });
  assert.equal(pause.statusCode, 200);
  assert.equal(pauseCalls, 1);

  const unauthenticatedEligibility = await app.inject({
    method: "GET",
    url: "/attendee/events/3/eligibility",
  });
  assert.equal(unauthenticatedEligibility.statusCode, 401);
  assert.equal(eligibilityCalls, 0);

  const adminAsAttendee = await app.inject({
    method: "GET",
    url: "/attendee/events/3/eligibility",
    headers: { "x-test-token": "admin" },
  });
  assert.equal(adminAsAttendee.statusCode, 403);
  assert.equal(adminAsAttendee.json().code, "ACCOUNT_UNAVAILABLE");
  assert.equal(eligibilityCalls, 0);

  const eligibility = await app.inject({
    method: "GET",
    url: "/attendee/events/3/eligibility",
    headers: { "x-test-token": "attendee" },
  });
  assert.equal(eligibility.statusCode, 200);
  assert.equal(eligibility.headers["cache-control"], "no-store");
  assert.equal(lastAttendeeId, 21);

  const unauthenticatedOwnHistory = await app.inject({
    method: "GET",
    url: "/attendee/events/3/spins?page=1&pageSize=10",
  });
  assert.equal(unauthenticatedOwnHistory.statusCode, 401);
  assert.equal(ownHistoryCalls, 0);

  const adminOwnHistory = await app.inject({
    method: "GET",
    url: "/attendee/events/3/spins?page=1&pageSize=10",
    headers: { "x-test-token": "admin" },
  });
  assert.equal(adminOwnHistory.statusCode, 403);
  assert.equal(ownHistoryCalls, 0);

  const spoofOwnHistory = await app.inject({
    method: "GET",
    url: "/attendee/events/3/spins?page=1&pageSize=10&userId=999",
    headers: { "x-test-token": "attendee" },
  });
  assert.equal(spoofOwnHistory.statusCode, 400);
  assert.equal(ownHistoryCalls, 0);

  const ownHistory = await app.inject({
    method: "GET",
    url: "/attendee/events/3/spins?page=2&pageSize=5",
    headers: { "x-test-token": "attendee" },
  });
  assert.equal(ownHistory.statusCode, 200);
  assert.equal(ownHistory.headers["cache-control"], "no-store");
  assert.equal(ownHistoryCalls, 1);
  assert.deepEqual(lastOwnHistory, {
    userId: 21,
    eventId: 3,
    page: 2,
    pageSize: 5,
  });
  const ownHistoryBody = ownHistory.json();
  assert.equal(ownHistoryBody.items[0].outcomeKind, "prize");
  assert.equal("rewardProof" in ownHistoryBody.items[0], false);
  assert.equal("qrPayload" in ownHistoryBody.items[0], false);
  assert.equal("displayCode" in ownHistoryBody.items[0], false);

  const spoofSpin = await app.inject({
    method: "POST",
    url: "/attendee/events/3/spins",
    headers: { "x-test-token": "attendee" },
    payload: {
      eventId: 3,
      configurationVersion: 2,
      poolRevision: 2,
      idempotencyKey: randomUUID(),
      userId: 999,
      winner: configuration.segments[0].id,
      playedAt: new Date().toISOString(),
    },
  });
  assert.equal(spoofSpin.statusCode, 400);
  assert.equal(spinCalls, 0);

  const spin = await app.inject({
    method: "POST",
    url: "/attendee/events/3/spins",
    headers: { "x-test-token": "attendee" },
    payload: {
      eventId: 3,
      configurationVersion: 2,
      poolRevision: 2,
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(spin.statusCode, 201);
  assert.equal(spin.headers["cache-control"], "no-store");
  assert.equal(spin.json().spin.userId, 21);
  assert.equal(spinCalls, 1);

  const spinId = "00000000-0000-4000-8000-000000000102";
  const ownReward = await app.inject({
    method: "GET",
    url: `/attendee/events/3/spins/${spinId}`,
    headers: { "x-test-token": "attendee" },
  });
  assert.equal(ownReward.statusCode, 200);
  assert.equal(ownReward.json().claimGeneration, 1);
  assert.equal(ownSpinCalls, 1);

  const lookup = await app.inject({
    method: "POST",
    url: "/backoffice/events/3/reward-lookups",
    headers: { "x-test-token": "admin" },
    payload: { credential: `PRIS-REWARD:${"a".repeat(64)}` },
  });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookupCalls, 1);

  const redemptionPayload = {
    eventId: 3,
    spinId,
    claimGeneration: 1,
    idempotencyKey: randomUUID(),
    identityChecked: true,
    collectionPoint: "Activity desk",
    deliveredDetails: null,
  };
  const attendeeCannotRedeem = await app.inject({
    method: "PUT",
    url: `/backoffice/events/3/spins/${spinId}/redemption`,
    headers: { "x-test-token": "attendee" },
    payload: redemptionPayload,
  });
  assert.equal(attendeeCannotRedeem.statusCode, 403);
  assert.equal(confirmCalls, 0);

  const redeemed = await app.inject({
    method: "PUT",
    url: `/backoffice/events/3/spins/${spinId}/redemption`,
    headers: { "x-test-token": "admin" },
    payload: redemptionPayload,
  });
  assert.equal(redeemed.statusCode, 200);
  assert.equal(confirmCalls, 1);

  const corrected = await app.inject({
    method: "POST",
    url: `/backoffice/events/3/spins/${spinId}/redemption-corrections`,
    headers: { "x-test-token": "admin" },
    payload: {
      eventId: 3,
      spinId,
      claimGeneration: 1,
      reason: "Physical handover needs retry",
      reopen: true,
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(corrected.statusCode, 200);
  assert.equal(corrected.json().toGeneration, 2);
  assert.equal(correctionCalls, 1);
});

test("attendee wheel throttling is account-aware instead of venue-IP-wide", async (t) => {
  let calls = 0;
  const options: LuckyWheelRouteOptions = {
    database: {} as WheelDatabase,
    getEligibilityFn: async (_db, actor, eventId) => {
      calls += 1;
      return {
        eventId,
        userId: actor.id,
        eligible: true,
        blockCode: null,
        serverNow: "2026-10-29T04:00:00.000Z",
        playDate: "2026-10-29",
        configurationVersion: 1,
        poolRevision: 1,
        paused: false,
        configuration,
        availability: [],
        existingSpin: null,
      };
    },
  };

  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.addHook("preHandler", async (request) => {
    const raw = request.headers["x-test-user"];
    if (typeof raw === "string") {
      (request as any).user = {
        id: Number(raw),
        role: "general",
        email: `user-${raw}@example.invalid`,
      };
    }
  });
  await app.register(luckyWheelAttendeeRoutes, options);
  await app.ready();
  t.after(async () => app.close());

  for (let index = 0; index < 30; index += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/events/3/eligibility",
      headers: { "x-test-user": "21" },
      remoteAddress: "10.10.10.10",
    });
    assert.equal(response.statusCode, 200);
  }
  const limited = await app.inject({
    method: "GET",
    url: "/events/3/eligibility",
    headers: { "x-test-user": "21" },
    remoteAddress: "10.10.10.10",
  });
  assert.equal(limited.statusCode, 429);

  const sameVenueOtherAccount = await app.inject({
    method: "GET",
    url: "/events/3/eligibility",
    headers: { "x-test-user": "22" },
    remoteAddress: "10.10.10.10",
  });
  assert.equal(sameVenueOtherAccount.statusCode, 200);
  assert.equal(calls, 31);
});
