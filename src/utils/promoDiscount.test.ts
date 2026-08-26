import assert from "node:assert/strict";
import test from "node:test";
import { calculatePromoDiscount } from "./promoDiscount.js";

test("100 percent promo reduces subtotal exactly to zero", () => {
  assert.deepEqual(calculatePromoDiscount({
    discountType: "percentage",
    discountValue: 100,
    fixedValueThb: null,
    fixedValueUsd: null,
    maxDiscount: null,
    currency: "THB",
    subtotal: 5000,
  }), {
    discountValue: 100,
    discountAmount: 5000,
    netAmount: 0,
  });
});

test("percentage discount respects maxDiscount", () => {
  assert.deepEqual(calculatePromoDiscount({
    discountType: "percentage",
    discountValue: 100,
    fixedValueThb: null,
    fixedValueUsd: null,
    maxDiscount: 3000,
    currency: "THB",
    subtotal: 5000,
  }), {
    discountValue: 100,
    discountAmount: 3000,
    netAmount: 2000,
  });
});

test("fixed discount is capped at subtotal", () => {
  assert.deepEqual(calculatePromoDiscount({
    discountType: "fixed",
    discountValue: 0,
    fixedValueThb: 9000,
    fixedValueUsd: null,
    maxDiscount: null,
    currency: "THB",
    subtotal: 5000,
  }), {
    discountValue: 9000,
    discountAmount: 5000,
    netAmount: 0,
  });
});
