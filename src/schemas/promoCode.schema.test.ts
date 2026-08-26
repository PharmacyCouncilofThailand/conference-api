import assert from "node:assert/strict";
import test from "node:test";
import { createPromoSchema, updatePromoSchema } from "./promoCode.schema.js";

test("create schema rejects percentage discount above 100", () => {
  const parsed = createPromoSchema.safeParse({
    code: "TOO-MUCH",
    discountType: "percentage",
    discountValue: 101,
    maxUses: 1,
    maxUsesPerUser: 1,
    isActive: true,
  });
  assert.equal(parsed.success, false);
});

test("create schema allows percentage discount equal to 100", () => {
  const parsed = createPromoSchema.safeParse({
    code: "FREE100",
    discountType: "percentage",
    discountValue: 100,
    maxUses: 1,
    maxUsesPerUser: 1,
    isActive: true,
  });
  assert.equal(parsed.success, true);
});

test("update schema rejects changing percentage discount above 100", () => {
  const parsed = updatePromoSchema.safeParse({
    discountType: "percentage",
    discountValue: 150,
  });
  assert.equal(parsed.success, false);
});
