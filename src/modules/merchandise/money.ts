import { MerchError } from "./errors.js";

export const SHIPPING_FEE_MINOR = 5000;

/** Largest order total accepted (2,000,000 THB); keeps every money column far inside int4. */
export const MAX_ORDER_TOTAL_MINOR = 200_000_000;

/** 422 MERCH_ORDER_TOO_LARGE when an order total exceeds the limit (instead of an int4 overflow 500). */
export function assertOrderTotalAllowed(totalMinor: number): void {
  if (!Number.isSafeInteger(totalMinor) || totalMinor > MAX_ORDER_TOTAL_MINOR) {
    throw new MerchError(422, "MERCH_ORDER_TOO_LARGE", "ยอดคำสั่งซื้อเกินวงเงินที่รองรับ (สูงสุด 2,000,000 บาท)", {
      maxTotalMinor: MAX_ORDER_TOTAL_MINOR,
      totalMinor,
    });
  }
}

export function formatProviderTotal(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Strict parse of a provider money value into satang; anything malformed returns null. */
export function parseProviderTotal(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    return Math.round(Number(trimmed) * 100);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const scaled = value * 100;
    if (Math.abs(scaled - Math.round(scaled)) >= 1e-6) return null;
    return Math.round(scaled);
  }
  return null;
}
