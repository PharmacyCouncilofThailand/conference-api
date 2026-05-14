import { FastifyInstance } from "fastify";
import { db } from "../../../database/index.js";
import {
    abstractCategories,
    abstractCoAuthors,
    abstractFiles,
    abstractRevisionRequestFiles,
    abstractRevisionRequests,
    abstracts,
    events,
} from "../../../database/schema.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { abstractResubmissionSchema } from "../../../schemas/abstracts.schema.js";
import {
    deleteFromGoogleDrive,
    extractFileIdFromUrl,
    uploadToGoogleDrive,
} from "../../../services/googleDrive.js";

const ALLOWED_MIME_TYPES = ["application/pdf"];
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_TOTAL_FILE_SIZE = MAX_FILE_SIZE * MAX_FILES;
const ABSTRACT_FILE_FIELD_NAMES = new Set([
    "abstractFile",
    "abstractFiles",
    "abstractFiles[]",
]);
const TITLE_WORD_LIMIT = 30;
const KEYWORD_LIMIT = 6;
const SECTION_MIN_WORDS = 10;

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

function validateWordCount(
    background: string,
    objective: string,
    methods: string,
    results: string,
    conclusion: string,
): { valid: boolean; count: number } {
    const totalText = [background, objective, methods, results, conclusion].join(" ");
    const wordCount = countWords(totalText);

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
                    category: abstracts.category,
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
                .where(eq(abstracts.userId, userId))
                .orderBy(desc(abstracts.createdAt));

            const abstractIds = userAbstracts.map((abstract) => abstract.id);
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
                    category: abstracts.category,
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
                })
                .from(abstracts)
                .leftJoin(events, eq(abstracts.eventId, events.id))
                .where(and(eq(abstracts.id, abstractId), eq(abstracts.userId, userId)))
                .limit(1);

            if (!currentAbstract) {
                return reply.status(404).send({ success: false, error: "Abstract not found" });
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
                return reply.status(400).send({
                    success: false,
                    error: result.error.errors[0].message,
                    details: result.error.errors,
                });
            }

            const {
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

            if (parsedFiles.length === 0) {
                return reply.status(400).send({
                    success: false,
                    error: "At least one replacement abstract file (PDF) is required",
                });
            }

            const [catRow] = await db
                .select({ id: abstractCategories.id })
                .from(abstractCategories)
                .where(
                    and(
                        eq(abstractCategories.eventId, currentAbstract.eventId),
                        eq(abstractCategories.name, category),
                        eq(abstractCategories.isActive, true),
                    ),
                )
                .limit(1);

            if (!catRow) {
                return reply.status(400).send({
                    success: false,
                    error: `Invalid category "${category}" for this event`,
                });
            }

            let uploadedFiles: UploadedAbstractFile[] = [];
            try {
                const typeFolderName = presentationType === "oral" ? "Oral" : "Poster";
                const sanitizedTitle = sanitizeFileSegment(title, "abstract", 80);
                const subfolders = currentAbstract.eventCode
                    ? [currentAbstract.eventCode, typeFolderName, category]
                    : [typeFolderName, category];

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

            const { updatedAbstract, insertedFiles } = await db
                .transaction(async (tx) => {
                    const [updated] = await tx
                        .update(abstracts)
                        .set({
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

                    return { updatedAbstract: updated, insertedFiles: newFiles };
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
                    trackingId: updatedAbstract.trackingId,
                    title: updatedAbstract.title,
                    status: updatedAbstract.status,
                    fullPaperUrl,
                    files: insertedFiles,
                    resubmittedAt: new Date().toISOString(),
                },
                message: "Abstract resubmitted successfully",
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({
                success: false,
                error: "Failed to resubmit abstract",
            });
        }
    });
}
