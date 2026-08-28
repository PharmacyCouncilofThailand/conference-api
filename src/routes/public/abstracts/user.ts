import { FastifyInstance } from "fastify";
import { db } from "../../../database/index.js";
import {
    abstractCategories,
    abstractCoAuthors,
    abstractFiles,
    abstractRevisionRequestFiles,
    abstractRevisionRequests,
    abstracts,
    abstractTrackingIdentifiers,
    events,
} from "../../../database/schema.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../../errors/ApiError.js";
import {
    allocateTrackingId,
    appendTrackingAssignment,
    appendTrackingAuditEvent,
    assertAbstractWritesAvailable,
    assertTypeChangeAvailable,
} from "../../../modules/abstracts/tracking.repository.js";
import { abstractResubmissionSchema } from "../../../schemas/abstracts.schema.js";
import {
    deleteFromGoogleDrive,
    extractFileIdFromUrl,
    uploadToGoogleDrive,
} from "../../../services/googleDrive.js";
import {
    formatAbstractWordCountIssue,
    validateAbstractWords,
} from "../../../utils/abstractWordCount.js";
import { summarizeAbstractValidationIssues } from "./validation.js";

const ALLOWED_MIME_TYPES = ["application/pdf"];
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_TOTAL_FILE_SIZE = MAX_FILE_SIZE * MAX_FILES;
const ABSTRACT_FILE_FIELD_NAMES = new Set([
    "abstractFile",
    "abstractFiles",
    "abstractFiles[]",
]);
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

function sanitizeFileSegment(value: string, fallback: string, maxLength: number): string {
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

async function cleanupExistingDriveFiles(
    files: { fileUrl: string }[],
    logger: FastifyInstance["log"],
) {
    await Promise.allSettled(
        files.map(async (file) => {
            const fileId = extractFileIdFromUrl(file.fileUrl);
            if (!fileId) return;

            try {
                await deleteFromGoogleDrive(fileId);
            } catch (error) {
                logger.warn({ err: error, fileUrl: file.fileUrl }, "Failed to delete replaced abstract file");
            }
        }),
    );
}


export default async function (fastify: FastifyInstance) {
    // Get current user's abstracts (JWT-protected)
    fastify.get("", { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.id;

            // Fetch user's abstracts
            const userAbstracts = await db
                .select({
                    id: abstracts.id,
                    trackingId: abstracts.trackingId,
                    title: abstracts.title,
                    categoryId: abstracts.categoryId,
                    category: abstractCategories.name,
                    categoryName: abstractCategories.name,
                    presentationType: abstracts.presentationType,
                    status: abstracts.status,
                    keywords: abstracts.keywords,
                    background: abstracts.background,
                    objective: abstracts.objective,
                    methods: abstracts.methods,
                    results: abstracts.results,
                    conclusion: abstracts.conclusion,
                    fullPaperUrl: abstracts.fullPaperUrl,
                    createdAt: abstracts.createdAt,
                })
                .from(abstracts)
                .leftJoin(abstractCategories, eq(abstracts.categoryId, abstractCategories.id))
                .where(and(eq(abstracts.userId, userId), isNull(abstracts.archivedAt)))
                .orderBy(desc(abstracts.createdAt));

            const abstractIds = userAbstracts.map((abstract) => abstract.id);
            const trackingHistory = abstractIds.length > 0
                ? await db
                    .select()
                    .from(abstractTrackingIdentifiers)
                    .where(inArray(abstractTrackingIdentifiers.abstractId, abstractIds))
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

            const abstractsWithCoAuthors = userAbstracts.map((abstract) => ({
                ...abstract,
                trackingAliases: trackingHistory
                    .filter((entry) => entry.abstractId === abstract.id && entry.trackingId !== abstract.trackingId)
                    .map((entry) => entry.trackingId),
                trackingIdHistory: trackingHistory
                    .filter((entry) => entry.abstractId === abstract.id)
                    .sort((a, b) => a.assignedAt.getTime() - b.assignedAt.getTime()),
                category: abstract.categoryName || abstract.category,
                coAuthors: coAuthorsList.filter((coAuthor) => coAuthor.abstractId === abstract.id),
                files: filesList
                    .filter((file) => file.abstractId === abstract.id)
                    .sort((a, b) => a.sortOrder - b.sortOrder),
                latestRevisionRequest: revisionRequestsList
                    .filter((request) => request.abstractId === abstract.id)
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                    .map((request) => ({
                        ...request,
                        files: revisionRequestFilesList.filter((file) => file.revisionRequestId === request.id),
                    }))[0] || null,
            }));

            return reply.send({
                abstracts: abstractsWithCoAuthors,
                total: abstractsWithCoAuthors.length,
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch abstracts" });
        }
    });

    // Load an abstract for editing after backoffice requested a revision.
    fastify.get("/:id/edit", { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const abstractId = parseInt(id, 10);

        if (Number.isNaN(abstractId)) {
            return reply.status(400).send({ error: "Invalid abstract id" });
        }

        try {
            const userId = request.user.id;
            const [abstractData] = await db
                .select({
                    id: abstracts.id,
                    trackingId: abstracts.trackingId,
                    title: abstracts.title,
                    categoryId: abstracts.categoryId,
                    category: abstractCategories.name,
                    categoryName: abstractCategories.name,
                    presentationType: abstracts.presentationType,
                    status: abstracts.status,
                    keywords: abstracts.keywords,
                    background: abstracts.background,
                    objective: abstracts.objective,
                    methods: abstracts.methods,
                    results: abstracts.results,
                    conclusion: abstracts.conclusion,
                    fullPaperUrl: abstracts.fullPaperUrl,
                    createdAt: abstracts.createdAt,
                })
                .from(abstracts)
                .leftJoin(abstractCategories, eq(abstracts.categoryId, abstractCategories.id))
                .where(and(eq(abstracts.id, abstractId), eq(abstracts.userId, userId)))
                .limit(1);

            if (!abstractData) {
                return reply.status(404).send({ error: "Abstract not found" });
            }

            if (abstractData.status !== "revision") {
                return reply.status(400).send({
                    error: "This abstract is not currently open for revision.",
                });
            }

            const coAuthors = await db
                .select()
                .from(abstractCoAuthors)
                .where(eq(abstractCoAuthors.abstractId, abstractId));
            const files = await db
                .select()
                .from(abstractFiles)
                .where(eq(abstractFiles.abstractId, abstractId));
            const revisionRequests = await db
                .select()
                .from(abstractRevisionRequests)
                .where(eq(abstractRevisionRequests.abstractId, abstractId))
                .orderBy(desc(abstractRevisionRequests.createdAt));
            const revisionRequestIds = revisionRequests.map((revisionRequest) => revisionRequest.id);
            const revisionFiles =
                revisionRequestIds.length > 0
                    ? await db
                        .select()
                        .from(abstractRevisionRequestFiles)
                        .where(inArray(abstractRevisionRequestFiles.revisionRequestId, revisionRequestIds))
                    : [];
            const revisionRequestsWithFiles = revisionRequests.map((revisionRequest) => ({
                ...revisionRequest,
                files: revisionFiles.filter((file) => file.revisionRequestId === revisionRequest.id),
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
            return reply.status(500).send({ error: "Failed to load abstract for editing" });
        }
    });

    // Resubmit an abstract after revision. Attached abstract PDFs replace old files.
    fastify.patch("/:id/resubmit", { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const abstractId = parseInt(id, 10);

        if (Number.isNaN(abstractId)) {
            return reply.status(400).send({ success: false, error: "Invalid abstract id" });
        }

        try {
            const userId = request.user.id;
            const [currentAbstract] = await db
                .select({
                    id: abstracts.id,
                    trackingId: abstracts.trackingId,
                    status: abstracts.status,
                    eventId: abstracts.eventId,
                    title: abstracts.title,
                    eventCode: events.eventCode,
                    archivedAt: abstracts.archivedAt,
                })
                .from(abstracts)
                .leftJoin(events, eq(abstracts.eventId, events.id))
                .where(and(eq(abstracts.id, abstractId), eq(abstracts.userId, userId)))
                .limit(1);

            if (!currentAbstract) {
                return reply.status(404).send({ success: false, error: "Abstract not found" });
            }

            if (currentAbstract.archivedAt) {
                return reply.status(409).send({
                    success: false,
                    code: "ABSTRACT_ARCHIVED",
                    error: "Abstract is archived",
                    requestId: request.id,
                });
            }

            if (currentAbstract.status !== "revision") {
                return reply.status(400).send({
                    success: false,
                    error: "Only abstracts with revision status can be resubmitted.",
                });
            }

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

                    if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
                        return reply.status(400).send({
                            success: false,
                            error: "Invalid file type. Only PDF files are allowed.",
                        });
                    }

                    const chunks: Buffer[] = [];
                    for await (const chunk of part.file) {
                        chunks.push(chunk);
                    }
                    const fileBuffer = Buffer.concat(chunks);
                    const fileName = part.filename || `abstract-${parsedFiles.length + 1}.pdf`;

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
                    if (part.fieldname === "coAuthors") {
                        try {
                            const value = part.value as string;
                            if (value && value.trim()) {
                                coAuthorsData = JSON.parse(value);
                            }
                        } catch {
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

            const result = abstractResubmissionSchema.safeParse({
                ...formFields,
                coAuthors: coAuthorsData,
            });
            if (!result.success) {
                request.log.warn(
                    {
                        requestId: request.id,
                        validationIssues: summarizeAbstractValidationIssues(result.error),
                    },
                    "Abstract resubmission validation failed",
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

            if (parsedFiles.length === 0) {
                return reply.status(400).send({
                    success: false,
                    error: "At least one replacement abstract file (PDF) is required",
                });
            }

            const [catRow] = await db
                .select({ id: abstractCategories.id, name: abstractCategories.name })
                .from(abstractCategories)
                .where(
                    and(
                        eq(abstractCategories.id, categoryId),
                        eq(abstractCategories.eventId, currentAbstract.eventId),
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

            let uploadedFiles: UploadedAbstractFile[] = [];
            try {
                const typeFolderName = presentationType === "oral" ? "Oral" : "Poster";
                const sanitizedTitle = sanitizeFileSegment(title, "abstract", 80);
                const subfolders = currentAbstract.eventCode
                    ? [currentAbstract.eventCode, typeFolderName, categoryDisplayName]
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
                    const docFileName = currentAbstract.eventCode
                        ? `${currentAbstract.eventCode}_${presentationType}_abstract_resubmitted_${sanitizedTitle}_${sequence}_${sanitizedOriginalName}${extension}`
                        : `abstract_resubmitted_${sanitizedTitle}_${sequence}_${sanitizedOriginalName}${extension}`;

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
            } catch (error) {
                await cleanupUploadedFiles(uploadedFiles, fastify.log);
                fastify.log.error({ err: error }, "Replacement abstract file upload failed");
                return reply.status(500).send({
                    success: false,
                    error: "Failed to upload replacement abstract files. Please try again.",
                });
            }

            const oldFiles = await db
                .select()
                .from(abstractFiles)
                .where(eq(abstractFiles.abstractId, abstractId));
            const fullPaperUrl = uploadedFiles[0].fileUrl;

            const { updatedAbstract, insertedFiles, trackingId } = await db
                .transaction(async (tx) => {
                    await assertAbstractWritesAvailable(tx);

                    const eventLock = await tx.execute(sql`
                        SELECT id, archived_at
                        FROM events
                        WHERE id = ${currentAbstract.eventId}
                        FOR UPDATE
                    `);
                    if ((eventLock as unknown as unknown[]).length === 0) {
                        throw new ApiError("EVENT_NOT_FOUND", "Event not found", 400);
                    }
                    const eventRow = (eventLock as unknown as Array<{ archived_at: Date | null }>)[0];
                    if (eventRow.archived_at) {
                        throw new ApiError("EVENT_ARCHIVED", "Submissions are disabled for this event", 409);
                    }

                    const abstractLock = await tx.execute(sql`
                        SELECT id, tracking_id, presentation_type, status
                        FROM abstracts
                        WHERE id = ${abstractId} AND user_id = ${userId}
                        FOR UPDATE
                    `) as unknown as Array<{
                        id: number;
                        tracking_id: string | null;
                        presentation_type: "oral" | "poster";
                        status: string;
                    }>;
                    const lockedAbstract = abstractLock[0];
                    if (!lockedAbstract || lockedAbstract.status !== "revision") {
                        throw new ApiError(
                            "ABSTRACT_NOT_OPEN_FOR_REVISION",
                            "Only abstracts with revision status can be resubmitted.",
                            400,
                        );
                    }

                    const categoryLock = await tx.execute(sql`
                        SELECT id
                        FROM abstract_categories
                        WHERE id = ${resolvedCategoryId}
                          AND event_id = ${currentAbstract.eventId}
                          AND is_active = true
                        FOR UPDATE
                    `);
                    if ((categoryLock as unknown as unknown[]).length === 0) {
                        throw new ApiError("ABSTRACT_CATEGORY_INVALID", "Invalid category selected for this event", 400);
                    }

                    const typeChanged = lockedAbstract.presentation_type !== presentationType;
                    let nextTrackingId = lockedAbstract.tracking_id;
                    if (typeChanged) {
                        await assertTypeChangeAvailable(tx);
                        const reservation = await allocateTrackingId(tx, {
                            eventId: currentAbstract.eventId,
                            presentationType,
                        });
                        nextTrackingId = reservation.trackingId;
                        await appendTrackingAssignment(tx, {
                            trackingId: reservation.trackingId,
                            abstractId,
                            eventId: currentAbstract.eventId,
                            presentationType,
                            previousTrackingId: lockedAbstract.tracking_id,
                            reason: "presentation_type_change",
                        });
                        await appendTrackingAuditEvent(tx, {
                            eventType: "abstract_tracking.rotated",
                            eventId: currentAbstract.eventId,
                            abstractId,
                            reasonCode: "presentation_type_change",
                            requestId: request.id,
                            beforeState: {
                                trackingId: lockedAbstract.tracking_id,
                                presentationType: lockedAbstract.presentation_type,
                            },
                            afterState: {
                                trackingId: reservation.trackingId,
                                presentationType,
                            },
                        });
                    }

                    const [updated] = await tx
                        .update(abstracts)
                        .set({
                            title,
                            categoryId: resolvedCategoryId,
                            presentationType,
                            trackingId: nextTrackingId,
                            keywords,
                            background,
                            objective,
                            methods,
                            results,
                            conclusion,
                            fullPaperUrl,
                            status: "pending",
                        })
                        .where(eq(abstracts.id, abstractId))
                        .returning();

                    await tx
                        .delete(abstractCoAuthors)
                        .where(eq(abstractCoAuthors.abstractId, abstractId));

                    if (coAuthors && coAuthors.length > 0) {
                        await tx.insert(abstractCoAuthors).values(
                            coAuthors.map((coAuthor, index) => ({
                                abstractId,
                                firstName: coAuthor.firstName,
                                lastName: coAuthor.lastName,
                                email: coAuthor.email,
                                institution: coAuthor.institution,
                                country: coAuthor.country,
                                sortOrder: index,
                            })),
                        );
                    }

                    await tx
                        .delete(abstractFiles)
                        .where(eq(abstractFiles.abstractId, abstractId));

                    const newFiles = await tx
                        .insert(abstractFiles)
                        .values(
                            uploadedFiles.map((file) => ({
                                abstractId,
                                fileName: file.originalFileName,
                                fileUrl: file.fileUrl,
                                fileType: file.mimeType,
                                fileSize: file.size,
                                sortOrder: file.sortOrder,
                            })),
                        )
                        .returning();

                    await tx
                        .update(abstractRevisionRequests)
                        .set({
                            status: "resubmitted",
                            resubmittedAt: new Date(),
                        })
                        .where(
                            and(
                                eq(abstractRevisionRequests.abstractId, abstractId),
                                eq(abstractRevisionRequests.status, "open"),
                            ),
                        );

                    return { updatedAbstract: updated, insertedFiles: newFiles, trackingId: nextTrackingId };
                })
                .catch(async (error) => {
                    await cleanupUploadedFiles(uploadedFiles, fastify.log);
                    throw error;
                });

            await cleanupExistingDriveFiles(oldFiles, fastify.log);

            return reply.send({
                success: true,
                abstract: {
                    id: updatedAbstract.id,
                    trackingId,
                    title: updatedAbstract.title,
                    status: updatedAbstract.status,
                    fullPaperUrl,
                    files: insertedFiles,
                    resubmittedAt: new Date().toISOString(),
                },
                message: "Abstract resubmitted successfully",
            });
        } catch (error) {
            if (error instanceof ApiError) {
                return reply.status(error.statusCode).send({
                    ...error.toJSON(),
                    requestId: request.id,
                });
            }
            fastify.log.error(error);
            return reply.status(500).send({
                success: false,
                code: "INTERNAL_ERROR",
                error: "Failed to resubmit abstract",
                requestId: request.id,
            });
        }
    });
}
