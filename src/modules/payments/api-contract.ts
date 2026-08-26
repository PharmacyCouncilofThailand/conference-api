export interface FreeCheckoutResponseInput {
  orderId: number;
  orderNumber: string;
  regCode: string;
  subtotal: number;
  discountAmount: number;
  discountType: "percentage" | "fixed" | null;
  discountValue: number | null;
  currency: "THB" | "USD";
}

export function freeCheckoutResponse(input: FreeCheckoutResponseInput) {
  return {
    success: true as const,
    data: {
      free: true as const,
      gateway: null,
      redirectForm: null,
      refno: null,
      orderRef: null,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      regCode: input.regCode,
      subtotal: input.subtotal,
      discountAmount: input.discountAmount,
      discountType: input.discountType,
      discountValue: input.discountValue,
      netAmount: 0,
      fee: 0,
      total: 0,
      currency: input.currency,
      feeMethod: null,
      paymentChannel: "free" as const,
    },
  };
}

export interface PromoConflictLike {
  readonly statusCode: 409;
  readonly code: string;
  readonly message: string;
}

export function promoReservationConflictResponse(error: PromoConflictLike) {
  return {
    statusCode: error.statusCode,
    body: {
      success: false as const,
      code: error.code,
      error: error.message,
    },
  };
}
