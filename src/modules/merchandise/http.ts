import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z, ZodError } from "zod";
import { events } from "../../database/schema.js";
import { WheelImageError } from "../lucky-wheel/images.js";
import { requireAdmin } from "./access.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";

export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store");
}

export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply.status(status).send({ success: true, data });
}

export function sendMerchFailure(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
): FastifyReply {
  noStore(reply);
  if (error instanceof WheelImageError) {
    error = new MerchError(error.statusCode, error.code, error.message, error.details, error);
  }
  const fastifyCode = (error as { code?: unknown } | null)?.code;
  if (fastifyCode === "FST_REQ_FILE_TOO_LARGE") {
    error = new MerchError(400, "IMAGE_TOO_LARGE", "รูปภาพต้องมีขนาดไม่เกิน 5 MB");
  } else if (
    fastifyCode === "FST_INVALID_MULTIPART_CONTENT_TYPE" ||
    fastifyCode === "FST_FILES_LIMIT" ||
    fastifyCode === "FST_PARTS_LIMIT"
  ) {
    error = new MerchError(400, "IMAGE_INVALID", "ต้องแนบไฟล์รูปภาพแบบ multipart");
  }
  if (error instanceof MerchError) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error, cause: error.cause, code: error.code }, "merchandise request failed");
    }
    return reply.status(error.statusCode).send({
      success: false,
      code: error.code,
      error: error.message,
      requestId: request.id,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof ZodError) {
    return reply.status(400).send({
      success: false,
      code: "VALIDATION_ERROR",
      error: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
      requestId: request.id,
      details: { fieldErrors: error.flatten().fieldErrors },
    });
  }
  request.log.error({ err: error, code: "MERCH_INTERNAL_ERROR" }, "merchandise request failed");
  return reply.status(500).send({
    success: false,
    code: "MERCH_INTERNAL_ERROR",
    error: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง",
    requestId: request.id,
  });
}

// Rate-limit key: the verified token's user id, else the client IP. Tokens are
// verified so a forged id can neither drain another user's bucket nor rotate
// ids to dodge the limit.
function rateKey(app: FastifyInstance, groupId: string) {
  return (request: FastifyRequest): string => {
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      try {
        const claims = app.jwt.verify<{ id?: unknown }>(header.slice(7));
        if (Number.isInteger(claims?.id) && Number(claims.id) > 0) {
          return `${groupId}:user:${claims.id}`;
        }
      } catch {
        // unverifiable token: fall through to IP
      }
    }
    return `${groupId}:ip:${request.ip}`;
  };
}

type LimiterFn = (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function merchRateLimit(
  app: FastifyInstance,
  opts: { max: number; groupId: string },
): preHandlerAsyncHookHandler {
  const inner = app.rateLimit({
    max: opts.max,
    timeWindow: "1 minute",
    keyGenerator: rateKey(app, opts.groupId),
    groupId: opts.groupId,
    errorResponseBuilder: () =>
      new MerchError(429, "MERCH_RATE_LIMITED", "มีการเรียกใช้งานถี่เกินไป กรุณาลองใหม่อีกครั้ง"),
  }) as unknown as LimiterFn;
  return async function (this: FastifyInstance, request, reply) {
    try {
      await inner.call(this, request, reply);
    } catch (error) {
      if (error instanceof MerchError) return sendMerchFailure(reply, request, error);
      throw error;
    }
  };
}

const eventIdSchema = z.coerce.number().int().positive();

export type AdminRouteCtx = { admin: { id: number; email: string }; eventId: number; request: FastifyRequest };
export type AdminRouteResult =
  | { data: unknown; status?: number }
  | { file: { buffer: Buffer; contentType: string; filename: string } };

/**
 * Wraps an admin handler under `/merchandise/events/:eventId`: no-store, `:eventId` parse,
 * role `admin` check, event existence (404), envelope and error mapping.
 */
export function adminRoute(db: MerchDb) {
  return (handler: (ctx: AdminRouteCtx) => Promise<AdminRouteResult>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        noStore(reply);
        const params = request.params as { eventId?: unknown };
        const parsed = eventIdSchema.safeParse(params.eventId);
        if (!parsed.success) {
          throw new MerchError(400, "VALIDATION_ERROR", "ข้อมูลที่ส่งมาไม่ถูกต้อง");
        }
        const eventId = parsed.data;
        const admin = await requireAdmin(db, request, eventId);
        const [event] = await db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);
        if (!event) throw new MerchError(404, "MERCH_EVENT_NOT_FOUND", "ไม่พบงานที่ระบุ");
        const result = await handler({ admin, eventId, request });
        if ("file" in result) {
          const { buffer, contentType, filename } = result.file;
          return reply
            .status(200)
            .header("Content-Type", contentType)
            .header("Content-Disposition", `attachment; filename="${filename}"`)
            .send(buffer);
        }
        return ok(reply, result.data, result.status ?? 200);
      } catch (error) {
        return sendMerchFailure(reply, request, error);
      }
    };
}
