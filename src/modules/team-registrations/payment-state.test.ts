import assert from "node:assert/strict";
import test from "node:test";
import {
  canReplayTeamPaymentAttempt,
  canStartTeamPayment,
  classifyTeamProviderStatus,
  decideTeamPaymentTransition,
  decideTeamSettlementOutcome,
  decideUnpaidTeamRegistrationTransition,
  resolveEffectiveTeamSettlementTime,
  type CanStartTeamPaymentInput,
  type DecideTeamSettlementOutcomeInput,
} from "./payment-state.js";

test("classifies production provider statuses with normalization", () => {
  assert.equal(classifyTeamProviderStatus({ status: " cp ", statusName: "" }), "paid");
  assert.equal(classifyTeamProviderStatus({ status: "", statusName: " completed " }), "paid");
  assert.equal(classifyTeamProviderStatus({ status: " fl ", statusName: "" }), "failed");
  assert.equal(classifyTeamProviderStatus({ status: "", statusName: " payment failed " }), "failed");
  assert.equal(classifyTeamProviderStatus({ status: " ca ", statusName: "" }), "cancelled");
  assert.equal(classifyTeamProviderStatus({ status: "", statusName: " cancelled " }), "cancelled");
  assert.equal(classifyTeamProviderStatus({ status: " ho ", statusName: "" }), "pending");
  assert.equal(classifyTeamProviderStatus({ status: "", statusName: " vbv checking " }), "pending");
  assert.equal(classifyTeamProviderStatus({ status: " rr ", statusName: "" }), "refunded");
  assert.equal(classifyTeamProviderStatus({ status: "???", statusName: "other" }), "unknown");
});

test("test-paid statuses are fail-closed and never enabled in production", () => {
  assert.equal(classifyTeamProviderStatus(
    { status: "TC", statusName: "TEST COMPLETE" },
    { nodeEnv: "production", allowTestStatuses: true },
  ), "unknown");
  assert.equal(classifyTeamProviderStatus(
    { status: "TC", statusName: "TEST COMPLETE" },
    { nodeEnv: " Production ", allowTestStatuses: true },
  ), "unknown");
  assert.equal(classifyTeamProviderStatus(
    { status: "tc", statusName: "test completed" },
    { nodeEnv: "test", allowTestStatuses: false },
  ), "unknown");
  assert.equal(classifyTeamProviderStatus(
    { status: "tc", statusName: "test completed" },
    { nodeEnv: "test", allowTestStatuses: true },
  ), "paid");
});

test("void means cancellation before settlement and refund after settlement", () => {
  assert.equal(classifyTeamProviderStatus({ status: "VO" }), "cancelled");
  assert.equal(classifyTeamProviderStatus(
    { statusName: "VOIDED" },
    { hasVerifiedSettlement: true },
  ), "refunded");
});

test("state transitions do not revive or downgrade terminal attempts", () => {
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "pending",
    providerClassification: "failed",
    hasVerifiedSettlement: false,
    actionResolved: false,
  }), { kind: "transition", nextStatus: "failed" });
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "cancelled",
    providerClassification: "pending",
    hasVerifiedSettlement: false,
    actionResolved: false,
  }), { kind: "metadata_only", nextStatus: "cancelled" });
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "paid",
    providerClassification: "failed",
    hasVerifiedSettlement: true,
    actionResolved: false,
  }), { kind: "metadata_only", nextStatus: "paid" });
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "expired",
    providerClassification: "paid",
    hasVerifiedSettlement: false,
    actionResolved: false,
  }), { kind: "settlement", nextStatus: "expired" });
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "verification_required",
    providerClassification: "paid",
    hasVerifiedSettlement: true,
    actionResolved: false,
  }), { kind: "settlement", nextStatus: "verification_required" });
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "verification_required",
    providerClassification: "paid",
    hasVerifiedSettlement: true,
    actionResolved: true,
  }), { kind: "metadata_only", nextStatus: "verification_required" });
  assert.deepEqual(decideTeamPaymentTransition({
    currentStatus: "duplicate_paid",
    providerClassification: "refunded",
    hasVerifiedSettlement: true,
    actionResolved: false,
  }), { kind: "refund", nextStatus: "refunded" });
});

const attemptCreatedAt = new Date("2026-08-10T10:00:00.000Z");
const inquiryStartedAt = new Date("2026-08-10T10:29:59.000Z");
const inquiryCompletedAt = new Date("2026-08-10T10:30:01.000Z");

test("settlement time keeps absent, malformed, and bounded valid paidAt distinct", () => {
  assert.deepEqual(resolveEffectiveTeamSettlementTime({
    paidAtState: "absent",
    paidAt: null,
    attemptCreatedAt,
    inquiryStartedAt,
    inquiryCompletedAt,
  }), { eligible: true, effectiveSettledAt: inquiryStartedAt });

  assert.deepEqual(resolveEffectiveTeamSettlementTime({
    paidAtState: "invalid",
    paidAt: null,
    attemptCreatedAt,
    inquiryStartedAt,
    inquiryCompletedAt,
  }), { eligible: false, reviewReason: "provider_paid_at_invalid" });

  for (const paidAt of [
    new Date("2026-08-10T09:55:00.000Z"),
    new Date("2026-08-10T10:35:01.000Z"),
  ]) {
    assert.equal(resolveEffectiveTeamSettlementTime({
      paidAtState: "valid",
      paidAt,
      attemptCreatedAt,
      inquiryStartedAt,
      inquiryCompletedAt,
    }).eligible, true);
  }
  for (const paidAt of [
    new Date("2026-08-10T09:54:59.999Z"),
    new Date("2026-08-10T10:35:01.001Z"),
  ]) {
    assert.deepEqual(resolveEffectiveTeamSettlementTime({
      paidAtState: "valid",
      paidAt,
      attemptCreatedAt,
      inquiryStartedAt,
      inquiryCompletedAt,
    }), { eligible: false, reviewReason: "provider_paid_at_invalid" });
  }
});

function settlementInput(overrides: Partial<DecideTeamSettlementOutcomeInput> = {}): DecideTeamSettlementOutcomeInput {
  return {
    attemptId: "attempt-a",
    currentStatus: "pending",
    winnerAttemptId: null,
    actionResolved: false,
    hasDifferentUnresolvedAction: false,
    attemptRegistrationRevision: 2,
    currentRegistrationRevision: 2,
    registrationStatus: "payment_pending",
    claimsHeld: true,
    attemptExpiresAt: new Date("2026-08-10T10:30:00.000Z"),
    currentPaymentReservationExpiresAt: new Date("2026-08-10T10:30:00.000Z"),
    effectiveSettledAt: new Date("2026-08-10T10:30:00.000Z"),
    ...overrides,
  };
}

test("settlement decision elects one winner and sends other settlements to duplicate or review", () => {
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput()), { kind: "winner" });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ winnerAttemptId: "attempt-b" })), {
    kind: "duplicate",
    reviewReason: "duplicate_payment",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ winnerAttemptId: "attempt-a" })), {
    kind: "idempotent",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ actionResolved: true })), {
    kind: "idempotent",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ hasDifferentUnresolvedAction: true })), {
    kind: "review",
    reviewReason: "other_payment_action_unresolved",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ attemptRegistrationRevision: 1 })), {
    kind: "review",
    reviewReason: "registration_revision_changed",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ registrationStatus: "expired" })), {
    kind: "review",
    reviewReason: "registration_expired",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({ claimsHeld: false })), {
    kind: "review",
    reviewReason: "claims_released",
  });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({
    currentPaymentReservationExpiresAt: new Date("2026-08-10T10:31:00.000Z"),
  })), { kind: "review", reviewReason: "payment_reservation_changed" });
  assert.deepEqual(decideTeamSettlementOutcome(settlementInput({
    effectiveSettledAt: new Date("2026-08-10T10:30:00.001Z"),
  })), { kind: "review", reviewReason: "payment_reservation_expired" });
});

const now = new Date("2026-08-10T10:00:00.000Z");

function startInput(overrides: Partial<CanStartTeamPaymentInput> = {}): CanStartTeamPaymentInput {
  return {
    now,
    configEnabled: true,
    paymentEnvironmentReady: true,
    eventProfileMatches: true,
    eventMerchantMatches: true,
    registrationStatus: "ready_for_payment",
    teamDataComplete: true,
    hasWinner: false,
    hasUnresolvedAction: false,
    claimsHeld: true,
    paymentReservationExpiresAt: null,
    retainedSessionProfileMatches: true,
    retainedSessionMerchantMatches: true,
    draftExpiresAt: new Date("2026-08-10T11:00:00.000Z"),
    registrationClosesAt: new Date("2026-08-10T12:00:00.000Z"),
    hasActiveAttempt: false,
    safeRetryEnabled: false,
    ...overrides,
  };
}

test("shared payment-start predicate is fail-closed for every safety guard", () => {
  assert.equal(canStartTeamPayment(startInput()), true);
  const falseCases: Partial<CanStartTeamPaymentInput>[] = [
    { configEnabled: false },
    { paymentEnvironmentReady: false },
    { eventProfileMatches: false },
    { eventMerchantMatches: false },
    { registrationStatus: "expired" },
    { teamDataComplete: false },
    { hasWinner: true },
    { hasUnresolvedAction: true },
    { claimsHeld: false },
    { hasActiveAttempt: true, safeRetryEnabled: false },
    { draftExpiresAt: now },
    { registrationClosesAt: now },
  ];
  for (const overrides of falseCases) assert.equal(canStartTeamPayment(startInput(overrides)), false);
  assert.equal(canStartTeamPayment(startInput({ hasActiveAttempt: true, safeRetryEnabled: true })), true);
});

test("an unexpired retained session ignores draft/close but enforces identity and exact expiry", () => {
  assert.equal(canStartTeamPayment(startInput({
    paymentReservationExpiresAt: new Date("2026-08-10T10:00:00.001Z"),
    draftExpiresAt: new Date("2026-08-10T09:00:00.000Z"),
    registrationClosesAt: new Date("2026-08-10T09:00:00.000Z"),
  })), true);
  assert.equal(canStartTeamPayment(startInput({
    paymentReservationExpiresAt: now,
    draftExpiresAt: new Date("2026-08-10T09:00:00.000Z"),
    registrationClosesAt: new Date("2026-08-10T09:00:00.000Z"),
  })), false);
  assert.equal(canStartTeamPayment(startInput({
    paymentReservationExpiresAt: new Date("2026-08-10T10:01:00.000Z"),
    retainedSessionProfileMatches: false,
  })), false);
  assert.equal(canStartTeamPayment(startInput({
    paymentReservationExpiresAt: new Date("2026-08-10T10:01:00.000Z"),
    retainedSessionMerchantMatches: false,
  })), false);
});

test("active replay uses its narrower configuration and ownership policy", () => {
  const replay = {
    configEnabled: true,
    paymentEnvironmentReady: true,
    eventProfileMatches: true,
    eventMerchantMatches: true,
    ownedByRequester: true,
    active: true,
    unexpired: true,
    sessionMatches: true,
    retainedSessionProfileMatches: true,
    retainedSessionMerchantMatches: true,
  };
  assert.equal(canReplayTeamPaymentAttempt(replay), true);
  assert.equal(canReplayTeamPaymentAttempt({ ...replay, configEnabled: false }), false);
  assert.equal(canReplayTeamPaymentAttempt({ ...replay, sessionMatches: false }), false);
});

test("unpaid registration transition retains, clears, holds, or safely releases the session", () => {
  const closesAt = new Date("2026-08-10T12:00:00.000Z");
  const reservation = new Date("2026-08-10T11:00:00.000Z");
  assert.deepEqual(decideUnpaidTeamRegistrationTransition({
    now,
    paymentReservationExpiresAt: reservation,
    registrationClosesAt: closesAt,
    hasWinner: false,
    hasUnresolvedAction: false,
    paymentFinalized: true,
  }), {
    kind: "ready_for_payment",
    registrationStatus: "ready_for_payment",
    paymentReservationExpiresAt: reservation,
    releaseClaims: false,
  });
  assert.deepEqual(decideUnpaidTeamRegistrationTransition({
    now,
    paymentReservationExpiresAt: new Date("2026-08-10T09:00:00.000Z"),
    registrationClosesAt: closesAt,
    hasWinner: false,
    hasUnresolvedAction: false,
    paymentFinalized: true,
  }), {
    kind: "ready_for_payment",
    registrationStatus: "ready_for_payment",
    paymentReservationExpiresAt: null,
    releaseClaims: false,
  });
  assert.equal(decideUnpaidTeamRegistrationTransition({
    now,
    paymentReservationExpiresAt: reservation,
    registrationClosesAt: closesAt,
    hasWinner: false,
    hasUnresolvedAction: true,
    paymentFinalized: true,
  }).kind, "held");
  assert.deepEqual(decideUnpaidTeamRegistrationTransition({
    now,
    paymentReservationExpiresAt: now,
    registrationClosesAt: now,
    hasWinner: false,
    hasUnresolvedAction: false,
    paymentFinalized: true,
  }), {
    kind: "expired",
    registrationStatus: "expired",
    paymentReservationExpiresAt: null,
    releaseClaims: true,
  });
});
