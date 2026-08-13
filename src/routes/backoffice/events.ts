import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../database/index.js";
import {
  events,
  sessions,
  ticketTypes,
  ticketSessions,
  eventImages,
  staffEventAssignments,
  registrations,
  registrationSessions,
  speakers,
  eventSpeakers,
  abstractTrackingNamespaces,
  abstractTrackingCounters,
  abstracts,
} from "../../database/schema.js";
import {
  createEventSchema,
  updateEventSchema,
  createSessionSchema,
  updateSessionSchema,
  createTicketTypeSchema,
  updateTicketTypeSchema,
  eventQuerySchema,
} from "../../schemas/events.schema.js";
import { eq, desc, ilike, and, sql, count, inArray } from "drizzle-orm";
import type {
  JWTPayload,
  EventUpdatePayload,
  SessionUpdatePayload,
  TicketTypeUpdatePayload,
} from "../../types/index.js";
import { validatePaddingWidth, validateTrackingPrefix } from "../../modules/abstracts/tracking-format.js";
import { appendTrackingAuditEvent } from "../../modules/abstracts/tracking.repository.js";

/**
 * Normalize allowedRoles to CSV format for consistent DB storage.
 * Handles: JSON array string '["pharmacist","student"]' → 'pharmacist,student'
 *          Already CSV 'pharmacist,student' → 'pharmacist,student'
 *          undefined/null → undefined
 */
function normalizeAllowedRoles(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.join(",");
    } catch {
      // not valid JSON, return as-is
    }
  }
  return raw;
}

/**
 * Priority weight map for auto-calculating displayOrder.
 * Lower weight = higher priority = shown first on frontend.
 */
const PRIORITY_WEIGHT: Record<string, number> = {
  early_bird: 100,
  regular: 200,
};

/**
 * Auto-calculate displayOrder from priority + saleStartDate.
 * Formula: weight * 10000 + MMDD(saleStartDate)
 *
 * Example:
 *   early_bird + Feb 01 → 100*10000 + 0201 = 1000201
 *   early_bird + Feb 18 → 100*10000 + 0218 = 1000218
 *   regular    + May 01 → 200*10000 + 0501 = 2000501
 *
 * Guarantees: EB always < Regular regardless of dates.
 */
function calculateDisplayOrder(
  priority: string,
  saleStartDate: string | Date | null | undefined,
): number {
  const weight = PRIORITY_WEIGHT[priority] ?? PRIORITY_WEIGHT.regular;

  if (!saleStartDate) return weight * 10000;

  const saleStart = saleStartDate instanceof Date ? saleStartDate : new Date(saleStartDate);
  if (isNaN(saleStart.getTime())) return weight * 10000;

  const mmdd = (saleStart.getMonth() + 1) * 100 + saleStart.getDate();
  return weight * 10000 + mmdd;
}

const trackingNamespaceSchema = z.object({
  prefix: z.string().min(1).max(50),
  paddingWidth: z.number().int().min(1).max(12).default(3),
}).strict();

const eventArchiveSchema = z.object({
  reason: z.enum(["manual", "completed", "cancelled", "duplicate_event"]),
  note: z.string().max(1000).optional().nullable(),
}).strict();

function requestIdOf(request: { id?: string }): string | undefined {
  return request.id;
}

export default async function (fastify: FastifyInstance) {
  // ============================================================================
  // EVENTS CRUD
  // ============================================================================

  // The tracking namespace is deliberately separate from eventCode. Event codes
  // may be edited for display; an issued identifier's prefix must not change.
  fastify.get("/:id/abstract-tracking-namespace", async (request, reply) => {
    const eventId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(eventId)) {
      return reply.status(400).send({ success: false, code: "INVALID_EVENT_ID", error: "Invalid event id" });
    }

    try {
      const [event] = await db
        .select({ id: events.id, eventCode: events.eventCode, archivedAt: events.archivedAt })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      if (!event) {
        return reply.status(404).send({ success: false, code: "EVENT_NOT_FOUND", error: "Event not found" });
      }

      const [namespace] = await db
        .select()
        .from(abstractTrackingNamespaces)
        .where(eq(abstractTrackingNamespaces.eventId, eventId))
        .limit(1);
      if (!namespace) {
        return reply.send({
          success: true,
          trackingNamespace: {
            eventId,
            configured: false,
            prefix: null,
            paddingWidth: null,
            lockedAt: null,
          },
          requestId: request.id,
        });
      }

      const counters = await db
        .select({ presentationType: abstractTrackingCounters.presentationType, lastIssuedNumber: abstractTrackingCounters.lastIssuedNumber })
        .from(abstractTrackingCounters)
        .where(eq(abstractTrackingCounters.namespaceId, namespace.id));

      return reply.send({
        success: true,
        trackingNamespace: {
          eventId,
          configured: true,
          prefix: namespace.prefix,
          paddingWidth: namespace.paddingWidth,
          lockedAt: namespace.lockedAt,
          counters,
          eventCode: event.eventCode,
          eventArchived: Boolean(event.archivedAt),
        },
        requestId: request.id,
      });
    } catch (error) {
      fastify.log.error({ err: error, eventId }, "Failed to fetch tracking namespace");
      return reply.status(500).send({ success: false, code: "TRACKING_NAMESPACE_READ_FAILED", error: "Failed to fetch tracking namespace", requestId: request.id });
    }
  });

  fastify.put("/:id/abstract-tracking-namespace", async (request, reply) => {
    const eventId = Number((request.params as { id: string }).id);
    const parsed = trackingNamespaceSchema.safeParse(request.body);
    if (!Number.isInteger(eventId) || !parsed.success) {
      return reply.status(422).send({ success: false, code: "INVALID_TRACKING_PREFIX", error: "Invalid tracking namespace", requestId: request.id });
    }

    let prefix: string;
    let paddingWidth: number;
    try {
      prefix = validateTrackingPrefix(parsed.data.prefix.trim());
      paddingWidth = validatePaddingWidth(parsed.data.paddingWidth);
      // Keep the current column contract safe for the default three digits.
      if (prefix.length + 3 + paddingWidth > 80) throw new Error("tracking prefix is too long");
    } catch {
      return reply.status(422).send({ success: false, code: "INVALID_TRACKING_PREFIX", error: "Invalid tracking namespace", requestId: request.id });
    }

    try {
      const result = await db.transaction(async (tx) => {
        const eventRows = await tx.execute(sql`
          SELECT id, archived_at
          FROM events
          WHERE id = ${eventId}
          FOR UPDATE
        `);
        const eventRow = (eventRows as unknown as Array<{ id: number; archived_at: Date | null }>)[0];
        if (!eventRow) return { notFound: true as const };

        const [existing] = await tx
          .select()
          .from(abstractTrackingNamespaces)
          .where(eq(abstractTrackingNamespaces.eventId, eventId))
          .limit(1);

        if (existing) {
          if (existing.lockedAt && (existing.prefix !== prefix || existing.paddingWidth !== paddingWidth)) {
            return { conflict: "TRACKING_PREFIX_LOCKED" as const };
          }
          const [conflicting] = await tx
            .select({ eventId: abstractTrackingNamespaces.eventId })
            .from(abstractTrackingNamespaces)
            .where(and(eq(abstractTrackingNamespaces.prefix, prefix), sql`${abstractTrackingNamespaces.eventId} <> ${eventId}`))
            .limit(1);
          if (conflicting) return { conflict: "TRACKING_PREFIX_IN_USE" as const };

          const [updated] = await tx
            .update(abstractTrackingNamespaces)
            .set({ prefix, paddingWidth, updatedAt: new Date() })
            .where(eq(abstractTrackingNamespaces.id, existing.id))
            .returning();
          await tx
            .insert(abstractTrackingCounters)
            .values([
              { namespaceId: existing.id, presentationType: "oral", lastIssuedNumber: 0 },
              { namespaceId: existing.id, presentationType: "poster", lastIssuedNumber: 0 },
            ])
            .onConflictDoNothing();
          return { namespace: updated };
        }

        const [conflicting] = await tx
          .select({ eventId: abstractTrackingNamespaces.eventId })
          .from(abstractTrackingNamespaces)
          .where(eq(abstractTrackingNamespaces.prefix, prefix))
          .limit(1);
        if (conflicting) return { conflict: "TRACKING_PREFIX_IN_USE" as const };

        const [namespace] = await tx
          .insert(abstractTrackingNamespaces)
          .values({ eventId, prefix, paddingWidth })
          .returning();
        await tx.insert(abstractTrackingCounters).values([
          { namespaceId: namespace.id, presentationType: "oral", lastIssuedNumber: 0 },
          { namespaceId: namespace.id, presentationType: "poster", lastIssuedNumber: 0 },
        ]);
        await appendTrackingAuditEvent(tx, {
          eventType: "abstract_tracking.prefix_configured",
          eventId,
          requestId: requestIdOf(request),
          reasonCode: "backoffice_namespace_configured",
          afterState: { prefix, paddingWidth },
        });
        return { namespace };
      });

      if ("notFound" in result) {
        return reply.status(404).send({ success: false, code: "EVENT_NOT_FOUND", error: "Event not found", requestId: request.id });
      }
      if ("conflict" in result) {
        const message = result.conflict === "TRACKING_PREFIX_LOCKED" ? "Tracking prefix is locked" : "Tracking prefix is already in use";
        return reply.status(409).send({ success: false, code: result.conflict, error: message, requestId: request.id });
      }
      return reply.send({
        success: true,
        trackingNamespace: {
          eventId,
          configured: true,
          prefix: result.namespace.prefix,
          paddingWidth: result.namespace.paddingWidth,
          lockedAt: result.namespace.lockedAt,
        },
        requestId: request.id,
      });
    } catch (error) {
      fastify.log.error({ err: error, eventId }, "Failed to configure tracking namespace");
      return reply.status(500).send({ success: false, code: "TRACKING_NAMESPACE_UPDATE_FAILED", error: "Failed to configure tracking namespace", requestId: request.id });
    }
  });

  const archiveEvent = async (request: any, reply: any) => {
    const eventId = Number(request.params?.id);
    const parsed = eventArchiveSchema.safeParse(request.body);
    if (!Number.isInteger(eventId) || !parsed.success) {
      return reply.status(400).send({ success: false, code: "VALIDATION_ERROR", error: "Invalid archive request", requestId: request.id });
    }
    const note = parsed.data.note?.trim() || null;
    try {
      const result = await db.transaction(async (tx) => {
        const rows = await tx.execute(sql`SELECT id, archived_at, archive_reason, archive_note FROM events WHERE id = ${eventId} FOR UPDATE`);
        const eventRow = (rows as unknown as Array<{ id: number; archived_at: Date | null; archive_reason: string | null; archive_note: string | null }>)[0];
        if (!eventRow) return { notFound: true as const };
        if (eventRow.archived_at) {
          if (eventRow.archive_reason !== parsed.data.reason || (eventRow.archive_note || null) !== note) return { conflict: "ARCHIVE_REASON_CONFLICT" as const };
          return { archived: true as const, archivedAt: eventRow.archived_at, reason: eventRow.archive_reason, note: eventRow.archive_note };
        }
        const [updated] = await tx.update(events).set({
          archivedAt: new Date(),
          archivedBy: request.user?.id ?? null,
          archiveReason: parsed.data.reason,
          archiveNote: note,
          updatedAt: new Date(),
        }).where(eq(events.id, eventId)).returning();
        await appendTrackingAuditEvent(tx, { eventType: "event.archived", eventId, actorId: request.user?.id, requestId: request.id, reasonCode: parsed.data.reason, afterState: { archived: true } });
        return { archived: true as const, archivedAt: updated.archivedAt, reason: updated.archiveReason, note: updated.archiveNote };
      });
      if ("notFound" in result) return reply.status(404).send({ success: false, code: "EVENT_NOT_FOUND", error: "Event not found", requestId: request.id });
      if ("conflict" in result) return reply.status(409).send({ success: false, code: result.conflict, error: "Archive reason conflicts with existing archive", requestId: request.id });
      return reply.send({ success: true, archival: result, requestId: request.id });
    } catch (error) {
      fastify.log.error({ err: error, eventId }, "Failed to archive event");
      return reply.status(500).send({ success: false, code: "EVENT_ARCHIVE_FAILED", error: "Failed to archive event", requestId: request.id });
    }
  };

  fastify.put("/:id/archival", archiveEvent);
  fastify.delete("/:id/archival", async (request: any, reply) => {
    const eventId = Number(request.params?.id);
    if (!Number.isInteger(eventId)) return reply.status(400).send({ success: false, code: "INVALID_EVENT_ID", error: "Invalid event id", requestId: request.id });
    try {
      const result = await db.transaction(async (tx) => {
        const rows = await tx.execute(sql`SELECT id, archived_at, archive_reason, archive_note FROM events WHERE id = ${eventId} FOR UPDATE`);
        const eventRow = (rows as unknown as Array<{ id: number; archived_at: Date | null; archive_reason: string | null; archive_note: string | null }>)[0];
        if (!eventRow) return null;
        if (!eventRow.archived_at) return { restored: false, archivedAt: null, reason: null, note: null };
        const [updated] = await tx.update(events).set({ archivedAt: null, archivedBy: null, archiveReason: null, archiveNote: null, updatedAt: new Date() }).where(eq(events.id, eventId)).returning();
        await appendTrackingAuditEvent(tx, { eventType: "event.restored", eventId, actorId: request.user?.id, requestId: request.id, afterState: { archived: false } });
        return { restored: true, archivedAt: updated.archivedAt, reason: updated.archiveReason, note: updated.archiveNote };
      });
      if (!result) return reply.status(404).send({ success: false, code: "EVENT_NOT_FOUND", error: "Event not found", requestId: request.id });
      return reply.send({ success: true, archival: result, requestId: request.id });
    } catch (error) {
      fastify.log.error({ err: error, eventId }, "Failed to restore event");
      return reply.status(500).send({ success: false, code: "EVENT_RESTORE_FAILED", error: "Failed to restore event", requestId: request.id });
    }
  });

  // List Events with pagination and filters
  fastify.get("", async (request, reply) => {
    const queryResult = eventQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply
        .status(400)
        .send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { status, eventType, search, page, limit } = queryResult.data;
    const offset = (page - 1) * limit;

    // Get user from request (set by auth middleware)
    const user = (request as { user?: JWTPayload }).user;

    try {
      // Build where conditions
      const conditions = [];

      // If user is not admin, filter by assigned events only
      if (user && user.role !== "admin") {
        const assignments = await db
          .select({ eventId: staffEventAssignments.eventId })
          .from(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, user.id));

        const assignedEventIds = assignments.map((a) => a.eventId);

        if (assignedEventIds.length === 0) {
          // No assignments, return empty list
          return reply.send({
            events: [],
            pagination: {
              page,
              limit,
              total: 0,
              totalPages: 0,
            },
          });
        }

        conditions.push(inArray(events.id, assignedEventIds));
      }

      if (status) {
        conditions.push(eq(events.status, status));
      }
      if (eventType) {
        conditions.push(eq(events.eventType, eventType));
      }
      if (search) {
        conditions.push(ilike(events.eventName, `%${search}%`));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Get total count
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(events)
        .where(whereClause);

      // Get events
      const eventList = await db
        .select()
        .from(events)
        .where(whereClause)
        .orderBy(desc(events.createdAt))
        .limit(limit)
        .offset(offset);

      return reply.send({
        events: eventList,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch events" });
    }
  });

  // Get Single Event by ID (with sessions and tickets)
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, parseInt(id)))
        .limit(1);

      if (!event) {
        return reply.status(404).send({ error: "Event not found" });
      }

      // Get sessions for this event
      const sessionList = await db
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, parseInt(id)))
        .orderBy(sessions.startTime);

      // Fetch speakers for these sessions (batch query to avoid N+1)
      const sessionIds = sessionList.map((s) => s.id);
      const allSpeakers =
        sessionIds.length > 0
          ? await db
            .select({
              sessionId: eventSpeakers.sessionId,
              firstName: speakers.firstName,
              lastName: speakers.lastName,
            })
            .from(eventSpeakers)
            .innerJoin(speakers, eq(eventSpeakers.speakerId, speakers.id))
            .where(inArray(eventSpeakers.sessionId, sessionIds))
          : [];

      // Group speakers by session in memory
      const speakersBySession = allSpeakers.reduce<Record<number, string[]>>(
        (acc, s) => {
          if (s.sessionId === null) return acc;
          if (!acc[s.sessionId]) acc[s.sessionId] = [];
          acc[s.sessionId].push(`${s.firstName} ${s.lastName}`);
          return acc;
        },
        {},
      );

      const sessionsWithSpeakers = sessionList.map((s) => ({
        ...s,
        speakers: speakersBySession[s.id] || [],
      }));

      // Get tickets for this event
      const eventTickets = await db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, parseInt(id)));

      // Get venue images
      const venueImages = await db
        .select()
        .from(eventImages)
        .where(eq(eventImages.eventId, parseInt(id)))
        .orderBy(eventImages.sortOrder);

      return reply.send({
        event,
        sessions: sessionsWithSpeakers,
        tickets: eventTickets,
        venueImages,
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch event" });
    }
  });

  // Create Event
  fastify.post("", async (request, reply) => {
    const result = createEventSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;

    try {
      // Check if event code already exists
      const existing = await db
        .select()
        .from(events)
        .where(eq(events.eventCode, data.eventCode))
        .limit(1);

      if (existing.length > 0) {
        return reply.status(409).send({ error: "Event code already exists" });
      }

      const [newEvent] = await db
        .insert(events)
        .values({
          eventCode: data.eventCode,
          eventName: data.eventName,
          shortName: data.shortName,
          description: data.description,
          eventType: data.eventType,
          location: data.location,
          category: data.category,
          startDate: new Date(data.startDate),
          endDate: new Date(data.endDate),
          maxCapacity: data.maxCapacity,
          conferenceCode: data.conferenceCode,
          cpeCredits:
            data.cpeCredits != null ? String(data.cpeCredits) : undefined,
          status: data.status,
          imageUrl: data.imageUrl,
          coverImage: data.coverImage,
          videoUrl: data.videoUrl,
          mapUrl: data.mapUrl,
          websiteUrl: data.websiteUrl,
          abstractStartDate: data.abstractStartDate
            ? new Date(new Date(data.abstractStartDate).setHours(0, 0, 0, 0))
            : null,
          abstractEndDate: data.abstractEndDate
            ? new Date(new Date(data.abstractEndDate).setHours(0, 0, 0, 0))
            : null,
          documents: data.documents,
        })
        .returning();

      return reply.status(201).send({ event: newEvent });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create event" });
    }
  });

  // Update Event
  fastify.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateEventSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;

    try {
      // Check if event code already exists (if updating eventCode)
      if (data.eventCode) {
        const existing = await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.eventCode, data.eventCode),
              sql`${events.id} != ${parseInt(id)}`,
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          return reply.status(409).send({ error: "Event code already exists" });
        }
      }

      const updates: Record<string, unknown> = {
        ...data,
        updatedAt: new Date(),
      };

      // Convert date strings to Date objects
      if (data.startDate)
        updates.startDate = new Date(data.startDate);
      if (data.endDate)
        updates.endDate = new Date(data.endDate);
      if (data.abstractStartDate)
        updates.abstractStartDate = new Date(
          new Date(data.abstractStartDate).setHours(0, 0, 0, 0),
        );
      if (data.abstractEndDate)
        updates.abstractEndDate = new Date(
          new Date(data.abstractEndDate).setHours(0, 0, 0, 0),
        );

      const [updatedEvent] = await db
        .update(events)
        .set(updates)
        .where(eq(events.id, parseInt(id)))
        .returning();

      if (!updatedEvent) {
        return reply.status(404).send({ error: "Event not found" });
      }

      return reply.send({ event: updatedEvent });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update event" });
    }
  });

  // Delete Event
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const eventId = parseInt(id);

    try {
      const [trackingNamespace] = await db
        .select({ id: abstractTrackingNamespaces.id })
        .from(abstractTrackingNamespaces)
        .where(eq(abstractTrackingNamespaces.eventId, eventId))
        .limit(1);
      const [abstractWithIdentifier] = await db
        .select({ id: abstracts.id })
        .from(abstracts)
        .where(and(eq(abstracts.eventId, eventId), sql`${abstracts.trackingId} IS NOT NULL`))
        .limit(1);
      if (trackingNamespace || abstractWithIdentifier) {
        return reply.status(409).send({
          success: false,
          code: "HARD_DELETE_NOT_ALLOWED",
          error: "Event has tracking identifiers; archive it instead.",
          requestId: request.id,
        });
      }

      // Check for related tickets
      const relatedTickets = await db
        .select({ id: ticketTypes.id })
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, eventId))
        .limit(1);

      if (relatedTickets.length > 0) {
        return reply.status(409).send({
          error:
            "Cannot delete event with existing tickets. Please delete all tickets first.",
        });
      }

      // Check for related sessions
      const relatedSessions = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.eventId, eventId))
        .limit(1);

      if (relatedSessions.length > 0) {
        return reply.status(409).send({
          error:
            "Cannot delete event with existing sessions. Please delete all sessions first.",
        });
      }

      const [deletedEvent] = await db
        .delete(events)
        .where(eq(events.id, eventId))
        .returning();

      if (!deletedEvent) {
        return reply.status(404).send({ error: "Event not found" });
      }

      return reply.send({ success: true, message: "Event deleted" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to delete event" });
    }
  });

  // ============================================================================
  // SESSIONS CRUD (nested under events)
  // ============================================================================

  // List Sessions for an Event
  fastify.get("/:eventId/sessions", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };

    try {
      const sessionList = await db
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, parseInt(eventId)))
        .orderBy(sessions.startTime);

      // Fetch speakers for these sessions (batch query to avoid N+1)
      const sessionIds = sessionList.map((s) => s.id);
      const allSpeakers =
        sessionIds.length > 0
          ? await db
            .select({
              sessionId: eventSpeakers.sessionId,
              firstName: speakers.firstName,
              lastName: speakers.lastName,
            })
            .from(eventSpeakers)
            .innerJoin(speakers, eq(eventSpeakers.speakerId, speakers.id))
            .where(inArray(eventSpeakers.sessionId, sessionIds))
          : [];

      // Group speakers by session in memory
      const speakersBySession = allSpeakers.reduce<Record<number, string[]>>(
        (acc, s) => {
          if (s.sessionId === null) return acc;
          if (!acc[s.sessionId]) acc[s.sessionId] = [];
          acc[s.sessionId].push(`${s.firstName} ${s.lastName}`);
          return acc;
        },
        {},
      );

      const sessionsWithSpeakers = sessionList.map((s) => ({
        ...s,
        speakers: speakersBySession[s.id] || [],
      }));

      return reply.send({ sessions: sessionsWithSpeakers });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch sessions" });
    }
  });

  // Create Session
  fastify.post("/:eventId/sessions", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const result = createSessionSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;

    try {
      // Verify event exists
      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, parseInt(eventId)))
        .limit(1);

      if (!event) {
        return reply.status(404).send({ error: "Event not found" });
      }

      const newSession = await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(sessions)
          .values({
            eventId: parseInt(eventId),
            sessionCode: data.sessionCode,
            sessionName: data.sessionName,
            sessionType: data.sessionType,
            isMainSession: data.isMainSession ?? false,
            requiresOptIn: data.requiresOptIn ?? false,
            description: data.description,
            room: data.room,
            startTime: new Date(data.startTime),
            endTime: new Date(data.endTime),
            maxCapacity: data.maxCapacity,
            agenda: data.agenda ?? null,
          })
          .returning();

        // Handle speaker assignments
        if (data.speakerIds && data.speakerIds.length > 0) {
          await tx.insert(eventSpeakers).values(
            data.speakerIds.map((sid) => ({
              eventId: parseInt(eventId),
              sessionId: session.id,
              speakerId: sid,
              speakerType: "guest" as const, // Default to guest, can be updated later if needed
              sortOrder: 0,
            })),
          );
        }

        return session;
      });

      return reply.status(201).send({ session: newSession });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create session" });
    }
  });

  // Update Session
  fastify.patch("/:eventId/sessions/:sessionId", async (request, reply) => {
    const { eventId, sessionId } = request.params as {
      eventId: string;
      sessionId: string;
    };
    const result = updateSessionSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;
    const { speakerIds, ...dbFields } = data;
    const updates: Record<string, unknown> = { ...dbFields, updatedAt: new Date() };

    if (data.startTime) updates.startTime = new Date(data.startTime);
    if (data.endTime) updates.endTime = new Date(data.endTime);

    try {
      const updatedSession = await db.transaction(async (tx) => {
        const [session] = await tx
          .update(sessions)
          .set(updates)
          .where(eq(sessions.id, parseInt(sessionId)))
          .returning();

        if (!session) return null;

        // Handle speaker assignments update if provided
        if (data.speakerIds !== undefined) {
          // Delete existing mappings for this session
          await tx
            .delete(eventSpeakers)
            .where(eq(eventSpeakers.sessionId, session.id));

          // Add new mappings
          if (data.speakerIds && data.speakerIds.length > 0) {
            await tx.insert(eventSpeakers).values(
              data.speakerIds.map((sid) => ({
                eventId: parseInt(eventId),
                sessionId: session.id,
                speakerId: sid,
                speakerType: "guest" as const,
                sortOrder: 0,
              })),
            );
          }
        }

        return session;
      });

      if (!updatedSession) {
        return reply.status(404).send({ error: "Session not found" });
      }

      return reply.send({ session: updatedSession });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update session" });
    }
  });

  // Delete Session
  fastify.delete("/:eventId/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as {
      eventId: string;
      sessionId: string;
    };

    try {
      const [deletedSession] = await db
        .delete(sessions)
        .where(eq(sessions.id, parseInt(sessionId)))
        .returning();

      if (!deletedSession) {
        return reply.status(404).send({ error: "Session not found" });
      }

      return reply.send({ success: true, message: "Session deleted" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to delete session" });
    }
  });

  // Get Session Enrollments (people registered for this session)
  fastify.get(
    "/:eventId/sessions/:sessionId/enrollments",
    async (request, reply) => {
      const { sessionId } = request.params as {
        eventId: string;
        sessionId: string;
      };

      try {
        // Query via registration_sessions junction table
        const enrollmentList = await db
          .select({
            id: registrations.id,
            regCode: registrations.regCode,
            email: registrations.email,
            firstName: registrations.firstName,
            lastName: registrations.lastName,
            status: registrations.status,
            createdAt: registrations.createdAt,
            ticketTypeId: registrationSessions.ticketTypeId,
            ticketName: ticketTypes.name,
          })
          .from(registrationSessions)
          .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
          .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
          .where(
            and(
              eq(registrationSessions.sessionId, parseInt(sessionId)),
              eq(registrations.status, "confirmed")
            )
          )
          .orderBy(desc(registrations.createdAt));

        return reply.send({
          enrollments: enrollmentList,
          count: enrollmentList.length,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: "Failed to fetch session enrollments" });
      }
    },
  );

  // ============================================================================
  // TICKET TYPES CRUD (nested under events)
  // ============================================================================

  // List Ticket Types for an Event
  fastify.get("/:eventId/tickets", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };

    try {
      const ticketList = await db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, parseInt(eventId)));

      // Fetch linked sessions for all tickets in ONE query (avoid N+1)
      const ticketIds = ticketList.map((t) => t.id);
      const allSessionLinks =
        ticketIds.length > 0
          ? await db
            .select()
            .from(ticketSessions)
            .where(inArray(ticketSessions.ticketTypeId, ticketIds))
          : [];

      // Group session links by ticket in memory
      const sessionsByTicket = allSessionLinks.reduce<Record<number, number[]>>(
        (acc, link) => {
          if (!acc[link.ticketTypeId]) acc[link.ticketTypeId] = [];
          acc[link.ticketTypeId].push(link.sessionId);
          return acc;
        },
        {},
      );

      const ticketsWithSessions = ticketList.map((t) => ({
        ...t,
        sessionIds: sessionsByTicket[t.id] || [],
      }));

      return reply.send({ tickets: ticketsWithSessions });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch tickets" });
    }
  });

  // Create Ticket Type
  fastify.post("/:eventId/tickets", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const result = createTicketTypeSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;

    try {
      // Verify event exists
      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, parseInt(eventId)))
        .limit(1);

      if (!event) {
        return reply.status(404).send({ error: "Event not found" });
      }

      // Start transaction
      const newTicket = await db.transaction(async (tx) => {
        const [ticket] = await tx
          .insert(ticketTypes)
          .values({
            eventId: parseInt(eventId),
            category: data.category,
            priority: data.priority || "regular",
            groupName: data.groupName,
            name: data.name,
            sessionId: data.sessionId, // Keep for backward compat
            price: String(data.price),
            currency: data.currency,
            allowedRoles: normalizeAllowedRoles(data.allowedRoles),
            allowedStudentLevels: normalizeAllowedRoles(data.allowedStudentLevels), // Reuse same normalization
            quota: data.quota,
            displayOrder: calculateDisplayOrder(data.priority || "regular", data.saleStartDate),
            saleStartDate: data.saleStartDate
              ? new Date(data.saleStartDate)
              : null,
            saleEndDate: data.saleEndDate ? new Date(data.saleEndDate) : null,
            description: data.description,
            originalPrice:
              data.originalPrice != null
                ? String(data.originalPrice)
                : null,
            features: data.features,
            badgeText: data.badgeText,
            isActive: data.isActive ?? true,
          })
          .returning();

        // Handle session linking
        const sessionsToLink =
          data.sessionIds || (data.sessionId ? [data.sessionId] : []);

        if (sessionsToLink.length > 0) {
          await tx.insert(ticketSessions).values(
            sessionsToLink.map((sid) => ({
              ticketTypeId: ticket.id,
              sessionId: sid,
            })),
          );
        }

        return {
          ...ticket,
          sessionIds: sessionsToLink,
        };
      });

      return reply.status(201).send({ ticket: newTicket });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create ticket" });
    }
  });

  // Update Ticket Type
  fastify.patch("/:eventId/tickets/:ticketId", async (request, reply) => {
    const { ticketId } = request.params as {
      eventId: string;
      ticketId: string;
    };
    const result = updateTicketTypeSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;
    const updates: Record<string, unknown> = { ...data };

    // Remove fields that aren't direct DB columns
    delete updates.sessionIds;
    delete updates.sessionId;

    if (data.allowedRoles !== undefined) updates.allowedRoles = normalizeAllowedRoles(data.allowedRoles);
    if (data.allowedStudentLevels !== undefined) updates.allowedStudentLevels = normalizeAllowedRoles(data.allowedStudentLevels);
    if (data.price !== undefined) updates.price = String(data.price);
    if (data.originalPrice !== undefined)
      updates.originalPrice =
        data.originalPrice != null ? String(data.originalPrice) : null;
    if (data.saleStartDate)
      updates.saleStartDate = new Date(data.saleStartDate);
    if (data.saleEndDate) updates.saleEndDate = new Date(data.saleEndDate);

    // Auto-recalculate displayOrder when priority or saleStartDate changes
    if (data.priority !== undefined || data.saleStartDate !== undefined) {
      const [existing] = await db
        .select({
          priority: ticketTypes.priority,
          saleStartDate: ticketTypes.saleStartDate,
        })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, parseInt(ticketId)))
        .limit(1);

      if (existing) {
        const newPriority = data.priority || existing.priority || "regular";
        const newSaleStart = data.saleStartDate || existing.saleStartDate;
        updates.displayOrder = calculateDisplayOrder(newPriority, newSaleStart);
      }
    }

    try {
      const updatedTicket = await db.transaction(async (tx) => {
        const [ticket] = await tx
          .update(ticketTypes)
          .set(updates)
          .where(eq(ticketTypes.id, parseInt(ticketId)))
          .returning();

        if (!ticket) return null;

        // Handle session linking update if provided
        if (data.sessionIds !== undefined) {
          // Delete existing links
          await tx
            .delete(ticketSessions)
            .where(eq(ticketSessions.ticketTypeId, ticket.id));

          // Add new links
          if (data.sessionIds && data.sessionIds.length > 0) {
            await tx.insert(ticketSessions).values(
              data.sessionIds.map((sid) => ({
                ticketTypeId: ticket.id,
                sessionId: sid,
              })),
            );
          }
        } else if (data.sessionId !== undefined) {
          // Backward compatibility: if only sessionId is provided
          await tx
            .delete(ticketSessions)
            .where(eq(ticketSessions.ticketTypeId, ticket.id));
          if (data.sessionId) {
            await tx.insert(ticketSessions).values({
              ticketTypeId: ticket.id,
              sessionId: data.sessionId,
            });
          }
        }

        // Get current linked sessions
        const linkedSessions = await tx
          .select({ sessionId: ticketSessions.sessionId })
          .from(ticketSessions)
          .where(eq(ticketSessions.ticketTypeId, ticket.id));

        return {
          ...ticket,
          sessionIds: linkedSessions.map((ls) => ls.sessionId),
        };
      });

      if (!updatedTicket) {
        return reply.status(404).send({ error: "Ticket not found" });
      }

      return reply.send({ ticket: updatedTicket });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update ticket" });
    }
  });

  // Delete Ticket Type
  fastify.delete("/:eventId/tickets/:ticketId", async (request, reply) => {
    const { ticketId } = request.params as {
      eventId: string;
      ticketId: string;
    };

    try {
      const [deletedTicket] = await db
        .delete(ticketTypes)
        .where(eq(ticketTypes.id, parseInt(ticketId)))
        .returning();

      if (!deletedTicket) {
        return reply.status(404).send({ error: "Ticket not found" });
      }

      return reply.send({ success: true, message: "Ticket deleted" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to delete ticket" });
    }
  });

  // ============================================================================
  // EVENT IMAGES
  // ============================================================================

  // Add venue image
  fastify.post("/:eventId/images", async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const {
      imageUrl,
      caption,
      imageType = "venue",
    } = request.body as {
      imageUrl: string;
      caption?: string;
      imageType?: string;
    };

    if (!imageUrl) {
      return reply.status(400).send({ error: "imageUrl is required" });
    }

    try {
      // Get next sort order
      const lastImage = await db
        .select({ sortOrder: eventImages.sortOrder })
        .from(eventImages)
        .where(eq(eventImages.eventId, parseInt(eventId)))
        .orderBy(desc(eventImages.sortOrder))
        .limit(1);

      const nextSortOrder = (lastImage[0]?.sortOrder ?? -1) + 1;

      const [newImage] = await db
        .insert(eventImages)
        .values({
          eventId: parseInt(eventId),
          imageUrl,
          caption,
          imageType,
          sortOrder: nextSortOrder,
        })
        .returning();

      return reply.status(201).send({ image: newImage });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to add image" });
    }
  });

  // Delete venue image
  fastify.delete("/:eventId/images/:imageId", async (request, reply) => {
    const { imageId } = request.params as { eventId: string; imageId: string };

    try {
      const [deletedImage] = await db
        .delete(eventImages)
        .where(eq(eventImages.id, parseInt(imageId)))
        .returning();

      if (!deletedImage) {
        return reply.status(404).send({ error: "Image not found" });
      }

      return reply.send({ success: true, message: "Image deleted" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to delete image" });
    }
  });
}
