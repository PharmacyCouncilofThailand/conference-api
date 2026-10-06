// schemas.ts; explicit offsets prevent host-local deadline interpretation.
import { z } from 'zod';
export const idSchema = z.coerce.number().int().positive().max(2147483647);
export const operationKeySchema = z.string().uuid();
export const closeSchema = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
export const reasonSchema = z.string().trim().min(1).max(10000);
export const revisionInputSchema = z.object({ details: reasonSchema, closesAt: closeSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const cancelInputSchema = z.object({ reason: reasonSchema }).strict();
export const resendInputSchema = z.object({ previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const settingsInputSchema = z.object({ closesAt: closeSchema, reason: reasonSchema, version: z.number().int().positive() }).strict();
export const verificationInputSchema = z.object({ sourceKey: z.string().regex(/^[12]:\d+$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason: reasonSchema }).strict();
export const batchInputSchema = z.object({ kind: z.enum(['initial', 'reminder']),
  abstractIds: z.array(idSchema).min(1).max(500), previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const listQuerySchema = z.object({ page: idSchema.default(1), pageSize: idSchema.max(100).default(25),
  round: z.enum(['1', '2']).optional(), search: z.string().max(500).optional(),
  presentationType: z.enum(['poster', 'highlighted-poster']).optional(),
  matchState: z.enum(['ready','alias_pending','conflict','missing','incomplete','withdrawn']).optional(),
  status: z.enum(['not_submitted','submitted','revision_pending','revised','revision_expired']).optional() }).strict();

export const mailPreviewInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['initial', 'reminder']), abstractIds: z.array(idSchema).min(1).max(500) }).strict(),
  z.object({ kind: z.literal('revision'), abstractId: idSchema, requestId: z.string().uuid().optional(),
    details: reasonSchema, closesAt: closeSchema }).strict(),
  z.object({ kind: z.literal('receipt'), abstractId: idSchema, uploadId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('resend'), jobId: z.string().uuid() }).strict(),
]);
export const createRevisionInputSchema = revisionInputSchema.extend({ requestId: z.string().uuid() });
