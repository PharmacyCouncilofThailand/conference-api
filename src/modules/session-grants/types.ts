import type { db } from "../../database/index.js";

export type GrantDatabase = typeof db;
export type GrantTransaction = Parameters<
  Parameters<GrantDatabase["transaction"]>[0]
>[0];

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "revoked";
export type InvitationDecision = "accepted" | "declined";
export type GrantOutcome = "added" | "invited" | "skipped";

export interface TokenEnvelope {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface InvitationMetadata {
  invitationId: string;
  invitationStatus: InvitationStatus;
  expiresAt: string;
  effectiveDeadline: string;
  respondedAt: string | null;
}

export interface InvitationCapacity {
  currentEnrollmentCount: number;
  reservedCount: number;
  occupiedCount: number;
  seatsRemaining: number;
}

export interface PublicInvitationDto {
  invitationId: string;
  status: InvitationStatus;
  respondedAt: string | null;
  effectiveDeadline: string;
  recipientFirstName: string | null;
  session: {
    sessionName: string;
    sessionType: string | null;
    startTime: string;
    endTime: string;
    room: string | null;
  };
}

export interface InvitationErrorDto {
  error: string;
  code: string;
  invitation?: PublicInvitationDto;
  capacity?: InvitationCapacity;
}

export type SkipCode =
  | "REGISTRATION_NOT_FOUND"
  | "EVENT_MISMATCH"
  | "REGISTRATION_NOT_CONFIRMED"
  | "ALREADY_REGISTERED"
  | "ALREADY_INVITED"
  | "DUPLICATE_PARTICIPANT";

export type EmailStatus =
  | "not_applicable"
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "suppressed";

export type SessionBlockCode = "SESSION_INACTIVE" | "SESSION_ENDED";

export interface GrantInput {
  actorId: number;
  idempotencyKey: string;
  sessionId: number;
  registrationIds: number[];
}

export interface GrantItemDto {
  id: string;
  registrationId: number;
  regCode: string | null;
  name: string | null;
  outcome: GrantOutcome;
  reasonCode: SkipCode | null;
  registrationSessionId: number | null;
  emailStatus: EmailStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  invitation: InvitationMetadata | null;
}

export interface GrantBatchDto {
  batchId: string;
  sessionId: number;
  eventId: number;
  requestedCount: number;
  addedCount: number;
  invitedCount: number;
  skippedCount: number;
  currentEnrollmentCount: number;
  reservedCount: number;
  occupiedCount: number;
  seatsRemaining: number | null;
  createdAt: string;
  results: GrantItemDto[];
  emailCounts: Record<EmailStatus, number>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AdminGrantedSessionDto {
  registrationId: number;
  sessionId: number;
  sessionName: string;
  sessionType: string | null;
  startTime: string;
  endTime: string;
  room: string | null;
  grantedAt: string;
  source: "admin_grant";
}

export class GrantError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: {
      invitation?: PublicInvitationDto;
      capacity?: InvitationCapacity;
    },
  ) {
    super(message);
    this.name = "GrantError";
  }
}
