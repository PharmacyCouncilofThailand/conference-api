import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  events,
  teamRegistrationConfigs,
  teamRegistrationEmailClaims,
  teamRegistrationEmailOutbox,
  teamRegistrationMembers,
  teamRegistrationPaymentAttempts,
  teamRegistrationPaymentEvents,
  teamRegistrations,
} from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import {
  advanceTerminalSchedule,
  initializeActiveReconciliationSchedule,
  initializeTerminalSchedule,
} from "./jobs-policy.js";
import { teamPaymentSafeRetryEnabled } from "./payment-flags.js";
import {
  activePaymentAttempts,
  cancelActivePaymentAttempts,
  hasAllCurrentEmailClaims,
  lockAllPaymentAttempts,
  lockTeamRegistration,
  paymentWinner,
  type TeamPaymentAttempt,
  type TeamRegistrationTransaction,
} from "./payment.repository.js";
import {
  canStartTeamPayment,
  classifyTeamProviderStatus,
  decideTeamPaymentTransition,
  decideTeamSettlementOutcome,
  decideUnpaidTeamRegistrationTransition,
  resolveEffectiveTeamSettlementTime,
  type TeamPaymentReviewReason,
} from "./payment-state.js";
import type { TeamPaySolutionsClient, TeamPaySolutionsInquiry } from "./paysolutions.client.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import type { TeamPaymentStatusResponse } from "./types.js";
import { compareTeamPaymentInquiry, getTeamPaymentClassifierOptions } from "./payment-verification.js";

function redactInquiry(inquiry: TeamPaySolutionsInquiry): Record<string, unknown> {
  return {
    referenceNo: inquiry.referenceNo.slice(0, 12),
    orderNo: inquiry.orderNo?.slice(0, 100) ?? null,
    merchantId: inquiry.merchantId.slice(0, 64),
    status: inquiry.status.slice(0, 100),
    statusName: inquiry.statusName.slice(0, 100),
    total: inquiry.total.slice(0, 64),
    currencyCode: inquiry.currencyCode.slice(0, 16),
    paidAtState: inquiry.paidAtState,
    paidAt: inquiry.paidAt?.toISOString() ?? null,
  };
}

function localProfileCode(): string | null {
  return process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE?.trim() || null;
}

function mismatchReason(comparison: ReturnType<typeof compareTeamPaymentInquiry>): TeamPaymentReviewReason | null {
  if (!comparison.referenceMatches) return "reference_mismatch";
  if (!comparison.merchantMatches) return "merchant_mismatch";
  if (!comparison.amountMatches) return "amount_mismatch";
  if (!comparison.currencyMatches) return "currency_mismatch";
  return null;
}

const REVIEW_REASON_PRIORITY: readonly TeamPaymentReviewReason[] = [
  "duplicate_payment",
  "other_payment_action_unresolved",
  "registration_revision_changed",
  "registration_not_payable",
  "registration_expired",
  "claims_released",
  "payment_reservation_changed",
  "payment_reservation_expired",
  "provider_paid_at_invalid",
  "reference_mismatch",
  "merchant_mismatch",
  "amount_mismatch",
  "currency_mismatch",
  "winner_refunded",
  "legacy_verification_required",
];

function earliestReviewReason(
  ...reasons: Array<string | null | undefined>
): TeamPaymentReviewReason {
  for (const candidate of REVIEW_REASON_PRIORITY) {
    if (reasons.includes(candidate)) return candidate;
  }
  return "legacy_verification_required";
}

function providerMetadata(inquiry: TeamPaySolutionsInquiry, now: Date) {
  return {
    providerStatus: inquiry.status.slice(0, 100),
    providerStatusName: inquiry.statusName.slice(0, 100),
    providerOrderNo: inquiry.orderNo?.slice(0, 100) ?? null,
    lastInquiredAt: now,
    updatedAt: now,
  };
}

async function insertInquiryEvent(
  tx: TeamRegistrationTransaction,
  attempt: TeamPaymentAttempt,
  inquiry: TeamPaySolutionsInquiry,
  comparison: ReturnType<typeof compareTeamPaymentInquiry>,
  eventType: string,
  now: Date,
) {
  await tx.insert(teamRegistrationPaymentEvents).values({
    paymentAttemptId: attempt.id,
    eventType,
    referenceNo: attempt.referenceNo,
    providerStatus: inquiry.status.slice(0, 100),
    payloadRedacted: redactInquiry(inquiry),
    merchantMatches: comparison.merchantMatches,
    amountMatches: comparison.amountMatches,
    currencyMatches: comparison.currencyMatches,
    processedAt: now,
    createdAt: now,
  });
}

async function queueWinnerEmails(
  tx: TeamRegistrationTransaction,
  registration: typeof teamRegistrations.$inferSelect,
  attempt: TeamPaymentAttempt,
  now: Date,
) {
  const members = await tx.select().from(teamRegistrationMembers)
    .where(eq(teamRegistrationMembers.registrationId, registration.id));
  const [event] = await tx.select({ name: events.eventName }).from(events)
    .where(eq(events.id, registration.eventId)).limit(1);
  if (members.length === 0) return;
  const memberNames = [...members]
    .sort((left, right) => left.position - right.position)
    .map((member) => `${member.firstName} ${member.lastName}`.trim());
  await tx.insert(teamRegistrationEmailOutbox).values(members.map((member) => ({
    registrationId: registration.id,
    memberId: member.id,
    templateCode: "team_payment_confirmation",
    deliveryKey: "initial",
    recipientEmail: member.email,
    payloadSnapshot: {
      eventName: event?.name ?? "Event",
      teamName: registration.teamName,
      memberNames,
      amount: attempt.amount,
      currency: attempt.currency,
      referenceNo: attempt.referenceNo,
    },
    status: "pending" as const,
    nextAttemptAt: now,
  }))).onConflictDoNothing();
}

async function applyUnpaidRegistrationTransition(
  tx: TeamRegistrationTransaction,
  registration: typeof teamRegistrations.$inferSelect,
  attempts: TeamPaymentAttempt[],
  now: Date,
) {
  const [config] = await tx.select().from(teamRegistrationConfigs)
    .where(eq(teamRegistrationConfigs.id, registration.configId)).for("share").limit(1);
  if (!config) return;
  const hasWinner = attempts.some((attempt) => attempt.isWinner);
  const hasUnresolvedAction = attempts.some((attempt) => attempt.actionRequired && !attempt.actionResolvedAt);
  const paymentFinalized = activePaymentAttempts(attempts).length === 0;
  const decision = decideUnpaidTeamRegistrationTransition({
    now,
    paymentReservationExpiresAt: registration.paymentReservationExpiresAt,
    registrationClosesAt: config.registrationClosesAt,
    hasWinner,
    hasUnresolvedAction,
    paymentFinalized,
  });
  if (decision.kind === "held") return;

  await tx.update(teamRegistrations).set({
    status: decision.registrationStatus,
    paymentReservationExpiresAt: decision.paymentReservationExpiresAt,
    expiredAt: decision.kind === "expired" ? now : null,
    updatedAt: now,
  }).where(eq(teamRegistrations.id, registration.id));
  if (decision.releaseClaims) {
    await tx.update(teamRegistrationEmailClaims).set({ releasedAt: now }).where(and(
      eq(teamRegistrationEmailClaims.registrationId, registration.id),
      isNull(teamRegistrationEmailClaims.releasedAt),
    ));
  }
}

function reviewUpdate(
  attempt: TeamPaymentAttempt,
  reason: TeamPaymentReviewReason,
  inquiry: TeamPaySolutionsInquiry,
  now: Date,
  paidAt: Date,
) {
  if (attempt.actionResolvedAt) {
    return { ...providerMetadata(inquiry, now), paidAt: attempt.paidAt ?? paidAt };
  }
  const settled = ["paid", "duplicate_paid", "refunded"].includes(attempt.status);
  return {
    ...providerMetadata(inquiry, now),
    status: settled ? attempt.status : "verification_required" as const,
    paidAt: attempt.paidAt ?? paidAt,
    actionRequired: true,
    reviewReason: earliestReviewReason(
      attempt.actionRequired ? attempt.reviewReason : null,
      reason,
    ),
    actionResolvedAt: null,
    actionResolution: null,
    actionResolutionNote: null,
    nextReconcileAt: null,
  };
}

async function applyInquiryUnderLock(input: {
  registrationId: string;
  paymentAttemptId: string;
  inquiry: TeamPaySolutionsInquiry;
  inquiryStartedAt: Date;
  inquiryCompletedAt: Date;
}) {
  return db.transaction(async (tx) => {
    const registration = await lockTeamRegistration(tx, input.registrationId);
    if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
    let attempts = await lockAllPaymentAttempts(tx, registration.id);
    const attempt = attempts.find((item) => item.id === input.paymentAttemptId);
    if (!attempt) throw new TeamRegistrationError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "ไม่พบรายการชำระเงิน");

    const classifierOptions = {
      ...getTeamPaymentClassifierOptions(),
      hasVerifiedSettlement: Boolean(attempt.paidAt),
    };
    const classification = classifyTeamProviderStatus(input.inquiry, classifierOptions);
    const comparison = compareTeamPaymentInquiry(
      {
        referenceNo: attempt.referenceNo,
        merchantId: attempt.merchantIdSnapshot,
        amount: attempt.amount,
        currency: "THB",
      },
      input.inquiry,
      classifierOptions,
    );
    const mismatch = mismatchReason(comparison);
    await insertInquiryEvent(
      tx,
      attempt,
      input.inquiry,
      comparison,
      mismatch ? "inquiry_mismatch" : `inquiry_${classification}`,
      input.inquiryCompletedAt,
    );

    const transition = decideTeamPaymentTransition({
      currentStatus: attempt.status,
      providerClassification: classification,
      hasVerifiedSettlement: Boolean(attempt.paidAt),
      actionResolved: Boolean(attempt.actionResolvedAt),
    });

    const settlementTime = resolveEffectiveTeamSettlementTime({
      paidAtState: input.inquiry.paidAtState,
      paidAt: input.inquiry.paidAt,
      attemptCreatedAt: attempt.formCreatedAt,
      inquiryStartedAt: input.inquiryStartedAt,
      inquiryCompletedAt: input.inquiryCompletedAt,
    });
    const discoveredPaidAt = settlementTime.eligible
      ? settlementTime.effectiveSettledAt
      : input.inquiry.paidAtState === "valid" && input.inquiry.paidAt
        ? input.inquiry.paidAt
        : input.inquiryCompletedAt;

    const reportsMoney = classification === "paid" || classification === "refunded";
    if (mismatch && reportsMoney && transition.kind !== "settlement") {
      await tx.update(teamRegistrationPaymentAttempts).set(
        reviewUpdate(attempt, mismatch, input.inquiry, input.inquiryCompletedAt, discoveredPaidAt),
      ).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      // An administrator has already made the money-handling decision for this
      // attempt. Later provider replays may refresh metadata, but must not reopen
      // the action indirectly by cancelling a replacement that is now in flight.
      if (attempt.actionResolvedAt) return;
      const schedule = initializeTerminalSchedule("cancelled", input.inquiryCompletedAt, input.inquiryCompletedAt);
      await cancelActivePaymentAttempts(tx, {
        registrationId: registration.id,
        reason: "payment_review_required",
        cancelledAt: input.inquiryCompletedAt,
        reconciliationDeadlineAt: schedule.reconciliationDeadlineAt,
        excludeAttemptId: attempt.id,
      });
      return;
    }

    if (mismatch && !reportsMoney) {
      await tx.update(teamRegistrationPaymentAttempts).set({
        ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      return;
    }

    if (transition.kind === "refund") {
      const isWinner = attempt.isWinner;
      const preserveResolution = Boolean(attempt.actionResolvedAt);
      const resolvedAt = preserveResolution
        ? attempt.actionResolvedAt
        : isWinner
          ? null
          : input.inquiryCompletedAt;
      await tx.update(teamRegistrationPaymentAttempts).set({
        ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
        status: "refunded",
        paidAt: attempt.paidAt ?? discoveredPaidAt,
        refundedAt: input.inquiryCompletedAt,
        nextReconcileAt: null,
        ...(preserveResolution ? {} : isWinner ? {
          actionRequired: true,
          reviewReason: "winner_refunded",
          actionResolvedAt: null,
          actionResolution: null,
          actionResolutionNote: null,
        } : {
          actionRequired: false,
          actionResolvedAt: input.inquiryCompletedAt,
          actionResolution: "refunded",
          actionResolutionNote: "Provider-confirmed refund",
        }),
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      attempts = attempts.map((item) => item.id === attempt.id ? {
        ...item,
        status: "refunded",
        paidAt: item.paidAt ?? discoveredPaidAt,
        refundedAt: input.inquiryCompletedAt,
        actionRequired: preserveResolution ? item.actionRequired : isWinner,
        actionResolvedAt: resolvedAt,
        actionResolution: preserveResolution
          ? item.actionResolution
          : isWinner
            ? null
            : "refunded",
        actionResolutionNote: preserveResolution
          ? item.actionResolutionNote
          : isWinner
            ? null
            : "Provider-confirmed refund",
      } : item);
      await applyUnpaidRegistrationTransition(tx, registration, attempts, input.inquiryCompletedAt);
      return;
    }

    if (transition.kind === "transition") {
      if (transition.nextStatus === "failed") {
        const schedule = initializeTerminalSchedule("failed", input.inquiryCompletedAt, input.inquiryCompletedAt);
        const { inquiryLeaseUntil: _preserveLease, ...terminalSchedule } = schedule;
        await tx.update(teamRegistrationPaymentAttempts).set({
          ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
          status: "failed",
          failedAt: input.inquiryCompletedAt,
          ...terminalSchedule,
        }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      } else {
        const cancelledAt = attempt.cancelledAt ?? input.inquiryCompletedAt;
        const schedule = initializeTerminalSchedule("cancelled", cancelledAt, input.inquiryCompletedAt);
        const { inquiryLeaseUntil: _preserveLease, ...terminalSchedule } = schedule;
        await tx.update(teamRegistrationPaymentAttempts).set({
          ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
          status: "cancelled",
          cancelledAt,
          cancellationReason: attempt.cancellationReason ?? "provider_cancelled",
          ...terminalSchedule,
        }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      }
      attempts = attempts.map((item) => item.id === attempt.id
        ? { ...item, status: transition.nextStatus, actionRequired: false }
        : item);
      await applyUnpaidRegistrationTransition(tx, registration, attempts, input.inquiryCompletedAt);
      return;
    }

    if (transition.kind !== "settlement") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      return;
    }

    const winner = paymentWinner(attempts);
    const claimsHeld = await hasAllCurrentEmailClaims(tx, registration.id);
    const outcome = decideTeamSettlementOutcome({
      attemptId: attempt.id,
      currentStatus: attempt.status,
      winnerAttemptId: winner?.id ?? null,
      actionResolved: Boolean(attempt.actionResolvedAt),
      hasDifferentUnresolvedAction: attempts.some((item) => (
        item.id !== attempt.id && item.actionRequired && !item.actionResolvedAt
      )),
      attemptRegistrationRevision: attempt.registrationRevisionSnapshot,
      currentRegistrationRevision: registration.revision,
      registrationStatus: registration.status,
      claimsHeld,
      attemptExpiresAt: attempt.expiresAt,
      currentPaymentReservationExpiresAt: registration.paymentReservationExpiresAt,
      effectiveSettledAt: discoveredPaidAt,
    });

    const reviewReason = earliestReviewReason(
      outcome.kind === "review" ? outcome.reviewReason : null,
      (mismatch || !settlementTime.eligible) && outcome.kind === "duplicate"
        ? outcome.reviewReason
        : null,
      settlementTime.eligible ? null : settlementTime.reviewReason,
      mismatch,
    );
    const requiresReview = outcome.kind === "review"
      || Boolean(mismatch)
      || !settlementTime.eligible;

    if (requiresReview) {
      await tx.update(teamRegistrationPaymentAttempts).set(
        reviewUpdate(
          attempt,
          reviewReason,
          input.inquiry,
          input.inquiryCompletedAt,
          discoveredPaidAt,
        ),
      ).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      const schedule = initializeTerminalSchedule("cancelled", input.inquiryCompletedAt, input.inquiryCompletedAt);
      await cancelActivePaymentAttempts(tx, {
        registrationId: registration.id,
        reason: "payment_review_required",
        cancelledAt: input.inquiryCompletedAt,
        reconciliationDeadlineAt: schedule.reconciliationDeadlineAt,
        excludeAttemptId: attempt.id,
      });
      return;
    }

    if (outcome.kind === "idempotent") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      return;
    }

    if (outcome.kind === "duplicate") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
        status: "duplicate_paid",
        paidAt: discoveredPaidAt,
        actionRequired: true,
        reviewReason: outcome.reviewReason,
        actionResolvedAt: null,
        actionResolution: null,
        actionResolutionNote: null,
        nextReconcileAt: null,
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      return;
    }

    await tx.update(teamRegistrationPaymentAttempts).set({
      ...providerMetadata(input.inquiry, input.inquiryCompletedAt),
      status: "paid",
      isWinner: true,
      paidAt: discoveredPaidAt,
      actionRequired: false,
      reviewReason: null,
      nextReconcileAt: null,
    }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
    const siblingSchedule = initializeTerminalSchedule("cancelled", input.inquiryCompletedAt, input.inquiryCompletedAt);
    await cancelActivePaymentAttempts(tx, {
      registrationId: registration.id,
      reason: "sibling_paid",
      cancelledAt: input.inquiryCompletedAt,
      reconciliationDeadlineAt: siblingSchedule.reconciliationDeadlineAt,
      excludeAttemptId: attempt.id,
    });
    await tx.update(teamRegistrations).set({
      status: "paid",
      paidAt: discoveredPaidAt,
      lockedAt: input.inquiryCompletedAt,
      categoryCodeSnapshot: attempt.categoryCodeSnapshot,
      categoryNameSnapshot: attempt.categoryNameSnapshot,
      pricingRoundCodeSnapshot: attempt.pricingRoundCodeSnapshot,
      pricingRoundNameSnapshot: attempt.pricingRoundNameSnapshot,
      amountSnapshot: attempt.amount,
      currencySnapshot: attempt.currency,
      updatedAt: input.inquiryCompletedAt,
    }).where(eq(teamRegistrations.id, registration.id));
    await queueWinnerEmails(tx, registration, attempt, input.inquiryCompletedAt);
  });
}

export async function reconcileTeamPaymentAttempt(
  paymentAttemptId: string,
  client: TeamPaySolutionsClient,
): Promise<TeamPaymentStatusResponse> {
  const [attempt] = await db.select().from(teamRegistrationPaymentAttempts)
    .where(eq(teamRegistrationPaymentAttempts.id, paymentAttemptId)).limit(1);
  if (!attempt) throw new TeamRegistrationError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "ไม่พบรายการชำระเงิน");
  const profile = localProfileCode();
  if (!profile || profile !== attempt.paymentProfileCode) {
    throw new TeamRegistrationError(503, "PAYMENT_PROFILE_MISMATCH", "โปรไฟล์ระบบชำระเงินไม่ตรงกับรายการ");
  }
  if (client.merchantId !== attempt.merchantIdSnapshot) {
    throw new TeamRegistrationError(503, "PAYMENT_MERCHANT_MISMATCH", "Merchant ไม่ตรงกับรายการชำระเงิน");
  }

  const inquiryStartedAt = new Date();
  const inquiry = await client.inquiry(attempt.referenceNo);
  const inquiryCompletedAt = new Date();
  if (!inquiry) throw new TeamRegistrationError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "ยังไม่พบสถานะจากผู้ให้บริการ");
  await applyInquiryUnderLock({
    registrationId: attempt.registrationId,
    paymentAttemptId,
    inquiry,
    inquiryStartedAt,
    inquiryCompletedAt,
  });
  return getPaymentStatusByRegistration(attempt.registrationId);
}

export async function releaseTeamPaymentInquiryLease(
  paymentAttemptId: string,
  claimedLeaseUntil: Date,
  now = new Date(),
  advanceTerminal = false,
) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(teamRegistrationPaymentAttempts)
      .where(and(
        eq(teamRegistrationPaymentAttempts.id, paymentAttemptId),
        eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimedLeaseUntil),
      )).for("update").limit(1);
    if (!attempt) return;
    if (attempt.status === "creating" || attempt.status === "pending") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        inquiryLeaseUntil: null,
        nextReconcileAt: attempt.expiresAt <= now
          ? now
          : initializeActiveReconciliationSchedule(now, attempt.expiresAt),
        updatedAt: now,
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      return;
    }
    if (advanceTerminal
      && ["cancelled", "failed", "expired"].includes(attempt.status)
      && attempt.reconciliationDeadlineAt) {
      await tx.update(teamRegistrationPaymentAttempts).set({
        ...advanceTerminalSchedule({
          terminalReconciliationCount: attempt.terminalReconciliationCount,
          reconciliationDeadlineAt: attempt.reconciliationDeadlineAt,
        }, now),
        updatedAt: now,
      }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      return;
    }
    await tx.update(teamRegistrationPaymentAttempts).set({ inquiryLeaseUntil: null, updatedAt: now })
      .where(and(
        eq(teamRegistrationPaymentAttempts.id, attempt.id),
        eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimedLeaseUntil),
      ));
  });
}

export async function getPaymentStatusByRegistration(registrationId: string): Promise<TeamPaymentStatusResponse> {
  const snapshot = await db.transaction(async (tx) => {
    const [registration] = await tx.select().from(teamRegistrations)
      .where(eq(teamRegistrations.id, registrationId)).limit(1);
    if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
    const attempts = await tx.select().from(teamRegistrationPaymentAttempts)
      .where(eq(teamRegistrationPaymentAttempts.registrationId, registrationId))
      .orderBy(desc(teamRegistrationPaymentAttempts.attemptNumber));
    const [config] = await tx.select().from(teamRegistrationConfigs)
      .where(eq(teamRegistrationConfigs.id, registration.configId)).limit(1);
    const claims = await tx.select({ id: teamRegistrationEmailClaims.id })
      .from(teamRegistrationEmailClaims).where(and(
        eq(teamRegistrationEmailClaims.registrationId, registrationId),
        isNull(teamRegistrationEmailClaims.releasedAt),
      ));
    const members = await tx.select({ id: teamRegistrationMembers.id })
      .from(teamRegistrationMembers).where(eq(teamRegistrationMembers.registrationId, registrationId));
    return { registration, attempts, config: config ?? null, claims, members };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const { registration, attempts, config, claims, members } = snapshot;
  const winner = paymentWinner(attempts);
  const latest = attempts[0] ?? null;
  const active = attempts.find((attempt) => attempt.status === "creating" || attempt.status === "pending") ?? null;
  const relevant = winner ?? active ?? latest;
  const unresolved = attempts.filter((attempt) => attempt.actionRequired && !attempt.actionResolvedAt);
  let environmentReady = false;
  let merchantId: string | null = null;
  try {
    const providerConfig = getTeamPaySolutionsConfig();
    const client = createTeamPaySolutionsClient(providerConfig);
    merchantId = client.merchantId;
    environmentReady = Boolean(localProfileCode());
  } catch {
    environmentReady = false;
  }
  const now = new Date();
  const hasRetainedReservation = Boolean(
    registration.paymentReservationExpiresAt && registration.paymentReservationExpiresAt > now,
  );
  const retained = hasRetainedReservation
    ? attempts.find((attempt) => (
      attempt.expiresAt.getTime() === registration.paymentReservationExpiresAt!.getTime()
      && attempt.registrationRevisionSnapshot === registration.revision
    )) ?? null
    : null;
  const profile = localProfileCode();
  const canRetry = config ? canStartTeamPayment({
    now,
    configEnabled: config.isEnabled,
    paymentEnvironmentReady: environmentReady,
    eventProfileMatches: Boolean(profile && profile === config.paymentProfileCode),
    eventMerchantMatches: true,
    registrationStatus: registration.status,
    teamDataComplete: registration.status === "ready_for_payment" || registration.status === "payment_pending",
    hasWinner: Boolean(winner),
    hasUnresolvedAction: unresolved.length > 0,
    claimsHeld: members.length > 0 && members.length === claims.length,
    paymentReservationExpiresAt: registration.paymentReservationExpiresAt,
    retainedSessionProfileMatches: !hasRetainedReservation || retained?.paymentProfileCode === profile,
    retainedSessionMerchantMatches: !hasRetainedReservation || retained?.merchantIdSnapshot === merchantId,
    draftExpiresAt: registration.draftExpiresAt,
    registrationClosesAt: config.registrationClosesAt,
    hasActiveAttempt: Boolean(active),
    safeRetryEnabled: teamPaymentSafeRetryEnabled(),
  }) : false;

  return {
    registrationId: registration.id,
    registrationStatus: registration.status,
    paymentStatus: relevant?.status === "creating" ? "pending" : relevant?.status ?? null,
    referenceNo: relevant?.referenceNo ?? null,
    amount: relevant?.amount ?? null,
    currency: relevant ? relevant.currency as "THB" : null,
    paidAt: relevant?.paidAt?.toISOString() ?? null,
    refundedAt: relevant?.refundedAt?.toISOString() ?? null,
    canRetry,
    requiresAction: unresolved.length > 0,
    unresolvedActionCount: unresolved.length,
    reviewReason: (unresolved[0]?.reviewReason as TeamPaymentReviewReason | null | undefined) ?? null,
    winnerPaymentAttemptId: winner?.id ?? null,
    latestPaymentAttemptId: latest?.id ?? null,
  };
}
