import { desc, eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  events,
  teamRegistrationEmailOutbox,
  teamRegistrationMembers,
  teamRegistrationPaymentAttempts,
  teamRegistrationPaymentEvents,
  teamRegistrations,
} from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import type { TeamPaySolutionsClient, TeamPaySolutionsInquiry } from "./paysolutions.client.js";
import type { TeamPaymentStatusResponse } from "./types.js";
import { compareTeamPaymentInquiry } from "./payment-verification.js";

function redactInquiry(inquiry: TeamPaySolutionsInquiry): Record<string, unknown> {
  return {
    referenceNo: inquiry.referenceNo,
    orderNo: inquiry.orderNo,
    merchantId: inquiry.merchantId,
    status: inquiry.status,
    statusName: inquiry.statusName,
    total: inquiry.total,
    currencyCode: inquiry.currencyCode,
    paidAt: inquiry.paidAt?.toISOString() ?? null,
  };
}

export async function reconcileTeamPaymentAttempt(
  paymentAttemptId: string,
  client: TeamPaySolutionsClient,
): Promise<TeamPaymentStatusResponse> {
  const [attempt] = await db.select().from(teamRegistrationPaymentAttempts)
    .where(eq(teamRegistrationPaymentAttempts.id, paymentAttemptId)).limit(1);
  if (!attempt) throw new TeamRegistrationError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "ไม่พบรายการชำระเงิน");
  const inquiry = await client.inquiry(attempt.referenceNo);
  if (!inquiry) throw new TeamRegistrationError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "ยังไม่พบสถานะจากผู้ให้บริการ");
  const comparison = compareTeamPaymentInquiry(
    { referenceNo: attempt.referenceNo, merchantId: attempt.merchantIdSnapshot, amount: attempt.amount, currency: "THB" },
    inquiry,
  );
  const now = new Date();

  await db.insert(teamRegistrationPaymentEvents).values({
    paymentAttemptId: attempt.id,
    eventType: comparison.verified ? "inquiry_verified" : "inquiry_result",
    referenceNo: attempt.referenceNo,
    providerStatus: inquiry.status,
    payloadRedacted: redactInquiry(inquiry),
    merchantMatches: comparison.merchantMatches,
    amountMatches: comparison.amountMatches,
    currencyMatches: comparison.currencyMatches,
    processedAt: now,
  });

  if (!comparison.verified) {
    const mismatch = !comparison.referenceMatches || !comparison.merchantMatches || !comparison.amountMatches || !comparison.currencyMatches;
    await db.update(teamRegistrationPaymentAttempts).set({
      status: mismatch ? "verification_required" : attempt.status,
      providerStatus: inquiry.status,
      providerStatusName: inquiry.statusName,
      providerOrderNo: inquiry.orderNo,
      lastInquiredAt: now,
      updatedAt: now,
    }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
    return getPaymentStatusByRegistration(attempt.registrationId);
  }

  await fulfillVerifiedTeamPayment(attempt.id, inquiry, now);
  return getPaymentStatusByRegistration(attempt.registrationId);
}

export async function fulfillVerifiedTeamPayment(
  paymentAttemptId: string,
  inquiry: TeamPaySolutionsInquiry,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(teamRegistrationPaymentAttempts)
      .where(eq(teamRegistrationPaymentAttempts.id, paymentAttemptId)).for("update").limit(1);
    if (!attempt) throw new TeamRegistrationError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "ไม่พบรายการชำระเงิน");
    const [registration] = await tx.select().from(teamRegistrations)
      .where(eq(teamRegistrations.id, attempt.registrationId)).for("update").limit(1);
    if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
    if (registration.status === "paid") return registration;

    const paidAt = inquiry.paidAt ?? now;
    await tx.update(teamRegistrationPaymentAttempts).set({
      status: "paid",
      providerStatus: inquiry.status,
      providerStatusName: inquiry.statusName,
      providerOrderNo: inquiry.orderNo,
      paidAt,
      lastInquiredAt: now,
      updatedAt: now,
    }).where(eq(teamRegistrationPaymentAttempts.id, attempt.id));
    const [paidRegistration] = await tx.update(teamRegistrations).set({
      status: "paid",
      paidAt,
      lockedAt: now,
      categoryCodeSnapshot: attempt.categoryCodeSnapshot,
      categoryNameSnapshot: attempt.categoryNameSnapshot,
      pricingRoundCodeSnapshot: attempt.pricingRoundCodeSnapshot,
      pricingRoundNameSnapshot: attempt.pricingRoundNameSnapshot,
      amountSnapshot: attempt.amount,
      currencySnapshot: attempt.currency,
      updatedAt: now,
    }).where(eq(teamRegistrations.id, registration.id)).returning();

    const members = await tx.select().from(teamRegistrationMembers)
      .where(eq(teamRegistrationMembers.registrationId, registration.id));
    const [event] = await tx.select({ name: events.eventName }).from(events).where(eq(events.id, registration.eventId)).limit(1);
    if (members.length > 0) {
      const memberNames = members.sort((a, b) => a.position - b.position).map((member) => `${member.firstName} ${member.lastName}`.trim());
      await tx.insert(teamRegistrationEmailOutbox).values(members.map((member) => ({
        registrationId: registration.id,
        memberId: member.id,
        templateCode: "team_payment_confirmation",
        deliveryKey: "initial",
        recipientEmail: member.email,
        payloadSnapshot: {
          eventName: event?.name ?? "Event",
          teamName: registration.teamName,
          memberNames,
          amount: attempt.amount,
          currency: attempt.currency,
          referenceNo: attempt.referenceNo,
        },
        status: "pending" as const,
        nextAttemptAt: now,
      }))).onConflictDoNothing();
    }
    return paidRegistration;
  });
}

export async function getPaymentStatusByRegistration(registrationId: string): Promise<TeamPaymentStatusResponse> {
  const [row] = await db.select({ registration: teamRegistrations, attempt: teamRegistrationPaymentAttempts })
    .from(teamRegistrations)
    .leftJoin(teamRegistrationPaymentAttempts, eq(teamRegistrationPaymentAttempts.registrationId, teamRegistrations.id))
    .where(eq(teamRegistrations.id, registrationId))
    .orderBy(desc(teamRegistrationPaymentAttempts.attemptNumber))
    .limit(1);
  if (!row) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
  return {
    registrationId: row.registration.id,
    registrationStatus: row.registration.status,
    paymentStatus: row.attempt?.status === "creating" ? "pending" : row.attempt?.status ?? null,
    referenceNo: row.attempt?.referenceNo ?? null,
    amount: row.attempt?.amount ?? null,
    currency: row.attempt ? "THB" : null,
    paidAt: row.registration.paidAt?.toISOString() ?? null,
  };
}
