import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTeamPaymentInquiry,
  getTeamPaymentClassifierOptions,
} from "./payment-verification.js";

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

test("runtime test-status switch is normalized, fail-closed, and forced off in production", () => {
  assert.deepEqual(getTeamPaymentClassifierOptions({}), {
    nodeEnv: undefined,
    allowTestStatuses: false,
  });
  assert.equal(getTeamPaymentClassifierOptions({
    NODE_ENV: "test",
    TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES: "yes",
  }).allowTestStatuses, false);
  assert.equal(getTeamPaymentClassifierOptions({
    NODE_ENV: "test",
    TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES: " TrUe ",
  }).allowTestStatuses, true);
  assert.deepEqual(getTeamPaymentClassifierOptions({
    NODE_ENV: " Production ",
    TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES: "true",
  }), {
    nodeEnv: "production",
    allowTestStatuses: false,
  });
});

test("test-paid inquiries require the explicit non-production runtime switch", () => {
  const inquiry = {
    referenceNo: attempt.referenceNo,
    merchantId: attempt.merchantId,
    total: attempt.amount,
    currencyCode: "00",
    status: "TC",
    statusName: "TEST COMPLETE",
  };
  assert.equal(compareTeamPaymentInquiry(attempt, inquiry, {
    nodeEnv: "test",
    allowTestStatuses: false,
  }).verified, false);
  assert.equal(compareTeamPaymentInquiry(attempt, inquiry, {
    nodeEnv: "test",
    allowTestStatuses: true,
  }).verified, true);
  assert.equal(compareTeamPaymentInquiry(attempt, inquiry, {
    nodeEnv: "production",
    allowTestStatuses: true,
  }).verified, false);
});
