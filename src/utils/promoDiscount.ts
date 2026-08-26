export type PromoCurrency = "THB" | "USD";
export type PromoDiscountType = "percentage" | "fixed";

export interface PromoDiscountInput {
  discountType: PromoDiscountType;
  discountValue: number;
  fixedValueThb: number | null;
  fixedValueUsd: number | null;
  maxDiscount: number | null;
  currency: PromoCurrency;
  subtotal: number;
}

export interface PromoDiscountResult {
  discountValue: number;
  discountAmount: number;
  netAmount: number;
}

const money = (value: number) => Math.round(value * 100) / 100;

export function calculatePromoDiscount(input: PromoDiscountInput): PromoDiscountResult {
  const subtotal = Math.max(0, money(input.subtotal));
  let discountValue: number;
  let discountAmount: number;

  if (input.discountType === "percentage") {
    discountValue = input.discountValue;
    discountAmount = money(subtotal * discountValue / 100);
    if (input.maxDiscount !== null && discountAmount > input.maxDiscount) {
      discountAmount = input.maxDiscount;
    }
  } else {
    discountValue = input.currency === "THB"
      ? Number(input.fixedValueThb ?? input.discountValue ?? 0)
      : Number(input.fixedValueUsd ?? input.discountValue ?? 0);
    discountAmount = discountValue;
  }

  discountAmount = money(Math.min(Math.max(discountAmount, 0), subtotal));

  return {
    discountValue,
    discountAmount,
    netAmount: money(subtotal - discountAmount),
  };
}
