import assert from "node:assert/strict";
import test from "node:test";
import { couponQuota, isCouponCheckout } from "./policy.js";
test("coupon quotas and qualifying checkout are server policies", () => {
  assert.deepEqual(
    [couponQuota("symposium"), couponQuota("premium"), couponQuota("standard")],
    [8, 4, 2],
  );
  const valid = {
    primary: true,
    discountType: "percentage",
    discountValue: 100,
    netAmount: 0,
  };
  assert.equal(isCouponCheckout(valid), true);
  for (const change of [
    { primary: false },
    { discountType: null },
    { discountType: "fixed" },
    { discountValue: 99 },
    { netAmount: 1 },
  ]) {
    assert.equal(isCouponCheckout({ ...valid, ...change }), false);
  }
});
