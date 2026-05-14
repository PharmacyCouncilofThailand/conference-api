import { FastifyInstance } from "fastify";
import { abstractSubmissionSchema } from "../../../schemas/abstracts.schema.js";
import { db } from "../../../database/index.js";
import {
  abstracts,
  abstractFiles,
  abstractCoAuthors,
  abstractCategories,
  events,
} from "../../../database/schema.js";
import {
  deleteFromGoogleDrive,
  extractFileIdFromUrl,
  uploadToGoogleDrive,
} from "../../../services/googleDrive.js";
import { eq, and, sql } from "drizzle-orm";
import { buildEventEmailContext, getDefaultEventEmailContext, type EventEmailRow } from "../../../services/emailTemplates.types.js";
import { sendEventAbstractSubmissionEmail, sendEventCoAuthorNotificationEmail } from "../../../services/emailTemplates.js";

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

const TITLE_WORD_LIMIT = 30;
const KEYWORD_LIMIT = 6;
const SECTION_MIN_WORDS = 10;

// Default event ID (configurable via env)
const DEFAULT_EVENT_ID = parseInt(process.env.DEFAULT_EVENT_ID || "1", 10);

type WordSegment = {
  segment: string;
  isWordLike?: boolean;
};

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

/**
 * Helper function to count words in text
 */
function getWordSegments(text: string): WordSegment[] | null {
  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: "word" },
    ) => { segment(input: string): Iterable<WordSegment> };
  };

  if (!intlWithSegmenter.Segmenter) return null;

  const segmenter = new intlWithSegmenter.Segmenter(["th", "en"], {
    granularity: "word",
  });

  return Array.from(segmenter.segment(text));
}

function countWords(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;

  const segments = getWordSegments(normalized);
  if (segments) {
    return segments.filter((segment) => segment.isWordLike).length;
  }

  return normalized.split(/\s+/).filter((word) => word.length > 0).length;
}

function parseKeywords(text: string): string[] {
  return text.split(",").map((keyword) => keyword.trim()).filter(Boolean);
}

/**
 * Validate total word count for abstract sections
 */
function validateWordCount(
  background: string,
  objective: string,
  methods: string,
  results: string,
  conclusion: string,
): { valid: boolean; count: number } {
  const totalText = [background, objective, methods, results, conclusion].join(" ");
  const wordCount = countWords(totalText);

  // Word count should be max 300 words
  return {
    valid: wordCount <= 300,
    count: wordCount,
  };
}

function validateSectionWordMinimum(
  sections: Record<string, string>,
): { valid: boolean; section?: string; count?: number } {
  for (const [section, text] of Object.entries(sections)) {
    const wordCount = countWords(text);
    if (wordCount < SECTION_MIN_WORDS) {
      return { valid: false, section, count: wordCount };
    }
  }

  return { valid: true };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        return reply.status(400).send({
          success: false,
          error: result.error.errors[0].message,
          details: result.error.errors,
        });
      }

      const {
        firstName,
        lastName,
        email,
        affiliation,
        phone,
        title,
        category,
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

      const titleWordCount = countWords(title);
      if (titleWordCount > TITLE_WORD_LIMIT) {
        return reply.status(400).send({
          success: false,
          error: `Abstract title must not exceed ${TITLE_WORD_LIMIT} words. Current: ${titleWordCount} words`,
        });
      }

      const keywordCount = parseKeywords(keywords).length;
      if (keywordCount > KEYWORD_LIMIT) {
        return reply.status(400).send({
          success: false,
          error: `Keywords must not exceed ${KEYWORD_LIMIT} comma-separated items. Current: ${keywordCount}`,
        });
      }

      const sectionMinimumValidation = validateSectionWordMinimum({
        background,
        objective,
        methods,
        results,
        conclusion,
      });
      if (!sectionMinimumValidation.valid) {
        return reply.status(400).send({
          success: false,
          error: `${sectionMinimumValidation.section} must be at least ${SECTION_MIN_WORDS} words. Current: ${sectionMinimumValidation.count} words`,
        });
      }

      // Validate word count
      const wordValidation = validateWordCount(
        background,
        objective,
        methods,
        results,
        conclusion,
      );
      if (!wordValidation.valid) {
        return reply.status(400).send({
          success: false,
          error: `Abstract word count must not exceed 300 words. Current: ${wordValidation.count} words`,
        });
      }

      // Check if file was uploaded
      if (parsedFiles.length === 0) {
        return reply.status(400).send({
          success: false,
          error: "At least one abstract file (PDF) is required",
        });
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

      // ── Validate category name against abstract_categories table ─────────
      const categoryDisplayName = category;

      if (finalEventId) {
        const [catRow] = await db
          .select({ id: abstractCategories.id })
          .from(abstractCategories)
          .where(
            and(
              eq(abstractCategories.eventId, finalEventId),
              eq(abstractCategories.name, category),
              eq(abstractCategories.isActive, true),
            )
          )
          .limit(1);

        if (!catRow) {
          return reply.status(400).send({
            success: false,
            error: `Invalid category "${category}" for this event`,
          });
        }
      }

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
      const abstractData: any = {
        eventId: finalEventId,
        userId: request.user.id,
        title,
        category,
        presentationType,
        keywords,
        background,
        objective,
        methods,
        results,
        conclusion,
        fullPaperUrl,
        status: "pending" as const,
      };

      const { newAbstract, trackingId, insertedFiles } = await db.transaction(async (tx) => {
        // Insert abstract
        const [createdAbstract] = await tx
          .insert(abstracts)
          .values(abstractData)
          .returning();

        // Generate tracking ID based on event + presentation type
        const prefix = resolvedEventCode || process.env.TRACKING_ID_PREFIX || "CONF";
        const padLength = parseInt(process.env.TRACKING_ID_PAD_LENGTH || "3", 10);
        const typePrefix = presentationType === "oral" ? "O" : "P";

        // Count existing abstracts of same presentation type within the same event
        const countResult = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(abstracts)
          .where(
            and(
              eq(abstracts.eventId, finalEventId),
              eq(abstracts.presentationType, presentationType as "oral" | "poster"),
            )
          );

        const runningNumber = (countResult[0]?.count || 0);
        const generatedTrackingId = `${prefix}-${typePrefix}${String(runningNumber).padStart(padLength, "0")}`;

        // Update abstract with tracking ID
        await tx
          .update(abstracts)
          .set({ trackingId: generatedTrackingId })
          .where(eq(abstracts.id, createdAbstract.id));

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

        return {
          newAbstract: createdAbstract,
          trackingId: generatedTrackingId,
          insertedFiles: insertedAbstractFiles,
        };
      }).catch(async (error) => {
        await cleanupUploadedFiles(uploadedFiles, fastify.log);
        throw error;
      });

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
      return reply.status(201).send({
        success: true,
        abstract: {
          id: newAbstract.id,
          trackingId,
          title: newAbstract.title,
          status: newAbstract.status,
          fullPaperUrl,
          files: insertedFiles,
          submittedAt: newAbstract.createdAt,
        },
        message: "Abstract submitted successfully",
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Internal server error",
      });
    }
  });
}
