import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
} from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  events,
  teamRegistrationConfigs,
  teamRegistrationEmailClaims,
  teamRegistrationEmailOutbox,
  teamRegistrationJobState,
  teamRegistrationMembers,
  teamRegistrationPaymentAttempts,
  teamRegistrations,
} from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import { processSequentiallyWithDelay } from "./email-outbox.js";
import {
  PAYMENT_INQUIRY_LEASE_MS,
  TEAM_EMAIL_PROCESSING_LEASE_MS,
  TEAM_REGISTRATION_JOB_PHASES,
  advanceTerminalSchedule,
  firstTeamRegistrationJobErrorCode,
  initializeActiveReconciliationSchedule,
  initializeTerminalSchedule,
  isTeamRegistrationWorkerProcessLive,
  reconciliationPhaseAfterCompletion,
  resolveTeamRegistrationWorkerHealth,
  sanitizeJobErrorCode,
  type PaymentReconciliationPhase,
  type TeamRegistrationWorkerStatus,
} from "./jobs-policy.js";
import { sendTeamPaidConfirmationEmail, type TeamPaidEmailInput } from "./paid-email.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import { reconcileTeamPaymentAttempt } from "./payment-verification.service.js";

export interface JobResult {
  scanned: number;
  changed: number;
  failed: number;
  errorCode?: string;
}

export interface TeamRegistrationWorkerHealth {
  status: TeamRegistrationWorkerStatus;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
}

export interface TeamRegistrationWorkerLiveness {
  live: boolean;
  lastActivityAt: string | null;
}

export const TEAM_REGISTRATION_WORKER_JOB_NAME = "team_registration_worker";
export { TEAM_REGISTRATION_JOB_PHASES };

type ClaimedPaymentAttempt = {
  id: string;
  registrationId: string;
  status: string;
  expiresAt: Date;
  cancelledAt: Date | null;
  failedAt: Date | null;
  nextReconcileAt: Date | null;
  reconciliationDeadlineAt: Date | null;
  terminalReconciliationCount: number;
  leaseUntil: Date;
};

function sameInstant(left: Date | null, right: Date): boolean {
  return left !== null && left.getTime() === right.getTime();
}

export function outboxRetryDelayMinutes(attemptCount: number): number {
  return [1, 5, 30, 120, 720][Math.min(Math.max(attemptCount - 1, 0), 4)];
}

function selectorForPhase(phase: PaymentReconciliationPhase, now: Date) {
  const leaseAvailable = or(
    isNull(teamRegistrationPaymentAttempts.inquiryLeaseUntil),
    lte(teamRegistrationPaymentAttempts.inquiryLeaseUntil, now),
  );

  if (phase === "regular") {
    return and(
      eq(teamRegistrationPaymentAttempts.status, "pending"),
      isNotNull(teamRegistrationPaymentAttempts.nextReconcileAt),
      lte(teamRegistrationPaymentAttempts.nextReconcileAt, now),
      gt(teamRegistrationPaymentAttempts.expiresAt, now),
      leaseAvailable,
    );
  }
  if (phase === "final") {
    return and(
      inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
      lte(teamRegistrationPaymentAttempts.expiresAt, now),
      leaseAvailable,
    );
  }
  return and(
    inArray(teamRegistrationPaymentAttempts.status, ["cancelled", "failed", "expired"]),
    isNotNull(teamRegistrationPaymentAttempts.nextReconcileAt),
    lte(teamRegistrationPaymentAttempts.nextReconcileAt, now),
    leaseAvailable,
  );
}

/**
 * Claims rows in a short transaction. The provider call happens only after this
 * transaction commits. The exact lease timestamp also acts as the ownership
 * token when the result is completed.
 */
export async function claimDueTeamPaymentAttempts(
  phase: PaymentReconciliationPhase,
  now = new Date(),
  batchSize = 50,
  excludeAttemptIds: readonly string[] = [],
): Promise<ClaimedPaymentAttempt[]> {
  const leaseUntil = new Date(now.getTime() + PAYMENT_INQUIRY_LEASE_MS);
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: teamRegistrationPaymentAttempts.id,
      registrationId: teamRegistrationPaymentAttempts.registrationId,
      status: teamRegistrationPaymentAttempts.status,
      expiresAt: teamRegistrationPaymentAttempts.expiresAt,
      cancelledAt: teamRegistrationPaymentAttempts.cancelledAt,
      failedAt: teamRegistrationPaymentAttempts.failedAt,
      nextReconcileAt: teamRegistrationPaymentAttempts.nextReconcileAt,
      reconciliationDeadlineAt: teamRegistrationPaymentAttempts.reconciliationDeadlineAt,
      terminalReconciliationCount: teamRegistrationPaymentAttempts.terminalReconciliationCount,
    }).from(teamRegistrationPaymentAttempts)
      .where(and(
        selectorForPhase(phase, now),
        excludeAttemptIds.length > 0
          ? notInArray(teamRegistrationPaymentAttempts.id, [...excludeAttemptIds])
          : undefined,
      ))
      .orderBy(asc(
        phase === "final"
          ? teamRegistrationPaymentAttempts.expiresAt
          : teamRegistrationPaymentAttempts.nextReconcileAt,
      ))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    if (rows.length === 0) return [];
    await tx.update(teamRegistrationPaymentAttempts).set({
      inquiryLeaseUntil: leaseUntil,
      updatedAt: now,
    }).where(inArray(teamRegistrationPaymentAttempts.id, rows.map((row) => row.id)));
    return rows.map((row) => ({ ...row, leaseUntil }));
  });
}

async function completeRegularOrFinalInquiry(
  claimed: ClaimedPaymentAttempt,
  claimedPhase: "regular" | "final",
  completedAt: Date,
): Promise<boolean> {
  const completionPhase = reconciliationPhaseAfterCompletion(claimedPhase, claimed.expiresAt, completedAt);
  return db.transaction(async (tx) => {
    // All flows that need both row types preserve registration -> attempts.
    const [registration] = await tx.select().from(teamRegistrations)
      .where(eq(teamRegistrations.id, claimed.registrationId)).for("update").limit(1);
    if (!registration) return false;
    const attempts = await tx.select().from(teamRegistrationPaymentAttempts)
      .where(eq(teamRegistrationPaymentAttempts.registrationId, claimed.registrationId))
      .for("update");
    const attempt = attempts.find((item) => item.id === claimed.id);
    if (!attempt || !sameInstant(attempt.inquiryLeaseUntil, claimed.leaseUntil)) return false;

    if (attempt.status !== "creating" && attempt.status !== "pending") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        inquiryLeaseUntil: null,
        updatedAt: completedAt,
      }).where(and(
        eq(teamRegistrationPaymentAttempts.id, attempt.id),
        eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimed.leaseUntil),
      ));
      return true;
    }

    if (completionPhase === "regular") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        nextReconcileAt: initializeActiveReconciliationSchedule(completedAt, attempt.expiresAt),
        inquiryLeaseUntil: null,
        updatedAt: completedAt,
      }).where(and(
        eq(teamRegistrationPaymentAttempts.id, attempt.id),
        eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimed.leaseUntil),
      ));
      return true;
    }

    const terminalSchedule = initializeTerminalSchedule("expired", attempt.expiresAt, completedAt);
    await tx.update(teamRegistrationPaymentAttempts).set({
      status: "expired",
      ...terminalSchedule,
      updatedAt: completedAt,
    }).where(and(
      eq(teamRegistrationPaymentAttempts.id, attempt.id),
      eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimed.leaseUntil),
      inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
    ));

    const hasWinner = attempts.some((item) => item.isWinner);
    const hasUnresolvedAction = attempts.some((item) => item.actionRequired && item.actionResolvedAt === null);
    const completingCurrentReservation = registration.paymentReservationExpiresAt !== null
      && registration.paymentReservationExpiresAt.getTime() === attempt.expiresAt.getTime();
    if (
      registration.status === "payment_pending"
      && completingCurrentReservation
      && !hasWinner
      && !hasUnresolvedAction
    ) {
      await tx.update(teamRegistrations).set({
        status: "ready_for_payment",
        paymentReservationExpiresAt: null,
        updatedAt: completedAt,
      }).where(and(
        eq(teamRegistrations.id, registration.id),
        eq(teamRegistrations.status, "payment_pending"),
      ));
    }
    return true;
  });
}

async function completeTerminalInquiry(
  claimed: ClaimedPaymentAttempt,
  completedAt: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(teamRegistrationPaymentAttempts)
      .where(eq(teamRegistrationPaymentAttempts.id, claimed.id)).for("update").limit(1);
    if (!attempt || !sameInstant(attempt.inquiryLeaseUntil, claimed.leaseUntil)) return false;
    if (attempt.status !== "cancelled" && attempt.status !== "failed" && attempt.status !== "expired") {
      await tx.update(teamRegistrationPaymentAttempts).set({
        inquiryLeaseUntil: null,
        updatedAt: completedAt,
      }).where(and(
        eq(teamRegistrationPaymentAttempts.id, attempt.id),
        eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimed.leaseUntil),
      ));
      return true;
    }

    const baseTime = attempt.status === "cancelled"
      ? attempt.cancelledAt ?? attempt.updatedAt
      : attempt.status === "failed"
        ? attempt.failedAt ?? attempt.updatedAt
        : attempt.expiresAt;
    const initialized = attempt.reconciliationDeadlineAt === null
      ? initializeTerminalSchedule(attempt.status, baseTime, completedAt)
      : {
          terminalReconciliationCount: attempt.terminalReconciliationCount,
          reconciliationDeadlineAt: attempt.reconciliationDeadlineAt,
        };
    const schedule = advanceTerminalSchedule(initialized, completedAt);
    await tx.update(teamRegistrationPaymentAttempts).set({
      ...schedule,
      updatedAt: completedAt,
    }).where(and(
      eq(teamRegistrationPaymentAttempts.id, attempt.id),
      eq(teamRegistrationPaymentAttempts.inquiryLeaseUntil, claimed.leaseUntil),
      inArray(teamRegistrationPaymentAttempts.status, ["cancelled", "failed", "expired"]),
    ));
    return true;
  });
}

async function reconcileClaimedTeamPayments(
  phase: PaymentReconciliationPhase,
  now: Date,
  batchSize: number,
): Promise<JobResult> {
  let client: ReturnType<typeof createTeamPaySolutionsClient>;
  try {
    client = createTeamPaySolutionsClient(getTeamPaySolutionsConfig());
  } catch (error) {
    return {
      scanned: 0,
      changed: 0,
      failed: 1,
      errorCode: sanitizeJobErrorCode(error),
    };
  }

  let scanned = 0;
  let changed = 0;
  let failed = 0;
  let firstErrorCode: string | undefined;
  const processedAttemptIds: string[] = [];
  // Claim immediately before each provider request. Leasing a large batch and
  // processing it serially could let later 30-second leases expire in the queue.
  for (let index = 0; index < batchSize; index += 1) {
    const claimAt = new Date(Math.max(now.getTime(), Date.now()));
    const [row] = await claimDueTeamPaymentAttempts(phase, claimAt, 1, processedAttemptIds);
    if (!row) break;
    processedAttemptIds.push(row.id);
    scanned += 1;
    const wallStartedAt = Date.now();
    let inquiryFailed = false;
    let mayCompleteSchedule = true;
    try {
      await reconcileTeamPaymentAttempt(row.id, client);
    } catch (error) {
      inquiryFailed = true;
      firstErrorCode ??= sanitizeJobErrorCode(error);
      // A controlled provider miss/timeout has no authoritative result, but the
      // bounded schedule must still advance. Persistence, invariant, and local
      // configuration errors keep the claimed state untouched so lease recovery
      // retries them instead of expiring a potentially paid reference.
      mayCompleteSchedule = error instanceof TeamRegistrationError
        && error.code === "PAYMENT_PROVIDER_UNAVAILABLE";
    }

    const completedAt = new Date(claimAt.getTime() + Math.max(0, Date.now() - wallStartedAt));
    if (mayCompleteSchedule) {
      try {
        const completed = phase === "terminal"
          ? await completeTerminalInquiry(row, completedAt)
          : await completeRegularOrFinalInquiry(row, phase, completedAt);
        if (completed) changed += 1;
      } catch (error) {
        inquiryFailed = true;
        firstErrorCode ??= sanitizeJobErrorCode(error);
      }
    }
    if (inquiryFailed) failed += 1;
  }
  return { scanned, changed, failed, ...(firstErrorCode ? { errorCode: firstErrorCode } : {}) };
}

export async function reconcilePendingTeamPayments(now = new Date(), batchSize = 50): Promise<JobResult> {
  return reconcileClaimedTeamPayments("regular", now, batchSize);
}

export async function reconcileFinalTeamPayments(now = new Date(), batchSize = 50): Promise<JobResult> {
  return reconcileClaimedTeamPayments("final", now, batchSize);
}

export async function reconcileTerminalTeamPayments(now = new Date(), batchSize = 50): Promise<JobResult> {
  return reconcileClaimedTeamPayments("terminal", now, batchSize);
}

/** @deprecated Final expiry must include an authoritative inquiry. */
export async function expireTeamPaymentAttempts(now = new Date(), batchSize = 50): Promise<JobResult> {
  return reconcileFinalTeamPayments(now, batchSize);
}

export async function expireTeamDrafts(now = new Date(), batchSize = 100): Promise<JobResult> {
  return db.transaction(async (tx) => {
    const activeAttempt = tx.select({ id: teamRegistrationPaymentAttempts.id })
      .from(teamRegistrationPaymentAttempts)
      .where(and(
        eq(teamRegistrationPaymentAttempts.registrationId, teamRegistrations.id),
        inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
      ));
    const winningAttempt = tx.select({ id: teamRegistrationPaymentAttempts.id })
      .from(teamRegistrationPaymentAttempts)
      .where(and(
        eq(teamRegistrationPaymentAttempts.registrationId, teamRegistrations.id),
        eq(teamRegistrationPaymentAttempts.isWinner, true),
      ));
    const unresolvedAction = tx.select({ id: teamRegistrationPaymentAttempts.id })
      .from(teamRegistrationPaymentAttempts)
      .where(and(
        eq(teamRegistrationPaymentAttempts.registrationId, teamRegistrations.id),
        eq(teamRegistrationPaymentAttempts.actionRequired, true),
        isNull(teamRegistrationPaymentAttempts.actionResolvedAt),
      ));

    const rows = await tx.select({ id: teamRegistrations.id }).from(teamRegistrations)
      .where(and(
        inArray(teamRegistrations.status, ["draft", "ready_for_payment", "payment_pending"]),
        lte(teamRegistrations.draftExpiresAt, now),
        or(
          isNull(teamRegistrations.paymentReservationExpiresAt),
          lte(teamRegistrations.paymentReservationExpiresAt, now),
        ),
        notExists(activeAttempt),
        notExists(winningAttempt),
        notExists(unresolvedAction),
      ))
      .orderBy(asc(teamRegistrations.draftExpiresAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return { scanned: 0, changed: 0, failed: 0 };

    const ids = rows.map((row) => row.id);
    await tx.update(teamRegistrationEmailClaims).set({ releasedAt: now })
      .where(and(inArray(teamRegistrationEmailClaims.registrationId, ids), isNull(teamRegistrationEmailClaims.releasedAt)));
    await tx.update(teamRegistrations).set({
      status: "expired",
      expiredAt: now,
      paymentReservationExpiresAt: null,
      updatedAt: now,
    }).where(inArray(teamRegistrations.id, ids));
    return { scanned: rows.length, changed: rows.length, failed: 0 };
  });
}

export async function processTeamEmailOutbox(now = new Date(), batchSize = 100): Promise<JobResult> {
  const staleProcessingBefore = new Date(now.getTime() - TEAM_EMAIL_PROCESSING_LEASE_MS);
  const dueCondition = or(
    and(
      inArray(teamRegistrationEmailOutbox.status, ["pending", "failed"]),
      or(
        isNull(teamRegistrationEmailOutbox.nextAttemptAt),
        lte(teamRegistrationEmailOutbox.nextAttemptAt, now),
      ),
    ),
    and(
      eq(teamRegistrationEmailOutbox.status, "processing"),
      lte(teamRegistrationEmailOutbox.updatedAt, staleProcessingBefore),
    ),
  );
  const rows = await db.select().from(teamRegistrationEmailOutbox)
    .where(dueCondition)
    .limit(batchSize);
  let changed = 0;
  let failed = 0;
  let firstErrorCode: string | undefined;
  await processSequentiallyWithDelay(rows, async (row) => {
    const claimed = await db.update(teamRegistrationEmailOutbox)
      .set({ status: "processing", updatedAt: now })
      .where(and(eq(teamRegistrationEmailOutbox.id, row.id), dueCondition))
      .returning({ id: teamRegistrationEmailOutbox.id });
    if (claimed.length === 0) return;
    try {
      await sendTeamPaidConfirmationEmail(row.recipientEmail, row.payloadSnapshot as unknown as TeamPaidEmailInput);
      await db.update(teamRegistrationEmailOutbox).set({ status: "sent", sentAt: new Date(), updatedAt: new Date(), lastErrorCode: null })
        .where(eq(teamRegistrationEmailOutbox.id, row.id));
      changed += 1;
    } catch (error) {
      firstErrorCode ??= sanitizeJobErrorCode(error);
      const attemptCount = row.attemptCount + 1;
      await db.update(teamRegistrationEmailOutbox).set({
        status: "failed",
        attemptCount,
        nextAttemptAt: new Date(now.getTime() + outboxRetryDelayMinutes(attemptCount) * 60 * 1000),
        lastErrorCode: sanitizeJobErrorCode(error),
        updatedAt: new Date(),
      }).where(eq(teamRegistrationEmailOutbox.id, row.id));
      failed += 1;
    }
  });
  return { scanned: rows.length, changed, failed, ...(firstErrorCode ? { errorCode: firstErrorCode } : {}) };
}

export async function purgeTeamSensitiveData(now = new Date(), batchSize = 100): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const memberRows = await db.select({ memberId: teamRegistrationMembers.id })
    .from(teamRegistrationMembers)
    .innerJoin(teamRegistrations, eq(teamRegistrations.id, teamRegistrationMembers.registrationId))
    .innerJoin(events, eq(events.id, teamRegistrations.eventId))
    .where(and(lte(events.endDate, cutoff), isNull(teamRegistrationMembers.sensitiveDataPurgedAt)))
    .limit(batchSize);

  const paymentRows = await db.select({ paymentAttemptId: teamRegistrationPaymentAttempts.id })
    .from(teamRegistrationPaymentAttempts)
    .innerJoin(teamRegistrations, eq(teamRegistrations.id, teamRegistrationPaymentAttempts.registrationId))
    .innerJoin(events, eq(events.id, teamRegistrations.eventId))
    .where(and(
      lte(events.endDate, cutoff),
      inArray(teamRegistrationPaymentAttempts.status, [
        "paid",
        "failed",
        "expired",
        "verification_required",
        "cancelled",
        "duplicate_paid",
        "refunded",
      ]),
      or(
        eq(teamRegistrationPaymentAttempts.actionRequired, false),
        isNotNull(teamRegistrationPaymentAttempts.actionResolvedAt),
      ),
      or(
        isNotNull(teamRegistrationPaymentAttempts.customerEmailSnapshot),
        isNotNull(teamRegistrationPaymentAttempts.customerNameSnapshot),
        isNotNull(teamRegistrationPaymentAttempts.productDetailSnapshot),
      ),
    ))
    .limit(batchSize);

  if (memberRows.length > 0) {
    await db.update(teamRegistrationMembers).set({
      foodDrugAllergies: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      sensitiveDataPurgedAt: now,
      updatedAt: now,
    }).where(inArray(teamRegistrationMembers.id, memberRows.map((row) => row.memberId)));
  }
  if (paymentRows.length > 0) {
    await db.update(teamRegistrationPaymentAttempts).set({
      customerEmailSnapshot: null,
      customerNameSnapshot: null,
      productDetailSnapshot: null,
      updatedAt: now,
    }).where(inArray(teamRegistrationPaymentAttempts.id, paymentRows.map((row) => row.paymentAttemptId)));
  }
  const changed = memberRows.length + paymentRows.length;
  return { scanned: changed, changed, failed: 0 };
}

async function recordWorkerStarted(now: Date): Promise<void> {
  await db.insert(teamRegistrationJobState).values({
    jobName: TEAM_REGISTRATION_WORKER_JOB_NAME,
    lastStartedAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: teamRegistrationJobState.jobName,
    set: { lastStartedAt: now, updatedAt: now },
  });
}

export async function touchTeamRegistrationWorkerActivity(now = new Date()): Promise<void> {
  await db.insert(teamRegistrationJobState).values({
    jobName: TEAM_REGISTRATION_WORKER_JOB_NAME,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: teamRegistrationJobState.jobName,
    set: { updatedAt: now },
  });
}

async function recordWorkerSucceeded(now: Date): Promise<void> {
  await db.insert(teamRegistrationJobState).values({
    jobName: TEAM_REGISTRATION_WORKER_JOB_NAME,
    lastStartedAt: now,
    lastSucceededAt: now,
    lastErrorCode: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: teamRegistrationJobState.jobName,
    set: { lastSucceededAt: now, lastErrorCode: null, updatedAt: now },
  });
}

async function recordWorkerFailed(error: unknown, now: Date): Promise<void> {
  const errorCode = sanitizeJobErrorCode(error);
  await db.insert(teamRegistrationJobState).values({
    jobName: TEAM_REGISTRATION_WORKER_JOB_NAME,
    lastStartedAt: now,
    lastErrorCode: errorCode,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: teamRegistrationJobState.jobName,
    set: { lastErrorCode: errorCode, updatedAt: now },
  });
}

async function hasRemainingTeamRegistrationWork(now: Date): Promise<boolean> {
  const [registration, attempt, outbox, memberRetention, paymentRetention] = await Promise.all([
    db.select({ id: teamRegistrations.id }).from(teamRegistrations)
      .where(inArray(teamRegistrations.status, ["draft", "ready_for_payment", "payment_pending"]))
      .limit(1),
    db.select({ id: teamRegistrationPaymentAttempts.id }).from(teamRegistrationPaymentAttempts)
      .where(or(
        inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
        isNotNull(teamRegistrationPaymentAttempts.nextReconcileAt),
        gt(teamRegistrationPaymentAttempts.inquiryLeaseUntil, now),
        and(
          eq(teamRegistrationPaymentAttempts.actionRequired, true),
          isNull(teamRegistrationPaymentAttempts.actionResolvedAt),
        ),
      )).limit(1),
    db.select({ id: teamRegistrationEmailOutbox.id }).from(teamRegistrationEmailOutbox)
      .where(inArray(teamRegistrationEmailOutbox.status, ["pending", "processing", "failed"]))
      .limit(1),
    db.select({ id: teamRegistrationMembers.id }).from(teamRegistrationMembers)
      .where(isNull(teamRegistrationMembers.sensitiveDataPurgedAt))
      .limit(1),
    db.select({ id: teamRegistrationPaymentAttempts.id }).from(teamRegistrationPaymentAttempts)
      .where(or(
        isNotNull(teamRegistrationPaymentAttempts.customerEmailSnapshot),
        isNotNull(teamRegistrationPaymentAttempts.customerNameSnapshot),
        isNotNull(teamRegistrationPaymentAttempts.productDetailSnapshot),
      )).limit(1),
  ]);
  return registration.length > 0
    || attempt.length > 0
    || outbox.length > 0
    || memberRetention.length > 0
    || paymentRetention.length > 0;
}

export async function getTeamRegistrationWorkerHealth(now = new Date()): Promise<TeamRegistrationWorkerHealth> {
  const [[enabledConfig], remainingWork, [heartbeat]] = await Promise.all([
    db.select({ id: teamRegistrationConfigs.id }).from(teamRegistrationConfigs)
      .where(eq(teamRegistrationConfigs.isEnabled, true)).limit(1),
    hasRemainingTeamRegistrationWork(now),
    db.select().from(teamRegistrationJobState)
      .where(eq(teamRegistrationJobState.jobName, TEAM_REGISTRATION_WORKER_JOB_NAME)).limit(1),
  ]);
  const status = resolveTeamRegistrationWorkerHealth({
    hasEnabledConfig: Boolean(enabledConfig),
    hasRemainingWork: remainingWork,
    lastSucceededAt: heartbeat?.lastSucceededAt ?? null,
    lastErrorCode: heartbeat?.lastErrorCode ?? null,
    now,
  });
  return {
    status,
    lastStartedAt: heartbeat?.lastStartedAt?.toISOString() ?? null,
    lastSucceededAt: heartbeat?.lastSucceededAt?.toISOString() ?? null,
    lastErrorCode: heartbeat?.lastErrorCode ?? null,
  };
}

export async function getTeamRegistrationWorkerLiveness(now = new Date()): Promise<TeamRegistrationWorkerLiveness> {
  const [[enabledConfig], remainingWork, [heartbeat]] = await Promise.all([
    db.select({ id: teamRegistrationConfigs.id }).from(teamRegistrationConfigs)
      .where(eq(teamRegistrationConfigs.isEnabled, true)).limit(1),
    hasRemainingTeamRegistrationWork(now),
    db.select({ updatedAt: teamRegistrationJobState.updatedAt }).from(teamRegistrationJobState)
      .where(eq(teamRegistrationJobState.jobName, TEAM_REGISTRATION_WORKER_JOB_NAME)).limit(1),
  ]);
  const lastActivityAt = heartbeat?.updatedAt ?? null;
  return {
    live: isTeamRegistrationWorkerProcessLive({
      hasEnabledConfig: Boolean(enabledConfig),
      hasRemainingWork: remainingWork,
      lastActivityAt,
      now,
    }),
    lastActivityAt: lastActivityAt?.toISOString() ?? null,
  };
}

async function runTeamRegistrationJobPhases(now: Date) {
  // Snapshot terminal-due work before active/final phases so a just-expired
  // attempt cannot cause a second provider call at the same TTL boundary.
  const terminalPayments = await reconcileTerminalTeamPayments(now);
  const reconciliation = await reconcilePendingTeamPayments(now);
  const finalPayments = await reconcileFinalTeamPayments(now);
  // All final payment handling precedes registration expiry/claim release.
  const drafts = await expireTeamDrafts(now);
  const emails = await processTeamEmailOutbox(now);
  const privacy = await purgeTeamSensitiveData(now);
  return {
    terminalPayments,
    reconciliation,
    finalPayments,
    payments: finalPayments,
    drafts,
    emails,
    privacy,
  };
}

export async function runTeamRegistrationJobsOnce(now = new Date()) {
  await recordWorkerStarted(now);
  try {
    const result = await runTeamRegistrationJobPhases(now);
    const completedAt = new Date(Math.max(now.getTime(), Date.now()));
    const errorCode = firstTeamRegistrationJobErrorCode([
      result.terminalPayments,
      result.reconciliation,
      result.finalPayments,
      result.drafts,
      result.emails,
      result.privacy,
    ]);
    if (errorCode) {
      await recordWorkerFailed(
        { code: errorCode },
        completedAt,
      );
    } else {
      await recordWorkerSucceeded(completedAt);
    }
    return result;
  } catch (error) {
    try {
      await recordWorkerFailed(error, new Date(Math.max(now.getTime(), Date.now())));
    } catch {
      // Preserve the original failure; the missing/stale heartbeat remains visible.
    }
    throw error;
  }
}
