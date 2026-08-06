import assert from "node:assert/strict";
import test from "node:test";
import { isPaymentDueForReconciliation } from "./jobs-policy.js";

test("reconciles pending payments that have never been inquired", () => {
  assert.equal(isPaymentDueForReconciliation({ status: "pending", expiresAt: new Date("2026-08-20T00:30:00Z"), lastInquiredAt: null }, new Date("2026-08-20T00:00:00Z")), true);
});

test("does not reconcile expired, paid, or recently inquired payments", () => {
  const now = new Date("2026-08-20T00:00:00Z");
  assert.equal(isPaymentDueForReconciliation({ status: "pending", expiresAt: new Date("2026-08-19T23:59:59Z"), lastInquiredAt: null }, now), false);
  assert.equal(isPaymentDueForReconciliation({ status: "paid", expiresAt: new Date("2026-08-20T00:30:00Z"), lastInquiredAt: null }, now), false);
  assert.equal(isPaymentDueForReconciliation({ status: "pending", expiresAt: new Date("2026-08-20T00:30:00Z"), lastInquiredAt: new Date("2026-08-19T23:58:00Z") }, now), false);
});
