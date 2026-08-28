import { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { abstractSubmissionSchema } from "../../../schemas/abstracts.schema.js";
import { db } from "../../../database/index.js";
import {
  abstracts,
  abstractFiles,
  abstractCoAuthors,
  abstractCategories,
  events,
  abstractSubmissionIdempotencyKeys,
} from "../../../database/schema.js";
import {
  allocateTrackingId,
  appendTrackingAssignment,
  appendTrackingAuditEvent,
  assertAbstractWritesAvailable,
} from "../../../modules/abstracts/tracking.repository.js";
import { ApiError } from "../../../errors/ApiError.js";
import {
  deleteFromGoogleDrive,
  extractFileIdFromUrl,
  uploadToGoogleDrive,
} from "../../../services/googleDrive.js";
import { eq, and, sql } from "drizzle-orm";
import { buildEventEmailContext, getDefaultEventEmailContext, type EventEmailRow } from "../../../services/emailTemplates.types.js";
import { sendEventAbstractSubmissionEmail, sendEventCoAuthorNotificationEmail } from "../../../services/emailTemplates.js";
import {
  formatAbstractWordCountIssue,
  validateAbstractWords,
} from "../../../utils/abstractWordCount.js";
import { summarizeAbstractValidationIssues } from "./validation.js";

// Allowed file types for abstract documents
const ALLOWED_MIME_TYPES = ["application/pdf"];

// Max file size: 30MB
const MAX_FILE_SIZE = 30 * 1024 * 1024;

// Max number of abstract documents per submission
const MAX_FILES = 3;

// Max combined size for all abstract documents
const MAX_TOTAL_FILE_SIZE = MAX_FILE_SIZE * MAX_FILES;

const ABSTRACT_FILE_FIELD_NAMES = new Set([
  "abstractFile",
  "abstractFiles",
  "abstractFiles[]",
]);

// Default event ID (configurable via env)
const DEFAULT_EVENT_ID = parseInt(process.env.DEFAULT_EVENT_ID || "1", 10);

type ParsedAbstractFile = {
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
  size: number;
};

type UploadedAbstractFile = ParsedAbstractFile & {
  fileUrl: string;
  storedFileName: string;
  sortOrder: number;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fingerprintSubmission(data: unknown, files: ParsedAbstractFile[]): string {
  const normalizedFiles = files.map((file) => ({
    name: file.originalFileName,
    mimeType: file.mimeType,
    size: file.size,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ data, files: normalizedFiles }))
    .digest("hex");
}

function sanitizeFileSegment(
  value: string,
  fallback: string,
  maxLength: number,
): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9\s\u0E00-\u0E7F._-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "")
    .substring(0, maxLength);

  return sanitized || fallback;
}

function getPdfExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  const extension = lastDot >= 0 ? fileName.substring(lastDot).toLowerCase() : "";
  return extension === ".pdf" ? extension : ".pdf";
}

async function cleanupUploadedFiles(
  files: UploadedAbstractFile[],
  logger: FastifyInstance["log"],
) {
  await Promise.allSettled(
    files.map(async (file) => {
      const fileId = extractFileIdFromUrl(file.fileUrl);
      if (!fileId) return;

      try {
        await deleteFromGoogleDrive(fileId);
      } catch (error) {
        logger.warn({ err: error, fileUrl: file.fileUrl }, "Failed to clean up uploaded abstract file");
      }
    }),
  );
}

export default async function (fastify: FastifyInstance) {
  /**
   * Submit Abstract
   * POST /api/abstracts/submit
   * * Accepts multipart/form-data with abstract information and one or more PDF files
  */
  fastify.post("/submit", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    let idempotencyKeyForRequest: string | undefined;
    let idempotencyFingerprintForRequest: string | null = null;
    try {
      // Parse multipart form data
      const parts = request.parts();
      const formFields: Record<string, string> = {};
      const parsedFiles: ParsedAbstractFile[] = [];
      let totalFileSize = 0;
      let coAuthorsData: any[] = [];

      for await (const part of parts) {
        if (part.type === "file") {
          if (!ABSTRACT_FILE_FIELD_NAMES.has(part.fieldname)) {
            return reply.status(400).send({
              success: false,
              error: `Unexpected file field "${part.fieldname}". Use abstractFiles for abstract PDFs.`,
            });
          }

          if (parsedFiles.length >= MAX_FILES) {
            return reply.status(400).send({
              success: false,
              error: `Too many files. Maximum allowed is ${MAX_FILES} files.`,
            });
          }

          // Validate file type
          if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
            return reply.status(400).send({
              success: false,
              error: "Invalid file type. Only PDF files are allowed.",
            });
          }

          // Read file into buffer
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);
          const fileName = part.filename || `abstract-${parsedFiles.length + 1}.pdf`;

          // Validate file size
          if (fileBuffer.length > MAX_FILE_SIZE) {
            return reply.status(400).send({
              success: false,
              error: "File too large. Maximum size is 30MB.",
            });
          }

          totalFileSize += fileBuffer.length;
          if (totalFileSize > MAX_TOTAL_FILE_SIZE) {
            return reply.status(400).send({
              success: false,
              error: `Total abstract file size too large. Maximum combined size is ${Math.floor(MAX_TOTAL_FILE_SIZE / 1024 / 1024)}MB.`,
            });
          }

          parsedFiles.push({
            buffer: fileBuffer,
            originalFileName: fileName,
            mimeType: part.mimetype,
            size: fileBuffer.length,
          });
        } else if (part.type === "field") {
          // Handle special case for coAuthors (JSON string)
          if (part.fieldname === "coAuthors") {
            try {
              const value = part.value as string;
              if (value && value.trim()) {
                coAuthorsData = JSON.parse(value);
              }
            } catch (e) {
              return reply.status(400).send({
                success: false,
                error: "Invalid co-authors data format",
              });
            }
          } else {
            formFields[part.fieldname] = part.value as string;
          }
        }
      }

      // Add co-authors to form fields for validation
      const dataToValidate = {
        ...formFields,
        coAuthors: coAuthorsData,
      };

      // Validate form fields using schema
      const result = abstractSubmissionSchema.safeParse(dataToValidate);
      if (!result.success) {
        request.log.warn(
          {
            requestId: request.id,
            validationIssues: summarizeAbstractValidationIssues(result.error),
          },
          "Abstract submission validation failed",
        );

        return reply.status(400).send({
          success: false,
          code: "VALIDATION_ERROR",
          error: result.error.errors[0].message,
          details: result.error.errors,
          requestId: request.id,
        });
      }

      const {
        firstName,
        lastName,
        email,
        affiliation,
        phone,
        title,
        categoryId,
        presentationType,
        keywords,
        background,
        objective,
        methods,
        results,
        conclusion,
        coAuthors,
        eventCode,
      } = result.data;

      const abstractWordValidation = await validateAbstractWords({
        title,
        keywords,
        sections: {
          background,
          objective,
          methods,
          results,
          conclusion,
        },
      });
      const firstWordIssue = abstractWordValidation.issues[0];
      if (firstWordIssue) {
        return reply.status(400).send({
          success: false,
          code: firstWordIssue.code,
          error: formatAbstractWordCountIssue(firstWordIssue),
          details: abstractWordValidation,
        });
      }

      // Check if file was uploaded
      if (parsedFiles.length === 0) {
        return reply.status(400).send({
          success: false,
          error: "At least one abstract file (PDF) is required",
        });
      }

      const rawIdempotencyKey = request.headers["idempotency-key"];
      idempotencyKeyForRequest = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;
      if (idempotencyKeyForRequest !== undefined) {
        if (!idempotencyKeyForRequest || idempotencyKeyForRequest.length > 128) {
          return reply.status(400).send({ success: false, code: "INVALID_IDEMPOTENCY_KEY", error: "Invalid Idempotency-Key", requestId: request.id });
        }
        idempotencyFingerprintForRequest = fingerprintSubmission(result.data, parsedFiles);
        const [existingIdempotency] = await db
          .select()
          .from(abstractSubmissionIdempotencyKeys)
          .where(and(
            eq(abstractSubmissionIdempotencyKeys.userId, request.user.id),
            eq(abstractSubmissionIdempotencyKeys.idempotencyKey, idempotencyKeyForRequest),
          ))
          .limit(1);
        if (existingIdempotency) {
          if (existingIdempotency.requestFingerprint !== idempotencyFingerprintForRequest) {
            return reply.status(409).send({ success: false, code: "IDEMPOTENCY_KEY_REUSED", error: "Idempotency-Key was already used for a different submission", requestId: request.id });
          }
          reply.header("Idempotency-Replayed", "true");
          return reply.status(201).send(existingIdempotency.responseBody);
        }
      }

      // ── Resolve event by eventCode ──────────────────────────────────────
      let finalEventId = DEFAULT_EVENT_ID;
      let resolvedEventCode = eventCode || "";

      let eventEmailRow: EventEmailRow | null = null;

      if (eventCode) {
        const [eventRow] = await db
          .select({
            id: events.id,
            eventCode: events.eventCode,
            eventName: events.eventName,
            shortName: events.shortName,
            startDate: events.startDate,
            endDate: events.endDate,
            location: events.location,
            websiteUrl: events.websiteUrl,
          })
          .from(events)
          .where(eq(events.eventCode, eventCode))
          .limit(1);

        if (!eventRow) {
          return reply.status(400).send({
            success: false,
            error: `Invalid event code: ${eventCode}`,
          });
        }
        finalEventId = eventRow.id;
        resolvedEventCode = eventRow.eventCode;
        eventEmailRow = eventRow as EventEmailRow;
      }

      // ── Validate category against abstract_categories table ─────────
      const [catRow] = await db
        .select({ id: abstractCategories.id, name: abstractCategories.name })
        .from(abstractCategories)
        .where(
          and(
            eq(abstractCategories.id, categoryId),
            eq(abstractCategories.eventId, finalEventId),
            eq(abstractCategories.isActive, true),
          ),
        )
        .limit(1);

      if (!catRow) {
        return reply.status(400).send({
          success: false,
          error: "Invalid category selected for this event",
        });
      }

      const resolvedCategoryId = catRow.id;
      const categoryDisplayName = catRow.name;

      // ── Upload file to Google Drive ─────────────────────────────────────
      // Folder structure: Root → EventCode → Type (Oral/Poster) → Category name
      let fullPaperUrl: string;
      let uploadedFiles: UploadedAbstractFile[] = [];
      try {
        const typeFolderName = presentationType === "oral" ? "Oral" : "Poster";

        const sanitizedTitle = sanitizeFileSegment(title, "abstract", 80);

        // Build subfolder path
        const subfolders: string[] = resolvedEventCode
          ? [resolvedEventCode, typeFolderName, categoryDisplayName]
          : [typeFolderName, categoryDisplayName];

        for (const [index, file] of parsedFiles.entries()) {
          const sequence = String(index + 1).padStart(2, "0");
          const originalNameWithoutExt = file.originalFileName.replace(/\.[^.]+$/, "");
          const sanitizedOriginalName = sanitizeFileSegment(
            originalNameWithoutExt,
            `file_${sequence}`,
            60,
          );
          const extension = getPdfExtension(file.originalFileName);
          const docFileName = resolvedEventCode
            ? `${resolvedEventCode}_${presentationType}_abstract_${sanitizedTitle}_${sequence}_${sanitizedOriginalName}${extension}`
            : `abstract_${sanitizedTitle}_${sequence}_${sanitizedOriginalName}${extension}`;

          const fileUrl = await uploadToGoogleDrive(
            file.buffer,
            docFileName,
            file.mimeType,
            "abstracts",
            subfolders,
          );

          uploadedFiles.push({
            ...file,
            fileUrl,
            storedFileName: docFileName,
            sortOrder: index,
          });
        }

        fullPaperUrl = uploadedFiles[0].fileUrl;
      } catch (error) {
        await cleanupUploadedFiles(uploadedFiles, fastify.log);
        fastify.log.error({ err: error }, "Google Drive upload failed");
        return reply.status(500).send({
          success: false,
          error: "Failed to upload abstract file. Please try again.",
        });
      }
      // Prepare abstract data (userId from JWT token)
      const submissionResult = await db.transaction(async (tx) => {
        await assertAbstractWritesAvailable(tx);

        const eventLock = await tx.execute(sql`
          SELECT id, event_code, archived_at
          FROM events
          WHERE id = ${finalEventId}
          FOR UPDATE
        `);
        if ((eventLock as unknown as unknown[]).length === 0) {
          throw new ApiError("EVENT_NOT_FOUND", "Invalid event selected", 400);
        }
        const eventRow = (eventLock as unknown as Array<{ archived_at: Date | null }>)[0];
        if (eventRow.archived_at) {
          throw new ApiError("EVENT_ARCHIVED", "Submissions are disabled for this event", 409);
        }

        const categoryLock = await tx.execute(sql`
          SELECT id
          FROM abstract_categories
          WHERE id = ${resolvedCategoryId}
            AND event_id = ${finalEventId}
            AND is_active = true
          FOR UPDATE
        `);
        if ((categoryLock as unknown as unknown[]).length === 0) {
          throw new ApiError("ABSTRACT_CATEGORY_INVALID", "Invalid category selected for this event", 400);
        }

        const reservation = await allocateTrackingId(tx, {
          eventId: finalEventId,
          presentationType,
        });

        const abstractData: any = {
          eventId: finalEventId,
          userId: request.user.id,
          title,
          categoryId: resolvedCategoryId,
          presentationType,
          keywords,
          background,
          objective,
          methods,
          results,
          conclusion,
          fullPaperUrl,
          status: "pending" as const,
          trackingId: reservation.trackingId,
        };

        const [createdAbstract] = await tx
          .insert(abstracts)
          .values(abstractData)
          .returning();

        await appendTrackingAssignment(tx, {
          trackingId: reservation.trackingId,
          abstractId: createdAbstract.id,
          eventId: finalEventId,
          presentationType,
          reason: "initial_submission",
        });
        await appendTrackingAuditEvent(tx, {
          eventType: "abstract_tracking.issued",
          eventId: finalEventId,
          abstractId: createdAbstract.id,
          reasonCode: "initial_submission",
          requestId: request.id,
          afterState: { trackingId: reservation.trackingId, presentationType },
        });

        const insertedAbstractFiles = await tx
          .insert(abstractFiles)
          .values(
            uploadedFiles.map((file) => ({
              abstractId: createdAbstract.id,
              fileName: file.originalFileName,
              fileUrl: file.fileUrl,
              fileType: file.mimeType,
              fileSize: file.size,
              sortOrder: file.sortOrder,
            })),
          )
          .returning();

        // Insert co-authors if any
        if (coAuthors && coAuthors.length > 0) {
          const coAuthorsToInsert = coAuthors.map((coAuthor, index) => ({
            abstractId: createdAbstract.id,
            firstName: coAuthor.firstName,
            lastName: coAuthor.lastName,
            email: coAuthor.email,
            institution: coAuthor.institution,
            country: coAuthor.country,
            sortOrder: index,
          }));

          await tx.insert(abstractCoAuthors).values(coAuthorsToInsert);
        }

        const responseBody = {
          success: true,
          abstract: {
            id: createdAbstract.id,
            trackingId: reservation.trackingId,
            title: createdAbstract.title,
            status: createdAbstract.status,
            fullPaperUrl,
            files: insertedAbstractFiles,
            submittedAt: createdAbstract.createdAt,
          },
          message: "Abstract submitted successfully",
        };
        if (idempotencyKeyForRequest && idempotencyFingerprintForRequest) {
          const [stored] = await tx
            .insert(abstractSubmissionIdempotencyKeys)
            .values({
              userId: request.user.id,
              idempotencyKey: idempotencyKeyForRequest,
              requestFingerprint: idempotencyFingerprintForRequest,
              abstractId: createdAbstract.id,
              responseBody: responseBody as Record<string, unknown>,
            })
            .onConflictDoNothing()
            .returning({ id: abstractSubmissionIdempotencyKeys.id });
          if (!stored) {
            throw new Error("IDEMPOTENCY_RACE");
          }
        }

        return {
          newAbstract: createdAbstract,
          trackingId: reservation.trackingId,
          insertedFiles: insertedAbstractFiles,
          responseBody,
        };
      }).catch(async (error) => {
        await cleanupUploadedFiles(uploadedFiles, fastify.log);
        throw error;
      });

      const { newAbstract, trackingId, insertedFiles } = submissionResult;

      // -----------------------------------------------------------------------
      // Email Sending
      // -----------------------------------------------------------------------
      const runEmailTasksInBackground = async () => {
        try {
          // Build event email context
          const ctx = eventEmailRow
            ? buildEventEmailContext(eventEmailRow)
            : getDefaultEventEmailContext();

          // 1. Send to Main Author
          await sendEventAbstractSubmissionEmail(
            email,
            firstName,
            lastName,
            trackingId,
            title,
            ctx,
            presentationType,
          );

          fastify.log.info(
            `Background: Abstract submission email sent to ${email}`,
          );

          // 2. Send to Co-authors (with delay to prevent Rate Limit)
          if (coAuthors && coAuthors.length > 0) {
            const mainAuthorName = `${firstName} ${lastName}`;

            for (const coAuthor of coAuthors) {
              await delay(800);

              try {
                await sendEventCoAuthorNotificationEmail(
                  coAuthor.email,
                  coAuthor.firstName,
                  coAuthor.lastName,
                  mainAuthorName,
                  trackingId,
                  title,
                  ctx,
                );
                fastify.log.info(
                  `Background: Co-author notification sent to ${coAuthor.email}`,
                );
              } catch (emailError) {
                // Log error but don't stop the loop
                fastify.log.error(
                  { err: emailError },
                  `Failed to send co-author email to ${coAuthor.email}`,
                );
              }
            }
          }
        } catch (emailError) {
          // Log general email failure
          fastify.log.error(
            { err: emailError },
            "Background email task encountered an error",
          );
        }
      };

      // Execute background task without awaiting it
      runEmailTasksInBackground();

      // Return response immediately after DB insert (Response time ~3-5s)
      return reply.status(201).send(submissionResult.responseBody);
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENCY_RACE" && idempotencyKeyForRequest && idempotencyFingerprintForRequest) {
        const [existingIdempotency] = await db
          .select()
          .from(abstractSubmissionIdempotencyKeys)
          .where(and(
            eq(abstractSubmissionIdempotencyKeys.userId, request.user.id),
            eq(abstractSubmissionIdempotencyKeys.idempotencyKey, idempotencyKeyForRequest),
          ))
          .limit(1);
        if (existingIdempotency) {
          if (existingIdempotency.requestFingerprint !== idempotencyFingerprintForRequest) {
            return reply.status(409).send({ success: false, code: "IDEMPOTENCY_KEY_REUSED", error: "Idempotency-Key was already used for a different submission", requestId: request.id });
          }
          reply.header("Idempotency-Replayed", "true");
          return reply.status(201).send(existingIdempotency.responseBody);
        }
      }
      fastify.log.error(error);
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          ...error.toJSON(),
          requestId: request.id,
        });
      }
      return reply.status(500).send({
        success: false,
        code: "INTERNAL_ERROR",
        error: "Internal server error",
        requestId: request.id,
      });
    }
  });
}
