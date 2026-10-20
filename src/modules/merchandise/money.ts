import { MerchError } from "./errors.js";

export const SHIPPING_FEE_BAHT = 50;

/** Largest order total accepted (2,000,000 THB); keeps every money column far inside int4. */
export const MAX_ORDER_TOTAL_BAHT = 2_000_000;

/** 422 MERCH_ORDER_TOO_LARGE when an order total exceeds the limit (instead of an int4 overflow 500). */
export function assertOrderTotalAllowed(totalBaht: number): void {
  if (!Number.isSafeInteger(totalBaht) || totalBaht > MAX_ORDER_TOTAL_BAHT) {
    throw new MerchError(422, "MERCH_ORDER_TOO_LARGE", "ยอดคำสั่งซื้อเกินวงเงินที่รองรับ (สูงสุด 2,000,000 บาท)", {
      maxTotalBaht: MAX_ORDER_TOTAL_BAHT,
      totalBaht,
    });
  }
}

/** Provider wire format: whole baht rendered with two decimals (e.g. 56 -> "56.00"). */
export function formatProviderTotal(baht: number): string {
  return baht.toFixed(2);
}

/** Strict parse of a provider money value into whole baht; fractions (satang), malformed or negative values return null. */
export function parseProviderTotal(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
    if (!match) return null;
    if (match[2] !== undefined && !/^0+$/.test(match[2])) return null;
    const n = Number(match[1]);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}