export type ReconciliationCandidate = {
  status: string;
  expiresAt: Date;
  lastInquiredAt: Date | null;
};

export function isPaymentDueForReconciliation(
  attempt: ReconciliationCandidate,
  now = new Date(),
  minimumIntervalMinutes = 5,
): boolean {
  if (attempt.status !== "pending" || attempt.expiresAt <= now) return false;
  return attempt.lastInquiredAt === null
    || attempt.lastInquiredAt <= new Date(now.getTime() - minimumIntervalMinutes * 60 * 1000);
}
