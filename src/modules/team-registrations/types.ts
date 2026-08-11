import type { InferInsertModel } from "drizzle-orm";
import type { teamRegistrationPaymentAttempts } from "../../database/schema.js";

export type TeamRegistrationStatus =
  | "draft"
  | "ready_for_payment"
  | "payment_pending"
  | "paid"
  | "expired";

export type TeamRegistrationPaymentStatus =
  | "creating"
  | "pending"
  | "paid"
  | "failed"
  | "expired"
  | "verification_required"
  | "cancelled"
  | "duplicate_paid"
  | "refunded";

export const TEAM_PAYMENT_CANCELLATION_REASONS = [
  "superseded_by_retry",
  "registration_edited",
  "sibling_paid",
  "payment_review_required",
  "provider_cancelled",
  "migration_safety",
] as const;

export type TeamPaymentCancellationReason =
  (typeof TEAM_PAYMENT_CANCELLATION_REASONS)[number];

export const TEAM_PAYMENT_REVIEW_REASONS = [
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
] as const;

export type TeamPaymentReviewReason = (typeof TEAM_PAYMENT_REVIEW_REASONS)[number];

export const TEAM_PAYMENT_ACTION_RESOLUTIONS = [
  "refunded",
  "closed_no_fulfillment",
] as const;

export type TeamPaymentActionResolution =
  (typeof TEAM_PAYMENT_ACTION_RESOLUTIONS)[number];

type PaymentAttemptInsert = InferInsertModel<typeof teamRegistrationPaymentAttempts>;

export type NewTeamRegistrationPaymentAttempt = Omit<
  PaymentAttemptInsert,
  | "customerEmailSnapshot"
  | "customerNameSnapshot"
  | "productDetailSnapshot"
  | "formActionUrlSnapshot"
> & {
  customerEmailSnapshot: string;
  customerNameSnapshot: string;
  productDetailSnapshot: string;
  formActionUrlSnapshot: string;
};

export type TeamRegistrationEducationLevel =
  | "higher_education"
  | "upper_secondary";

export type TeamRegistrationPharmacyRule = "required" | "forbidden";

export interface VerifiedTeamAccess {
  eventId: number;
  leaderEmailNormalized: string;
  sessionId: string;
}

export interface ReadyRegistration {
  registrationId: string;
  eventId: number;
  configId: number;
  categoryId: number;
  categoryCode: string;
  categoryName: string;
  registrationCode: string;
  teamName: string;
  leaderEmail: string;
  leaderName: string;
}

export interface TeamPaymentStatusResponse {
  registrationId: string;
  registrationStatus: TeamRegistrationStatus;
  paymentStatus: Exclude<TeamRegistrationPaymentStatus, "creating"> | null;
  referenceNo: string | null;
  amount: string | null;
  currency: "THB" | null;
  paidAt: string | null;
  refundedAt: string | null;
  canRetry: boolean;
  requiresAction: boolean;
  unresolvedActionCount: number;
  reviewReason: TeamPaymentReviewReason | null;
  winnerPaymentAttemptId: string | null;
  latestPaymentAttemptId: string | null;
}
