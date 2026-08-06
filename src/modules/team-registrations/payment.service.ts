import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  teamRegistrationConfigs,
  teamRegistrationPaymentAttempts,
  teamRegistrations,
} from "../../database/schema.js";
import { getPricingRounds } from "./database.repository.js";
import { TeamRegistrationError } from "./errors.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import { getPaymentStatusByRegistration } from "./payment-verification.service.js";
import { insertWithUniquePaymentReference } from "./payment-reference.js";
import { selectPriceForTime } from "./pricing.service.js";
import { getRegistration, requireReadyRegistration } from "./registration.service.js";
import type { VerifiedTeamAccess } from "./types.js";

export async function createTeamPaymentAttempt(
  registrationId: string,
  access: VerifiedTeamAccess,
  idempotencyKey: string,
  now = new Date(),
) {
  if (!idempotencyKey.trim() || idempotencyKey.length > 100) {
    throw new TeamRegistrationError(400, "IDEMPOTENCY_KEY_REQUIRED", "กรุณาส่ง Idempotency-Key");
  }
  const ready = await requireReadyRegistration(registrationId, access);
  const [config] = await db.select().from(teamRegistrationConfigs).where(eq(teamRegistrationConfigs.id, ready.configId)).limit(1);
  if (!config) throw new TeamRegistrationError(500, "TEAM_REGISTRATION_CONFIG_ERROR", "ไม่พบการตั้งค่าการชำระเงิน");
  const client = createTeamPaySolutionsClient(getTeamPaySolutionsConfig());

  return db.transaction(async (tx) => {
    const [registration] = await tx.select().from(teamRegistrations)
      .where(eq(teamRegistrations.id, registrationId)).for("update").limit(1);
    if (!registration || registration.eventId !== access.eventId || registration.leaderEmailNormalized !== access.leaderEmailNormalized) {
      throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
    }
    if (registration.status === "paid") throw new TeamRegistrationError(409, "REGISTRATION_LOCKED", "ทีมชำระเงินแล้ว");

    const [sameRequest] = await tx.select().from(teamRegistrationPaymentAttempts).where(and(
      eq(teamRegistrationPaymentAttempts.registrationId, registrationId),
      eq(teamRegistrationPaymentAttempts.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (sameRequest) return paymentAttemptResponse(sameRequest, ready, client);

    await tx.update(teamRegistrationPaymentAttempts).set({ status: "expired", updatedAt: now })
      .where(and(
        eq(teamRegistrationPaymentAttempts.registrationId, registrationId),
        inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
        lte(teamRegistrationPaymentAttempts.expiresAt, now),
      ));
    const [active] = await tx.select().from(teamRegistrationPaymentAttempts).where(and(
      eq(teamRegistrationPaymentAttempts.registrationId, registrationId),
      inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
    )).limit(1);
    if (active) throw new TeamRegistrationError(409, "PAYMENT_ATTEMPT_ACTIVE", "มีรายการชำระเงินที่ยังใช้งานอยู่");

    const rounds = await getPricingRounds(config.id);
    const price = selectPriceForTime(rounds, ready.categoryId, now);
    const [latest] = await tx.select({ attemptNumber: teamRegistrationPaymentAttempts.attemptNumber })
      .from(teamRegistrationPaymentAttempts)
      .where(eq(teamRegistrationPaymentAttempts.registrationId, registrationId))
      .orderBy(desc(teamRegistrationPaymentAttempts.attemptNumber))
      .limit(1);
    const expiresAt = new Date(now.getTime() + config.paymentAttemptTtlMinutes * 60 * 1000);
    const attempt = await insertWithUniquePaymentReference(async (referenceNo) => {
      const [inserted] = await tx.insert(teamRegistrationPaymentAttempts).values({
        registrationId,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
        idempotencyKey,
        provider: "paysolutions",
        paymentProfileCode: config.paymentProfileCode,
        merchantIdSnapshot: client.merchantId,
        referenceNo,
        categoryCodeSnapshot: ready.categoryCode,
        categoryNameSnapshot: ready.categoryName,
        pricingRoundCodeSnapshot: price.pricingRoundCode,
        pricingRoundNameSnapshot: price.pricingRoundName,
        amount: price.amount,
        currency: price.currency,
        channel: "promptpay",
        status: "pending",
        formCreatedAt: now,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({ target: teamRegistrationPaymentAttempts.referenceNo }).returning();
      return inserted;
    });
    await tx.update(teamRegistrations).set({ status: "payment_pending", updatedAt: now })
      .where(eq(teamRegistrations.id, registrationId));
    return paymentAttemptResponse(attempt, ready, client);
  });
}

function paymentAttemptResponse(
  attempt: typeof teamRegistrationPaymentAttempts.$inferSelect,
  ready: Awaited<ReturnType<typeof requireReadyRegistration>>,
  client: ReturnType<typeof createTeamPaySolutionsClient>,
) {
  return {
    paymentAttemptId: attempt.id,
    referenceNo: attempt.referenceNo,
    amount: attempt.amount,
    currency: "THB" as const,
    expiresAt: attempt.expiresAt.toISOString(),
    redirectForm: client.createRedirectForm({
      amount: attempt.amount,
      referenceNo: attempt.referenceNo,
      customerEmail: ready.leaderEmail,
      customerName: ready.leaderName,
      productDetail: `${ready.categoryName} - ${ready.teamName}`,
    }),
  };
}

export async function getTeamPaymentStatus(registrationId: string, access: VerifiedTeamAccess) {
  await getRegistration(access, registrationId);
  return getPaymentStatusByRegistration(registrationId);
}
