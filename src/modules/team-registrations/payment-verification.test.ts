import assert from "node:assert/strict";
import test from "node:test";
import { compareTeamPaymentInquiry } from "./payment-verification.js";

const attempt = {
  referenceNo: "400000000001",
  merchantId: "12345678",
  amount: "700.00",
  currency: "THB" as const,
};

test("accepts a paid inquiry only when all snapshots match", () => {
  const result = compareTeamPaymentInquiry(attempt, {
    referenceNo: "400000000001",
    merchantId: "12345678",
    total: "700",
    currencyCode: "00",
    status: "CP",
    statusName: "Complete",
  });
  assert.deepEqual(result, {
    referenceMatches: true,
    merchantMatches: true,
    amountMatches: true,
    currencyMatches: true,
    isPaid: true,
    verified: true,
  });
});

test("rejects amount and merchant mismatches even with paid status", () => {
  const result = compareTeamPaymentInquiry(attempt, {
    referenceNo: "400000000001",
    merchantId: "99999999",
    total: "1.00",
    currencyCode: "00",
    status: "CP",
    statusName: "Complete",
  });
  assert.equal(result.isPaid, true);
  assert.equal(result.merchantMatches, false);
  assert.equal(result.amountMatches, false);
  assert.equal(result.verified, false);
});

test("does not accept pending or failed provider statuses", () => {
  assert.equal(compareTeamPaymentInquiry(attempt, { referenceNo: attempt.referenceNo, merchantId: attempt.merchantId, total: attempt.amount, currencyCode: "00", status: "HO", statusName: "Hold" }).verified, false);
  assert.equal(compareTeamPaymentInquiry(attempt, { referenceNo: attempt.referenceNo, merchantId: attempt.merchantId, total: attempt.amount, currencyCode: "00", status: "FL", statusName: "Failed" }).verified, false);
});
