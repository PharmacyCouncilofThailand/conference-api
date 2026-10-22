import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../database/index.js";
import { adminActor, featureEnabled, sendGrantError } from "./routes.js";
import { idempotencyKeySchema, resendInvitationSchema, resultQuerySchema } from "./schemas.js";
import { getResendOperation } from "./resend-readers.js";
import { previewInvitationResends, queueInvitationResends } from "./resend-service.js";
import { GrantError, type GrantDatabase } from "./types.js";

export interface InvitationResendRouteOptions {
  database?: GrantDatabase;
  previewInvitationResendsFn?: typeof previewInvitationResends;
  queueInvitationResendsFn?: typeof queueInvitationResends;
  getResendOperationFn?: typeof getResendOperation;
}
export async function registerInvitationResendRoutes(fastify: FastifyInstance, options: InvitationResendRouteOptions = {}) {
  const database = options.database ?? db;
  for (const path of ["/resend-preview", "/resend"] as const) fastify.post(path, { onRequest: async (_request, reply) => { reply.header("Cache-Control", "no-store"); } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actor = adminActor(request, reply);
    if (!actor) return;
    if (!featureEnabled()) return reply.status(503).send({ error: "Admin Session Grants are temporarily disabled", code: "ADMIN_SESSION_GRANTS_DISABLED" });
    const body = resendInvitationSchema.safeParse(request.body);
    const key = path === "/resend" ? idempotencyKeySchema.safeParse(request.headers["idempotency-key"]) : null;
    if (!body.success || (key && !key.success)) return reply.status(400).send({ error: "Invalid invitation resend request", code: "INVALID_RESEND_REQUEST" });
    try {
      if (path === "/resend-preview") return reply.send(await (options.previewInvitationResendsFn ?? previewInvitationResends)(database, body.data));
      const response = await (options.queueInvitationResendsFn ?? queueInvitationResends)(database, { ...body.data, actorId: actor.id, idempotencyKey: key!.data! });
      return reply.status(response.replayed ? 200 : 202).send(response.result);
    } catch (error) {
      fastify.log.error({ err: error instanceof GrantError ? error.code : "SESSION_INVITATION_RESEND_FAILED" });
      return sendGrantError(reply, error);
    }
  });
  fastify.get("/resends/:requestId", { onRequest: async (_request, reply) => { reply.header("Cache-Control", "no-store"); } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!adminActor(request, reply)) return;
    if (!featureEnabled()) return reply.status(503).send({ error: "Admin Session Grants are temporarily disabled", code: "ADMIN_SESSION_GRANTS_DISABLED" });
    const id = z.string().uuid().safeParse((request.params as { requestId: string }).requestId);
    const query = resultQuerySchema.strict().safeParse(request.query);
    if (!id.success || !query.success) return reply.status(400).send({ error: "Invalid resend operation request", code: "INVALID_RESEND_REQUEST" });
    try {
      const operation = await (options.getResendOperationFn ?? getResendOperation)(database, id.data, query.data.page, query.data.limit);
      if (!operation) return reply.status(404).send({ error: "Resend operation not found", code: "RESEND_REQUEST_NOT_FOUND" });
      return reply.send(operation);
    } catch (error) {
      fastify.log.error({ err: error instanceof GrantError ? error.code : "SESSION_INVITATION_RESEND_READ_FAILED" });
      return sendGrantError(reply, error);
    }
  });
}

