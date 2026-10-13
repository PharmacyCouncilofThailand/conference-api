import { z } from "zod";
export const positiveId = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number),
  ])
  .pipe(z.number().int().positive().max(2147483647));
export const boothTypeSchema = z.enum(["symposium", "premium", "standard"]);
export const boothCreateSchema = z
  .object({ name: z.string().trim().min(1).max(255), type: boothTypeSchema })
  .strict();
export const boothPatchSchema = boothCreateSchema
  .partial()
  .refine((x) => Object.keys(x).length > 0, "No changes supplied");
export const boothListSchema = z
  .object({
    page: positiveId.default(1),
    limit: positiveId.pipe(z.number().max(100)).default(20),
    search: z.string().trim().max(255).optional(),
    type: boothTypeSchema.optional(),
  })
  .strict();
export const memberListSchema = boothListSchema.omit({ type: true });
export const boothParamsSchema = z.object({
  eventId: positiveId,
  boothId: positiveId.optional(),
});
export const eventCodeSchema = z.string().trim().min(1).max(50);
