export type TeamProviderPaymentClassification =
  | "paid"
  | "failed"
  | "cancelled"
  | "pending"
  | "refunded"
  | "unknown";

export type TeamPaymentLocalStatus =
  | "creating"
  | "pending"
  | "paid"
  | "failed"
  | "expired"
  | "verification_required"
  | "cancelled"
  | "duplicate_paid"
  | "refunded";

export interface TeamProviderStatusInput {
  status?: string | null;
  statusName?: string | null;
}

export interface TeamProviderStatusOptions {
  nodeEnv?: string;
  allowTestStatuses?: boolean;
  hasVerifiedSettlement?: boolean;
}

function normalizeProviderValue(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function includesEither(status: string, statusName: string, statuses: readonly string[], names: readonly string[]): boolean {
  return statuses.includes(status) || names.includes(statusName);
}

export function classifyTeamProviderStatus(
  input: TeamProviderStatusInput,
  options: TeamProviderStatusOptions = {},
): TeamProviderPaymentClassification {
  const status = normalizeProviderValue(input.status);
  const statusName = normalizeProviderValue(input.statusName);
  const hasVerifiedSettlement = options.hasVerifiedSettlement === true;

  if (includesEither(status, statusName, ["RF", "RR"], ["REFUND", "REFUNDED", "REQUEST REFUND"])) {
    return "refunded";
  }
  if (status === "VO" || statusName === "VOIDED") {
    return hasVerifiedSettlement ? "refunded" : "cancelled";
  }

  const isProduction = options.nodeEnv?.trim().toLowerCase() === "production";
  const testStatusesAllowed = !isProduction && options.allowTestStatuses === true;
  const hasTestMarker = status === "TC" || ["TEST COMPLETE", "TEST COMPLETED"].includes(statusName);
  if (hasTestMarker) {
    return testStatusesAllowed ? "paid" : "unknown";
  }
  if (includesEither(
    status,
    statusName,
    ["CP", "Y", "COMPLETE", "COMPLETED", "PAID"],
    ["COMPLETE", "COMPLETED", "PAID"],
  )) {
    return "paid";
  }

  if (includesEither(status, statusName, ["CA", "CANCEL", "CANCELLED"], ["CANCEL", "CANCELLED"])) {
    return "cancelled";
  }
  if (includesEither(
    status,
    statusName,
    ["FL", "FAILED", "FAIL", "RE", "VR", "PF", "C", "N", "NS"],
    ["FAILED", "FAIL", "REJECTED", "VBV REJECTED", "PAYMENT FAILED", "NOT SUBMIT", "UNPAID"],
  )) {
    return "failed";
  }
  if (includesEither(status, statusName, ["VC", "HO"], ["VBV CHECKING", "HOLD"])) {
    return "pending";
  }
  return "unknown";
}

export type TeamPaymentTransitionDecision =
  | { kind: "metadata_only"; nextStatus: TeamPaymentLocalStatus }
  | { kind: "transition"; nextStatus: "failed" | "cancelled" }
  | { kind: "settlement"; nextStatus: TeamPaymentLocalStatus }
  | { kind: "refund"; nextStatus: "refunded" };

export interface DecideTeamPaymentTransitionInput {
  currentStatus: TeamPaymentLocalStatus;
  providerClassification: TeamProviderPaymentClassification;
  hasVerifiedSettlement: boolean;
  actionResolved: boolean;
}

const ACTIVE_PAYMENT_STATUSES: readonly TeamPaymentLocalStatus[] = ["creating", "pending"];
const SETTLED_PAYMENT_STATUSES: readonly TeamPaymentLocalStatus[] = ["paid", "duplicate_paid", "refunded"];

/**
 * Chooses only the local status path. Provider metadata may be recorded for every
 * result after snapshot validation, including when this returns metadata_only.
 */
export function decideTeamPaymentTransition(input: DecideTeamPaymentTransitionInput): TeamPaymentTransitionDecision {
  const { currentStatus, providerClassification } = input;

  if (providerClassification === "refunded") {
    if (currentStatus === "refunded") return { kind: "metadata_only", nextStatus: currentStatus };
    if (input.hasVerifiedSettlement || ["paid", "duplicate_paid"].includes(currentStatus)) {
      return { kind: "refund", nextStatus: "refunded" };
    }
    return { kind: "metadata_only", nextStatus: currentStatus };
  }

  if (providerClassification === "paid") {
    if (input.actionResolved || SETTLED_PAYMENT_STATUSES.includes(currentStatus)) {
      return { kind: "metadata_only", nextStatus: currentStatus };
    }
    return { kind: "settlement", nextStatus: currentStatus };
  }

  if (ACTIVE_PAYMENT_STATUSES.includes(currentStatus)) {
    if (providerClassification === "failed") return { kind: "transition", nextStatus: "failed" };
    if (providerClassification === "cancelled") return { kind: "transition", nextStatus: "cancelled" };
  }

  return { kind: "metadata_only", nextStatus: currentStatus };
}

export type TeamProviderPaidAtState = "absent" | "valid" | "invalid";

export type EffectiveTeamSettlementTimeResult =
  | { eligible: true; effectiveSettledAt: Date }
  | { eligible: false; reviewReason: "provider_paid_at_invalid" };

export interface EffectiveTeamSettlementTimeInput {
  paidAtState: TeamProviderPaidAtState;
  paidAt: Date | null;
  attemptCreatedAt: Date;
  inquiryStartedAt: Date;
  inquiryCompletedAt: Date;
}

const PROVIDER_PAID_AT_SKEW_MS = 5 * 60 * 1000;

function isFiniteDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

export function resolveEffectiveTeamSettlementTime(
  input: EffectiveTeamSettlementTimeInput,
): EffectiveTeamSettlementTimeResult {
  if (!isFiniteDate(input.attemptCreatedAt)
    || !isFiniteDate(input.inquiryStartedAt)
    || !isFiniteDate(input.inquiryCompletedAt)) {
    return { eligible: false, reviewReason: "provider_paid_at_invalid" };
  }

  if (input.paidAtState === "absent") {
    return { eligible: true, effectiveSettledAt: new Date(input.inquiryStartedAt) };
  }
  if (input.paidAtState !== "valid" || !input.paidAt || !isFiniteDate(input.paidAt)) {
    return { eligible: false, reviewReason: "provider_paid_at_invalid" };
  }

  const paidAtMs = input.paidAt.getTime();
  const earliestMs = input.attemptCreatedAt.getTime() - PROVIDER_PAID_AT_SKEW_MS;
  const latestMs = input.inquiryCompletedAt.getTime() + PROVIDER_PAID_AT_SKEW_MS;
  if (paidAtMs < earliestMs || paidAtMs > latestMs) {
    return { eligible: false, reviewReason: "provider_paid_at_invalid" };
  }
  return { eligible: true, effectiveSettledAt: new Date(input.paidAt) };
}

export type TeamPaymentReviewReason =
  | "duplicate_payment"
  | "other_payment_action_unresolved"
  | "registration_revision_changed"
  | "registration_not_payable"
  | "registration_expired"
  | "claims_released"
  | "payment_reservation_changed"
  | "payment_reservation_expired"
  | "provider_paid_at_invalid"
  | "reference_mismatch"
  | "merchant_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "winner_refunded"
  | "legacy_verification_required";

export type TeamSettlementOutcome =
  | { kind: "winner" }
  | { kind: "duplicate"; reviewReason: "duplicate_payment" }
  | { kind: "review"; reviewReason: TeamPaymentReviewReason }
  | { kind: "idempotent" };

export interface DecideTeamSettlementOutcomeInput {
  attemptId: string;
  currentStatus: TeamPaymentLocalStatus;
  winnerAttemptId: string | null;
  actionResolved: boolean;
  hasDifferentUnresolvedAction: boolean;
  attemptRegistrationRevision: number;
  currentRegistrationRevision: number;
  registrationStatus: string;
  claimsHeld: boolean;
  attemptExpiresAt: Date;
  currentPaymentReservationExpiresAt: Date | null;
  effectiveSettledAt: Date;
}

export function decideTeamSettlementOutcome(input: DecideTeamSettlementOutcomeInput): TeamSettlementOutcome {
  if (input.winnerAttemptId === input.attemptId
    || input.currentStatus === "paid"
    || input.currentStatus === "duplicate_paid"
    || input.currentStatus === "refunded"
    || input.actionResolved) {
    return { kind: "idempotent" };
  }
  if (input.winnerAttemptId) return { kind: "duplicate", reviewReason: "duplicate_payment" };
  if (input.hasDifferentUnresolvedAction) {
    return { kind: "review", reviewReason: "other_payment_action_unresolved" };
  }
  if (input.attemptRegistrationRevision !== input.currentRegistrationRevision) {
    return { kind: "review", reviewReason: "registration_revision_changed" };
  }
  if (input.registrationStatus === "expired") {
    return { kind: "review", reviewReason: "registration_expired" };
  }
  if (!["ready_for_payment", "payment_pending"].includes(input.registrationStatus)) {
    return { kind: "review", reviewReason: "registration_not_payable" };
  }
  if (!input.claimsHeld) return { kind: "review", reviewReason: "claims_released" };
  if (!input.currentPaymentReservationExpiresAt
    || !isFiniteDate(input.currentPaymentReservationExpiresAt)
    || input.currentPaymentReservationExpiresAt.getTime() !== input.attemptExpiresAt.getTime()) {
    return { kind: "review", reviewReason: "payment_reservation_changed" };
  }
  if (!isFiniteDate(input.effectiveSettledAt)
    || input.effectiveSettledAt.getTime() > input.attemptExpiresAt.getTime()) {
    return { kind: "review", reviewReason: "payment_reservation_expired" };
  }
  return { kind: "winner" };
}

export interface CanStartTeamPaymentInput {
  now: Date;
  configEnabled: boolean;
  paymentEnvironmentReady: boolean;
  eventProfileMatches: boolean;
  eventMerchantMatches: boolean;
  registrationStatus: string;
  teamDataComplete: boolean;
  hasWinner: boolean;
  hasUnresolvedAction: boolean;
  claimsHeld: boolean;
  paymentReservationExpiresAt: Date | null;
  retainedSessionProfileMatches: boolean;
  retainedSessionMerchantMatches: boolean;
  draftExpiresAt: Date;
  registrationClosesAt: Date;
  hasActiveAttempt: boolean;
  safeRetryEnabled: boolean;
}

export function canStartTeamPayment(input: CanStartTeamPaymentInput): boolean {
  if (!isFiniteDate(input.now)
    || !input.configEnabled
    || !input.paymentEnvironmentReady
    || !input.eventProfileMatches
    || !input.eventMerchantMatches
    || !["ready_for_payment", "payment_pending"].includes(input.registrationStatus)
    || !input.teamDataComplete
    || input.hasWinner
    || input.hasUnresolvedAction
    || !input.claimsHeld
    || (input.hasActiveAttempt && !input.safeRetryEnabled)) {
    return false;
  }

  const hasRetainedSession = input.paymentReservationExpiresAt !== null
    && isFiniteDate(input.paymentReservationExpiresAt)
    && input.paymentReservationExpiresAt.getTime() > input.now.getTime();
  if (hasRetainedSession) {
    return input.retainedSessionProfileMatches && input.retainedSessionMerchantMatches;
  }

  return isFiniteDate(input.draftExpiresAt)
    && input.draftExpiresAt.getTime() > input.now.getTime()
    && isFiniteDate(input.registrationClosesAt)
    && input.registrationClosesAt.getTime() > input.now.getTime();
}

export interface CanReplayTeamPaymentAttemptInput {
  configEnabled: boolean;
  paymentEnvironmentReady: boolean;
  eventProfileMatches: boolean;
  eventMerchantMatches: boolean;
  ownedByRequester: boolean;
  active: boolean;
  unexpired: boolean;
  sessionMatches: boolean;
  retainedSessionProfileMatches: boolean;
  retainedSessionMerchantMatches: boolean;
}

export function canReplayTeamPaymentAttempt(input: CanReplayTeamPaymentAttemptInput): boolean {
  return input.configEnabled
    && input.paymentEnvironmentReady
    && input.eventProfileMatches
    && input.eventMerchantMatches
    && input.ownedByRequester
    && input.active
    && input.unexpired
    && input.sessionMatches
    && input.retainedSessionProfileMatches
    && input.retainedSessionMerchantMatches;
}

export type UnpaidTeamRegistrationTransition =
  | {
    kind: "held";
    registrationStatus: "payment_pending";
    paymentReservationExpiresAt: Date | null;
    releaseClaims: false;
  }
  | {
    kind: "ready_for_payment";
    registrationStatus: "ready_for_payment";
    paymentReservationExpiresAt: Date | null;
    releaseClaims: false;
  }
  | {
    kind: "expired";
    registrationStatus: "expired";
    paymentReservationExpiresAt: null;
    releaseClaims: true;
  };

export interface DecideUnpaidTeamRegistrationTransitionInput {
  now: Date;
  paymentReservationExpiresAt: Date | null;
  registrationClosesAt: Date;
  hasWinner: boolean;
  hasUnresolvedAction: boolean;
  paymentFinalized: boolean;
}

export function decideUnpaidTeamRegistrationTransition(
  input: DecideUnpaidTeamRegistrationTransitionInput,
): UnpaidTeamRegistrationTransition {
  if (input.hasWinner || input.hasUnresolvedAction || !input.paymentFinalized) {
    return {
      kind: "held",
      registrationStatus: "payment_pending",
      paymentReservationExpiresAt: input.paymentReservationExpiresAt,
      releaseClaims: false,
    };
  }

  if (input.paymentReservationExpiresAt
    && isFiniteDate(input.paymentReservationExpiresAt)
    && input.paymentReservationExpiresAt.getTime() > input.now.getTime()) {
    return {
      kind: "ready_for_payment",
      registrationStatus: "ready_for_payment",
      paymentReservationExpiresAt: new Date(input.paymentReservationExpiresAt),
      releaseClaims: false,
    };
  }

  if (isFiniteDate(input.registrationClosesAt)
    && input.registrationClosesAt.getTime() > input.now.getTime()) {
    return {
      kind: "ready_for_payment",
      registrationStatus: "ready_for_payment",
      paymentReservationExpiresAt: null,
      releaseClaims: false,
    };
  }

  return {
    kind: "expired",
    registrationStatus: "expired",
    paymentReservationExpiresAt: null,
    releaseClaims: true,
  };
}
