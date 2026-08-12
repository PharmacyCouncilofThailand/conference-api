export const PAYMENT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
export const PAYMENT_INQUIRY_LEASE_MS = 30 * 1000;
export const TERMINAL_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TEAM_REGISTRATION_WORKER_STALE_MS = 3 * 60 * 1000;
export const TEAM_REGISTRATION_WORKER_PULSE_MS = 30 * 1000;
export const TEAM_EMAIL_PROCESSING_LEASE_MS = 15 * 60 * 1000;
export const TEAM_REGISTRATION_JOB_PHASES = [
  "terminalPayments",
  "reconciliation",
  "finalPayments",
  "drafts",
  "emails",
  "privacy",
] as const;

export type ActivePaymentStatus = "creating" | "pending";
export type TerminalReconciliationStatus = "cancelled" | "failed" | "expired";
export type PaymentReconciliationPhase = "regular" | "final" | "terminal";
export type TeamRegistrationWorkerStatus = "disabled" | "healthy" | "stale";

export function isTeamEmailOutboxDue(
  row: { status: string; nextAttemptAt: Date | null; updatedAt: Date },
  now: Date,
): boolean {
  if ((row.status === "pending" || row.status === "failed")
    && (row.nextAttemptAt === null || row.nextAttemptAt <= now)) {
    return true;
  }
  return row.status === "processing"
    && row.updatedAt.getTime() <= now.getTime() - TEAM_EMAIL_PROCESSING_LEASE_MS;
}

export type PaymentReconciliationCandidate = {
  status: string;
  expiresAt: Date;
  nextReconcileAt: Date | null;
  inquiryLeaseUntil: Date | null;
};

export type TerminalSchedule = {
  terminalReconciliationCount: number;
  reconciliationDeadlineAt: Date;
  nextReconcileAt: Date | null;
  inquiryLeaseUntil: null;
};

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

export function initializeActiveReconciliationSchedule(now: Date, expiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + PAYMENT_RECONCILIATION_INTERVAL_MS, expiresAt.getTime()));
}

export function initializeTerminalSchedule(
  status: TerminalReconciliationStatus,
  baseTime: Date,
  now: Date,
): TerminalSchedule {
  // Keeping the status in the signature prevents callers from accidentally using
  // this schedule for paid/review states, whose provider facts are monotonic.
  if (!(["cancelled", "failed", "expired"] as const).includes(status)) {
    throw new TypeError(`Cannot initialize a terminal reconciliation schedule for ${String(status)}`);
  }
  return {
    terminalReconciliationCount: 0,
    reconciliationDeadlineAt: new Date(baseTime.getTime() + TERMINAL_RECONCILIATION_WINDOW_MS),
    nextReconcileAt: copyDate(now),
    inquiryLeaseUntil: null,
  };
}

export function advanceTerminalSchedule(
  current: Pick<TerminalSchedule, "terminalReconciliationCount" | "reconciliationDeadlineAt">,
  completedAt: Date,
): TerminalSchedule {
  const deadlineAt = copyDate(current.reconciliationDeadlineAt);
  const count = Math.min(Math.max(current.terminalReconciliationCount, 0), 4);

  if (count >= 4 || completedAt >= deadlineAt) {
    return {
      terminalReconciliationCount: 4,
      reconciliationDeadlineAt: deadlineAt,
      nextReconcileAt: null,
      inquiryLeaseUntil: null,
    };
  }

  const baseTime = deadlineAt.getTime() - TERMINAL_RECONCILIATION_WINDOW_MS;
  const completedCount = count + 1;
  const nextOffset = completedCount === 1
    ? 15 * 60 * 1000
    : completedCount === 2
      ? 2 * 60 * 60 * 1000
      : TERMINAL_RECONCILIATION_WINDOW_MS;

  return {
    terminalReconciliationCount: completedCount,
    reconciliationDeadlineAt: deadlineAt,
    nextReconcileAt: completedCount >= 4 ? null : new Date(baseTime + nextOffset),
    inquiryLeaseUntil: null,
  };
}

export function isPaymentInquiryLeaseAvailable(
  inquiryLeaseUntil: Date | null,
  now: Date,
): boolean {
  return inquiryLeaseUntil === null || inquiryLeaseUntil <= now;
}

export function classifyPaymentReconciliationCandidate(
  attempt: PaymentReconciliationCandidate,
  now: Date,
): PaymentReconciliationPhase | null {
  if (!isPaymentInquiryLeaseAvailable(attempt.inquiryLeaseUntil, now)) return null;

  if (
    attempt.status === "pending"
    && attempt.nextReconcileAt !== null
    && attempt.nextReconcileAt <= now
    && attempt.expiresAt > now
  ) {
    return "regular";
  }

  if (
    (attempt.status === "creating" || attempt.status === "pending")
    && attempt.expiresAt <= now
  ) {
    return "final";
  }

  if (
    (attempt.status === "cancelled" || attempt.status === "failed" || attempt.status === "expired")
    && attempt.nextReconcileAt !== null
    && attempt.nextReconcileAt <= now
  ) {
    return "terminal";
  }

  return null;
}

export function reconciliationPhaseAfterCompletion(
  claimedPhase: PaymentReconciliationPhase,
  expiresAt: Date,
  completedAt: Date,
): PaymentReconciliationPhase {
  return claimedPhase === "regular" && completedAt >= expiresAt ? "final" : claimedPhase;
}

/**
 * Backwards-compatible adapter for callers that have not yet persisted
 * nextReconcileAt. New worker selectors use classifyPaymentReconciliationCandidate.
 */
export function isPaymentDueForReconciliation(
  attempt: {
    status: string;
    expiresAt: Date;
    nextReconcileAt?: Date | null;
    inquiryLeaseUntil?: Date | null;
    lastInquiredAt?: Date | null;
  },
  now = new Date(),
  minimumIntervalMinutes = 5,
): boolean {
  const nextReconcileAt = attempt.nextReconcileAt !== undefined
    ? attempt.nextReconcileAt
    : attempt.lastInquiredAt === null || attempt.lastInquiredAt === undefined
      ? now
      : new Date(attempt.lastInquiredAt.getTime() + minimumIntervalMinutes * 60 * 1000);
  return classifyPaymentReconciliationCandidate({
    status: attempt.status,
    expiresAt: attempt.expiresAt,
    nextReconcileAt,
    inquiryLeaseUntil: attempt.inquiryLeaseUntil ?? null,
  }, now) === "regular";
}

export function sanitizeJobErrorCode(error: unknown): string {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : error instanceof Error
      ? error.name
      : "UNKNOWN_ERROR";
  const sanitized = candidate.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (sanitized || "UNKNOWN_ERROR").slice(0, 100);
}

export function hasTeamRegistrationJobFailures(
  results: readonly { failed: number }[],
): boolean {
  return results.some((result) => Number.isFinite(result.failed) && result.failed > 0);
}

export function firstTeamRegistrationJobErrorCode(
  results: readonly { failed: number; errorCode?: string | null }[],
): string | null {
  for (const result of results) {
    if (result.failed > 0 && result.errorCode) return sanitizeJobErrorCode({ code: result.errorCode });
  }
  return hasTeamRegistrationJobFailures(results)
    ? "TEAM_REGISTRATION_JOB_PARTIAL_FAILURE"
    : null;
}

export function resolveTeamRegistrationWorkerHealth(input: {
  hasEnabledConfig: boolean;
  hasRemainingWork: boolean;
  lastSucceededAt: Date | null;
  lastErrorCode: string | null;
  now: Date;
}): TeamRegistrationWorkerStatus {
  if (!input.hasEnabledConfig && !input.hasRemainingWork) return "disabled";
  if (input.lastSucceededAt === null || input.lastErrorCode !== null) return "stale";
  return input.lastSucceededAt.getTime() >= input.now.getTime() - TEAM_REGISTRATION_WORKER_STALE_MS
    ? "healthy"
    : "stale";
}

/**
 * Container/process liveness is intentionally independent from operational job
 * success. Provider or email failures remain visible through the external worker
 * health status, while a runner that is still processing a long batch keeps its
 * activity pulse fresh.
 */
export function isTeamRegistrationWorkerProcessLive(input: {
  hasEnabledConfig: boolean;
  hasRemainingWork: boolean;
  lastActivityAt: Date | null;
  now: Date;
}): boolean {
  if (!input.hasEnabledConfig && !input.hasRemainingWork) return true;
  if (input.lastActivityAt === null || !Number.isFinite(input.lastActivityAt.getTime())) return false;
  return input.lastActivityAt.getTime() >= input.now.getTime() - TEAM_REGISTRATION_WORKER_STALE_MS;
}
