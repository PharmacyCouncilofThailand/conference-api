import assert from "node:assert/strict";
import test from "node:test";
import { teamPaymentSafeRetryEnabled } from "./payment-flags.js";

test("safe payment retry is fail-closed and only normalized true enables it", () => {
  assert.equal(teamPaymentSafeRetryEnabled({}), false);
  assert.equal(teamPaymentSafeRetryEnabled({ TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED: "1" }), false);
  assert.equal(teamPaymentSafeRetryEnabled({ TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED: "false" }), false);
  assert.equal(teamPaymentSafeRetryEnabled({ TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED: " TrUe " }), true);
});
