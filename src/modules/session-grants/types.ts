import type { db } from "../../database/index.js";

export type GrantDatabase = typeof db;
export type GrantTransaction = Parameters<
  Parameters<GrantDatabase["transaction"]>[0]
>[0];

export type SkipCode =
  | "REGISTRATION_NOT_FOUND"
  | "EVENT_MISMATCH"
  | "REGISTRATION_NOT_CONFIRMED"
  | "ALREADY_REGISTERED";

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
  outcome: "added" | "skipped";
  reasonCode: SkipCode | null;
  registrationSessionId: number | null;
  emailStatus: EmailStatus;
  attemptCount: number;
  lastErrorCode: string | null;
}

export interface GrantBatchDto {
  batchId: string;
  sessionId: number;
  eventId: number;
  requestedCount: number;
  addedCount: number;
  skippedCount: number;
  currentEnrollmentCount: number;
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
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "GrantError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
