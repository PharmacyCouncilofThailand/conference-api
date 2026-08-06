import { randomInt } from "node:crypto";
import { TeamRegistrationError } from "./errors.js";

export const MAX_PAYMENT_REFERENCE_ATTEMPTS = 5;

export function createReferenceNo(): string {
  return `4${randomInt(0, 100_000_000_000).toString().padStart(11, "0")}`;
}

/**
 * Inserts a payment record using a newly generated reference number and
 * retries when the caller reports a reference-number conflict.
 */
export async function insertWithUniquePaymentReference<T>(
  insert: (referenceNo: string) => Promise<T | null | undefined>,
  options: {
    maxAttempts?: number;
    referenceFactory?: () => string;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_PAYMENT_REFERENCE_ATTEMPTS;
  const referenceFactory = options.referenceFactory ?? createReferenceNo;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const inserted = await insert(referenceFactory());
    if (inserted !== null && inserted !== undefined) return inserted;
  }

  throw new TeamRegistrationError(
    503,
    "PAYMENT_REFERENCE_GENERATION_FAILED",
    "ไม่สามารถสร้างเลขอ้างอิงการชำระเงินที่ไม่ซ้ำได้ กรุณาลองใหม่อีกครั้ง",
  );
}
