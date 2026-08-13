import { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import { eventStudentEligibilityRequests, events, users } from "../../database/schema.js";
import {
  deleteFromGoogleDrive,
  extractFileIdFromUrl,
  uploadToGoogleDrive,
} from "../../services/googleDrive.js";
import {
  sendEventStudentEligibilitySubmittedEmail,
} from "../../services/emailTemplates.js";
import {
  buildEventEmailContext,
  type EventEmailRow,
} from "../../services/emailTemplates.types.js";

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.substring(dotIndex) : "";
}

async function cleanupDriveFile(fileUrl: string | null | undefined, log: FastifyInstance["log"]) {
  if (!fileUrl) return;
  const fileId = extractFileIdFromUrl(fileUrl);
  if (!fileId) return;

  try {
    await deleteFromGoogleDrive(fileId);
  } catch (error) {
    log.warn({ err: error, fileId }, "Failed to delete replaced student eligibility document");
  }
}

function sendSubmissionEmailInBackground(
  log: FastifyInstance["log"],
  data: {
    requestId: number;
    email: string;
    firstName: string;
    lastName: string;
    event: EventEmailRow;
    isResubmission: boolean;
  },
) {
  void (async () => {
    try {
      const ctx = buildEventEmailContext(data.event);
      await sendEventStudentEligibilitySubmittedEmail(
        data.email,
        data.firstName,
        data.lastName,
        ctx,
        data.isResubmission,
      );
    } catch (error) {
      log.error(
        { err: error, requestId: data.requestId, email: data.email },
        "Failed to send student eligibility submission email",
      );
    }
  })();
}

export default async function studentEligibilityRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:eventCode/student-eligibility/me",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { eventCode } = request.params as { eventCode: string };
      const userId = request.user.id;

      try {
        const [event] = await db
          .select({
            id: events.id,
            eventCode: events.eventCode,
            eventName: events.eventName,
            startDate: events.startDate,
            endDate: events.endDate,
            location: events.location,
            websiteUrl: events.websiteUrl,
            shortName: events.shortName,
            archivedAt: events.archivedAt,
          })
          .from(events)
          .where(eq(events.eventCode, eventCode))
          .limit(1);

        if (!event || event.archivedAt) {
          return reply.status(404).send({
            success: false,
            code: "EVENT_NOT_FOUND",
            error: "Event not found",
          });
        }

        const [user] = await db
          .select({ role: users.role, status: users.status })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        const [eligibility] = await db
          .select()
          .from(eventStudentEligibilityRequests)
          .where(
            and(
              eq(eventStudentEligibilityRequests.eventId, event.id),
              eq(eventStudentEligibilityRequests.userId, userId),
            )
          )
          .limit(1);

        return reply.send({
          success: true,
          eligibility: eligibility
            ? {
                id: eligibility.id,
                eventId: event.id,
                eventCode: event.eventCode,
                eventName: event.eventName,
                role: user?.role || null,
                accountStatus: user?.status || null,
                studentLevel: eligibility.studentLevel,
                status: eligibility.status,
                documentFileName: eligibility.documentFileName,
                documentUrl: eligibility.documentFileUrl,
                rejectionReason: eligibility.rejectionReason,
                reviewNote: eligibility.reviewNote,
                resubmissionCount: eligibility.resubmissionCount,
                createdAt: eligibility.createdAt,
                updatedAt: eligibility.updatedAt,
                reviewedAt: eligibility.reviewedAt,
              }
            : null,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch student eligibility status",
        });
      }
    },
  );

  fastify.post(
    "/:eventCode/student-eligibility-requests",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { eventCode } = request.params as { eventCode: string };
      const userId = request.user.id;

      try {
        const [event] = await db
          .select({
            id: events.id,
            eventCode: events.eventCode,
            eventName: events.eventName,
            startDate: events.startDate,
            endDate: events.endDate,
            location: events.location,
            websiteUrl: events.websiteUrl,
            shortName: events.shortName,
            archivedAt: events.archivedAt,
          })
          .from(events)
          .where(eq(events.eventCode, eventCode))
          .limit(1);

        if (!event || event.archivedAt) {
          return reply.status(404).send({
            success: false,
            code: "EVENT_NOT_FOUND",
            error: "Event not found",
          });
        }

        const [user] = await db
          .select({
            id: users.id,
            role: users.role,
            status: users.status,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        if (!user) {
          return reply.status(404).send({
            success: false,
            code: "USER_NOT_FOUND",
            error: "User not found",
          });
        }

        if (user.role !== "pharmacist") {
          return reply.status(403).send({
            success: false,
            code: "PHARMACIST_REQUIRED",
            error: "Postgraduate student-rate eligibility is available only for pharmacist accounts.",
          });
        }

        if (user.status !== "active") {
          return reply.status(403).send({
            success: false,
            code: "ACCOUNT_NOT_ACTIVE",
            error: "Your account must be active before requesting postgraduate student-rate eligibility.",
          });
        }

        let fileBuffer: Buffer | null = null;
        let originalFileName = "";
        let mimeType = "";

        for await (const part of request.parts()) {
          if (part.type !== "file") continue;
          if (part.fieldname !== "verificationDoc") {
            await part.file.resume();
            continue;
          }

          if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
            return reply.status(400).send({
              success: false,
              code: "INVALID_FILE_TYPE",
              error: "Invalid file type. Only PDF, JPG, and PNG are allowed.",
            });
          }

          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }

          fileBuffer = Buffer.concat(chunks);
          originalFileName = part.filename;
          mimeType = part.mimetype;

          if (fileBuffer.length > MAX_FILE_SIZE) {
            return reply.status(400).send({
              success: false,
              code: "FILE_TOO_LARGE",
              error: "File too large. Maximum size is 10MB.",
            });
          }
        }

        if (!fileBuffer || !originalFileName || !mimeType) {
          return reply.status(400).send({
            success: false,
            code: "DOCUMENT_REQUIRED",
            error: "Student verification document is required.",
          });
        }

        const [existing] = await db
          .select()
          .from(eventStudentEligibilityRequests)
          .where(
            and(
              eq(eventStudentEligibilityRequests.eventId, event.id),
              eq(eventStudentEligibilityRequests.userId, userId),
            )
          )
          .limit(1);

        if (existing?.status === "approved") {
          return reply.status(409).send({
            success: false,
            code: "ALREADY_APPROVED",
            error: "Postgraduate student-rate eligibility is already approved for this event.",
          });
        }

        const safeOriginalName = sanitizeFilePart(originalFileName);
        const extension = getFileExtension(safeOriginalName);
        const baseName = extension ? safeOriginalName.slice(0, -extension.length) : safeOriginalName;
        const storedFileName = `${userId}_${event.eventCode}_postgraduate_${baseName || "document"}${extension}`;

        const documentUrl = await uploadToGoogleDrive(
          fileBuffer,
          storedFileName,
          mimeType,
          "student_docs",
          ["event-student-eligibility", event.eventCode],
        );

        if (existing) {
          const [updated] = await db
            .update(eventStudentEligibilityRequests)
            .set({
              studentLevel: "postgraduate",
              status: "pending",
              documentFileName: originalFileName,
              documentFileUrl: documentUrl,
              documentFileType: mimeType,
              documentFileSize: fileBuffer.length,
              rejectionReason: null,
              reviewNote: null,
              reviewedBy: null,
              reviewedAt: null,
              resubmissionCount:
                existing.status === "rejected"
                  ? existing.resubmissionCount + 1
                  : existing.resubmissionCount,
              updatedAt: new Date(),
            })
            .where(eq(eventStudentEligibilityRequests.id, existing.id))
            .returning();

          await cleanupDriveFile(existing.documentFileUrl, fastify.log);
          sendSubmissionEmailInBackground(fastify.log, {
            requestId: updated.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            event,
            isResubmission: true,
          });

          return reply.send({
            success: true,
            eligibility: {
              id: updated.id,
              eventCode: event.eventCode,
              eventName: event.eventName,
              studentLevel: updated.studentLevel,
              status: updated.status,
              documentFileName: updated.documentFileName,
              documentUrl: updated.documentFileUrl,
              resubmissionCount: updated.resubmissionCount,
            },
          });
        }

        const [created] = await db
          .insert(eventStudentEligibilityRequests)
          .values({
            eventId: event.id,
            userId,
            studentLevel: "postgraduate",
            status: "pending",
            documentFileName: originalFileName,
            documentFileUrl: documentUrl,
            documentFileType: mimeType,
            documentFileSize: fileBuffer.length,
          })
          .returning();

        sendSubmissionEmailInBackground(fastify.log, {
          requestId: created.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          event,
          isResubmission: false,
        });

        return reply.status(201).send({
          success: true,
          eligibility: {
            id: created.id,
            eventCode: event.eventCode,
            eventName: event.eventName,
            studentLevel: created.studentLevel,
            status: created.status,
            documentFileName: created.documentFileName,
            documentUrl: created.documentFileUrl,
            resubmissionCount: created.resubmissionCount,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to submit student eligibility request",
        });
      }
    },
  );
}
