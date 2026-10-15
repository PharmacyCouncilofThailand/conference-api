import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
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
  if (error instanceof MerchError) {
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
