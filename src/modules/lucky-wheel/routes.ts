import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  publishWheelBodySchema,
  redemptionCorrectionBodySchema,
  redemptionInputSchema,
  rewardLookupBodySchema,
  setWheelPausedBodySchema,
  spinInputSchema,
  stockAdjustmentBodySchema,
} from "./schemas.js";
import {
  adjustStock,
  createSpin,
  getEligibility,
  publishWheel,
  readAdminSpins,
  setWheelPaused,
  validateAdminActor,
  WheelError,
  type WheelActor,
  type WheelDatabase,
} from "./service.js";
import {
  confirmRedemption,
  correctRedemption,
  lookupReward,
  readOwnedSpin,
  RewardError,
} from "./rewards.js";

const eventIdSchema = z.coerce.number().int().positive();
const spinIdSchema = z.string().uuid();

export interface LuckyWheelRouteOptions {
  database?: WheelDatabase;
  validateAdminActorFn?: typeof validateAdminActor;
  publishWheelFn?: typeof publishWheel;
  adjustStockFn?: typeof adjustStock;
  setWheelPausedFn?: typeof setWheelPaused;
  readAdminSpinsFn?: typeof readAdminSpins;
  getEligibilityFn?: typeof getEligibility;
  createSpinFn?: typeof createSpin;
  readOwnedSpinFn?: typeof readOwnedSpin;
  lookupRewardFn?: typeof lookupReward;
  confirmRedemptionFn?: typeof confirmRedemption;
  correctRedemptionFn?: typeof correctRedemption;
}

function claimedActor(request: FastifyRequest): WheelActor | null {
  const raw = (request as any).user as
    | { id?: unknown; role?: unknown; email?: unknown }
    | undefined;
  if (!raw || !Number.isInteger(raw.id) || Number(raw.id) <= 0) return null;
  return {
    id: Number(raw.id),
    role: typeof raw.role === "string" ? raw.role : null,
    email: typeof raw.email === "string" ? raw.email : null,
  };
}

const ATTENDEE_ROLES = new Set([
  "pharmacist",
  "medical_professional",
  "general",
  "student",
]);

function claimedAttendee(request: FastifyRequest): WheelActor | null {
  const actor = claimedActor(request);
  if (!actor || !actor.role || !ATTENDEE_ROLES.has(actor.role)) return null;
  return actor;
}

function accountRateKey(request: FastifyRequest): string {
  const actor = claimedActor(request);
  return actor ? `lucky-wheel:account:${actor.id}` : `lucky-wheel:ip:${request.ip}`;
}

function sendWheelError(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof WheelError || error instanceof RewardError) {
    return reply.status(error.statusCode).send({
      success: false,
      code: error.code,
      error: error.message,
      ...(error.details ?? {}),
      requestId,
    });
  }
  return reply.status(500).send({
    success: false,
    code: "LUCKY_WHEEL_REQUEST_FAILED",
    error: "Lucky wheel request failed",
    requestId,
  });
}

function invalid(reply: FastifyReply, requestId: string, details?: unknown) {
  return reply.status(400).send({
    success: false,
    code: "INVALID_WHEEL_REQUEST",
    error: "Invalid lucky wheel request",
    details,
    requestId,
  });
}

async function requireAdminFromRequest(
  database: WheelDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  eventId: number,
  validateAdminActorFn: typeof validateAdminActor,
) {
  const claimed = claimedActor(request);
  if (!claimed) {
    reply.status(401).send({
      success: false,
      code: "AUTH_REQUIRED",
      error: "Authentication required",
      requestId: request.id,
    });
    return null;
  }
  if (claimed.role !== "admin") {
    reply.status(403).send({
      success: false,
      code: "ADMIN_REQUIRED",
      error: "Admin access required",
      requestId: request.id,
    });
    return null;
  }
  const admin = await validateAdminActorFn(database, claimed, eventId);
  if (!admin) {
    reply.status(403).send({
      success: false,
      code: "ADMIN_REQUIRED",
      error: "Active admin access required",
      requestId: request.id,
    });
    return null;
  }
  return admin;
}

export async function luckyWheelAdminRoutes(
  fastify: FastifyInstance,
  options: LuckyWheelRouteOptions = {},
) {
  const database = options.database ?? (await import("../../database/index.js")).db;
  const validateAdminActorFn = options.validateAdminActorFn ?? validateAdminActor;
  const publishWheelFn = options.publishWheelFn ?? publishWheel;
  const adjustStockFn = options.adjustStockFn ?? adjustStock;
  const setWheelPausedFn = options.setWheelPausedFn ?? setWheelPaused;
  const readAdminSpinsFn = options.readAdminSpinsFn ?? readAdminSpins;
  const lookupRewardFn = options.lookupRewardFn ?? lookupReward;
  const confirmRedemptionFn = options.confirmRedemptionFn ?? confirmRedemption;
  const correctRedemptionFn = options.correctRedemptionFn ?? correctRedemption;
  const adminRateLimit = fastify.rateLimit({
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: accountRateKey,
    groupId: "lucky-wheel-admin",
  });

  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  fastify.put(
    "/events/:eventId/publication",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = publishWheelBodySchema.safeParse(request.body);
      if (!eventResult.success || !bodyResult.success) {
        return invalid(reply, request.id, {
          eventId: eventResult.success ? undefined : eventResult.error.flatten(),
          body: bodyResult.success ? undefined : bodyResult.error.flatten(),
        });
      }
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await publishWheelFn(
          database,
          admin,
          eventResult.data,
          bodyResult.data.expectedVersion,
          bodyResult.data.configuration,
          bodyResult.data.reason,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_PUBLISH_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/stock",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = stockAdjustmentBodySchema.safeParse(request.body);
      if (!eventResult.success || !bodyResult.success) {
        return invalid(reply, request.id);
      }
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await adjustStockFn(
          database,
          admin,
          eventResult.data,
          bodyResult.data.segmentId,
          bodyResult.data.delta,
          bodyResult.data.reason,
          bodyResult.data.idempotencyKey,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_STOCK_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.put(
    "/events/:eventId/pause",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = setWheelPausedBodySchema.safeParse(request.body);
      if (!eventResult.success || !bodyResult.success) {
        return invalid(reply, request.id);
      }
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await setWheelPausedFn(
          database,
          admin,
          eventResult.data,
          bodyResult.data.paused,
          bodyResult.data.reason,
          bodyResult.data.idempotencyKey,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_PAUSE_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/spins",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      if (!eventResult.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await readAdminSpinsFn(database, admin, eventResult.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_HISTORY_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/reward-lookups",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = rewardLookupBodySchema.safeParse(request.body);
      if (!eventResult.success || !bodyResult.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await lookupRewardFn(
          database,
          admin,
          eventResult.data,
          bodyResult.data.credential,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code: error instanceof RewardError ? error.code : "LUCKY_WHEEL_REWARD_LOOKUP_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.put(
    "/events/:eventId/spins/:spinId/redemption",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; spinId?: unknown };
      const eventResult = eventIdSchema.safeParse(params.eventId);
      const spinResult = spinIdSchema.safeParse(params.spinId);
      const bodyResult = redemptionInputSchema.safeParse(request.body);
      if (
        !eventResult.success ||
        !spinResult.success ||
        !bodyResult.success ||
        bodyResult.data.eventId !== eventResult.data ||
        bodyResult.data.spinId !== spinResult.data
      ) {
        return invalid(reply, request.id);
      }
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await confirmRedemptionFn(database, admin, bodyResult.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code: error instanceof RewardError ? error.code : "LUCKY_WHEEL_REDEMPTION_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/spins/:spinId/redemption-corrections",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; spinId?: unknown };
      const eventResult = eventIdSchema.safeParse(params.eventId);
      const spinResult = spinIdSchema.safeParse(params.spinId);
      const bodyResult = redemptionCorrectionBodySchema.safeParse(request.body);
      if (
        !eventResult.success ||
        !spinResult.success ||
        !bodyResult.success ||
        bodyResult.data.eventId !== eventResult.data ||
        bodyResult.data.spinId !== spinResult.data
      ) {
        return invalid(reply, request.id);
      }
      try {
        const admin = await requireAdminFromRequest(
          database,
          request,
          reply,
          eventResult.data,
          validateAdminActorFn,
        );
        if (!admin) return;
        const result = await correctRedemptionFn(database, admin, bodyResult.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code: error instanceof RewardError ? error.code : "LUCKY_WHEEL_REDEMPTION_CORRECTION_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );
}

export async function luckyWheelAttendeeRoutes(
  fastify: FastifyInstance,
  options: LuckyWheelRouteOptions = {},
) {
  const database = options.database ?? (await import("../../database/index.js")).db;
  const getEligibilityFn = options.getEligibilityFn ?? getEligibility;
  const createSpinFn = options.createSpinFn ?? createSpin;
  const readOwnedSpinFn = options.readOwnedSpinFn ?? readOwnedSpin;
  const attendeeRateLimit = fastify.rateLimit({
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: accountRateKey,
    groupId: "lucky-wheel-attendee",
  });

  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  fastify.get(
    "/events/:eventId/eligibility",
    { config: { rateLimit: false }, preHandler: attendeeRateLimit },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const claimed = claimedActor(request);
      if (!claimed) {
        return reply.status(401).send({
          success: false,
          code: "AUTH_REQUIRED",
          error: "Authentication required",
          requestId: request.id,
        });
      }
      const actor = claimedAttendee(request);
      if (!actor) {
        return reply.status(403).send({
          success: false,
          code: "ACCOUNT_UNAVAILABLE",
          error: "Attendee account required",
          requestId: request.id,
        });
      }
      if (!eventResult.success) return invalid(reply, request.id);
      try {
        const result = await getEligibilityFn(database, actor, eventResult.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_ELIGIBILITY_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/spins",
    { config: { rateLimit: false }, preHandler: attendeeRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = spinInputSchema.safeParse(request.body);
      const claimed = claimedActor(request);
      if (!claimed) {
        return reply.status(401).send({
          success: false,
          code: "AUTH_REQUIRED",
          error: "Authentication required",
          requestId: request.id,
        });
      }
      const actor = claimedAttendee(request);
      if (!actor) {
        return reply.status(403).send({
          success: false,
          code: "ACCOUNT_UNAVAILABLE",
          error: "Attendee account required",
          requestId: request.id,
        });
      }
      if (
        !eventResult.success ||
        !bodyResult.success ||
        (eventResult.success && bodyResult.success && eventResult.data !== bodyResult.data.eventId)
      ) {
        return invalid(reply, request.id);
      }
      try {
        const result = await createSpinFn(database, actor, bodyResult.data);
        return reply.status(result.created ? 201 : 200).send({
          ...result,
          requestId: request.id,
        });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_SPIN_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/spins/:spinId",
    { config: { rateLimit: false }, preHandler: attendeeRateLimit },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; spinId?: unknown };
      const eventResult = eventIdSchema.safeParse(params.eventId);
      const spinResult = spinIdSchema.safeParse(params.spinId);
      const claimed = claimedActor(request);
      if (!claimed) {
        return reply.status(401).send({
          success: false,
          code: "AUTH_REQUIRED",
          error: "Authentication required",
          requestId: request.id,
        });
      }
      const actor = claimedAttendee(request);
      if (!actor) {
        return reply.status(403).send({
          success: false,
          code: "ACCOUNT_UNAVAILABLE",
          error: "Attendee account required",
          requestId: request.id,
        });
      }
      if (!eventResult.success || !spinResult.success) return invalid(reply, request.id);
      try {
        const result = await readOwnedSpinFn(
          database,
          actor.id,
          eventResult.data,
          spinResult.data,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code: error instanceof RewardError ? error.code : "LUCKY_WHEEL_OWN_REWARD_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );
}

export default luckyWheelAttendeeRoutes;
