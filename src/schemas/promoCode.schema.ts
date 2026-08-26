import { z } from "zod";

export const promoRuleSetSchema = z.object({
  matchType: z.enum(["all", "any", "only"]).default("all"),
  ticketTypeIds: z.array(z.number().int().positive()).min(1),
});

const promoBaseSchema = z.object({
  eventId: z.number().nullable().optional(),
  code: z.string().trim().min(1).max(50),
  description: z.string().optional(),
  discountType: z.enum(["percentage", "fixed"]),
  discountValue: z.number().min(0).default(0),
  fixedValueThb: z.number().min(0).nullable().optional(),
  fixedValueUsd: z.number().min(0).nullable().optional(),
  minPurchase: z.number().min(0).default(0),
  maxDiscount: z.number().min(0).nullable().optional(),
  maxUses: z.number().int().min(1).default(100),
  maxUsesPerUser: z.number().int().min(1).default(1),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  isActive: z.boolean().default(true),
  ruleSets: z.array(promoRuleSetSchema).optional(),
});

function percentageIsBounded(
  value: { discountType?: string; discountValue?: number },
  ctx: z.RefinementCtx,
) {
  if (value.discountType === "percentage" && (value.discountValue ?? 0) > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValue"],
      message: "Percentage discount must be between 0 and 100",
    });
  }
}

export const createPromoSchema = promoBaseSchema.superRefine(percentageIsBounded);
export const updatePromoSchema = promoBaseSchema.partial().superRefine(percentageIsBounded);
