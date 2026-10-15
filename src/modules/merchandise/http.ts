import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { WheelImageError } from "../lucky-wheel/images.js";
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
