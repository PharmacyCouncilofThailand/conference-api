import type { InvitationStatus } from "./types.js";

export interface InvitationPolicyInput {
  status: InvitationStatus;
  expiresAt: Date;
  startTime: Date;
  isActive: boolean;
  registrationConfirmed: boolean;
  eventMatches: boolean;
}

export function effectiveDeadline(
  expiresAt: Date,
  currentStartTime: Date,
): Date {
  return new Date(Math.min(expiresAt.getTime(), currentStartTime.getTime()));
}

export function effectiveInvitationStatus(
  input: InvitationPolicyInput,
  now: Date,
): InvitationStatus {
  if (input.status !== "pending") return input.status;
  if (!input.isActive || !input.registrationConfirmed || !input.eventMatches) {
    return "revoked";
  }
  const deadline = effectiveDeadline(input.expiresAt, input.startTime).getTime();
  return !Number.isFinite(deadline) || now.getTime() >= deadline
    ? "expired"
    : "pending";
}

export function participantKey(row: {
  id: number;
  userId: number | null;
}): string {
  return row.userId === null ? `registration:${row.id}` : `user:${row.userId}`;
}
