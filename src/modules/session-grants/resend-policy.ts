import { effectiveInvitationStatus } from "./invitation-policy.js";
import type { ResendCandidate, ResendInput, ResendSkip } from "./resend-types.js";

export const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
export function canonicalResendInput(input: ResendInput): ResendInput {
  return { sessionId: input.sessionId, invitationIds: [...new Set(input.invitationIds.map(id => id.toLowerCase()))].sort() };
}
export function resendCooldownUntil(lastSuccessfulSentAt: Date | null, lastResendQueuedAt: Date | null): Date | null {
  const values = [lastSuccessfulSentAt, lastResendQueuedAt].filter((value): value is Date => value !== null).map(value => value.getTime());
  return values.length ? new Date(Math.max(...values) + RESEND_COOLDOWN_MS) : null;
}
export function resendDisabledReason(candidate: Pick<ResendCandidate, "invitationId" | "invitationStatus" | "expiresAt" | "sessionStartTime" | "sessionIsActive" | "registrationStatus" | "registrationEventId" | "sessionEventId" | "emailStatus" | "lastSuccessfulSentAt" | "lastResendQueuedAt">, now: Date): ResendSkip | null {
  const skip = (reasonCode: ResendSkip["reasonCode"]): ResendSkip => ({ invitationId: candidate.invitationId, reasonCode });
  const status = effectiveInvitationStatus({ status: candidate.invitationStatus,
    expiresAt: candidate.expiresAt, startTime: candidate.sessionStartTime,
    isActive: candidate.sessionIsActive, registrationConfirmed: candidate.registrationStatus === "confirmed",
    eventMatches: candidate.registrationEventId === candidate.sessionEventId }, now);
  if (status !== "pending") return skip("INVITATION_NOT_PENDING");
  if (candidate.emailStatus === "pending" || candidate.emailStatus === "sending") return skip("EMAIL_BUSY");
  if (candidate.emailStatus !== "sent") return skip("EMAIL_NOT_RESENDABLE");
  const until = resendCooldownUntil(candidate.lastSuccessfulSentAt, candidate.lastResendQueuedAt);
  if (!Number.isFinite(now.getTime()) || (until && !Number.isFinite(until.getTime()))) return skip("INVITATION_PAYLOAD_INVALID");
  if (until && now.getTime() < until.getTime()) return { ...skip("RESEND_COOLDOWN"), retryAfter: until.toISOString() };
  return null;
}
