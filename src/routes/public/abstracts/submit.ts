import { FastifyInstance } from "fastify";
import { abstractSubmissionSchema } from "../../../schemas/abstracts.schema.js";
import { db } from "../../../database/index.js";
import {
  abstracts,
  abstractCoAuthors,
  abstractCategories,
  events,
} from "../../../database/schema.js";
import {
  uploadToGoogleDrive,
} from "../../../services/googleDrive.js";
import { eq, and, sql } from "drizzle-orm";
import { buildEventEmailContext, getDefaultEventEmailContext, type EventEmailRow } from "../../../services/emailTemplates.types.js";
import { sendEventAbstractSubmissionEmail, sendEventCoAuthorNotificationEmail } from "../../../services/emailTemplates.js";

// Allowed file types for abstract documents
const ALLOWED_MIME_TYPES = ["application/pdf"];

// Max file size: 30MB
const MAX_FILE_SIZE = 30 * 1024 * 1024;

// Default event ID (configurable via env)
const DEFAULT_EVENT_ID = parseInt(process.env.DEFAULT_EVENT_ID || "1", 10);

/**
 * Helper function to count words in text
 */
function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
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

  // Word count should be max 250 words
  return {
    valid: wordCount <= 250,
    count: wordCount,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function (fastify: FastifyInstance) {
  /**
   * Submit Abstract
   * POST /api/abstracts/submit
   * * Accepts multipart/form-data with abstract information and PDF file
   */
  fastify.post("/submit", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      // Parse multipart form data
      const parts = request.parts();
      const formFields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;
      let fileName: string = "";
      let mimeType: string = "";
      let coAuthorsData: any[] = [];

      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "abstractFile") {
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
          fileBuffer = Buffer.concat(chunks);
          fileName = part.filename;
          mimeType = part.mimetype;

          // Validate file size
          if (fileBuffer.length > MAX_FILE_SIZE) {
            return reply.status(400).send({
              success: false,
              error: "File too large. Maximum size is 30MB.",
            });
          }
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
          error: `Abstract word count must not exceed 250 words. Current: ${wordValidation.count} words`,
        });
      }

      // Check if file was uploaded
      if (!fileBuffer) {
        return reply.status(400).send({
          success: false,
          error: "Abstract file (PDF) is required",
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
      try {
        const typeFolderName = presentationType === "oral" ? "Oral" : "Poster";

        // Build sanitised filename: {eventCode}_{type}_abstract_{title}.pdf
        const sanitizedTitle = title
          .replace(/[^a-zA-Z0-9\s\u0E00-\u0E7F]/g, "")
          .replace(/\s+/g, "_")
          .substring(0, 80);
        const docFileName = resolvedEventCode
          ? `${resolvedEventCode}_${presentationType}_abstract_${sanitizedTitle}.pdf`
          : `abstract_${sanitizedTitle}.pdf`;

        // Build subfolder path
        const subfolders: string[] = resolvedEventCode
          ? [resolvedEventCode, typeFolderName, categoryDisplayName]
          : [typeFolderName, categoryDisplayName];

        fullPaperUrl = await uploadToGoogleDrive(
          fileBuffer,
          docFileName,
          mimeType,
          "abstracts",
          subfolders,
        );
      } catch (error) {
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

      // Insert abstract
      const [newAbstract] = await db
        .insert(abstracts)
        .values(abstractData)
        .returning();

      // Generate tracking ID based on event + presentation type
      const prefix = resolvedEventCode || process.env.TRACKING_ID_PREFIX || "CONF";
      const padLength = parseInt(process.env.TRACKING_ID_PAD_LENGTH || "3", 10);
      const typePrefix = presentationType === "oral" ? "O" : "P";
      
      // Count existing abstracts of same presentation type within the same event
      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(abstracts)
        .where(
          and(
            eq(abstracts.eventId, finalEventId),
            eq(abstracts.presentationType, presentationType as "oral" | "poster"),
          )
        );
      
      const runningNumber = (countResult[0]?.count || 0);
      const trackingId = `${prefix}-${typePrefix}${String(runningNumber).padStart(padLength, "0")}`;
      
      // Update abstract with tracking ID
      await db
        .update(abstracts)
        .set({ trackingId })
        .where(eq(abstracts.id, newAbstract.id));

      // Insert co-authors if any
      if (coAuthors && coAuthors.length > 0) {
        const coAuthorsToInsert = coAuthors.map((coAuthor, index) => ({
          abstractId: newAbstract.id,
          firstName: coAuthor.firstName,
          lastName: coAuthor.lastName,
          email: coAuthor.email,
          institution: coAuthor.institution,
          country: coAuthor.country,
          sortOrder: index,
        }));

        await db.insert(abstractCoAuthors).values(coAuthorsToInsert);
      }

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
