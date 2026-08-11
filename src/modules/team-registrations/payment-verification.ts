import {
  classifyTeamProviderStatus,
  type TeamProviderStatusOptions,
} from "./payment-state.js";

export interface VerificationAttemptSnapshot {
  referenceNo: string;
  merchantId: string;
  amount: string;
  currency: "THB";
}

export interface VerificationInquirySnapshot {
  referenceNo: string;
  merchantId: string;
  total: string;
  currencyCode: string;
  status: string;
  statusName: string;
}

function normalizedMoney(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "invalid";
}

export function getTeamPaymentClassifierOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TeamProviderStatusOptions {
  const nodeEnv = environment.NODE_ENV?.trim().toLowerCase() || undefined;
  const requested = environment.TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES?.trim().toLowerCase() === "true";
  return {
    nodeEnv,
    allowTestStatuses: nodeEnv !== "production" && requested,
  };
}

export function compareTeamPaymentInquiry(
  attempt: VerificationAttemptSnapshot,
  inquiry: VerificationInquirySnapshot,
  classifierOptions: TeamProviderStatusOptions = getTeamPaymentClassifierOptions(),
) {
  const referenceMatches = inquiry.referenceNo === attempt.referenceNo;
  const merchantMatches = inquiry.merchantId === attempt.merchantId
    || inquiry.merchantId === attempt.merchantId.replace(/\D/g, "").slice(-5);
  const amountMatches = normalizedMoney(inquiry.total) === normalizedMoney(attempt.amount);
  const currencyMatches = inquiry.currencyCode.trim().toUpperCase() === "00"
    || inquiry.currencyCode.trim().toUpperCase() === attempt.currency;
  const isPaid = classifyTeamProviderStatus(inquiry, classifierOptions) === "paid";
  return {
    referenceMatches,
    merchantMatches,
    amountMatches,
    currencyMatches,
    isPaid,
    verified: referenceMatches && merchantMatches && amountMatches && currencyMatches && isPaid,
  };
}
