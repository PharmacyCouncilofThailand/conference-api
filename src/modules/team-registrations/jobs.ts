import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  events,
  teamRegistrationEmailClaims,
  teamRegistrationEmailOutbox,
  teamRegistrationMembers,
  teamRegistrationPaymentAttempts,
  teamRegistrations,
} from "../../database/schema.js";
import { sendTeamPaidConfirmationEmail, type TeamPaidEmailInput } from "./paid-email.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import { reconcileTeamPaymentAttempt } from "./payment-verification.service.js";
import { isPaymentDueForReconciliation } from "./jobs-policy.js";
import { processSequentiallyWithDelay } from "./email-outbox.js";

export interface JobResult { scanned: number; changed: number; failed: number }

export function outboxRetryDelayMinutes(attemptCount: number): number {
  return [1, 5, 30, 120, 720][Math.min(Math.max(attemptCount - 1, 0), 4)];
}

export async function expireTeamDrafts(now = new Date(), batchSize = 100): Promise<JobResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: teamRegistrations.id }).from(teamRegistrations)
      .where(and(inArray(teamRegistrations.status, ["draft", "ready_for_payment", "payment_pending"]), lte(teamRegistrations.draftExpiresAt, now)))
      .limit(batchSize).for("update", { skipLocked: true });
    if (rows.length === 0) return { scanned: 0, changed: 0, failed: 0 };
    const ids = rows.map((row) => row.id);
    await tx.update(teamRegistrationEmailClaims).set({ releasedAt: now })
      .where(and(inArray(teamRegistrationEmailClaims.registrationId, ids), isNull(teamRegistrationEmailClaims.releasedAt)));
    await tx.update(teamRegistrations).set({ status: "expired", expiredAt: now, updatedAt: now })
      .where(inArray(teamRegistrations.id, ids));
    return { scanned: rows.length, changed: rows.length, failed: 0 };
  });
}

export async function expireTeamPaymentAttempts(now = new Date(), batchSize = 100): Promise<JobResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(teamRegistrationPaymentAttempts)
      .where(and(inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]), lte(teamRegistrationPaymentAttempts.expiresAt, now)))
      .limit(batchSize).for("update", { skipLocked: true });
    for (const attempt of rows) {
      await tx.update(teamRegistrationPaymentAttempts).set({ status: "expired", updatedAt: now })
        .where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
      await tx.update(teamRegistrations).set({ status: "ready_for_payment", updatedAt: now })
        .where(and(eq(teamRegistrations.id, attempt.registrationId), eq(teamRegistrations.status, "payment_pending")));
    }
    return { scanned: rows.length, changed: rows.length, failed: 0 };
  });
}

export async function reconcilePendingTeamPayments(now = new Date(), batchSize = 50): Promise<JobResult> {
  const inquiryCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const rows = await db.select().from(teamRegistrationPaymentAttempts)
    .where(and(
      eq(teamRegistrationPaymentAttempts.status, "pending"),
      gt(teamRegistrationPaymentAttempts.expiresAt, now),
      or(
        isNull(teamRegistrationPaymentAttempts.lastInquiredAt),
        lte(teamRegistrationPaymentAttempts.lastInquiredAt, inquiryCutoff),
      ),
    ))
    .limit(batchSize);
  if (rows.length === 0) return { scanned: 0, changed: 0, failed: 0 };

  const client = createTeamPaySolutionsClient(getTeamPaySolutionsConfig());
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    if (!isPaymentDueForReconciliation(row, now)) continue;
    try {
      const result = await reconcileTeamPaymentAttempt(row.id, client);
      if (result.paymentStatus === "paid") changed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, changed, failed };
}

export async function processTeamEmailOutbox(now = new Date(), batchSize = 100): Promise<JobResult> {
  const rows = await db.select().from(teamRegistrationEmailOutbox)
    .where(and(
      inArray(teamRegistrationEmailOutbox.status, ["pending", "failed"]),
      or(isNull(teamRegistrationEmailOutbox.nextAttemptAt), lte(teamRegistrationEmailOutbox.nextAttemptAt, now)),
    ))
    .limit(batchSize);
  let changed = 0;
  let failed = 0;
  await processSequentiallyWithDelay(rows, async (row) => {
    const claimed = await db.update(teamRegistrationEmailOutbox)
      .set({ status: "processing", updatedAt: now })
      .where(and(eq(teamRegistrationEmailOutbox.id, row.id), inArray(teamRegistrationEmailOutbox.status, ["pending", "failed"])))
      .returning({ id: teamRegistrationEmailOutbox.id });
    if (claimed.length === 0) return;
    try {
      await sendTeamPaidConfirmationEmail(row.recipientEmail, row.payloadSnapshot as unknown as TeamPaidEmailInput);
      await db.update(teamRegistrationEmailOutbox).set({ status: "sent", sentAt: new Date(), updatedAt: new Date(), lastErrorCode: null })
        .where(eq(teamRegistrationEmailOutbox.id, row.id));
      changed += 1;
    } catch (error) {
      const attemptCount = row.attemptCount + 1;
      await db.update(teamRegistrationEmailOutbox).set({
        status: "failed",
        attemptCount,
        nextAttemptAt: new Date(now.getTime() + outboxRetryDelayMinutes(attemptCount) * 60 * 1000),
        lastErrorCode: error instanceof Error ? error.name.slice(0, 100) : "EMAIL_ERROR",
        updatedAt: new Date(),
      }).where(eq(teamRegistrationEmailOutbox.id, row.id));
      failed += 1;
    }
  });
  return { scanned: rows.length, changed, failed };
}

export async function purgeTeamSensitiveData(now = new Date(), batchSize = 100): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const rows = await db.select({ memberId: teamRegistrationMembers.id })
    .from(teamRegistrationMembers)
    .innerJoin(teamRegistrations, eq(teamRegistrations.id, teamRegistrationMembers.registrationId))
    .innerJoin(events, eq(events.id, teamRegistrations.eventId))
    .where(and(lte(events.endDate, cutoff), isNull(teamRegistrationMembers.sensitiveDataPurgedAt)))
    .limit(batchSize);
  if (rows.length === 0) return { scanned: 0, changed: 0, failed: 0 };
  await db.update(teamRegistrationMembers).set({
    foodDrugAllergies: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    sensitiveDataPurgedAt: now,
    updatedAt: now,
  }).where(inArray(teamRegistrationMembers.id, rows.map((row) => row.memberId)));
  return { scanned: rows.length, changed: rows.length, failed: 0 };
}

export async function runTeamRegistrationJobsOnce(now = new Date()) {
  return {
    drafts: await expireTeamDrafts(now),
    reconciliation: await reconcilePendingTeamPayments(now),
    payments: await expireTeamPaymentAttempts(now),
    emails: await processTeamEmailOutbox(now),
    privacy: await purgeTeamSensitiveData(now),
  };
}
