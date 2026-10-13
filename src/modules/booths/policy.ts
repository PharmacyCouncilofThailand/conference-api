import type { BoothType } from "./types.js";
export const couponQuota = (type: BoothType): number =>
  ({ symposium: 8, premium: 4, standard: 2 })[type];
export function isCouponCheckout(x: {
  primary: boolean;
  discountType: string | null;
  discountValue: number | null;
  netAmount: number;
}): boolean {
  return (
    x.primary &&
    x.discountType === "percentage" &&
    x.discountValue === 100 &&
    x.netAmount === 0
  );
}
export class BoothError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BoothError";
  }
}
