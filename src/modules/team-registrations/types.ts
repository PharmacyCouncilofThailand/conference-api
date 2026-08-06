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
  | "verification_required";

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
}
