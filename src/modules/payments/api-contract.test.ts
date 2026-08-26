import assert from "node:assert/strict";
import test from "node:test";
import { freeCheckoutResponse, promoReservationConflictResponse } from "./api-contract.js";

test("free checkout response keeps the stable zero-total API contract", () => {
  const response = freeCheckoutResponse({
    orderId: 123,
    orderNumber: "CONF-FREE-1",
    regCode: "REG-FREE-1",
    subtotal: 5000,
    discountAmount: 5000,
    discountType: "percentage",
    discountValue: 100,
    currency: "THB",
  });

  assert.deepEqual(response, {
    success: true,
    data: {
      free: true,
      gateway: null,
      redirectForm: null,
      refno: null,
      orderRef: null,
      orderId: 123,
      orderNumber: "CONF-FREE-1",
      regCode: "REG-FREE-1",
      subtotal: 5000,
      discountAmount: 5000,
      discountType: "percentage",
      discountValue: 100,
      netAmount: 0,
      fee: 0,
      total: 0,
      currency: "THB",
      feeMethod: null,
      paymentChannel: "free",
    },
  });
});

test("promo reservation conflict keeps HTTP 409 and stable error body", () => {
  const mapped = promoReservationConflictResponse({
    statusCode: 409,
    code: "PROMO_USER_LIMIT_REACHED",
    message: "You have already used this promo code",
  });

  assert.equal(mapped.statusCode, 409);
  assert.deepEqual(mapped.body, {
    success: false,
    code: "PROMO_USER_LIMIT_REACHED",
    error: "You have already used this promo code",
  });
});
