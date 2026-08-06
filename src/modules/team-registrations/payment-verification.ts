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

function isPaidStatus(status: string, statusName: string): boolean {
  const values = [status, statusName].map((value) => value.trim().toUpperCase());
  return values.some((value) => ["CP", "Y", "TC", "COMPLETE", "COMPLETED", "PAID", "TEST COMPLETE", "TEST COMPLETED"].includes(value));
}

export function compareTeamPaymentInquiry(
  attempt: VerificationAttemptSnapshot,
  inquiry: VerificationInquirySnapshot,
) {
  const referenceMatches = inquiry.referenceNo === attempt.referenceNo;
  const merchantMatches = inquiry.merchantId === attempt.merchantId
    || inquiry.merchantId === attempt.merchantId.replace(/\D/g, "").slice(-5);
  const amountMatches = normalizedMoney(inquiry.total) === normalizedMoney(attempt.amount);
  const currencyMatches = inquiry.currencyCode.trim().toUpperCase() === "00"
    || inquiry.currencyCode.trim().toUpperCase() === attempt.currency;
  const isPaid = isPaidStatus(inquiry.status, inquiry.statusName);
  return {
    referenceMatches,
    merchantMatches,
    amountMatches,
    currencyMatches,
    isPaid,
    verified: referenceMatches && merchantMatches && amountMatches && currencyMatches && isPaid,
  };
}
