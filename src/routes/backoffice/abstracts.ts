import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  abstracts,
  abstractCategories,
  abstractFiles,
  abstractCoAuthors,
  abstractRevisionRequestFiles,
  abstractRevisionRequests,
  abstractTrackingIdentifiers,
  events,
  users,
} from "../../database/schema.js";
import {
  abstractListSchema,
  requestAbstractRevisionSchema,
  updateAbstractStatusSchema,
} from "../../schemas/abstracts.schema.js";
import { eq, desc, ilike, and, or, count, inArray, isNull, exists, sql } from "drizzle-orm";
import { z } from "zod";
import { appendTrackingAuditEvent } from "../../modules/abstracts/tracking.repository.js";
import {
  sendAbstractRejectedEmail,
} from "../../services/emailService.js";
import {
  sendEventAbstractAcceptedEmail,
  sendEventAbstractRevisionRequestedEmail,
} from "../../services/emailTemplates.js";
import {
  buildConfirmationUrl,
  getConfirmDeadlineDays,
  issueConfirmationToken,
  supersedeActiveTokens,
} from "../../services/abstractConfirmation.js";
import {
  buildEventEmailContext,
  getDefaultEventEmailContext,
} from "../../services/emailTemplates.types.js";
import {
  deleteFromGoogleDrive,
  extractFileIdFromUrl,
  uploadToGoogleDrive,
} from "../../services/googleDrive.js";

const REVISION_ATTACHMENT_FIELD_NAMES = new Set([
  "file",
  "attachment",
  "revisionFile",
]);

const REVISION_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
];

const MAX_REVISION_ATTACHMENT_SIZE = 30 * 1024 * 1024;

type ParsedRevisionAttachment = {
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
  size: number;
};

type UploadedRevisionAttachment = ParsedRevisionAttachment & {
  fileUrl: string;
  storedFileName: string;
};

function sanitizeFileSegment(value: string, fallback: string, maxLength: number): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9\s\u0E00-\u0E7F._-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "")
    .substring(0, maxLength);

  return sanitized || fallback;
}

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.substring(lastDot).toLowerCase() : "";
}

async function cleanupRevisionAttachment(
  attachment: UploadedRevisionAttachment | null,
  logger: FastifyInstance["log"],
) {
  if (!attachment) return;

  const fileId = extractFileIdFromUrl(attachment.fileUrl);
  if (!fileId) return;

  try {
    await deleteFromGoogleDrive(fileId);
  } catch (error) {
    logger.warn({ err: error, fileUrl: attachment.fileUrl }, "Failed to clean up revision attachment");
  }
}

export default async function (fastify: FastifyInstance) {
  const archiveSchema = z.object({
    reason: z.enum(["manual", "withdrawn", "duplicate_submission"]),
    note: z.string().max(1000).optional().nullable(),
  }).strict();

  fastify.put("/:id/archival", async (request, reply) => {
    const abstractId = Number((request.params as { id: string }).id);
    const parsed = archiveSchema.safeParse(request.body);
    if (!Number.isInteger(abstractId) || !parsed.success) {
      return reply.status(400).send({ success: false, code: "VALIDATION_ERROR", error: "Invalid archive request" });
    }
    const note = parsed.data.note?.trim() || null;
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx.select({
          id: abstracts.id,
          eventId: abstracts.eventId,
          trackingId: abstracts.trackingId,
          archivedAt: abstracts.archivedAt,
          archiveReason: abstracts.archiveReason,
          archiveNote: abstracts.archiveNote,
        }).from(abstracts).where(eq(abstracts.id, abstractId)).limit(1);
        if (!current) return null;
        if (current.archivedAt) {
          if (current.archiveReason !== parsed.data.reason || (current.archiveNote || null) !== note) {
            throw new Error("ARCHIVE_REASON_CONFLICT");
          }
          return current;
        }
        const [updated] = await tx.update(abstracts).set({
          archivedAt: new Date(),
          archivedBy: request.user.id,
          archiveReason: parsed.data.reason,
          archiveNote: note,
        }).where(eq(abstracts.id, abstractId)).returning();
        await appendTrackingAuditEvent(tx, {
          eventType: "abstract.archived",
          eventId: current.eventId,
          abstractId,
          reasonCode: parsed.data.reason,
          requestId: request.id,
          beforeState: { trackingId: current.trackingId, archived: false },
          afterState: { trackingId: current.trackingId, archived: true, notePresent: Boolean(note) },
        });
        return updated;
      });
      if (!result) return reply.status(404).send({ success: false, code: "NOT_FOUND", error: "Abstract not found" });
      return reply.send({ success: true, abstract: result, requestId: request.id });
    } catch (error) {
      if (error instanceof Error && error.message === "ARCHIVE_REASON_CONFLICT") {
        return reply.status(409).send({ success: false, code: "ARCHIVE_REASON_CONFLICT", error: "Abstract already archived with different reason", requestId: request.id });
      }
      fastify.log.error(error);
      return reply.status(500).send({ success: false, code: "INTERNAL_ERROR", error: "Failed to archive abstract", requestId: request.id });
    }
  });

  fastify.delete("/:id/archival", async (request, reply) => {
    const abstractId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(abstractId)) {
      return reply.status(400).send({ success: false, code: "VALIDATION_ERROR", error: "Invalid abstract id" });
    }
    try {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx.select({
          id: abstracts.id,
          eventId: abstracts.eventId,
          trackingId: abstracts.trackingId,
          archivedAt: abstracts.archivedAt,
          userId: abstracts.userId,
        }).from(abstracts).where(eq(abstracts.id, abstractId)).limit(1);
        if (!current) return null;
        if (!current.archivedAt) return current;
        if (!current.userId && current.archivedAt) {
          throw new Error("ABSTRACT_RESTORE_AUTHOR_REQUIRED");
        }
        const [updated] = await tx.update(abstracts).set({
          archivedAt: null,
          archivedBy: null,
          archiveReason: null,
          archiveNote: null,
        }).where(eq(abstracts.id, abstractId)).returning();
        await appendTrackingAuditEvent(tx, {
          eventType: "abstract.restored",
          eventId: current.eventId,
          abstractId,
          requestId: request.id,
          beforeState: { trackingId: current.trackingId, archived: true },
          afterState: { trackingId: current.trackingId, archived: false },
        });
        return updated;
      });
      if (!result) return reply.status(404).send({ success: false, code: "NOT_FOUND", error: "Abstract not found" });
      return reply.send({ success: true, abstract: result, requestId: request.id });
    } catch (error) {
      if (error instanceof Error && error.message === "ABSTRACT_RESTORE_AUTHOR_REQUIRED") {
        return reply.status(409).send({ success: false, code: "ABSTRACT_RESTORE_AUTHOR_REQUIRED", error: "Abstract author is required before restore", requestId: request.id });
      }
      fastify.log.error(error);
      return reply.status(500).send({ success: false, code: "INTERNAL_ERROR", error: "Failed to restore abstract", requestId: request.id });
    }
  });

  // List Abstracts
  fastify.get("", async (request, reply) => {
    const queryResult = abstractListSchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply
        .status(400)
        .send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search, eventId, status, categoryId, presentationType, trackingId, trackingMatch, archived } =
      queryResult.data;
    const offset = (page - 1) * limit;

    // Get user info from JWT
    const user = request.user;

    try {
      const conditions = archived === "include"
        ? []
        : archived === "only"
          ? [sql`${abstracts.archivedAt} IS NOT NULL`]
          : [isNull(abstracts.archivedAt)];

      // Category-based access control for reviewers
      // Admin sees all, Reviewer sees only assigned categories
      if (user.role === "reviewer") {
        const assignedCategories = user.assignedCategories || [];
        if (assignedCategories.length > 0) {
          const validCategories = assignedCategories.filter(
            (cat): cat is string => typeof cat === "string" && cat.trim().length > 0,
          );
          if (validCategories.length > 0) {
            conditions.push(inArray(abstractCategories.name, validCategories));
          } else {
            // No valid categories assigned
            return reply.send({
              abstracts: [],
              pagination: { page, limit, total: 0, totalPages: 0 },
            });
          }
        } else {
          // Reviewer with no assigned categories sees nothing
          return reply.send({
            abstracts: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          });
        }

        // Presentation type filtering for reviewers
        const assignedPresentationTypes = user.assignedPresentationTypes || [];
        if (assignedPresentationTypes.length > 0) {
          // Reviewer can only see abstracts with their assigned presentation types
          type PresentationType = "poster" | "oral";
          const validPresentationTypes = assignedPresentationTypes.filter(
            (type): type is PresentationType =>
              ["poster", "oral"].includes(type),
          );
          if (validPresentationTypes.length > 0) {
            conditions.push(
              inArray(abstracts.presentationType, validPresentationTypes),
            );
          } else {
            // No valid presentation types assigned
            return reply.send({
              abstracts: [],
              pagination: { page, limit, total: 0, totalPages: 0 },
            });
          }
        }
        // If no presentation types assigned, reviewer can see all presentation types
      }
      // Admin and other roles see all abstracts (no category filter applied)

      if (eventId) conditions.push(eq(abstracts.eventId, eventId));
      if (status) conditions.push(eq(abstracts.status, status));
      if (categoryId) conditions.push(eq(abstracts.categoryId, categoryId));
      if (presentationType)
        conditions.push(eq(abstracts.presentationType, presentationType));
      if (trackingId) {
        if (trackingMatch === "canonical") {
          conditions.push(eq(abstracts.trackingId, trackingId));
        } else if (trackingMatch === "alias") {
          conditions.push(exists(
            db.select({ id: abstractTrackingIdentifiers.trackingId })
              .from(abstractTrackingIdentifiers)
              .where(and(
                eq(abstractTrackingIdentifiers.abstractId, abstracts.id),
                eq(abstractTrackingIdentifiers.trackingId, trackingId),
                sql`${abstractTrackingIdentifiers.trackingId} <> ${abstracts.trackingId}`,
              )),
          ));
        } else {
          conditions.push(or(
            eq(abstracts.trackingId, trackingId),
            exists(
              db.select({ id: abstractTrackingIdentifiers.trackingId })
                .from(abstractTrackingIdentifiers)
                .where(and(
                  eq(abstractTrackingIdentifiers.abstractId, abstracts.id),
                  eq(abstractTrackingIdentifiers.trackingId, trackingId),
                )),
            ),
          )!);
        }
      }
      if (search) {
        conditions.push(
          or(
            ilike(abstracts.title, `%${search}%`),
            ilike(abstracts.trackingId, `%${search}%`),
            ilike(users.firstName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
            ilike(users.email, `%${search}%`),
          )!,
        );
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Count total
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .leftJoin(abstractCategories, eq(abstracts.categoryId, abstractCategories.id))
        .where(whereClause);

      // Fetch data
      const abstractList = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          categoryId: abstracts.categoryId,
          category: abstractCategories.name,
          categoryName: abstractCategories.name,
          presentationType: abstracts.presentationType,
          keywords: abstracts.keywords,
          background: abstracts.background,
          objective: abstracts.objective,
          methods: abstracts.methods,
          results: abstracts.results,
          conclusion: abstracts.conclusion,
          status: abstracts.status,
          fullPaperUrl: abstracts.fullPaperUrl,
          approvedAt: abstracts.approvedAt,
          rejectedAt: abstracts.rejectedAt,
          confirmedAt: abstracts.confirmedAt,
          reviewComment: abstracts.reviewComment,
          createdAt: abstracts.createdAt,
          author: {
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            phone: users.phone,
            country: users.country,
            institution: users.institution,
          },
          event: {
            name: events.eventName,
            code: events.eventCode,
          },
        })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .leftJoin(events, eq(abstracts.eventId, events.id))
        .leftJoin(abstractCategories, eq(abstracts.categoryId, abstractCategories.id))
        .where(whereClause)
        .orderBy(desc(abstracts.createdAt))
        .limit(limit)
        .offset(offset);

      // Fetch co-authors for each abstract (using inArray for efficiency)
      const abstractIds = abstractList.map((a) => a.id);
      const trackingHistory = abstractIds.length > 0
        ? await db.select().from(abstractTrackingIdentifiers).where(inArray(abstractTrackingIdentifiers.abstractId, abstractIds))
        : [];
      const coAuthorsList =
        abstractIds.length > 0
          ? await db
              .select()
              .from(abstractCoAuthors)
              .where(inArray(abstractCoAuthors.abstractId, abstractIds))
          : [];
      const filesList =
        abstractIds.length > 0
          ? await db
              .select()
              .from(abstractFiles)
              .where(inArray(abstractFiles.abstractId, abstractIds))
          : [];
      const revisionRequestsList =
        abstractIds.length > 0
          ? await db
              .select()
              .from(abstractRevisionRequests)
              .where(inArray(abstractRevisionRequests.abstractId, abstractIds))
          : [];
      const revisionRequestIds = revisionRequestsList.map((request) => request.id);
      const revisionRequestFilesList =
        revisionRequestIds.length > 0
          ? await db
              .select()
              .from(abstractRevisionRequestFiles)
              .where(inArray(abstractRevisionRequestFiles.revisionRequestId, revisionRequestIds))
          : [];

      // Merge co-authors with abstracts
      const abstractsWithCoAuthors = abstractList.map((abs) => ({
        ...abs,
        trackingAliases: trackingHistory
          .filter((entry) => entry.abstractId === abs.id && entry.trackingId !== abs.trackingId)
          .map((entry) => entry.trackingId),
        ...(trackingId ? {
          matchedTrackingId: trackingId,
          trackingIdMatch: abs.trackingId === trackingId ? "canonical" : "alias",
        } : { matchedTrackingId: null, trackingIdMatch: null }),
        category: abs.categoryName || abs.category,
        coAuthors: coAuthorsList.filter((ca) => ca.abstractId === abs.id),
        files: filesList
          .filter((file) => file.abstractId === abs.id)
          .sort((a, b) => a.sortOrder - b.sortOrder),
        latestRevisionRequest: revisionRequestsList
          .filter((request) => request.abstractId === abs.id)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((request) => ({
            ...request,
            files: revisionRequestFilesList.filter((file) => file.revisionRequestId === request.id),
          }))[0] || null,
      }));

      return reply.send({
        abstracts: abstractsWithCoAuthors,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch abstracts" });
    }
  });

  // Get Single Abstract by ID
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const [abstractData] = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          categoryId: abstracts.categoryId,
          category: abstractCategories.name,
          categoryName: abstractCategories.name,
          presentationType: abstracts.presentationType,
          keywords: abstracts.keywords,
          background: abstracts.background,
          objective: abstracts.objective,
          methods: abstracts.methods,
          results: abstracts.results,
          conclusion: abstracts.conclusion,
          status: abstracts.status,
          fullPaperUrl: abstracts.fullPaperUrl,
          approvedAt: abstracts.approvedAt,
          rejectedAt: abstracts.rejectedAt,
          confirmedAt: abstracts.confirmedAt,
          reviewComment: abstracts.reviewComment,
          createdAt: abstracts.createdAt,
          author: {
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            phone: users.phone,
            country: users.country,
            institution: users.institution,
          },
          event: {
            name: events.eventName,
            code: events.eventCode,
          },
        })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .leftJoin(events, eq(abstracts.eventId, events.id))
        .leftJoin(abstractCategories, eq(abstracts.categoryId, abstractCategories.id))
        .where(eq(abstracts.id, parseInt(id)));

      if (abstractData) {
        abstractData.category = abstractData.categoryName || abstractData.category;
      }

      if (!abstractData) {
        return reply.status(404).send({ error: "Abstract not found" });
      }

      // Fetch co-authors for this abstract
      const coAuthors = await db
        .select()
        .from(abstractCoAuthors)
        .where(eq(abstractCoAuthors.abstractId, parseInt(id)));
      const files = await db
        .select()
        .from(abstractFiles)
        .where(eq(abstractFiles.abstractId, parseInt(id)));
      const revisionRequests = await db
        .select()
        .from(abstractRevisionRequests)
        .where(eq(abstractRevisionRequests.abstractId, parseInt(id)))
        .orderBy(desc(abstractRevisionRequests.createdAt));
      const revisionRequestIds = revisionRequests.map((request) => request.id);
      const revisionRequestFiles =
        revisionRequestIds.length > 0
          ? await db
              .select()
              .from(abstractRevisionRequestFiles)
              .where(inArray(abstractRevisionRequestFiles.revisionRequestId, revisionRequestIds))
          : [];
      const revisionRequestsWithFiles = revisionRequests.map((request) => ({
        ...request,
        files: revisionRequestFiles.filter((file) => file.revisionRequestId === request.id),
      }));

      return reply.send({
        abstract: {
          ...abstractData,
          coAuthors,
          files: files.sort((a, b) => a.sortOrder - b.sortOrder),
          latestRevisionRequest: revisionRequestsWithFiles[0] || null,
          revisionRequests: revisionRequestsWithFiles,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch abstract" });
    }
  });

  // Request Abstract Revision
  fastify.post("/:id/revision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const abstractId = parseInt(id, 10);

    if (Number.isNaN(abstractId)) {
      return reply.status(400).send({ error: "Invalid abstract id" });
    }

    try {
      const formFields: Record<string, string> = {};
      let parsedAttachment: ParsedRevisionAttachment | null = null;

      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (!REVISION_ATTACHMENT_FIELD_NAMES.has(part.fieldname)) {
            return reply.status(400).send({
              error: `Unexpected file field "${part.fieldname}". Use revisionFile for reviewer attachments.`,
            });
          }

          if (parsedAttachment) {
            return reply.status(400).send({ error: "Only one revision attachment is allowed." });
          }

          if (!REVISION_ATTACHMENT_MIME_TYPES.includes(part.mimetype)) {
            return reply.status(400).send({
              error: "Invalid attachment type. Allowed: PDF, DOC, DOCX, JPG, PNG.",
            });
          }

          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }

          const fileBuffer = Buffer.concat(chunks);
          if (fileBuffer.length > MAX_REVISION_ATTACHMENT_SIZE) {
            return reply.status(400).send({
              error: "Attachment too large. Maximum size is 30MB.",
            });
          }

          parsedAttachment = {
            buffer: fileBuffer,
            originalFileName: part.filename || "revision-attachment",
            mimeType: part.mimetype,
            size: fileBuffer.length,
          };
        } else if (part.type === "field") {
          formFields[part.fieldname] = String(part.value ?? "");
        }
      }

      const parsed = requestAbstractRevisionSchema.safeParse(formFields);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }

      const [targetAbstract] = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          status: abstracts.status,
          eventId: abstracts.eventId,
          authorFirstName: users.firstName,
          authorLastName: users.lastName,
          authorEmail: users.email,
          eventName: events.eventName,
          startDate: events.startDate,
          endDate: events.endDate,
          location: events.location,
          websiteUrl: events.websiteUrl,
          shortName: events.shortName,
        })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .leftJoin(events, eq(abstracts.eventId, events.id))
        .where(eq(abstracts.id, abstractId))
        .limit(1);

      if (!targetAbstract) {
        return reply.status(404).send({ error: "Abstract not found" });
      }

      if (targetAbstract.status !== "pending") {
        return reply.status(400).send({
          error: "Only pending abstracts can be sent for revision.",
        });
      }

      let uploadedAttachment: UploadedRevisionAttachment | null = null;
      if (parsedAttachment) {
        try {
          const sequence = Date.now();
          const sanitizedTitle = sanitizeFileSegment(targetAbstract.title, "abstract", 60);
          const sanitizedOriginalName = sanitizeFileSegment(
            parsedAttachment.originalFileName.replace(/\.[^.]+$/, ""),
            "revision_attachment",
            60,
          );
          const extension = getFileExtension(parsedAttachment.originalFileName);
          const storedFileName = `${targetAbstract.trackingId || `ABS-${abstractId}`}_revision_${sequence}_${sanitizedTitle}_${sanitizedOriginalName}${extension}`;

          const fileUrl = await uploadToGoogleDrive(
            parsedAttachment.buffer,
            storedFileName,
            parsedAttachment.mimeType,
            "abstracts",
            ["revision-requests", String(targetAbstract.eventId)],
          );

          uploadedAttachment = {
            ...parsedAttachment,
            fileUrl,
            storedFileName,
          };
        } catch (error) {
          fastify.log.error({ err: error }, "Revision attachment upload failed");
          return reply.status(500).send({
            error: "Failed to upload revision attachment. Please try again.",
          });
        }
      }

      const { revisionRequest, revisionFiles } = await db
        .transaction(async (tx) => {
          await tx
            .update(abstracts)
            .set({ status: "revision" })
            .where(eq(abstracts.id, abstractId));

          const [createdRevisionRequest] = await tx
            .insert(abstractRevisionRequests)
            .values({
              abstractId,
              requestedBy: request.user.id,
              topic: parsed.data.topic,
              comment: parsed.data.comment,
              status: "open",
            })
            .returning();

          const insertedFiles = uploadedAttachment
            ? await tx
                .insert(abstractRevisionRequestFiles)
                .values({
                  revisionRequestId: createdRevisionRequest.id,
                  fileName: uploadedAttachment.originalFileName,
                  fileUrl: uploadedAttachment.fileUrl,
                  fileType: uploadedAttachment.mimeType,
                  fileSize: uploadedAttachment.size,
                })
                .returning()
            : [];

          return {
            revisionRequest: createdRevisionRequest,
            revisionFiles: insertedFiles,
          };
        })
        .catch(async (error) => {
          await cleanupRevisionAttachment(uploadedAttachment, fastify.log);
          throw error;
        });

      if (targetAbstract.authorEmail && targetAbstract.authorFirstName && targetAbstract.authorLastName) {
        try {
          const emailContext =
            targetAbstract.startDate && targetAbstract.endDate
              ? buildEventEmailContext({
                  eventName: targetAbstract.eventName || "Conference",
                  startDate: targetAbstract.startDate,
                  endDate: targetAbstract.endDate,
                  location: targetAbstract.location,
                  websiteUrl: targetAbstract.websiteUrl,
                  shortName: targetAbstract.shortName,
                })
              : getDefaultEventEmailContext();

          await sendEventAbstractRevisionRequestedEmail(
            targetAbstract.authorEmail,
            targetAbstract.authorFirstName,
            targetAbstract.authorLastName,
            targetAbstract.title,
            parsed.data.topic,
            parsed.data.comment,
            emailContext,
            revisionFiles.map((file) => file.fileUrl),
          );
        } catch (emailError) {
          fastify.log.error({ err: emailError }, "Failed to send abstract revision email");
        }
      }

      return reply.send({
        success: true,
        abstract: {
          id: abstractId,
          status: "revision",
        },
        revisionRequest: {
          ...revisionRequest,
          files: revisionFiles,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to request abstract revision" });
    }
  });

  // Update Abstract Status
  fastify.patch("/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateAbstractStatusSchema.safeParse(request.body);

    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const { status, comment } = result.data;

    try {
      const reviewerId = request.user?.id ?? null;
      const now = new Date();
      const updatePatch: Record<string, unknown> = { status };
      if (status === "accepted") {
        updatePatch.approvedAt = now;
        updatePatch.reviewedBy = reviewerId;
        updatePatch.reviewComment = comment ?? null;
      } else if (status === "rejected") {
        updatePatch.rejectedAt = now;
        updatePatch.reviewedBy = reviewerId;
        updatePatch.reviewComment = comment ?? null;
      }

      const [updatedAbstract] = await db
        .update(abstracts)
        .set(updatePatch)
        .where(eq(abstracts.id, parseInt(id)))
        .returning();

      if (!updatedAbstract)
        return reply.status(404).send({ error: "Abstract not found" });

      // On reject: invalidate any pending confirmation tokens.
      if (status === "rejected") {
        try {
          await supersedeActiveTokens(updatedAbstract.id);
        } catch (e) {
          fastify.log.warn({ err: e }, "Failed to supersede confirmation tokens on reject");
        }
      }

      // Get author information for email (skip if no userId)
      let author = null;
      if (updatedAbstract.userId) {
        const [authorResult] = await db
          .select({
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, updatedAbstract.userId))
          .limit(1);
        author = authorResult;
      }

      // Send email notification based on status
      if (author) {
        try {
          if (status === "accepted") {
            const [eventResult] = await db
              .select({
                eventName: events.eventName,
                startDate: events.startDate,
                endDate: events.endDate,
                location: events.location,
                websiteUrl: events.websiteUrl,
                shortName: events.shortName,
              })
              .from(events)
              .where(eq(events.id, updatedAbstract.eventId))
              .limit(1);

            if (eventResult && (updatedAbstract.presentationType === "poster" || updatedAbstract.presentationType === "oral")) {
              // Supersede any previous tokens, then issue a new one for this approval.
              try {
                await supersedeActiveTokens(updatedAbstract.id);
              } catch (e) {
                fastify.log.warn({ err: e }, "Failed to supersede previous confirmation tokens");
              }
              const issued = await issueConfirmationToken(updatedAbstract.id);
              const confirmUrl = buildConfirmationUrl(
                issued.rawToken,
                "en",
                eventResult.websiteUrl ?? undefined,
              );
              await sendEventAbstractAcceptedEmail(
                author.email,
                author.firstName,
                author.lastName,
                updatedAbstract.title,
                updatedAbstract.presentationType,
                buildEventEmailContext(eventResult),
                comment,
                { confirmUrl, deadline: issued.expiresAt },
              );
              fastify.log.info(
                `Abstract accepted+confirmation email sent to ${author.email} (deadline=${issued.expiresAt.toISOString()}, ${getConfirmDeadlineDays()} days)`,
              );
            }
          } else if (status === "rejected") {
            await sendAbstractRejectedEmail(
              author.email,
              author.firstName,
              author.lastName,
              updatedAbstract.title,
              comment,
            );
            fastify.log.info(`Abstract rejected email sent to ${author.email}`);
          }
        } catch (emailError) {
          fastify.log.error(
            { err: emailError },
            "Failed to send abstract status email",
          );
        }
      }

      return reply.send({ abstract: updatedAbstract });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update abstract" });
    }
  });

  // -------------------------------------------------------------------------
  // Resend approval-confirmation email (admin only)
  // Supersedes any active token, issues a fresh one, re-sends the email.
  // -------------------------------------------------------------------------
  fastify.post("/:id/resend-confirmation", async (request, reply) => {
    const { id } = request.params as { id: string };
    const abstractId = parseInt(id, 10);
    if (Number.isNaN(abstractId)) return reply.status(400).send({ error: "Invalid abstract id" });

    try {
      const [abs] = await db
        .select({
          id: abstracts.id,
          title: abstracts.title,
          trackingId: abstracts.trackingId,
          status: abstracts.status,
          confirmedAt: abstracts.confirmedAt,
          presentationType: abstracts.presentationType,
          eventId: abstracts.eventId,
          userId: abstracts.userId,
          reviewComment: abstracts.reviewComment,
        })
        .from(abstracts)
        .where(eq(abstracts.id, abstractId))
        .limit(1);

      if (!abs) return reply.status(404).send({ error: "Abstract not found" });
      if (abs.status !== "accepted") {
        return reply.status(400).send({ error: "Only accepted abstracts can have a confirmation email." });
      }
      if (abs.confirmedAt) {
        return reply.status(409).send({ error: "Abstract is already confirmed." });
      }
      if (!abs.userId) {
        return reply.status(400).send({ error: "Abstract has no associated user." });
      }

      const [author] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, abs.userId))
        .limit(1);
      if (!author) return reply.status(400).send({ error: "Author not found." });

      const [event] = await db
        .select({
          eventName: events.eventName,
          startDate: events.startDate,
          endDate: events.endDate,
          location: events.location,
          websiteUrl: events.websiteUrl,
          shortName: events.shortName,
        })
        .from(events)
        .where(eq(events.id, abs.eventId))
        .limit(1);
      if (!event) return reply.status(400).send({ error: "Event not found." });

      await supersedeActiveTokens(abs.id);
      const issued = await issueConfirmationToken(abs.id);
      const confirmUrl = buildConfirmationUrl(
        issued.rawToken,
        "en",
        event.websiteUrl ?? undefined,
      );

      await sendEventAbstractAcceptedEmail(
        author.email,
        author.firstName,
        author.lastName,
        abs.title,
        abs.presentationType,
        buildEventEmailContext(event),
        abs.reviewComment ?? undefined,
        { confirmUrl, deadline: issued.expiresAt },
      );

      return reply.send({
        success: true,
        deadline: issued.expiresAt.toISOString(),
        deadlineDays: getConfirmDeadlineDays(),
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to resend confirmation email" });
    }
  });

  // -------------------------------------------------------------------------
  // Manual confirm (admin override). Used when the author confirmed via
  // another channel (phone/email) and the admin records it in the system.
  // -------------------------------------------------------------------------
  fastify.post("/:id/manual-confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    const abstractId = parseInt(id, 10);
    if (Number.isNaN(abstractId)) return reply.status(400).send({ error: "Invalid abstract id" });

    try {
      const [abs] = await db
        .select({ id: abstracts.id, status: abstracts.status, confirmedAt: abstracts.confirmedAt })
        .from(abstracts)
        .where(eq(abstracts.id, abstractId))
        .limit(1);

      if (!abs) return reply.status(404).send({ error: "Abstract not found" });
      if (abs.status !== "accepted") {
        return reply.status(400).send({ error: "Only accepted abstracts can be confirmed." });
      }
      if (abs.confirmedAt) {
        return reply.send({ success: true, abstractId: abs.id, confirmedAt: abs.confirmedAt, alreadyConfirmed: true });
      }

      const now = new Date();
      const [updated] = await db
        .update(abstracts)
        .set({ confirmedAt: now })
        .where(eq(abstracts.id, abs.id))
        .returning({ id: abstracts.id, confirmedAt: abstracts.confirmedAt });

      // Mark active tokens as used so the email link cannot be re-used.
      await supersedeActiveTokens(abs.id);

      return reply.send({ success: true, abstractId: updated.id, confirmedAt: updated.confirmedAt });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to manually confirm abstract" });
    }
  });
}
