import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const uuidKey = z.string().uuid();

export const attendanceSetupBodySchema = z.object({
  mainSessionId: z.number().int().positive(),
  expectedReadinessRevision: z.string().regex(/^[a-f0-9]{64}$/),
  reason: boundedText(500),
  idempotencyKey: uuidKey,
}).strict();

export const bilingualTextSchema = z.object({
  th: boundedText(160),
  en: boundedText(160),
}).strict();

export const wheelSegmentConfigurationSchema = z.object({
  id: uuidKey,
  kind: z.enum(["prize", "no_prize"]),
  name: bilingualTextSchema,
  imageId: uuidKey.nullable(),
  enabled: z.boolean(),
  position: z.number().int().nonnegative().max(255),
  initialQuantity: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "no_prize" && value.initialQuantity !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["initialQuantity"], message: "no-prize segments are unlimited" });
  }
});

export const wheelConfigurationSchema = z.object({
  segments: z.array(wheelSegmentConfigurationSchema).min(1).max(64),
  collectionInstructions: bilingualTextSchema.optional(),
  collectionDeadline: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const positions = new Set<number>();
  value.segments.forEach((segment, index) => {
    if (ids.has(segment.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments", index, "id"],
        message: "segment id must be unique",
      });
    }
    ids.add(segment.id);
    if (positions.has(segment.position)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments", index, "position"],
        message: "segment position must be unique",
      });
    }
    positions.add(segment.position);
  });
});

export const publishWheelBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  configuration: wheelConfigurationSchema,
  reason: boundedText(500).optional(),
}).strict();

export const initializeWheelBodySchema = z.object({
  mainSessionId: z.number().int().positive(),
}).strict();

export const stockAdjustmentBodySchema = z.object({
  segmentId: uuidKey,
  delta: z.number().int().min(1).max(1_000_000),
  reason: boundedText(500),
  idempotencyKey: uuidKey,
}).strict();

export const setWheelPausedBodySchema = z.object({
  paused: z.boolean(),
  reason: boundedText(500),
  idempotencyKey: uuidKey,
}).strict();

export const wheelDayDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

export const dayWindowBodySchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  expectedVersion: z.number().int().positive().nullable(),
  reason: boundedText(500).nullable(),
}).strict();

export const dayChangesQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const qrBatchBodySchema = z.object({
  date: wheelDayDateSchema,
  names: z.array(boundedText(160)).min(1).max(20).refine(
    (names) => new Set(names.map((name) => name.toLocaleLowerCase())).size === names.length,
    { message: "QR names must be distinct within a batch" },
  ),
  idempotencyKey: uuidKey,
}).strict();

export const qrListQuerySchema = z.object({
  date: wheelDayDateSchema,
  page: z.coerce.number().int().positive().max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const qrStatusBodySchema = z.object({
  status: z.enum(["open", "closed"]),
  reason: z.string().trim().max(500).optional(),
  idempotencyKey: uuidKey,
}).strict();

export const qrRevocationBodySchema = z.object({
  reason: boundedText(500),
  idempotencyKey: uuidKey,
}).strict();

export const qrCreditClaimBodySchema = z.object({
  qrId: uuidKey,
}).strict();

export const spinInputSchema = z.object({
  eventId: z.number().int().positive(),
  configurationVersion: z.number().int().positive(),
  poolRevision: z.number().int().positive(),
  scheduleVersion: z.number().int().positive(),
  idempotencyKey: uuidKey,
}).strict();

export const wheelImageUploadResponseSchema = z.object({
  imageId: uuidKey,
  imageKey: boundedText(512),
  url: z.string().url(),
  width: z.number().int().positive().max(1600),
  height: z.number().int().positive().max(1600),
}).strict();

export const adminSpinQuerySchema = z.object({
  date: z.string().date().optional(),
  segmentId: uuidKey.optional(),
  claimStatus: z.enum(["none", "open", "redeemed"]).optional(),
  page: z.coerce.number().int().positive().max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const attendeeSpinHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const rewardLookupBodySchema = z.object({
  credential: boundedText(256),
}).strict();

export const redemptionInputSchema = z.object({
  eventId: z.number().int().positive(),
  spinId: uuidKey,
  claimGeneration: z.number().int().positive(),
  idempotencyKey: uuidKey,
  identityChecked: z.literal(true),
  collectionPoint: boundedText(255),
  deliveredDetails: boundedText(1000).nullable(),
}).strict();

export const redemptionCorrectionBodySchema = z.object({
  eventId: z.number().int().positive(),
  spinId: uuidKey,
  claimGeneration: z.number().int().positive(),
  reason: boundedText(500),
  reopen: z.boolean(),
  idempotencyKey: uuidKey,
}).strict();
