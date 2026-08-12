import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTerminalSchedule,
  classifyPaymentReconciliationCandidate,
  firstTeamRegistrationJobErrorCode,
  hasTeamRegistrationJobFailures,
  initializeActiveReconciliationSchedule,
  initializeTerminalSchedule,
  isTeamEmailOutboxDue,
  isPaymentInquiryLeaseAvailable,
  isTeamRegistrationWorkerProcessLive,
  reconciliationPhaseAfterCompletion,
  resolveTeamRegistrationWorkerHealth,
  sanitizeJobErrorCode,
  TEAM_REGISTRATION_JOB_PHASES,
} from "./jobs-policy.js";

const base = new Date("2026-08-20T00:00:00.000Z");
const minute = 60 * 1000;
const hour = 60 * minute;

function candidate(overrides: Partial<Parameters<typeof classifyPaymentReconciliationCandidate>[0]> = {}) {
  return {
    status: "pending",
    expiresAt: new Date(base.getTime() + 30 * minute),
    nextReconcileAt: base,
    inquiryLeaseUntil: null,
    ...overrides,
  };
}

test("initial active scheduling is five minutes but never later than TTL", () => {
  assert.deepEqual(initializeActiveReconciliationSchedule(base, new Date(base.getTime() + 30 * minute)), new Date(base.getTime() + 5 * minute));
  assert.deepEqual(initializeActiveReconciliationSchedule(base, new Date(base.getTime() + 2 * minute)), new Date(base.getTime() + 2 * minute));
});

test("job ordering snapshots prior terminal work and always final-inquires before claim release", () => {
  assert.deepEqual(TEAM_REGISTRATION_JOB_PHASES, [
    "terminalPayments",
    "reconciliation",
    "finalPayments",
    "drafts",
    "emails",
    "privacy",
  ]);
});

test("regular, final, and terminal selectors are disjoint at the TTL boundary", () => {
  assert.equal(classifyPaymentReconciliationCandidate(candidate(), base), "regular");
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ expiresAt: base }), base), "final");
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ status: "creating", expiresAt: base, nextReconcileAt: null }), base), "final");
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ status: "cancelled", expiresAt: base, nextReconcileAt: base }), base), "terminal");
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ status: "paid" }), base), null);
});

test("regular selector requires its explicit schedule and strictly pre-TTL time", () => {
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ nextReconcileAt: null }), base), null);
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ nextReconcileAt: new Date(base.getTime() + 1) }), base), null);
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ expiresAt: new Date(base.getTime() + 1) }), base), "regular");
});

test("lease excludes a candidate until its exact recovery boundary", () => {
  const lease = new Date(base.getTime() + 30_000);
  assert.equal(isPaymentInquiryLeaseAvailable(lease, new Date(lease.getTime() - 1)), false);
  assert.equal(isPaymentInquiryLeaseAvailable(lease, lease), true);
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ inquiryLeaseUntil: lease }), base), null);
  assert.equal(classifyPaymentReconciliationCandidate(candidate({ inquiryLeaseUntil: lease }), lease), "regular");
});

test("a regular inquiry completing at or beyond TTL becomes final", () => {
  const expiresAt = new Date(base.getTime() + 5 * minute);
  assert.equal(reconciliationPhaseAfterCompletion("regular", expiresAt, new Date(expiresAt.getTime() - 1)), "regular");
  assert.equal(reconciliationPhaseAfterCompletion("regular", expiresAt, expiresAt), "final");
  assert.equal(reconciliationPhaseAfterCompletion("terminal", expiresAt, expiresAt), "terminal");
});

test("terminal initializer uses immediate due time and an absolute 24-hour deadline", () => {
  const now = new Date(base.getTime() + minute);
  for (const status of ["cancelled", "failed", "expired"] as const) {
    assert.deepEqual(initializeTerminalSchedule(status, base, now), {
      terminalReconciliationCount: 0,
      reconciliationDeadlineAt: new Date(base.getTime() + 24 * hour),
      nextReconcileAt: now,
      inquiryLeaseUntil: null,
    });
  }
});

test("terminal checks advance through immediate, 15m, 2h, and 24h", () => {
  const deadline = new Date(base.getTime() + 24 * hour);
  const one = advanceTerminalSchedule({ terminalReconciliationCount: 0, reconciliationDeadlineAt: deadline }, base);
  assert.equal(one.terminalReconciliationCount, 1);
  assert.deepEqual(one.nextReconcileAt, new Date(base.getTime() + 15 * minute));
  const two = advanceTerminalSchedule(one, new Date(base.getTime() + 15 * minute));
  assert.equal(two.terminalReconciliationCount, 2);
  assert.deepEqual(two.nextReconcileAt, new Date(base.getTime() + 2 * hour));
  const three = advanceTerminalSchedule(two, new Date(base.getTime() + 2 * hour));
  assert.equal(three.terminalReconciliationCount, 3);
  assert.deepEqual(three.nextReconcileAt, deadline);
  const four = advanceTerminalSchedule(three, deadline);
  assert.equal(four.terminalReconciliationCount, 4);
  assert.equal(four.nextReconcileAt, null);
  assert.equal(four.inquiryLeaseUntil, null);
});

test("an overdue terminal check stops at its deadline without rapid catch-up inquiries", () => {
  const deadline = new Date(base.getTime() + 24 * hour);
  const result = advanceTerminalSchedule({ terminalReconciliationCount: 0, reconciliationDeadlineAt: deadline }, deadline);
  assert.equal(result.terminalReconciliationCount, 4);
  assert.equal(result.nextReconcileAt, null);
});

test("worker health is disabled only without config and without remaining work", () => {
  assert.equal(resolveTeamRegistrationWorkerHealth({ hasEnabledConfig: false, hasRemainingWork: false, lastSucceededAt: null, lastErrorCode: null, now: base }), "disabled");
  assert.equal(resolveTeamRegistrationWorkerHealth({ hasEnabledConfig: false, hasRemainingWork: true, lastSucceededAt: base, lastErrorCode: null, now: base }), "healthy");
  assert.equal(resolveTeamRegistrationWorkerHealth({ hasEnabledConfig: true, hasRemainingWork: false, lastSucceededAt: null, lastErrorCode: null, now: base }), "stale");
});

test("worker heartbeat is healthy through three minutes and stale after or on an error", () => {
  const lastSucceededAt = new Date(base.getTime() - 3 * minute);
  assert.equal(resolveTeamRegistrationWorkerHealth({ hasEnabledConfig: true, hasRemainingWork: false, lastSucceededAt, lastErrorCode: null, now: base }), "healthy");
  assert.equal(resolveTeamRegistrationWorkerHealth({ hasEnabledConfig: true, hasRemainingWork: false, lastSucceededAt: new Date(lastSucceededAt.getTime() - 1), lastErrorCode: null, now: base }), "stale");
  assert.equal(resolveTeamRegistrationWorkerHealth({ hasEnabledConfig: true, hasRemainingWork: false, lastSucceededAt: base, lastErrorCode: "PROVIDER_ERROR", now: base }), "stale");
});

test("worker process liveness uses activity and ignores operational job errors", () => {
  const exactBoundary = new Date(base.getTime() - 3 * minute);
  assert.equal(isTeamRegistrationWorkerProcessLive({
    hasEnabledConfig: false,
    hasRemainingWork: false,
    lastActivityAt: null,
    now: base,
  }), true);
  assert.equal(isTeamRegistrationWorkerProcessLive({
    hasEnabledConfig: true,
    hasRemainingWork: false,
    lastActivityAt: null,
    now: base,
  }), false);
  assert.equal(isTeamRegistrationWorkerProcessLive({
    hasEnabledConfig: true,
    hasRemainingWork: false,
    lastActivityAt: exactBoundary,
    now: base,
  }), true);
  assert.equal(isTeamRegistrationWorkerProcessLive({
    hasEnabledConfig: false,
    hasRemainingWork: true,
    lastActivityAt: new Date(exactBoundary.getTime() - 1),
    now: base,
  }), false);

  // Operational failure remains externally stale, while the recent process
  // activity used by the container healthcheck stays live.
  assert.equal(resolveTeamRegistrationWorkerHealth({
    hasEnabledConfig: true,
    hasRemainingWork: false,
    lastSucceededAt: base,
    lastErrorCode: "PAYMENT_PROVIDER_UNAVAILABLE",
    now: base,
  }), "stale");
  assert.equal(isTeamRegistrationWorkerProcessLive({
    hasEnabledConfig: true,
    hasRemainingWork: false,
    lastActivityAt: base,
    now: base,
  }), true);
});

test("heartbeat error sanitizer stores codes rather than messages", () => {
  assert.equal(sanitizeJobErrorCode(Object.assign(new Error("contains a secret"), { code: " provider-timeout " })), "PROVIDER_TIMEOUT");
  assert.equal(sanitizeJobErrorCode(new Error("contains a secret")), "ERROR");
  assert.equal(sanitizeJobErrorCode("raw secret"), "UNKNOWN_ERROR");
});

test("partial phase failures keep the worker heartbeat in an error state", () => {
  assert.equal(hasTeamRegistrationJobFailures([{ failed: 0 }, { failed: 0 }]), false);
  assert.equal(hasTeamRegistrationJobFailures([{ failed: 0 }, { failed: 1 }]), true);
  assert.equal(firstTeamRegistrationJobErrorCode([{ failed: 0 }, { failed: 1 }]), "TEAM_REGISTRATION_JOB_PARTIAL_FAILURE");
  assert.equal(firstTeamRegistrationJobErrorCode([
    { failed: 1, errorCode: " payment-profile-mismatch " },
    { failed: 1, errorCode: "LATER_ERROR" },
  ]), "PAYMENT_PROFILE_MISMATCH");
});

test("email outbox recovers processing rows only after the lease boundary", () => {
  const leaseBoundary = new Date(base.getTime() - 15 * minute);
  assert.equal(isTeamEmailOutboxDue({ status: "processing", nextAttemptAt: null, updatedAt: new Date(leaseBoundary.getTime() + 1) }, base), false);
  assert.equal(isTeamEmailOutboxDue({ status: "processing", nextAttemptAt: null, updatedAt: leaseBoundary }, base), true);
  assert.equal(isTeamEmailOutboxDue({ status: "failed", nextAttemptAt: base, updatedAt: base }, base), true);
});
