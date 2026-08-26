import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  users,
  orders,
  orderItems,
  payments,
  registrations,
  registrationSessions,
  registrationAddons,
  checkIns,
  abstracts,
  abstractReviews,
  passwordResetTokens,
  verificationRejectionHistory,
  staffEventAssignments,
  events,
} from "../../database/schema.js";
import { eq, desc, ilike, or, count, and, SQL, inArray, exists, sql } from "drizzle-orm";
import { z } from "zod";
import { appendTrackingAuditEvent } from "../../modules/abstracts/tracking.repository.js";

// Query schema for listing members
const listMembersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  role: z.enum(["pharmacist", "medical_professional", "general", "student"]).optional(),
  status: z.enum(["pending_approval", "active", "rejected"]).optional(),
  eventId: z.coerce.number().int().positive().optional(),
});

const memberStatsQuerySchema = z.object({
  eventId: z.coerce.number().int().positive().optional(),
});

export default async function (fastify: FastifyInstance) {
  // List Members (users from users table)
  fastify.get("", async (request, reply) => {
    const queryResult = listMembersQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search, role, status, eventId } = queryResult.data;
    const offset = (page - 1) * limit;
    const staffUser = (request as any).user;

    try {
      const conditions: SQL[] = [];

      // Filter by role
      if (role) {
        conditions.push(eq(users.role, role));
      }

      // Filter by status
      if (status) {
        conditions.push(eq(users.status, status));
      }

      // Scope non-admin users to accounts created from their assigned events.
      // Member identity is based on users.registeredFromEvent, not ticket registration.
      if (staffUser.role !== "admin") {
        const assignments = await db
          .select({ eventId: staffEventAssignments.eventId })
          .from(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, staffUser.id));
        const assignedEventIds = assignments.map((assignment) => assignment.eventId);

        if (assignedEventIds.length === 0 || (eventId && !assignedEventIds.includes(eventId))) {
          return reply.send({
            members: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          });
        }

        const scopedEventIds = eventId ? [eventId] : assignedEventIds;
        const scopedEvents = await db
          .select({ eventCode: events.eventCode })
          .from(events)
          .where(inArray(events.id, scopedEventIds));
        const scopedEventCodes = scopedEvents.map((event) => event.eventCode);

        if (scopedEventCodes.length === 0) {
          return reply.send({
            members: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          });
        }

        conditions.push(inArray(users.registeredFromEvent, scopedEventCodes));
      } else if (eventId) {
        const [selectedEvent] = await db
          .select({ eventCode: events.eventCode })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);

        if (!selectedEvent) {
          return reply.send({
            members: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          });
        }

        conditions.push(eq(users.registeredFromEvent, selectedEvent.eventCode));
      }

      // Search by name or email
      if (search) {
        conditions.push(
          or(
            ilike(users.firstName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
            ilike(users.email, `%${search}%`)
          )!
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Count total
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(users)
        .where(whereClause);

      // Fetch members
      const members = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          phone: users.phone,
          country: users.country,
          institution: users.institution,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

      return reply.send({
        members,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch members" });
    }
  });

  // Get single member by ID
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const staffUser = (request as any).user;

    try {
      const memberConditions: SQL[] = [eq(users.id, parseInt(id))];
      if (staffUser.role !== "admin") {
        const assignments = await db
          .select({ eventId: staffEventAssignments.eventId })
          .from(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, staffUser.id));
        const assignedEventIds = assignments.map((assignment) => assignment.eventId);
        if (assignedEventIds.length === 0) {
          return reply.status(404).send({ error: "Member not found" });
        }

        const assignedEvents = await db
          .select({ eventCode: events.eventCode })
          .from(events)
          .where(inArray(events.id, assignedEventIds));
        const assignedEventCodes = assignedEvents.map((event) => event.eventCode);
        if (assignedEventCodes.length === 0) {
          return reply.status(404).send({ error: "Member not found" });
        }

        memberConditions.push(inArray(users.registeredFromEvent, assignedEventCodes));
      }

      const [member] = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          phone: users.phone,
          country: users.country,
          institution: users.institution,
          thaiIdCard: users.thaiIdCard,
          passportId: users.passportId,
          pharmacyLicenseId: users.pharmacyLicenseId,
          verificationDocUrl: users.verificationDocUrl,
          rejectionReason: users.rejectionReason,
          resubmissionCount: users.resubmissionCount,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(and(...memberConditions));

      if (!member) {
        return reply.status(404).send({ error: "Member not found" });
      }

      return reply.send({ member });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch member" });
    }
  });

  // Get member statistics
  fastify.get("/stats/summary", async (request, reply) => {
    const queryResult = memberStatsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { eventId } = queryResult.data;
    const staffUser = (request as any).user;

    try {
      let scopeCondition: SQL | undefined;
      let purchaseEventIds: number[] | undefined;

      if (staffUser.role !== "admin") {
        const assignments = await db
          .select({ eventId: staffEventAssignments.eventId })
          .from(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, staffUser.id));
        const assignedEventIds = assignments.map((assignment) => assignment.eventId);

        if (assignedEventIds.length === 0 || (eventId && !assignedEventIds.includes(eventId))) {
          return reply.send({ total: 0, purchased: 0, notPurchased: 0, byRole: [], byStatus: [] });
        }

        const scopedEventIds = eventId ? [eventId] : assignedEventIds;
        const scopedEvents = await db
          .select({ eventCode: events.eventCode })
          .from(events)
          .where(inArray(events.id, scopedEventIds));
        const scopedEventCodes = scopedEvents.map((event) => event.eventCode);

        if (scopedEventCodes.length === 0) {
          return reply.send({ total: 0, purchased: 0, notPurchased: 0, byRole: [], byStatus: [] });
        }

        scopeCondition = inArray(users.registeredFromEvent, scopedEventCodes);
        purchaseEventIds = scopedEventIds;
      } else if (eventId) {
        const [selectedEvent] = await db
          .select({ eventCode: events.eventCode })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);

        if (!selectedEvent) {
          return reply.send({ total: 0, purchased: 0, notPurchased: 0, byRole: [], byStatus: [] });
        }

        scopeCondition = eq(users.registeredFromEvent, selectedEvent.eventCode);
        purchaseEventIds = [eventId];
      }

      // Count by role inside the authenticated event scope.
      const roleStats = await db
        .select({
          role: users.role,
          count: count(),
        })
        .from(users)
        .where(scopeCondition)
        .groupBy(users.role);

      // Count by status inside the authenticated event scope.
      const statusStats = await db
        .select({
          status: users.status,
          count: count(),
        })
        .from(users)
        .where(scopeCondition)
        .groupBy(users.status);

      // Total count inside the authenticated event scope.
      const [{ total }] = await db
        .select({ total: count() })
        .from(users)
        .where(scopeCondition);

      const registrationConditions: SQL[] = [
        eq(registrations.userId, users.id),
        eq(registrations.status, "confirmed"),
      ];
      if (purchaseEventIds) {
        registrationConditions.push(inArray(registrations.eventId, purchaseEventIds));
      }

      const hasPurchasedTicket = exists(
        db.select({ id: registrations.id })
          .from(registrations)
          .where(and(...registrationConditions))
      );
      const purchasedWhere = scopeCondition
        ? and(scopeCondition, hasPurchasedTicket)
        : hasPurchasedTicket;

      const [{ purchased }] = await db
        .select({ purchased: count() })
        .from(users)
        .where(purchasedWhere);

      return reply.send({
        total,
        purchased,
        notPurchased: Math.max(total - purchased, 0),
        byRole: roleStats,
        byStatus: statusStats,
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch stats" });
    }
  });

  // Delete Member
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);
    const staffUser = (request as any).user;
    if (staffUser.role !== "admin") {
      return reply.status(403).send({ error: "Admin access required" });
    }

    try {
      // Check if user exists
      const [member] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId));

      if (!member) {
        return reply.status(404).send({ error: "Member not found" });
      }

      // Execute cleanup in one transaction. Abstracts are archived/unlinked,
      // never deleted, so issued tracking IDs remain reserved forever.
      const archivedAbstractCount = await db.transaction(async (tx) => {
        // 1. Verification rejection history
        await tx.delete(verificationRejectionHistory).where(eq(verificationRejectionHistory.userId, userId));

        // 2. Password reset tokens
        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));

        // 3. Abstract reviews (where user is REVIEWER)
        await tx.delete(abstractReviews).where(eq(abstractReviews.reviewerId, userId));

        // 3.1. Preserve reviews on archived abstracts.
        const userAbstracts = await tx
          .select({ id: abstracts.id, eventId: abstracts.eventId, trackingId: abstracts.trackingId })
          .from(abstracts)
          .where(eq(abstracts.userId, userId));

        // Match submit/resubmit lock order: event rows are locked before any
        // abstract rows. Sort IDs to avoid deadlocks across multi-event users.
        const eventIds = [...new Set(userAbstracts.map((abstract) => abstract.eventId))].sort((a, b) => a - b);
        for (const eventId of eventIds) {
          await tx.execute(sql`SELECT id FROM events WHERE id = ${eventId} FOR UPDATE`);
        }

        if (userAbstracts.length > 0) {
          for (const abstract of userAbstracts) {
            await tx
              .update(abstracts)
              .set({
                archivedAt: new Date(),
                archiveReason: "member_deleted",
                archiveNote: null,
                userId: null,
              })
              .where(eq(abstracts.id, abstract.id));

            await appendTrackingAuditEvent(tx, {
              eventType: "abstract.member_unlinked",
              eventId: abstract.eventId,
              abstractId: abstract.id,
              reasonCode: "member_deleted",
              requestId: request.id,
              beforeState: { trackingId: abstract.trackingId, userId },
              afterState: { trackingId: abstract.trackingId, archived: true, userId: null },
            });
          }
        }

        // 5. Get user's registrations for cascading
        const userRegistrations = await tx
          .select({ id: registrations.id })
          .from(registrations)
          .where(eq(registrations.userId, userId));

        if (userRegistrations.length > 0) {
          const regIds = userRegistrations.map((r) => r.id);

          // 5a. Check-ins
          await tx.delete(checkIns).where(inArray(checkIns.registrationId, regIds));

          // 5b. Registration sessions
          await tx.delete(registrationSessions).where(inArray(registrationSessions.registrationId, regIds));

          // 5c. Registration addons
          await tx.delete(registrationAddons).where(inArray(registrationAddons.registrationId, regIds));
        }

        // 6. Get user's orders for cascading
        const userOrders = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.userId, userId));

        if (userOrders.length > 0) {
          const orderIds = userOrders.map((o) => o.id);

          // 6a. Order items
          await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));

          // 6b. Payments
          await tx.delete(payments).where(inArray(payments.orderId, orderIds));
        }

        // 7. Registrations
        await tx.delete(registrations).where(eq(registrations.userId, userId));

        // 8. Orders
        await tx.delete(orders).where(eq(orders.userId, userId));

        // 9. Finally delete the user
        const [deletedUser] = await tx
          .delete(users)
          .where(eq(users.id, userId))
          .returning({ id: users.id });

        if (!deletedUser) {
          throw new Error("Failed to delete user record");
        }

        return userAbstracts.length;
      });

      return reply.send({
        success: true,
        message: "Member deleted",
        archivedAbstractCount,
        identifiersPreserved: true,
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        code: "INTERNAL_ERROR",
        error: "Failed to delete member",
        requestId: request.id,
      });
    }
  });
}
