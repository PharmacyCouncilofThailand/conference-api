import { z } from "zod";

export const promoCodeAbstractReportQuerySchema = z.object({
  eventId: z.coerce.number().int().positive(),
  promoCodeId: z.coerce.number().int().positive().optional(),
  submissionStatus: z.enum(["all", "submitted", "not_submitted"]).default("all"),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
