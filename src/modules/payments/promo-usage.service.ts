import { and, count, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  promoCodeRuleItems,
  promoCodeRuleSets,
  promoCodes,
  promoCodeUsages,
} from "../../database/schema.js";
import { normalizePromoCode, promoAppliesToEvent } from "../../utils/promoCodeNormalization.js";
import { calculatePromoDiscount } from "../../utils/promoDiscount.js";
import type { PaymentTransaction } from "./types.js";

const PROMO_PENDING_TTL_MS = parseInt(process.env.PROMO_PENDING_TTL_MINUTES || "15", 10) * 60 * 1000;

export type PromoReservationErrorCode =
  | "PROMO_NOT_FOUND"
  | "PROMO_EVENT_MISMATCH"
  | "PROMO_INACTIVE"
  | "PROMO_NOT_STARTED"
  | "PROMO_EXPIRED"
  | "PROMO_MIN_PURCHASE"
  | "PROMO_TICKET_MISMATCH"
  | "PROMO_USAGE_LIMIT_REACHED"
  | "PROMO_USER_LIMIT_REACHED";

export class PromoReservationConflict extends Error {
  readonly statusCode = 409;

  constructor(
    public readonly code: PromoReservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromoReservationConflict";
  }
}

export interface PromoReservationInput {
  code: string;
  eventId: number;
  userId: number;
  currency: "THB" | "USD";
  subtotal: number;
  selectedTicketTypeIds: number[];
  orderId: number;
}

export interface PromoReservationResult {
  promoCodeId: number;
  discountType: "percentage" | "fixed";
  discountValue: number;
  discountAmount: number;
  netAmount: number;
}

async function assertRuleSetsMatch(
  tx: PaymentTransaction,
  promoCodeId: number,
  selectedTicketTypeIds: number[],
): Promise<void> {
  const ruleSets = await tx
    .select()
    .from(promoCodeRuleSets)
    .where(eq(promoCodeRuleSets.promoCodeId, promoCodeId));

  if (ruleSets.length === 0) return;

  const selectedSet = new Set(selectedTicketTypeIds);
  let matched = false;

  for (const ruleSet of ruleSets) {
    const ruleItems = await tx
      .select({ ticketTypeId: promoCodeRuleItems.ticketTypeId })
      .from(promoCodeRuleItems)
      .where(eq(promoCodeRuleItems.ruleSetId, ruleSet.id));
    const ruleTicketIds = ruleItems.map((item) => item.ticketTypeId);
    const ruleTicketSet = new Set(ruleTicketIds);

    if (ruleSet.matchType === "all") {
      matched = ruleTicketIds.every((id) => selectedSet.has(id));
    } else if (ruleSet.matchType === "any") {
      matched = ruleTicketIds.some((id) => selectedSet.has(id));
    } else if (ruleSet.matchType === "only") {
      matched = selectedTicketTypeIds.length === ruleTicketIds.length
        && selectedTicketTypeIds.every((id) => ruleTicketSet.has(id));
    }

    if (matched) break;
  }

  if (!matched) {
    throw new PromoReservationConflict(
      "PROMO_TICKET_MISMATCH",
      "Promo code does not apply to selected tickets",
    );
  }
}

export async function reservePromoUsageLocked(
  tx: PaymentTransaction,
  input: PromoReservationInput,
): Promise<PromoReservationResult> {
  const normalizedCode = normalizePromoCode(input.code);
  const [promo] = await tx
    .select()
    .from(promoCodes)
    .where(sql`upper(trim(${promoCodes.code})) = ${normalizedCode}`)
    .for("update")
    .limit(1);

  if (!promo) {
    throw new PromoReservationConflict("PROMO_NOT_FOUND", "Promo code not found");
  }

  const now = new Date();
  await tx
    .update(promoCodeUsages)
    .set({ status: "expired", cancelledAt: now })
    .where(and(
      eq(promoCodeUsages.promoCodeId, promo.id),
      eq(promoCodeUsages.status, "pending"),
      lt(promoCodeUsages.expiresAt, now),
    ));

  if (!promoAppliesToEvent(promo.eventId, input.eventId)) {
    throw new PromoReservationConflict("PROMO_EVENT_MISMATCH", "Promo code is not valid for this event");
  }
  if (!promo.isActive) {
    throw new PromoReservationConflict("PROMO_INACTIVE", "Promo code is inactive");
  }
  if (promo.validFrom && now < new Date(promo.validFrom)) {
    throw new PromoReservationConflict("PROMO_NOT_STARTED", "Promo code is not yet valid");
  }
  if (promo.validUntil && now > new Date(promo.validUntil)) {
    throw new PromoReservationConflict("PROMO_EXPIRED", "Promo code has expired");
  }

  const minPurchase = Number(promo.minPurchase || 0);
  if (input.subtotal < minPurchase) {
    throw new PromoReservationConflict(
      "PROMO_MIN_PURCHASE",
      `Minimum purchase of ${minPurchase} ${input.currency} required`,
    );
  }

  await assertRuleSetsMatch(tx, promo.id, input.selectedTicketTypeIds);

  const [{ total: globalUsage }] = await tx
    .select({ total: count() })
    .from(promoCodeUsages)
    .where(and(
      eq(promoCodeUsages.promoCodeId, promo.id),
      inArray(promoCodeUsages.status, ["pending", "used"]),
    ));
  if (globalUsage >= promo.maxUses) {
    throw new PromoReservationConflict("PROMO_USAGE_LIMIT_REACHED", "Promo code usage limit reached");
  }

  const [{ total: userUsage }] = await tx
    .select({ total: count() })
    .from(promoCodeUsages)
    .where(and(
      eq(promoCodeUsages.promoCodeId, promo.id),
      eq(promoCodeUsages.userId, input.userId),
      inArray(promoCodeUsages.status, ["pending", "used"]),
    ));
  if (userUsage >= promo.maxUsesPerUser) {
    throw new PromoReservationConflict("PROMO_USER_LIMIT_REACHED", "You have already used this promo code");
  }

  const discount = calculatePromoDiscount({
    discountType: promo.discountType as "percentage" | "fixed",
    discountValue: Number(promo.discountValue),
    fixedValueThb: promo.fixedValueThb == null ? null : Number(promo.fixedValueThb),
    fixedValueUsd: promo.fixedValueUsd == null ? null : Number(promo.fixedValueUsd),
    maxDiscount: promo.maxDiscount == null ? null : Number(promo.maxDiscount),
    currency: input.currency,
    subtotal: input.subtotal,
  });

  const expiresAt = new Date(now.getTime() + PROMO_PENDING_TTL_MS);
  await tx.insert(promoCodeUsages).values({
    promoCodeId: promo.id,
    userId: input.userId,
    orderId: input.orderId,
    status: "pending",
    discountAmount: String(discount.discountAmount),
    reservedAt: now,
    expiresAt,
  });

  return {
    promoCodeId: promo.id,
    discountType: promo.discountType as "percentage" | "fixed",
    ...discount,
  };
}

export async function settlePromoUsageInTransaction(
  tx: PaymentTransaction,
  orderId: number,
): Promise<boolean> {
  const now = new Date();
  const [settled] = await tx
    .update(promoCodeUsages)
    .set({ status: "used", usedAt: now })
    .where(and(
      eq(promoCodeUsages.orderId, orderId),
      eq(promoCodeUsages.status, "pending"),
    ))
    .returning({ promoCodeId: promoCodeUsages.promoCodeId });

  if (!settled) return false;

  await tx
    .update(promoCodes)
    .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
    .where(eq(promoCodes.id, settled.promoCodeId));

  return true;
}

export async function settlePromoUsageSuccess(orderId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await settlePromoUsageInTransaction(tx, orderId);
  });
}

export async function cancelPromoUsageInTransaction(
  tx: PaymentTransaction,
  orderId: number,
): Promise<void> {
  const now = new Date();
  await tx
    .update(promoCodeUsages)
    .set({ status: "cancelled", cancelledAt: now })
    .where(and(
      eq(promoCodeUsages.orderId, orderId),
      inArray(promoCodeUsages.status, ["pending", "expired"]),
    ));
}

export async function cancelPromoUsage(orderId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await cancelPromoUsageInTransaction(tx, orderId);
  });
}
