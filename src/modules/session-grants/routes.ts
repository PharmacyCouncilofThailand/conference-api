import { getGrantTracking } from "./tracking.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../database/index.js";
import {
  registrationSessionGrantBatches,
  registrationSessionGrantEmailAttempts,
  registrationSessionGrantItems,
  registrations,
  sessionInvitations,
  sessions,
} from "../../database/schema.js";
import {
  createGrantSchema,
  idempotencyKeySchema,
  resultQuerySchema,
  retryEmailsSchema,
  trackingQuerySchema,
} from "./schemas.js";
import { retryGrantEmails } from "./email-jobs.js";
import {
  effectiveDeadline,
  effectiveInvitationStatus,
} from "./invitation-policy.js";
import { createGrant, getGrantBatch } from "./service.js";
import type { GrantDatabase, InvitationStatus } from "./types.js";
import { GrantError } from "./types.js";

const batchIdSchema = z.string().uuid();
const historyQuerySchema = resultQuerySchema.extend({
  registrationId: z.coerce.number().int().positive(),
  eventId: z.coerce.number().int().positive().optional(),
});

export interface SessionGrantRouteOptions {
  database?: GrantDatabase;
  createGrantFn?: typeof createGrant;
  getGrantBatchFn?: typeof getGrantBatch;
  getGrantTrackingFn?: typeof getGrantTracking;
  retryGrantEmailsFn?: typeof retryGrantEmails;
}

function featureEnabled(): boolean {
  return process.env.ADMIN_SESSION_GRANTS_ENABLED?.trim().toLowerCase() === "true";
}

function adminActor(request: FastifyRequest, reply: FastifyReply): { id: number; role: string } | null {
  const actor = (request as any).user as { id?: number; role?: string } | undefined;
  if (!actor?.id) {
    reply.status(401).send({ error: "Authentication required", code: "AUTH_REQUIRED" });
    return null;
  }
  if (actor.role !== "admin") {
    reply.status(403).send({ error: "Admin access required", code: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: actor.id, role: actor.role };
}

function sendGrantError(reply: FastifyReply, error: unknown) {
  if (error instanceof GrantError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  return reply.status(500).send({ error: "Session grant request failed", code: "SESSION_GRANT_FAILED" });
}

export default async function sessionGrantRoutes(
  fastify: FastifyInstance,
  options: SessionGrantRouteOptions = {},
) {
  const database = options.database ?? db;
  const createGrantFn = options.createGrantFn ?? createGrant;
  const getGrantBatchFn = options.getGrantBatchFn ?? getGrantBatch;
  const retryGrantEmailsFn = options.retryGrantEmailsFn ?? retryGrantEmails;

  const getGrantTrackingFn = options.getGrantTrackingFn ?? getGrantTracking;

  fastify.get("/tracking", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!adminActor(request, reply)) return;
    const parsed = trackingQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query", code: "INVALID_QUERY" });
    }
    try {
      return reply.send(await getGrantTrackingFn(database, parsed.data));
    } catch {
      fastify.log.error({ err: "SESSION_GRANT_TRACKING_FAILED" });
      return reply.status(500).send({ error: "Failed to read session grant tracking", code: "SESSION_GRANT_TRACKING_FAILED" });
    }
  });

  fastify.get("/status", async (request, reply) => {
    const actor = adminActor(request, reply);
    if (!actor) return;
    return reply.send({ enabled: featureEnabled() });
  });

  fastify.post("/", async (request, reply) => {
    const actor = adminActor(request, reply);
    if (!actor) return;
    if (!featureEnabled()) {
      return reply.status(503).send({
        error: "Admin Session Grants are temporarily disabled",
        code: "ADMIN_SESSION_GRANTS_DISABLED",
      });
    }

    const keyResult = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    const bodyResult = createGrantSchema.safeParse(request.body);
    if (!keyResult.success || !bodyResult.success) {
      return reply.status(400).send({
        error: "Invalid session grant request",
        code: "INVALID_SESSION_GRANT_REQUEST",
        details: {
          idempotencyKey: keyResult.success ? undefined : keyResult.error.flatten(),
          body: bodyResult.success ? undefined : bodyResult.error.flatten(),
        },
      });
    }

    try {
      const result = await createGrantFn(database, {
        actorId: actor.id,
        idempotencyKey: keyResult.data,
        sessionId: bodyResult.data.sessionId,
        registrationIds: bodyResult.data.registrationIds,
      });
      return reply.status(result.replayed ? 200 : 201).send(result.batch);
    } catch (error) {
      fastify.log.error({ err: error instanceof GrantError ? error.code : "SESSION_GRANT_FAILED" });
      return sendGrantError(reply, error);
    }
  });

  fastify.get("/", async (request, reply) => {
    const actor = adminActor(request, reply);
    if (!actor) return;
    const queryResult = historyQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", code: "INVALID_QUERY" });
    }
    const { registrationId, eventId, page, limit } = queryResult.data;
    const whereClause = eventId
      ? and(
          eq(registrationSessionGrantItems.requestedRegistrationId, registrationId),
          eq(registrationSessionGrantBatches.eventId, eventId),
        )
      : eq(registrationSessionGrantItems.requestedRegistrationId, registrationId);

    try {
      const [{ total }] = await database
        .select({ total: count() })
        .from(registrationSessionGrantItems)
        .innerJoin(
          registrationSessionGrantBatches,
          eq(registrationSessionGrantItems.batchId, registrationSessionGrantBatches.id),
        )
        .where(whereClause);
      const [{ now: rawNow }] = await database.execute<{
        now: Date | string;
      }>(sql`SELECT clock_timestamp() AS now`);
      const now = rawNow instanceof Date ? rawNow : new Date(rawNow);
      const rows = await database
        .select({
          batchId: registrationSessionGrantBatches.id,
          eventId: registrationSessionGrantBatches.eventId,
          sessionId: registrationSessionGrantBatches.sessionId,
          sessionName: registrationSessionGrantBatches.sessionNameSnapshot,
          actorName: registrationSessionGrantBatches.actorNameSnapshot,
          createdAt: registrationSessionGrantBatches.createdAt,
          outcome: registrationSessionGrantItems.outcome,
          reasonCode: registrationSessionGrantItems.reasonCode,
          emailStatus: registrationSessionGrantItems.emailStatus,
          attemptCount: registrationSessionGrantItems.attemptCount,
          invitationId: sessionInvitations.id,
          invitationStatus: sessionInvitations.status,
          invitationExpiresAt: sessionInvitations.expiresAt,
          invitationRespondedAt: sessionInvitations.respondedAt,
          registrationStatus: registrations.status,
          registrationEventId: registrations.eventId,
          sessionEventId: sessions.eventId,
          sessionIsActive: sessions.isActive,
          sessionStartTime: sessions.startTime,
        })
        .from(registrationSessionGrantItems)
        .innerJoin(
          registrationSessionGrantBatches,
          eq(registrationSessionGrantItems.batchId, registrationSessionGrantBatches.id),
        )
        .leftJoin(
          sessionInvitations,
          eq(sessionInvitations.grantItemId, registrationSessionGrantItems.id),
        )
        .leftJoin(
          registrations,
          eq(sessionInvitations.registrationId, registrations.id),
        )
        .leftJoin(
          sessions,
          eq(sessionInvitations.sessionId, sessions.id),
        )
        .where(whereClause)
        .orderBy(
          desc(registrationSessionGrantBatches.createdAt),
          desc(registrationSessionGrantItems.id),
        )
        .limit(limit)
        .offset((page - 1) * limit);
      return reply.send({
        batches: rows.map((row) => {
          const invitation =
            row.invitationId &&
            row.invitationStatus &&
            row.invitationExpiresAt &&
            row.registrationStatus &&
            row.registrationEventId !== null &&
            row.sessionEventId !== null &&
            row.sessionIsActive !== null &&
            row.sessionStartTime
              ? (() => {
                  const status = effectiveInvitationStatus(
                    {
                      status:
                        row.invitationStatus as InvitationStatus,
                      expiresAt: row.invitationExpiresAt,
                      startTime: row.sessionStartTime,
                      isActive: row.sessionIsActive,
                      registrationConfirmed:
                        row.registrationStatus === "confirmed",
                      eventMatches:
                        row.registrationEventId === row.sessionEventId,
                    },
                    now,
                  );
                  return {
                    invitationId: row.invitationId,
                    invitationStatus: status,
                    expiresAt:
                      row.invitationExpiresAt.toISOString(),
                    effectiveDeadline: effectiveDeadline(
                      row.invitationExpiresAt,
                      row.sessionStartTime,
                    ).toISOString(),
                    respondedAt:
                      row.invitationRespondedAt?.toISOString() ??
                      null,
                  };
                })()
              : null;
          return {
            batchId: row.batchId,
            eventId: row.eventId,
            sessionId: row.sessionId,
            sessionName: row.sessionName,
            actorName: row.actorName,
            createdAt: row.createdAt.toISOString(),
            outcome: row.outcome,
            reasonCode: row.reasonCode,
            emailStatus: row.emailStatus,
            attemptCount: row.attemptCount,
            invitation,
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        },
      });
    } catch (error) {
      fastify.log.error({ err: "SESSION_GRANT_HISTORY_FAILED" });
      return reply.status(500).send({ error: "Failed to read session grant history", code: "SESSION_GRANT_HISTORY_FAILED" });
    }
  });

  fastify.post("/:batchId/retry", async (request, reply) => {
    const actor = adminActor(request, reply);
    if (!actor) return;
    if (!featureEnabled()) {
      return reply.status(503).send({ error: "Admin Session Grants are temporarily disabled", code: "ADMIN_SESSION_GRANTS_DISABLED" });
    }
    const batchIdResult = batchIdSchema.safeParse((request.params as { batchId?: string }).batchId);
    const bodyResult = retryEmailsSchema.safeParse(request.body);
    if (!batchIdResult.success || !bodyResult.success) {
      return reply.status(400).send({ error: "Invalid retry request", code: "INVALID_RETRY_REQUEST" });
    }
    try {
      const result = await retryGrantEmailsFn(database, {
        actorId: actor.id,
        batchId: batchIdResult.data,
        itemIds: bodyResult.data.itemIds,
        acknowledgeUnknown: bodyResult.data.acknowledgeUnknown,
      });
      return reply.send(result);
    } catch (error) {
      fastify.log.error({ err: "SESSION_GRANT_RETRY_FAILED" });
      return sendGrantError(reply, error);
    }
  });

  fastify.get("/:batchId/items/:itemId/email-attempts", async (request, reply) => {
    const actor = adminActor(request, reply);
    if (!actor) return;
    const params = request.params as { batchId?: string; itemId?: string };
    const batchIdResult = batchIdSchema.safeParse(params.batchId);
    const itemIdResult = batchIdSchema.safeParse(params.itemId);
    const queryResult = resultQuerySchema.safeParse(request.query);
    if (!batchIdResult.success || !itemIdResult.success || !queryResult.success) {
      return reply.status(400).send({ error: "Invalid email attempt request", code: "INVALID_EMAIL_ATTEMPT_REQUEST" });
    }
    const [item] = await database
      .select({ id: registrationSessionGrantItems.id })
      .from(registrationSessionGrantItems)
      .where(and(
        eq(registrationSessionGrantItems.id, itemIdResult.data),
        eq(registrationSessionGrantItems.batchId, batchIdResult.data),
      ))
      .limit(1);
    if (!item) {
      return reply.status(404).send({ error: "Grant item not found in batch", code: "GRANT_ITEM_NOT_FOUND" });
    }
    const { page, limit } = queryResult.data;
    const [{ total }] = await database
      .select({ total: count() })
      .from(registrationSessionGrantEmailAttempts)
      .where(eq(registrationSessionGrantEmailAttempts.itemId, item.id));
    const attempts = await database
      .select({
        id: registrationSessionGrantEmailAttempts.id,
        attemptNo: registrationSessionGrantEmailAttempts.attemptNo,
        trigger: registrationSessionGrantEmailAttempts.trigger,
        triggeredBy: registrationSessionGrantEmailAttempts.triggeredBy,
        recipientEmail: registrationSessionGrantEmailAttempts.recipientEmail,
        templateVersion: registrationSessionGrantEmailAttempts.templateVersion,
        subject: registrationSessionGrantEmailAttempts.subjectSnapshot,
        result: registrationSessionGrantEmailAttempts.result,
        startedAt: registrationSessionGrantEmailAttempts.startedAt,
        requestStartedAt: registrationSessionGrantEmailAttempts.requestStartedAt,
        finishedAt: registrationSessionGrantEmailAttempts.finishedAt,
        errorCode: registrationSessionGrantEmailAttempts.errorCode,
        errorMessage: registrationSessionGrantEmailAttempts.errorMessage,
        providerMessageId: registrationSessionGrantEmailAttempts.providerMessageId,
      })
      .from(registrationSessionGrantEmailAttempts)
      .where(eq(registrationSessionGrantEmailAttempts.itemId, item.id))
      .orderBy(registrationSessionGrantEmailAttempts.attemptNo)
      .limit(limit)
      .offset((page - 1) * limit);
    return reply.send({
      attempts: attempts.map((attempt) => ({
        ...attempt,
        startedAt: attempt.startedAt.toISOString(),
        requestStartedAt: attempt.requestStartedAt?.toISOString() ?? null,
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
      })),
      pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
    });
  });

  fastify.get("/:batchId", async (request, reply) => {
    const actor = adminActor(request, reply);
    if (!actor) return;
    const batchIdResult = batchIdSchema.safeParse((request.params as { batchId?: string }).batchId);
    const queryResult = resultQuerySchema.safeParse(request.query);
    if (!batchIdResult.success || !queryResult.success) {
      return reply.status(400).send({ error: "Invalid batch request", code: "INVALID_BATCH_REQUEST" });
    }
    try {
      const batch = await getGrantBatchFn(
        database,
        batchIdResult.data,
        queryResult.data.page,
        queryResult.data.limit,
      );
      if (!batch) {
        return reply.status(404).send({ error: "Grant batch not found", code: "GRANT_BATCH_NOT_FOUND" });
      }
      return reply.send(batch);
    } catch (error) {
      fastify.log.error({ err: error instanceof GrantError ? error.code : "SESSION_GRANT_READ_FAILED" });
      return sendGrantError(reply, error);
    }
  });
}
