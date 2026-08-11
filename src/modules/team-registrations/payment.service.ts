import { eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import { teamRegistrationPaymentAttempts, teamRegistrations } from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import { initializeActiveReconciliationSchedule, initializeTerminalSchedule } from "./jobs-policy.js";
import {
  activePaymentAttempts,
  cancelActivePaymentAttempts,
  countCreatedPaymentAttemptsSince,
  hasAllCurrentEmailClaims,
  latestPaymentAttempt,
  linkPaymentAttemptsToSuccessor,
  loadCurrentPaymentQuote,
  lockAllPaymentAttempts,
  lockOwnedTeamRegistration,
  lockTeamRegistrationConfig,
  paymentWinner,
  type TeamPaymentAttempt,
} from "./payment.repository.js";
import { teamPaymentSafeRetryEnabled } from "./payment-flags.js";
import { insertWithUniquePaymentReference } from "./payment-reference.js";
import { canReplayTeamPaymentAttempt, canStartTeamPayment } from "./payment-state.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import { getPaymentStatusByRegistration } from "./payment-verification.service.js";
import { getRegistration } from "./registration.service.js";
import type { VerifiedTeamAccess } from "./types.js";

const MAX_CREATED_ATTEMPTS_PER_TEN_MINUTES = 10;

function localPaymentProfileCode(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE?.trim();
  if (!value) {
    throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", "ระบบชำระเงินยังตั้งค่าไม่ครบ");
  }
  return value;
}

function idempotencyError(attempt: TeamPaymentAttempt): TeamRegistrationError {
  return new TeamRegistrationError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "กรุณาเริ่มรายการชำระเงินใหม่",
    undefined,
    { paymentAttemptId: attempt.id, paymentStatus: attempt.status },
  );
}

function paymentAttemptResponse(
  attempt: TeamPaymentAttempt,
  supersededPaymentAttemptId: string | null,
) {
  if (!attempt.customerEmailSnapshot
    || !attempt.customerNameSnapshot
    || !attempt.productDetailSnapshot
    || !attempt.formActionUrlSnapshot) {
    throw new TeamRegistrationError(409, "PAYMENT_ATTEMPT_NOT_REPLAYABLE", "กรุณาเริ่มรายการชำระเงินใหม่");
  }
  return {
    paymentAttemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    supersededPaymentAttemptId,
    referenceNo: attempt.referenceNo,
    amount: attempt.amount,
    currency: attempt.currency as "THB",
    expiresAt: attempt.expiresAt.toISOString(),
    redirectForm: {
      actionUrl: attempt.formActionUrlSnapshot,
      method: "POST" as const,
      fields: {
        merchantid: attempt.merchantIdSnapshot,
        refno: attempt.referenceNo,
        customeremail: attempt.customerEmailSnapshot,
        customername: attempt.customerNameSnapshot,
        productdetail: attempt.productDetailSnapshot,
        total: attempt.amount,
        cc: "00",
        lang: "TH",
        channel: attempt.channel,
      },
    },
  };
}

function throwStartError(input: {
  configEnabled: boolean;
  profileMatches: boolean;
  merchantMatches: boolean;
  registrationStatus: string;
  hasWinner: boolean;
  hasUnresolvedAction: boolean;
  claimsHeld: boolean;
  hasActiveAttempt: boolean;
  safeRetryEnabled: boolean;
}) {
  if (!input.configEnabled) {
    throw new TeamRegistrationError(409, "TEAM_REGISTRATION_DISABLED", "ระบบรับสมัครทีมถูกปิดใช้งาน");
  }
  if (!input.profileMatches) {
    throw new TeamRegistrationError(409, "PAYMENT_PROFILE_MISMATCH", "โปรไฟล์ระบบชำระเงินไม่ตรงกับ Event");
  }
  if (!input.merchantMatches) {
    throw new TeamRegistrationError(409, "PAYMENT_MERCHANT_MISMATCH", "Merchant ของรายการเดิมไม่ตรงกับระบบปัจจุบัน");
  }
  if (input.hasWinner) throw new TeamRegistrationError(409, "REGISTRATION_LOCKED", "ทีมชำระเงินแล้ว");
  if (input.hasUnresolvedAction) {
    throw new TeamRegistrationError(409, "PAYMENT_REVIEW_REQUIRED", "รายการชำระเงินนี้ต้องให้เจ้าหน้าที่ตรวจสอบ");
  }
  if (input.hasActiveAttempt && !input.safeRetryEnabled) {
    throw new TeamRegistrationError(409, "PAYMENT_ATTEMPT_ACTIVE", "มีรายการชำระเงินที่ยังใช้งานอยู่");
  }
  if (!input.claimsHeld) {
    throw new TeamRegistrationError(409, "REGISTRATION_EXPIRED", "สิทธิ์สำรองสมาชิกหมดอายุแล้ว");
  }
  if (!["ready_for_payment", "payment_pending"].includes(input.registrationStatus)) {
    throw new TeamRegistrationError(409, "REGISTRATION_NOT_READY", "ข้อมูลทีมยังไม่พร้อมชำระเงิน");
  }
  throw new TeamRegistrationError(409, "REGISTRATION_EXPIRED", "ไม่สามารถเริ่มรายการชำระเงินใหม่ได้");
}

export async function createTeamPaymentAttempt(
  registrationId: string,
  access: VerifiedTeamAccess,
  idempotencyKey: string,
  now = new Date(),
) {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey || normalizedKey.length > 100) {
    throw new TeamRegistrationError(400, "IDEMPOTENCY_KEY_REQUIRED", "กรุณาส่ง Idempotency-Key");
  }

  const providerConfig = getTeamPaySolutionsConfig();
  const localProfile = localPaymentProfileCode();
  const client = createTeamPaySolutionsClient(providerConfig);
  const safeRetryEnabled = teamPaymentSafeRetryEnabled();

  const result = await db.transaction(async (tx) => {
    const registration = await lockOwnedTeamRegistration(
      tx,
      registrationId,
      access.eventId,
      access.leaderEmailNormalized,
    );
    if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");

    const attempts = await lockAllPaymentAttempts(tx, registrationId);
    const sameRequest = attempts.find((attempt) => attempt.idempotencyKey === normalizedKey) ?? null;
    const config = await lockTeamRegistrationConfig(tx, registration.configId);
    if (!config) throw new TeamRegistrationError(500, "TEAM_REGISTRATION_CONFIG_ERROR", "ไม่พบการตั้งค่าการชำระเงิน");

    const eventProfileMatches = config.paymentProfileCode === localProfile;
    const currentReservation = registration.paymentReservationExpiresAt;
    const hasUnexpiredReservation = Boolean(currentReservation && currentReservation > now);
    const retainedSessionAttempt = hasUnexpiredReservation
      ? attempts.find((attempt) => (
        attempt.expiresAt.getTime() === currentReservation!.getTime()
        && attempt.registrationRevisionSnapshot === registration.revision
      )) ?? null
      : null;
    const retainedSessionProfileMatches = !hasUnexpiredReservation
      || retainedSessionAttempt?.paymentProfileCode === localProfile;
    const retainedSessionMerchantMatches = !hasUnexpiredReservation
      || retainedSessionAttempt?.merchantIdSnapshot === client.merchantId;

    if (sameRequest) {
      const active = sameRequest.status === "creating" || sameRequest.status === "pending";
      if (!active || sameRequest.expiresAt <= now) {
        if (active) {
          await tx.update(teamRegistrationPaymentAttempts).set({
            nextReconcileAt: now,
            updatedAt: now,
          }).where(eq(teamRegistrationPaymentAttempts.id, sameRequest.id));
        }
        // Return the conflict after the transaction commits. Throwing here would
        // roll back the due-now reconciliation update for an expired active key.
        return {
          kind: "idempotency_conflict" as const,
          attempt: sameRequest,
          supersededPaymentAttemptId: null,
        };
      }
      const replayAllowed = canReplayTeamPaymentAttempt({
        configEnabled: config.isEnabled,
        paymentEnvironmentReady: true,
        eventProfileMatches,
        eventMerchantMatches: true,
        ownedByRequester: true,
        active,
        unexpired: sameRequest.expiresAt > now,
        sessionMatches: currentReservation?.getTime() === sameRequest.expiresAt.getTime(),
        retainedSessionProfileMatches: sameRequest.paymentProfileCode === localProfile,
        retainedSessionMerchantMatches: sameRequest.merchantIdSnapshot === client.merchantId,
      });
      if (!replayAllowed) {
        throwStartError({
          configEnabled: config.isEnabled,
          profileMatches: eventProfileMatches && sameRequest.paymentProfileCode === localProfile,
          merchantMatches: sameRequest.merchantIdSnapshot === client.merchantId,
          registrationStatus: registration.status,
          hasWinner: Boolean(paymentWinner(attempts)),
          hasUnresolvedAction: attempts.some((attempt) => attempt.actionRequired && !attempt.actionResolvedAt),
          claimsHeld: true,
          hasActiveAttempt: true,
          safeRetryEnabled: true,
        });
      }
      const predecessor = attempts.find((attempt) => attempt.supersededByAttemptId === sameRequest.id) ?? null;
      return {
        kind: "payment_attempt" as const,
        attempt: sameRequest,
        supersededPaymentAttemptId: predecessor?.id ?? null,
      };
    }

    const activeAttempts = activePaymentAttempts(attempts);
    const winner = paymentWinner(attempts);
    const hasUnresolvedAction = attempts.some((attempt) => attempt.actionRequired && !attempt.actionResolvedAt);
    const claimsHeld = await hasAllCurrentEmailClaims(tx, registrationId);
    if (hasUnexpiredReservation && !retainedSessionAttempt) {
      throw new TeamRegistrationError(409, "PAYMENT_REVIEW_REQUIRED", "ไม่พบข้อมูล session การชำระเงินที่ตรงกับสิทธิ์สำรอง");
    }
    const canStart = canStartTeamPayment({
      now,
      configEnabled: config.isEnabled,
      paymentEnvironmentReady: true,
      eventProfileMatches,
      eventMerchantMatches: true,
      registrationStatus: registration.status,
      teamDataComplete: registration.status === "ready_for_payment" || registration.status === "payment_pending",
      hasWinner: Boolean(winner),
      hasUnresolvedAction,
      claimsHeld,
      paymentReservationExpiresAt: currentReservation,
      retainedSessionProfileMatches,
      retainedSessionMerchantMatches,
      draftExpiresAt: registration.draftExpiresAt,
      registrationClosesAt: config.registrationClosesAt,
      hasActiveAttempt: activeAttempts.length > 0,
      safeRetryEnabled,
    });
    if (!canStart) {
      throwStartError({
        configEnabled: config.isEnabled,
        profileMatches: eventProfileMatches && retainedSessionProfileMatches,
        merchantMatches: retainedSessionMerchantMatches,
        registrationStatus: registration.status,
        hasWinner: Boolean(winner),
        hasUnresolvedAction,
        claimsHeld,
        hasActiveAttempt: activeAttempts.length > 0,
        safeRetryEnabled,
      });
    }

    const recentCount = await countCreatedPaymentAttemptsSince(
      tx,
      registrationId,
      new Date(now.getTime() - 10 * 60 * 1000),
    );
    if (recentCount >= MAX_CREATED_ATTEMPTS_PER_TEN_MINUTES) {
      throw new TeamRegistrationError(429, "PAYMENT_RETRY_RATE_LIMITED", "เริ่มรายการชำระเงินบ่อยเกินไป กรุณารอสักครู่");
    }

    const retainedSession = Boolean(hasUnexpiredReservation && retainedSessionAttempt);
    const expiresAt = retainedSession
      ? new Date(currentReservation!)
      : new Date(Math.min(
        now.getTime() + config.paymentAttemptTtlMinutes * 60 * 1000,
        config.registrationClosesAt.getTime() + config.paymentAttemptTtlMinutes * 60 * 1000,
      ));

    const currentQuote = retainedSession ? null : await loadCurrentPaymentQuote(tx, {
      configId: config.id,
      categoryId: registration.categoryId,
      registrationId,
      now,
    });
    if (!retainedSession && !currentQuote) {
      throw new TeamRegistrationError(409, "PRICING_NOT_AVAILABLE", "ไม่พบราคาที่ใช้งานได้ในขณะนี้");
    }

    const quote = retainedSessionAttempt ? {
      categoryCode: retainedSessionAttempt.categoryCodeSnapshot,
      categoryName: retainedSessionAttempt.categoryNameSnapshot,
      pricingRoundCode: retainedSessionAttempt.pricingRoundCodeSnapshot,
      pricingRoundName: retainedSessionAttempt.pricingRoundNameSnapshot,
      amount: retainedSessionAttempt.amount,
      currency: retainedSessionAttempt.currency,
      leaderEmail: retainedSessionAttempt.customerEmailSnapshot,
      leaderName: retainedSessionAttempt.customerNameSnapshot,
      productDetail: retainedSessionAttempt.productDetailSnapshot,
    } : currentQuote ? {
      ...currentQuote,
      productDetail: `${currentQuote.categoryName} - ${registration.teamName}`,
    } : null;
    if (!quote?.leaderEmail || !quote.leaderName || !quote.productDetail) {
      throw new TeamRegistrationError(409, "PAYMENT_REVIEW_REQUIRED", "ข้อมูลรายการชำระเงินเดิมไม่ครบถ้วน กรุณาติดต่อเจ้าหน้าที่");
    }

    const preview = client.createRedirectForm({
      amount: quote.amount,
      referenceNo: "400000000000",
      customerEmail: quote.leaderEmail,
      customerName: quote.leaderName,
      productDetail: quote.productDetail,
    });

    if (activeAttempts.length > 0) {
      const schedule = initializeTerminalSchedule("cancelled", now, now);
      await cancelActivePaymentAttempts(tx, {
        registrationId,
        reason: "superseded_by_retry",
        cancelledAt: now,
        reconciliationDeadlineAt: schedule.reconciliationDeadlineAt,
      });
    }

    const latest = latestPaymentAttempt(attempts);
    const attempt = await insertWithUniquePaymentReference(async (referenceNo) => {
      const [inserted] = await tx.insert(teamRegistrationPaymentAttempts).values({
        registrationId,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
        idempotencyKey: normalizedKey,
        provider: "paysolutions",
        paymentProfileCode: config.paymentProfileCode,
        merchantIdSnapshot: client.merchantId,
        referenceNo,
        categoryCodeSnapshot: quote.categoryCode,
        categoryNameSnapshot: quote.categoryName,
        pricingRoundCodeSnapshot: quote.pricingRoundCode,
        pricingRoundNameSnapshot: quote.pricingRoundName,
        amount: quote.amount,
        currency: quote.currency,
        channel: "promptpay",
        status: "pending",
        registrationRevisionSnapshot: registration.revision,
        customerEmailSnapshot: preview.fields.customeremail,
        customerNameSnapshot: preview.fields.customername,
        productDetailSnapshot: preview.fields.productdetail,
        formActionUrlSnapshot: preview.actionUrl,
        formCreatedAt: now,
        expiresAt,
        nextReconcileAt: initializeActiveReconciliationSchedule(now, expiresAt),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({ target: teamRegistrationPaymentAttempts.referenceNo }).returning();
      return inserted;
    });

    await linkPaymentAttemptsToSuccessor(tx, activeAttempts.map((item) => item.id), attempt.id, now);
    await tx.update(teamRegistrations).set({
      status: "payment_pending",
      paymentReservationExpiresAt: expiresAt,
      updatedAt: now,
    }).where(eq(teamRegistrations.id, registrationId));
    return {
      kind: "payment_attempt" as const,
      attempt,
      supersededPaymentAttemptId: activeAttempts[0]?.id ?? null,
    };
  });

  if (result.kind === "idempotency_conflict") throw idempotencyError(result.attempt);
  return paymentAttemptResponse(result.attempt, result.supersededPaymentAttemptId);
}

export async function getTeamPaymentStatus(registrationId: string, access: VerifiedTeamAccess) {
  await getRegistration(access, registrationId);
  return getPaymentStatusByRegistration(registrationId);
}
