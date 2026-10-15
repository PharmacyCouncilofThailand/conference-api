import { z } from "zod";
import type { Recipient } from "./types.js";

/** Strips spaces, dashes and parentheses, maps `+66` to `0`; a Thai number is then 9–10 digits starting with 0. */
export function normalizePhone(raw: string): string | null {
  let value = raw.replace(/[\s\-()]/g, "");
  if (value.startsWith("+66")) value = `0${value.slice(3)}`;
  return /^0\d{8,9}$/.test(value) ? value : null;
}

const required = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const recipientSchema: z.ZodType<Recipient, z.ZodTypeDef, unknown> = z
  .object({
    fullName: required(200),
    phone: z
      .string()
      .max(30)
      .transform((v, ctx) => {
        const phone = normalizePhone(v);
        if (!phone) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid phone" });
          return z.NEVER;
        }
        return phone;
      }),
    addressLine: required(500),
    subdistrict: required(100),
    district: required(100),
    province: required(100),
    postalCode: z.string().trim().regex(/^\d{5}$/),
    company: optionalText(200),
    deliveryNote: optionalText(500),
  })
  .strict();
