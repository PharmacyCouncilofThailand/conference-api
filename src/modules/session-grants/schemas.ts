import { z } from "zod";

export const createGrantSchema = z
  .object({
    sessionId: z.number().int().positive(),
    registrationIds: z.array(z.number().int().positive()).min(1).max(500),
  })
  .strict();

export const idempotencyKeySchema = z.string().uuid();

export const invitationDecisionSchema = z
  .object({
    decision: z.enum(["accepted", "declined"]),
  })
  .strict();

export const retryEmailsSchema = z
  .object({
    itemIds: z.array(z.string().uuid()).min(1).max(500),
    acknowledgeUnknown: z.boolean().default(false),
  })
  .strict();

export const resultQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
