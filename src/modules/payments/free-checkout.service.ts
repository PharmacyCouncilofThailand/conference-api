import { eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import { orderItems, orders, payments } from "../../database/schema.js";
import { normalizePromoCode } from "../../utils/promoCodeNormalization.js";
import { reservePromoUsageLocked, settlePromoUsageInTransaction } from "./promo-usage.service.js";
import { processSuccessfulPaymentInTransaction } from "./registration-settlement.service.js";
import type { PaymentLogger } from "./types.js";

export interface FreeCheckoutOrderItemInput {
  itemType: "ticket" | "addon";
  ticketTypeId: number;
  price: string;
  quantity: number;
}

export interface FreeCheckoutTaxInvoiceInput {
  needTaxInvoice: boolean;
  taxName: string | null;
  taxId: string | null;
  taxAddress: string | null;
  taxSubDistrict: string | null;
  taxDistrict: string | null;
  taxProvince: string | null;
  taxPostalCode: string | null;
  taxFullAddress: string | null;
}

export interface FreeCheckoutInput {
  logger: PaymentLogger;
  orderNumber: string;
  userId: number;
  eventId: number;
  currency: "THB" | "USD";
  subtotal: number;
  preliminaryDiscountAmount: number;
  preliminaryDiscountType: "percentage" | "fixed" | null;
  preliminaryDiscountValue: number | null;
  promoCode: string | null;
  selectedTicketTypeIds: number[];
  items: FreeCheckoutOrderItemInput[];
  workshopSessionId: number | null;
  optionalSessionIds: number[];
  taxInvoice: FreeCheckoutTaxInvoiceInput;
}

export interface FreeCheckoutResult {
  orderId: number;
  orderNumber: string;
  regCode: string;
  user: { email: string; firstName: string; lastName: string };
  discountAmount: number;
  discountType: "percentage" | "fixed" | null;
  discountValue: number | null;
  netAmount: 0;
  paymentProvider: "internal";
  paymentChannel: "free";
}

export class FreeCheckoutError extends Error {
  constructor(
    public readonly code: "FREE_TOTAL_CHANGED" | "REGISTRATION_NOT_CREATED",
    public readonly statusCode: 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "FreeCheckoutError";
  }
}

export async function completeFreeCheckout(input: FreeCheckoutInput): Promise<FreeCheckoutResult> {
  return db.transaction(async (tx) => {
    const canonicalPromoCode = input.promoCode ? normalizePromoCode(input.promoCode) : null;

    const [order] = await tx.insert(orders).values({
      userId: input.userId,
      eventId: input.eventId,
      orderNumber: input.orderNumber,
      subtotalAmount: String(input.subtotal),
      discountAmount: String(input.preliminaryDiscountAmount),
      promoCode: canonicalPromoCode,
      promoDiscountType: input.preliminaryDiscountType,
      promoDiscountValue: input.preliminaryDiscountValue === null
        ? null
        : String(input.preliminaryDiscountValue),
      totalAmount: "0",
      currency: input.currency,
      status: "pending",
      needTaxInvoice: input.taxInvoice.needTaxInvoice,
      taxName: input.taxInvoice.taxName,
      taxId: input.taxInvoice.taxId,
      taxAddress: input.taxInvoice.taxAddress,
      taxSubDistrict: input.taxInvoice.taxSubDistrict,
      taxDistrict: input.taxInvoice.taxDistrict,
      taxProvince: input.taxInvoice.taxProvince,
      taxPostalCode: input.taxInvoice.taxPostalCode,
      taxFullAddress: input.taxInvoice.taxFullAddress,
      taxCreatedAt: input.taxInvoice.needTaxInvoice ? new Date() : null,
    }).returning();

    if (input.items.length > 0) {
      await tx.insert(orderItems).values(input.items.map((item) => ({
        orderId: order.id,
        itemType: item.itemType,
        ticketTypeId: item.ticketTypeId,
        price: item.price,
        quantity: item.quantity,
      })));
    }

    const promo = input.promoCode
      ? await reservePromoUsageLocked(tx, {
        code: input.promoCode,
        eventId: input.eventId,
        userId: input.userId,
        currency: input.currency,
        subtotal: input.subtotal,
        selectedTicketTypeIds: input.selectedTicketTypeIds,
        orderId: order.id,
      })
      : null;

    const authoritativeNet = promo?.netAmount ?? input.subtotal;
    if (authoritativeNet !== 0) {
      throw new FreeCheckoutError(
        "FREE_TOTAL_CHANGED",
        409,
        "Checkout total changed; refresh pricing and try again",
      );
    }

    await tx.update(orders).set({
      discountAmount: String(promo?.discountAmount ?? 0),
      promoCodeId: promo?.promoCodeId ?? null,
      promoCode: canonicalPromoCode,
      promoDiscountType: promo?.discountType ?? null,
      promoDiscountValue: promo?.discountValue == null ? null : String(promo.discountValue),
      totalAmount: "0",
    }).where(eq(orders.id, order.id));

    await tx.insert(payments).values({
      orderId: order.id,
      amount: "0",
      status: "paid",
      paymentChannel: "free",
      paymentProvider: "internal",
      providerRef: `FREE-${order.orderNumber}`,
      providerStatus: "COMPLETED",
      paySolutionsRefno: null,
      paySolutionsChannel: null,
      paidAt: new Date(),
      paymentDetails: {
        requestedMethod: "free",
        workshopSessionId: input.workshopSessionId,
        optionalSessionIds: input.optionalSessionIds,
        processingFee: 0,
        processingVat: 0,
        freeReason: promo ? "promo_full_discount" : "free_ticket",
      },
    });

    const settlement = await processSuccessfulPaymentInTransaction(tx, input.logger, {
      orderId: order.id,
      providerRef: `FREE-${order.orderNumber}`,
      workshopSessionId: input.workshopSessionId,
      receiptUrl: null,
      paymentChannel: "free",
      paymentProvider: "internal",
      providerStatus: "COMPLETED",
      paymentDetails: {
        freeRegistration: true,
        workshopSessionId: input.workshopSessionId,
        optionalSessionIds: input.optionalSessionIds,
      },
    });

    if (!settlement.regCode) {
      throw new FreeCheckoutError(
        "REGISTRATION_NOT_CREATED",
        500,
        "Registration could not be created",
      );
    }

    if (promo) {
      await settlePromoUsageInTransaction(tx, order.id);
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      regCode: settlement.regCode,
      user: settlement.user,
      discountAmount: promo?.discountAmount ?? 0,
      discountType: promo?.discountType ?? null,
      discountValue: promo?.discountValue ?? null,
      netAmount: 0,
      paymentProvider: "internal",
      paymentChannel: "free",
    };
  });
}
