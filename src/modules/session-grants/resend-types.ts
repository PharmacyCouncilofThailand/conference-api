import type { InvitationNotificationSnapshot } from "./email-template.js";
import type { EmailStatus, InvitationStatus, TokenEnvelope } from "./types.js";

export interface ResendInput { sessionId: number; invitationIds: string[] }
export type ResendSkipCode = "INVITATION_NOT_FOUND" | "INVITATION_NOT_PENDING"
  | "EMAIL_BUSY" | "EMAIL_NOT_RESENDABLE" | "RESEND_COOLDOWN" | "INVITATION_PAYLOAD_INVALID";
export interface ResendSkip { invitationId: string; reasonCode: ResendSkipCode; retryAfter?: string }
export interface ResendQueued { invitationId: string; itemId: string }
export interface ResendResult {
  requestId: string; sessionId: number; requestedCount: number;
  queued: ResendQueued[]; skipped: ResendSkip[];
}
export interface ResendPreviewDto {
  emails: { invitationId: string; registrationId: number; name: string; recipient: string; subject: string; html: string }[];
  skipped: ResendSkip[];
}
export type ResendDeliveryState = "waiting" | "sending" | "sent" | "failed" | "unknown" | "suppressed";
export interface ResendOperationEntry extends ResendQueued {
  batchId: string; recipient: string | null; name: string | null;
  state: ResendDeliveryState; attemptNo: number | null; finishedAt: string | null; errorCode: string | null;
}
export interface ResendOperationDto {
  result: ResendResult; actorId: number; createdAt: string;
  entries: ResendOperationEntry[];
  summary: Record<ResendDeliveryState, number>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
export interface ResendCandidate {
  invitationId: string; itemId: string; registrationId: number; sessionId: number;
  invitationStatus: InvitationStatus; expiresAt: Date; tokenHash: string;
  tokenCiphertext: TokenEnvelope | null;
  emailStatus: EmailStatus; recipientEmail: string | null; name: string | null;
  notificationSnapshot: InvitationNotificationSnapshot | null;
  registrationStatus: string; registrationEventId: number;
  sessionEventId: number; sessionIsActive: boolean;
  sessionName: string; sessionType: string | null; sessionStartTime: Date; sessionEndTime: Date; room: string | null;
  eventName: string; eventStartDate: Date; eventEndDate: Date; eventLocation: string | null;
  lastSuccessfulSentAt: Date | null; lastResendQueuedAt: Date | null;
}
