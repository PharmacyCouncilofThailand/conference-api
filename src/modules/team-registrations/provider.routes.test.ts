import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldReleasePostbackLeaseAfterFailure,
  teamPaymentPostbackIdentity,
} from "./provider-postback.js";

test("derives a stable normalized Pay Solutions postback identity", () => {
  const first = teamPaymentPostbackIdentity({
    EventID: " event-1 ",
    ReferenceNo: "400000000001",
    OrderNo: " order-1 ",
    MerchantID: " merchant-1 ",
    Status: " cp ",
    StatusName: " complete ",
    Total: "700",
    CurrencyCode: " thb ",
  });
  const replay = teamPaymentPostbackIdentity({
    eventId: "event-1",
    referenceNo: "400000000001",
    orderNo: "order-1",
    merchantId: "MERCHANT-1",
    status: "CP",
    statusName: "COMPLETE",
    total: "700.00",
    currencyCode: "THB",
  });
  assert.equal(first.key, replay.key);
  assert.match(first.key, /^paysolutions:sha256:[a-f0-9]{64}$/);
  assert.equal(first.redacted.total, "700.00");
});

test("marks an invalid total deterministically and bounds stored fields", () => {
  const identity = teamPaymentPostbackIdentity({
    refno: "400000000002",
    status: "hold",
    total: "not-money",
    statusName: "x".repeat(500),
  });
  assert.equal(identity.redacted.total, "invalid");
  assert.equal(String(identity.redacted.statusName).length, 255);
});

test("missing optional identifiers remain part of the exact composite", () => {
  const first = teamPaymentPostbackIdentity({ refno: "400000000003", status: "CP", total: "1" });
  const second = teamPaymentPostbackIdentity({ refno: "400000000003", orderNo: "1", status: "CP", total: "1" });
  assert.notEqual(first.key, second.key);
});

test("postback lease advances only after success or a controlled provider failure", () => {
  assert.equal(shouldReleasePostbackLeaseAfterFailure(true, null), true);
  assert.equal(shouldReleasePostbackLeaseAfterFailure(false, "PAYMENT_PROVIDER_UNAVAILABLE"), true);
  assert.equal(shouldReleasePostbackLeaseAfterFailure(false, "PAYMENT_PROFILE_MISMATCH"), false);
  assert.equal(shouldReleasePostbackLeaseAfterFailure(false, "DATABASE_ERROR"), false);
  assert.equal(shouldReleasePostbackLeaseAfterFailure(false, null), false);
});
