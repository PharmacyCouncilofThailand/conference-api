import { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  abstractTrackingIdentifiers,
  abstracts,
  events,
} from "../../database/schema.js";

const API_REASON: Record<string, string> = {
  initial_submission: "INITIAL_SUBMISSION",
  presentation_type_change: "PRESENTATION_TYPE_CHANGED",
  legacy_import: "LEGACY_IMPORT",
  migration_assignment: "MIGRATION_ASSIGNMENT",
  migration_normalization: "MIGRATION_NORMALIZATION",
  admin_correction: "ADMIN_CORRECTION",
};

export default async function (fastify: FastifyInstance) {
  fastify.get("", async (request, reply) => {
    const trackingId = (request.query as { trackingId?: string }).trackingId;
    if (!trackingId || trackingId.length > 80) {
      return reply.status(400).send({
        success: false,
        code: "INVALID_TRACKING_ID",
        error: "trackingId is required",
        requestId: request.id,
      });
    }

    try {
      const [match] = await db
        .select({
          trackingId: abstractTrackingIdentifiers.trackingId,
          abstractId: abstractTrackingIdentifiers.abstractId,
          eventId: abstractTrackingIdentifiers.eventId,
          presentationType: abstractTrackingIdentifiers.presentationTypeAtAssignment,
          previousTrackingId: abstractTrackingIdentifiers.previousTrackingId,
          reason: abstractTrackingIdentifiers.reason,
          issuedAt: abstractTrackingIdentifiers.assignedAt,
          currentTrackingId: abstracts.trackingId,
          abstractPresentationType: abstracts.presentationType,
          abstractStatus: abstracts.status,
          abstractArchivedAt: abstracts.archivedAt,
          eventCode: events.eventCode,
        })
        .from(abstractTrackingIdentifiers)
        .innerJoin(abstracts, and(
          eq(abstracts.id, abstractTrackingIdentifiers.abstractId),
          eq(abstracts.eventId, abstractTrackingIdentifiers.eventId),
        ))
        .innerJoin(events, eq(events.id, abstractTrackingIdentifiers.eventId))
        .where(eq(abstractTrackingIdentifiers.trackingId, trackingId))
        .limit(1);

      // Reviewers without a shared category/event authorization helper must not
      // receive an identifier oracle. Their normal abstract list remains scoped.
      if (!match || request.user?.role === "reviewer") {
        return reply.status(404).send({
          success: false,
          code: "ABSTRACT_IDENTIFIER_NOT_FOUND",
          error: "Abstract identifier not found",
          requestId: request.id,
        });
      }

      const [successor] = await db
        .select({
          trackingId: abstractTrackingIdentifiers.trackingId,
          reason: abstractTrackingIdentifiers.reason,
          replacedAt: abstractTrackingIdentifiers.assignedAt,
        })
        .from(abstractTrackingIdentifiers)
        .where(and(
          eq(abstractTrackingIdentifiers.abstractId, match.abstractId),
          eq(abstractTrackingIdentifiers.previousTrackingId, trackingId),
        ))
        .limit(1);

      return reply.send({
        success: true,
        identifier: {
          requested: trackingId,
          match: match.currentTrackingId === trackingId ? "canonical" : "alias",
          canonicalTrackingId: match.currentTrackingId,
          issuedAt: match.issuedAt,
          assignmentReason: API_REASON[match.reason] ?? "UNKNOWN",
          replacement: successor ? {
            reason: API_REASON[successor.reason] ?? "UNKNOWN",
            replacedAt: successor.replacedAt,
            successorTrackingId: successor.trackingId,
          } : null,
        },
        abstract: {
          id: match.abstractId,
          eventId: match.eventId,
          eventCode: match.eventCode,
          trackingId: match.currentTrackingId,
          presentationType: match.abstractPresentationType,
          status: match.abstractStatus,
          archived: Boolean(match.abstractArchivedAt),
        },
        requestId: request.id,
      });
    } catch (error) {
      fastify.log.error({ err: error, trackingId }, "Failed to resolve abstract identifier");
      return reply.status(500).send({
        success: false,
        code: "ABSTRACT_IDENTIFIER_LOOKUP_FAILED",
        error: "Failed to resolve abstract identifier",
        requestId: request.id,
      });
    }
  });
}
