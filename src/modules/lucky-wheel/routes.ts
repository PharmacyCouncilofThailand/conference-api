import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminSpinQuerySchema,
  attendanceSetupBodySchema,
  attendeeSpinHistoryQuerySchema,
  dayChangesQuerySchema,
  dayWindowBodySchema,
  initializeWheelBodySchema,
  publishWheelBodySchema,
  qrBatchBodySchema,
  qrCreditClaimBodySchema,
  qrListQuerySchema,
  qrRevocationBodySchema,
  qrStatusBodySchema,
  redemptionCorrectionBodySchema,
  redemptionInputSchema,
  rewardLookupBodySchema,
  setWheelPausedBodySchema,
  spinInputSchema,
  stockAdjustmentBodySchema,
  wheelDayDateSchema,
} from "./schemas.js";
import { editDayWindow, listDayWindows, readDayChanges, readDayWindow } from "./day-schedule.js";
import {
  createQrBatch,
  readQrClaims,
  readQrCodes,
  readQrProjection,
  revokeCreditClaim,
  setQrStatus,
  claimQrCredit,
  previewQrCredit,
} from "./qr-credits.js";
import {
  adjustStock,
  createSpin,
  getEligibility,
  initializeWheel,
  publishWheel,
  readAdminSpins,
  readAdminWheelState,
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
  readOwnedSpins,
  requireRewardCollector,
  RewardError,
} from "./rewards.js";
import {
  MAX_WHEEL_IMAGE_BYTES,
  uploadWheelImage,
  WheelImageError,
  type WheelImageContext,
} from "./images.js";
import { setupWheelAttendance } from "./attendance-setup.js";

const eventIdSchema = z.coerce.number().int().positive();
const spinIdSchema = z.string().uuid();

export interface LuckyWheelRouteOptions {
  database?: WheelDatabase;
  validateAdminActorFn?: typeof validateAdminActor;
  publishWheelFn?: typeof publishWheel;
  adjustStockFn?: typeof adjustStock;
  setWheelPausedFn?: typeof setWheelPaused;
  readAdminWheelStateFn?: typeof readAdminWheelState;
  initializeWheelFn?: typeof initializeWheel;
  setupWheelAttendanceFn?: typeof setupWheelAttendance;
  readAdminSpinsFn?: typeof readAdminSpins;
  readDayWindowFn?: typeof readDayWindow;
  listDayWindowsFn?: typeof listDayWindows;
  editDayWindowFn?: typeof editDayWindow;
  readDayChangesFn?: typeof readDayChanges;
  createQrBatchFn?: typeof createQrBatch;
  readQrCodesFn?: typeof readQrCodes;
  readQrProjectionFn?: typeof readQrProjection;
  readQrClaimsFn?: typeof readQrClaims;
  setQrStatusFn?: typeof setQrStatus;
  revokeCreditClaimFn?: typeof revokeCreditClaim;
  claimQrCreditFn?: typeof claimQrCredit;
  previewQrCreditFn?: typeof previewQrCredit;
  getEligibilityFn?: typeof getEligibility;
  createSpinFn?: typeof createSpin;
  readOwnedSpinsFn?: typeof readOwnedSpins;
  readOwnedSpinFn?: typeof readOwnedSpin;
  lookupRewardFn?: typeof lookupReward;
  confirmRedemptionFn?: typeof confirmRedemption;
  correctRedemptionFn?: typeof correctRedemption;
  requireRewardCollectorFn?: typeof requireRewardCollector;
  uploadWheelImageFn?: typeof uploadWheelImage;
  imageContext?: WheelImageContext;
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
  if (
    error instanceof WheelError ||
    error instanceof RewardError ||
    error instanceof WheelImageError
  ) {
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
  const readAdminWheelStateFn = options.readAdminWheelStateFn ?? readAdminWheelState;
  const initializeWheelFn = options.initializeWheelFn ?? initializeWheel;
  const setupWheelAttendanceFn = options.setupWheelAttendanceFn ?? setupWheelAttendance;
  const readAdminSpinsFn = options.readAdminSpinsFn ?? readAdminSpins;
  const readDayWindowFn = options.readDayWindowFn ?? readDayWindow;
  const listDayWindowsFn = options.listDayWindowsFn ?? listDayWindows;
  const editDayWindowFn = options.editDayWindowFn ?? editDayWindow;
  const readDayChangesFn = options.readDayChangesFn ?? readDayChanges;
  const createQrBatchFn = options.createQrBatchFn ?? createQrBatch;
  const readQrCodesFn = options.readQrCodesFn ?? readQrCodes;
  const readQrProjectionFn = options.readQrProjectionFn ?? readQrProjection;
  const readQrClaimsFn = options.readQrClaimsFn ?? readQrClaims;
  const setQrStatusFn = options.setQrStatusFn ?? setQrStatus;
  const revokeCreditClaimFn = options.revokeCreditClaimFn ?? revokeCreditClaim;
  const lookupRewardFn = options.lookupRewardFn ?? lookupReward;
  const confirmRedemptionFn = options.confirmRedemptionFn ?? confirmRedemption;
  const correctRedemptionFn = options.correctRedemptionFn ?? correctRedemption;
  const requireRewardCollectorFn = options.requireRewardCollectorFn ?? requireRewardCollector;
  const uploadWheelImageFn = options.uploadWheelImageFn ?? uploadWheelImage;
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

  fastify.post("/events/:eventId/attendance-setup",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const event = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const body = attendanceSetupBodySchema.safeParse(request.body);
      if (!event.success || !body.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await setupWheelAttendanceFn(database, admin, event.data, body.data);
        return reply.status(result.replayed ? 200 : 201).send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "ATTENDANCE_SETUP_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    });

  fastify.put(
    "/events/:eventId",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = initializeWheelBodySchema.safeParse(request.body);
      if (!eventResult.success || !bodyResult.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(
          database, request, reply, eventResult.data, validateAdminActorFn,
        );
        if (!admin) return;
        const result = await initializeWheelFn(
          database, admin, eventResult.data, bodyResult.data.mainSessionId,
        );
        return reply.status(result.created ? 201 : 200).send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({ code: error instanceof WheelError ? error.code : "LUCKY_WHEEL_INITIALIZE_FAILED" });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/days",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const event = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      if (!event.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const days = await listDayWindowsFn(database, admin, event.data);
        return reply.send({ eventId: event.data, days, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/days/:date",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; date?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const date = wheelDayDateSchema.safeParse(params.date);
      if (!event.success || !date.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const day = await readDayWindowFn(database, admin, event.data, date.data);
        return reply.send({ eventId: event.data, day, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.put(
    "/events/:eventId/days/:date",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; date?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const date = wheelDayDateSchema.safeParse(params.date);
      const body = dayWindowBodySchema.safeParse(request.body);
      if (!event.success || !date.success || !body.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const day = await editDayWindowFn(database, admin, event.data, { date: date.data, ...body.data });
        return reply.send({ eventId: event.data, day, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/days/:date/changes",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; date?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const date = wheelDayDateSchema.safeParse(params.date);
      const query = dayChangesQuerySchema.safeParse(request.query);
      if (!event.success || !date.success || !query.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const changes = await readDayChangesFn(database, admin, event.data, date.data, query.data);
        return reply.send({ eventId: event.data, ...changes, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/qr-codes",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const event = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const body = qrBatchBodySchema.safeParse(request.body);
      if (!event.success || !body.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await createQrBatchFn(database, admin, event.data, body.data);
        return reply.status(result.replayed ? 200 : 201).send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/qr-codes",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const event = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const query = qrListQuerySchema.safeParse(request.query);
      if (!event.success || !query.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await readQrCodesFn(database, admin, event.data, query.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/qr-codes/:qrId",
    { config: { rateLimit: false }, preHandler: adminRateLimit, logLevel: "silent" },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; qrId?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const qrId = spinIdSchema.safeParse(params.qrId);
      if (!event.success || !qrId.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await readQrProjectionFn(database, admin, event.data, qrId.data, request.headers.origin ?? null);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId/qr-codes/:qrId/claims",
    { config: { rateLimit: false }, preHandler: adminRateLimit, logLevel: "silent" },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; qrId?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const qrId = spinIdSchema.safeParse(params.qrId);
      const query = dayChangesQuerySchema.safeParse(request.query);
      if (!event.success || !qrId.success || !query.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await readQrClaimsFn(database, admin, event.data, qrId.data, query.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.patch(
    "/events/:eventId/qr-codes/:qrId",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024, logLevel: "silent" },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; qrId?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const qrId = spinIdSchema.safeParse(params.qrId);
      const body = qrStatusBodySchema.safeParse(request.body);
      if (!event.success || !qrId.success || !body.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await setQrStatusFn(database, admin, event.data, qrId.data, body.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/credit-claims/:claimId/revocations",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const params = request.params as { eventId?: unknown; claimId?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const claimId = spinIdSchema.safeParse(params.claimId);
      const body = qrRevocationBodySchema.safeParse(request.body);
      if (!event.success || !claimId.success || !body.success) return invalid(reply, request.id);
      try {
        const admin = await requireAdminFromRequest(database, request, reply, event.data, validateAdminActorFn);
        if (!admin) return;
        const result = await revokeCreditClaimFn(database, admin, event.data, claimId.data, body.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    "/events/:eventId",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse(
        (request.params as { eventId?: unknown }).eventId,
      );
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
        const result = await readAdminWheelStateFn(
          database,
          admin,
          eventResult.data,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code:
            error instanceof WheelError
              ? error.code
              : "LUCKY_WHEEL_ADMIN_STATE_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

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
      const eventResult = eventIdSchema.safeParse(
        (request.params as { eventId?: unknown }).eventId,
      );
      const queryResult = adminSpinQuerySchema.safeParse(request.query);
      if (!eventResult.success || !queryResult.success) {
        return invalid(reply, request.id, {
          eventId: eventResult.success ? undefined : eventResult.error.flatten(),
          query: queryResult.success ? undefined : queryResult.error.flatten(),
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
        const result = await readAdminSpinsFn(
          database,
          admin,
          eventResult.data,
          queryResult.data,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code:
            error instanceof WheelError
              ? error.code
              : "LUCKY_WHEEL_HISTORY_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/images",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse(
        (request.params as { eventId?: unknown }).eventId,
      );
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

        const data = await request.file({
          limits: {
            fileSize: MAX_WHEEL_IMAGE_BYTES,
            files: 1,
            fields: 0,
            parts: 1,
          },
        });
        if (!data) {
          throw new WheelImageError(400, "IMAGE_INVALID", "Image file is required");
        }

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of data.file) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_WHEEL_IMAGE_BYTES) {
            throw new WheelImageError(
              400,
              "IMAGE_TOO_LARGE",
              "Lucky Wheel image must be 5 MiB or smaller",
            );
          }
          chunks.push(buffer);
        }
        if (data.file.truncated) {
          throw new WheelImageError(
            400,
            "IMAGE_TOO_LARGE",
            "Lucky Wheel image must be 5 MiB or smaller",
          );
        }

        const context: WheelImageContext = {
          ...options.imageContext,
          database,
          logger:
            options.imageContext?.logger ??
            {
              warn(details, message) {
                request.log.warn(details, message);
              },
            },
        };
        const result = await uploadWheelImageFn(
          admin,
          eventResult.data,
          {
            buffer: Buffer.concat(chunks),
            filename: data.filename,
            mimetype: data.mimetype,
          },
          context,
        );
        return reply.status(201).send({ ...result, requestId: request.id });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
        ) {
          return sendWheelError(
            reply,
            new WheelImageError(
              400,
              "IMAGE_TOO_LARGE",
              "Lucky Wheel image must be 5 MiB or smaller",
            ),
            request.id,
          );
        }
        request.log.error({
          code:
            error instanceof WheelImageError
              ? error.code
              : "LUCKY_WHEEL_IMAGE_UPLOAD_FAILED",
        });
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.get("/events/:eventId/collection-access",
    { config: { rateLimit: false }, preHandler: adminRateLimit },
    async (request, reply) => {
      const event = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      if (!event.success) return invalid(reply, request.id);
      try {
        const collector = await requireRewardCollectorFn(database, claimedActor(request), event.data);
        return reply.send({ eventId: event.data, role: collector.role, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    });

  fastify.post(
    "/events/:eventId/reward-lookups",
    { config: { rateLimit: false }, preHandler: adminRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const bodyResult = rewardLookupBodySchema.safeParse(request.body);
      if (!eventResult.success || !bodyResult.success) return invalid(reply, request.id);
      try {
        const admin = await requireRewardCollectorFn(database, claimedActor(request), eventResult.data);
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
        const admin = await requireRewardCollectorFn(database, claimedActor(request), eventResult.data);
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
  const readOwnedSpinsFn = options.readOwnedSpinsFn ?? readOwnedSpins;
  const readOwnedSpinFn = options.readOwnedSpinFn ?? readOwnedSpin;
  const claimQrCreditFn = options.claimQrCreditFn ?? claimQrCredit;
  const previewQrCreditFn = options.previewQrCreditFn ?? previewQrCredit;
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
    "/events/:eventId/qr-codes/:qrId",
    {
      config: { rateLimit: false },
      preHandler: attendeeRateLimit,
      logLevel: "silent",
    },
    async (request, reply) => {
      reply.header("Referrer-Policy", "no-referrer");
      const params = request.params as { eventId?: unknown; qrId?: unknown };
      const event = eventIdSchema.safeParse(params.eventId);
      const qrId = spinIdSchema.safeParse(params.qrId);
      const claimed = claimedActor(request);
      if (!claimed) {
        return reply.status(401).send({
          success: false, code: "AUTH_REQUIRED", error: "Authentication required", requestId: request.id,
        });
      }
      const actor = claimedAttendee(request);
      if (!actor) {
        return reply.status(403).send({
          success: false, code: "ACCOUNT_UNAVAILABLE", error: "Attendee account required", requestId: request.id,
        });
      }
      if (!event.success || !qrId.success) return invalid(reply, request.id);
      try {
        const result = await previewQrCreditFn(database, actor, event.data, qrId.data);
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    "/events/:eventId/credit-claims",
    { config: { rateLimit: false }, preHandler: attendeeRateLimit, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const event = eventIdSchema.safeParse((request.params as { eventId?: unknown }).eventId);
      const body = qrCreditClaimBodySchema.safeParse(request.body);
      const claimed = claimedActor(request);
      if (!claimed) {
        return reply.status(401).send({
          success: false, code: "AUTH_REQUIRED", error: "Authentication required", requestId: request.id,
        });
      }
      const actor = claimedAttendee(request);
      if (!actor) {
        return reply.status(403).send({
          success: false, code: "ACCOUNT_UNAVAILABLE", error: "Attendee account required", requestId: request.id,
        });
      }
      if (!event.success || !body.success) return invalid(reply, request.id);
      try {
        const result = await claimQrCreditFn(database, actor, event.data, body.data.qrId);
        return reply.status(result.created ? 201 : 200).send({ ...result, requestId: request.id });
      } catch (error) {
        return sendWheelError(reply, error, request.id);
      }
    },
  );

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

  fastify.get(
    "/events/:eventId/spins",
    { config: { rateLimit: false }, preHandler: attendeeRateLimit },
    async (request, reply) => {
      const eventResult = eventIdSchema.safeParse(
        (request.params as { eventId?: unknown }).eventId,
      );
      const queryResult = attendeeSpinHistoryQuerySchema.safeParse(request.query);
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
      if (!eventResult.success || !queryResult.success) {
        return invalid(reply, request.id, {
          eventId: eventResult.success ? undefined : eventResult.error.flatten(),
          query: queryResult.success ? undefined : queryResult.error.flatten(),
        });
      }
      try {
        const result = await readOwnedSpinsFn(
          database,
          actor.id,
          eventResult.data,
          queryResult.data,
        );
        return reply.send({ ...result, requestId: request.id });
      } catch (error) {
        request.log.error({
          code:
            error instanceof RewardError
              ? error.code
              : "LUCKY_WHEEL_OWN_HISTORY_FAILED",
        });
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
