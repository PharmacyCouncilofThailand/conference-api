import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const uuidKey = z.string().uuid();

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
}).strict();

export const wheelConfigurationSchema = z.object({
  segments: z.array(wheelSegmentConfigurationSchema).min(1).max(64),
  collectionInstructions: bilingualTextSchema,
  collectionDeadline: z.string().datetime({ offset: true }),
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

export const stockAdjustmentBodySchema = z.object({
  segmentId: uuidKey,
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0, {
    message: "delta must not be zero",
  }),
  reason: boundedText(500),
  idempotencyKey: uuidKey,
}).strict();

export const setWheelPausedBodySchema = z.object({
  paused: z.boolean(),
  reason: boundedText(500),
  idempotencyKey: uuidKey,
}).strict();

export const spinInputSchema = z.object({
  eventId: z.number().int().positive(),
  configurationVersion: z.number().int().positive(),
  poolRevision: z.number().int().positive(),
  idempotencyKey: uuidKey,
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
