import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePhone, recipientSchema } from "./recipient.js";

const valid = {
  fullName: "สมชาย ใจดี",
  phone: "081-234-5678",
  addressLine: "99/1 ถนนสุขุมวิท",
  subdistrict: "คลองเตย",
  district: "คลองเตย",
  province: "กรุงเทพมหานคร",
  postalCode: "10110",
  company: null,
  deliveryNote: null,
};

test("normalizePhone strips separators and maps +66 to 0", () => {
  assert.equal(normalizePhone("081-234-5678"), "0812345678");
  assert.equal(normalizePhone("+66 81 234 5678"), "0812345678");
  assert.equal(normalizePhone("02 123 4567"), "021234567");
  assert.equal(normalizePhone("(02) 123-4567"), "021234567");
});

test("normalizePhone rejects non-digits and wrong lengths", () => {
  assert.equal(normalizePhone("08x2345678"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("1812345678"), null);
  assert.equal(normalizePhone("081234567890"), null);
});

test("recipientSchema accepts a valid recipient with company null and normalizes phone", () => {
  const parsed = recipientSchema.parse(valid);
  assert.equal(parsed.phone, "0812345678");
  assert.equal(parsed.company, null);
  assert.equal(parsed.deliveryNote, null);
});

test("recipientSchema rejects a 4-digit postal code, blank province and bad phone", () => {
  assert.equal(recipientSchema.safeParse({ ...valid, postalCode: "1011" }).success, false);
  assert.equal(recipientSchema.safeParse({ ...valid, province: "   " }).success, false);
  assert.equal(recipientSchema.safeParse({ ...valid, phone: "12345" }).success, false);
});
