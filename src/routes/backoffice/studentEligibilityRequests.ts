import { FastifyInstance } from "fastify";
import { and, count, desc, eq, ilike, or, SQL } from "drizzle-orm";
import z from "zod";
import { db } from "../../database/index.js";
import {
  backofficeUsers,
  eventStudentEligibilityRequests,
  events,
  users,
} from "../../database/schema.js";
import {
  sendEventStudentEligibilityApprovedEmail,
  sendEventStudentEligibilityRejectedEmail,
} from "../../services/emailTemplates.js";
import {
  buildEventEmailContext,
  type EventEmailRow,
} from "../../services/emailTemplates.types.js";

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  eventId: z.coerce.number().min(1).optional(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
  search: z.string().trim().optional(),
});

const reviewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("approved"),
    reviewNote: z.string().trim().max(1000).optional(),
  }),
  z.object({
    status: z.literal("rejected"),
    rejectionReason: z.string().trim().min(1, "Rejection reason is required").max(1000),
    reviewNote: z.string().trim().max(1000).optional(),
  }),
]);

function mapRequest(row: {
  id: number;
  eventId: number;
  eventCode: string;
  eventName: string;
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  pharmacyLicenseId: string | null;
  institution: string | null;
  studentLevel: string;
  status: string;
  documentFileName: string;
  documentFileUrl: string;
  documentFileType: string | null;
  documentFileSize: number | null;
  rejectionReason: string | null;
  reviewNote: string | null;
  reviewedBy: number | null;
  reviewerFirstName: string | null;
  reviewerLastName: string | null;
  reviewedAt: Date | null;
  resubmissionCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    eventId: row.eventId,
    eventCode: row.eventCode,
    eventName: row.eventName,
    userId: row.userId,
    name: `${row.firstName} ${row.lastName}`.trim(),
    email: row.email,
    role: row.role,
    pharmacyLicenseId: row.pharmacyLicenseId,
    institution: row.institution,
    studentLevel: row.studentLevel,
    status: row.status,
    documentFileName: row.documentFileName,
    documentUrl: row.documentFileUrl,
    documentFileType: row.documentFileType,
    documentFileSize: row.documentFileSize,
    rejectionReason: row.rejectionReason,
    reviewNote: row.reviewNote,
    reviewedBy: row.reviewedBy,
    reviewedByName:
      row.reviewerFirstName || row.reviewerLastName
        ? `${row.reviewerFirstName || ""} ${row.reviewerLastName || ""}`.trim()
        : null,
    reviewedAt: row.reviewedAt?.toISOString() || null,
    resubmissionCount: row.resubmissionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sendReviewEmailInBackground(
  log: FastifyInstance["log"],
  row: {
    id: number;
    status: string;
    email: string;
    firstName: string;
    lastName: string;
    rejectionReason: string | null;
    reviewNote: string | null;
    eventName: string;
    startDate: Date;
    endDate: Date;
    location: string | null;
    websiteUrl: string | null;
    shortName: string | null;
  },
) {
  void (async () => {
    try {
      const eventCtx = buildEventEmailContext(row as EventEmailRow);

      if (row.status === "approved") {
        await sendEventStudentEligibilityApprovedEmail(
          row.email,
          row.firstName,
          row.lastName,
          eventCtx,
          row.reviewNote || undefined,
        );
      } else if (row.status === "rejected") {
        await sendEventStudentEligibilityRejectedEmail(
          row.email,
          row.firstName,
          row.lastName,
          eventCtx,
          row.rejectionReason || "The submitted document could not be approved.",
          row.reviewNote || undefined,
        );
      }
    } catch (error) {
      log.error(
        { err: error, requestId: row.id, email: row.email, status: row.status },
        "Failed to send student eligibility review email",
      );
    }
  })();
}

export default async function backofficeStudentEligibilityRequestsRoutes(fastify: FastifyInstance) {
  fastify.get("", async (request, reply) => {
    const queryResult = listQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid query",
        details: queryResult.error.flatten(),
      });
    }

    const { page, limit, eventId, status, search } = queryResult.data;
    const offset = (page - 1) * limit;

    try {
      const conditions: SQL[] = [];
      if (eventId) conditions.push(eq(eventStudentEligibilityRequests.eventId, eventId));
      if (status) conditions.push(eq(eventStudentEligibilityRequests.status, status));
      if (search) {
        conditions.push(
          or(
            ilike(users.firstName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
            ilike(users.email, `%${search}%`),
            ilike(users.pharmacyLicenseId, `%${search}%`),
            ilike(events.eventCode, `%${search}%`),
            ilike(events.eventName, `%${search}%`),
          )!,
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(eventStudentEligibilityRequests)
        .innerJoin(users, eq(eventStudentEligibilityRequests.userId, users.id))
        .innerJoin(events, eq(eventStudentEligibilityRequests.eventId, events.id))
        .where(whereClause);

      const rows = await db
        .select({
          id: eventStudentEligibilityRequests.id,
          eventId: eventStudentEligibilityRequests.eventId,
          eventCode: events.eventCode,
          eventName: events.eventName,
          userId: eventStudentEligibilityRequests.userId,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          pharmacyLicenseId: users.pharmacyLicenseId,
          institution: users.institution,
          studentLevel: eventStudentEligibilityRequests.studentLevel,
          status: eventStudentEligibilityRequests.status,
          documentFileName: eventStudentEligibilityRequests.documentFileName,
          documentFileUrl: eventStudentEligibilityRequests.documentFileUrl,
          documentFileType: eventStudentEligibilityRequests.documentFileType,
          documentFileSize: eventStudentEligibilityRequests.documentFileSize,
          rejectionReason: eventStudentEligibilityRequests.rejectionReason,
          reviewNote: eventStudentEligibilityRequests.reviewNote,
          reviewedBy: eventStudentEligibilityRequests.reviewedBy,
          reviewerFirstName: backofficeUsers.firstName,
          reviewerLastName: backofficeUsers.lastName,
          reviewedAt: eventStudentEligibilityRequests.reviewedAt,
          resubmissionCount: eventStudentEligibilityRequests.resubmissionCount,
          createdAt: eventStudentEligibilityRequests.createdAt,
          updatedAt: eventStudentEligibilityRequests.updatedAt,
        })
        .from(eventStudentEligibilityRequests)
        .innerJoin(users, eq(eventStudentEligibilityRequests.userId, users.id))
        .innerJoin(events, eq(eventStudentEligibilityRequests.eventId, events.id))
        .leftJoin(backofficeUsers, eq(eventStudentEligibilityRequests.reviewedBy, backofficeUsers.id))
        .where(whereClause)
        .orderBy(desc(eventStudentEligibilityRequests.createdAt))
        .limit(limit)
        .offset(offset);

      return reply.send({
        success: true,
        requests: rows.map(mapRequest),
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch student eligibility requests",
      });
    }
  });

  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const [row] = await db
        .select({
          id: eventStudentEligibilityRequests.id,
          eventId: eventStudentEligibilityRequests.eventId,
          eventCode: events.eventCode,
          eventName: events.eventName,
          userId: eventStudentEligibilityRequests.userId,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          pharmacyLicenseId: users.pharmacyLicenseId,
          institution: users.institution,
          studentLevel: eventStudentEligibilityRequests.studentLevel,
          status: eventStudentEligibilityRequests.status,
          documentFileName: eventStudentEligibilityRequests.documentFileName,
          documentFileUrl: eventStudentEligibilityRequests.documentFileUrl,
          documentFileType: eventStudentEligibilityRequests.documentFileType,
          documentFileSize: eventStudentEligibilityRequests.documentFileSize,
          rejectionReason: eventStudentEligibilityRequests.rejectionReason,
          reviewNote: eventStudentEligibilityRequests.reviewNote,
          reviewedBy: eventStudentEligibilityRequests.reviewedBy,
          reviewerFirstName: backofficeUsers.firstName,
          reviewerLastName: backofficeUsers.lastName,
          reviewedAt: eventStudentEligibilityRequests.reviewedAt,
          resubmissionCount: eventStudentEligibilityRequests.resubmissionCount,
          createdAt: eventStudentEligibilityRequests.createdAt,
          updatedAt: eventStudentEligibilityRequests.updatedAt,
        })
        .from(eventStudentEligibilityRequests)
        .innerJoin(users, eq(eventStudentEligibilityRequests.userId, users.id))
        .innerJoin(events, eq(eventStudentEligibilityRequests.eventId, events.id))
        .leftJoin(backofficeUsers, eq(eventStudentEligibilityRequests.reviewedBy, backofficeUsers.id))
        .where(eq(eventStudentEligibilityRequests.id, parseInt(id, 10)))
        .limit(1);

      if (!row) {
        return reply.status(404).send({
          success: false,
          error: "Student eligibility request not found",
        });
      }

      return reply.send({ success: true, request: mapRequest(row) });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch student eligibility request",
      });
    }
  });

  fastify.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bodyResult = reviewSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid input",
        details: bodyResult.error.flatten(),
      });
    }

    const reviewer = request.user as { id: number } | undefined;
    const body = bodyResult.data;

    try {
      const [updated] = await db
        .update(eventStudentEligibilityRequests)
        .set({
          status: body.status,
          rejectionReason: body.status === "rejected" ? body.rejectionReason : null,
          reviewNote: body.reviewNote || null,
          reviewedBy: reviewer?.id ?? null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(eventStudentEligibilityRequests.id, parseInt(id, 10)))
        .returning();

      if (!updated) {
        return reply.status(404).send({
          success: false,
          error: "Student eligibility request not found",
        });
      }

      const [emailRow] = await db
        .select({
          id: eventStudentEligibilityRequests.id,
          status: eventStudentEligibilityRequests.status,
          rejectionReason: eventStudentEligibilityRequests.rejectionReason,
          reviewNote: eventStudentEligibilityRequests.reviewNote,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          eventName: events.eventName,
          startDate: events.startDate,
          endDate: events.endDate,
          location: events.location,
          websiteUrl: events.websiteUrl,
          shortName: events.shortName,
        })
        .from(eventStudentEligibilityRequests)
        .innerJoin(users, eq(eventStudentEligibilityRequests.userId, users.id))
        .innerJoin(events, eq(eventStudentEligibilityRequests.eventId, events.id))
        .where(eq(eventStudentEligibilityRequests.id, updated.id))
        .limit(1);

      if (emailRow) {
        sendReviewEmailInBackground(fastify.log, emailRow);
      }

      return reply.send({ success: true, request: updated });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to update student eligibility request",
      });
    }
  });
}
