import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../../database/index.js";
import { teamRegistrationPaymentAttempts, teamRegistrationPaymentEvents } from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import {
  claimPaymentInquiryLease,
  countProviderEventsSince,
  insertProviderEvent,
} from "./payment.repository.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import {
  reconcileTeamPaymentAttempt,
  releaseTeamPaymentInquiryLease,
} from "./payment-verification.service.js";
import {
  shouldReleasePostbackLeaseAfterFailure,
  teamPaymentPostbackIdentity,
} from "./provider-postback.js";

const POSTBACK_BODY_LIMIT = 16 * 1024;
const POSTBACK_STORAGE_LIMIT_PER_HOUR = 60;
const POSTBACK_INQUIRY_LIMIT_PER_HOUR = 12;
const POSTBACK_INQUIRY_COOLDOWN_MS = 30_000;
const INQUIRY_LEASE_MS = 30_000;

function utcHourKey(date: Date): string {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
}

function safeErrorCode(error: unknown): string {
  if (error instanceof TeamRegistrationError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,99}$/.test(error.name)) return error.name;
  return "PAYMENT_RECONCILIATION_ERROR";
}

export default async function teamRegistrationProviderRoutes(fastify: FastifyInstance) {
  fastify.post("/payment-providers/paysolutions/postback", { bodyLimit: POSTBACK_BODY_LIMIT }, async (request, reply) => {
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const identity = teamPaymentPostbackIdentity(payload);
    if (!/^\d{12}$/.test(identity.referenceNo)) {
      return reply.status(400).send({ success: false, error: "invalid reference", requestId: request.id });
    }

    const now = new Date();
    const decision = await db.transaction(async (tx) => {
      const [attempt] = await tx.select().from(teamRegistrationPaymentAttempts)
        .where(eq(teamRegistrationPaymentAttempts.referenceNo, identity.referenceNo))
        .for("update").limit(1);
      if (!attempt) return { attemptId: null, shouldInquire: false, terminalAtClaim: false, leaseUntil: null };
      const terminalAtClaim = attempt.status === "cancelled" || attempt.status === "failed" || attempt.status === "expired";

      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const storedCount = await countProviderEventsSince(tx, identity.referenceNo, "postback_received", hourAgo);
      if (storedCount < POSTBACK_STORAGE_LIMIT_PER_HOUR) {
        await insertProviderEvent(tx, {
          paymentAttemptId: attempt.id,
          eventType: "postback_received",
          providerEventKey: identity.key,
          referenceNo: identity.referenceNo,
          providerStatus: identity.providerStatus,
          payloadRedacted: identity.redacted,
          createdAt: now,
        });
      } else {
        await insertProviderEvent(tx, {
          paymentAttemptId: attempt.id,
          eventType: "postback_throttled",
          providerEventKey: `paysolutions:throttled:${identity.referenceNo}:${utcHourKey(now)}`,
          referenceNo: identity.referenceNo,
          providerStatus: null,
          payloadRedacted: { referenceNo: identity.referenceNo },
          createdAt: now,
        });
      }

      const inquiryCount = await countProviderEventsSince(tx, identity.referenceNo, "postback_inquiry_started", hourAgo);
      if (inquiryCount >= POSTBACK_INQUIRY_LIMIT_PER_HOUR) {
        return { attemptId: attempt.id, shouldInquire: false, terminalAtClaim, leaseUntil: null };
      }
      const [latestStart] = await tx.select({ createdAt: teamRegistrationPaymentEvents.createdAt })
        .from(teamRegistrationPaymentEvents).where(and(
          eq(teamRegistrationPaymentEvents.referenceNo, identity.referenceNo),
          eq(teamRegistrationPaymentEvents.eventType, "postback_inquiry_started"),
          gte(teamRegistrationPaymentEvents.createdAt, hourAgo),
        )).orderBy(desc(teamRegistrationPaymentEvents.createdAt)).limit(1);
      if (latestStart && latestStart.createdAt > new Date(now.getTime() - POSTBACK_INQUIRY_COOLDOWN_MS)) {
        return { attemptId: attempt.id, shouldInquire: false, terminalAtClaim, leaseUntil: null };
      }

      const leased = await claimPaymentInquiryLease(
        tx,
        attempt.id,
        now,
        new Date(now.getTime() + INQUIRY_LEASE_MS),
      );
      if (!leased) return { attemptId: attempt.id, shouldInquire: false, terminalAtClaim, leaseUntil: null };
      await insertProviderEvent(tx, {
        paymentAttemptId: attempt.id,
        eventType: "postback_inquiry_started",
        providerEventKey: `paysolutions:inquiry:${identity.referenceNo}:${now.getTime()}:${request.id}`.slice(0, 255),
        referenceNo: identity.referenceNo,
        providerStatus: null,
        payloadRedacted: { referenceNo: identity.referenceNo },
        createdAt: now,
      });
      return {
        attemptId: attempt.id,
        shouldInquire: true,
        terminalAtClaim,
        leaseUntil: leased.inquiryLeaseUntil,
      };
    });

    if (!decision.attemptId || !decision.shouldInquire || !decision.leaseUntil) {
      return reply.send({ success: true });
    }

    let reconciliationCompleted = false;
    try {
      await reconcileTeamPaymentAttempt(
        decision.attemptId,
        createTeamPaySolutionsClient(getTeamPaySolutionsConfig()),
      );
      reconciliationCompleted = true;
      await releaseTeamPaymentInquiryLease(
        decision.attemptId,
        decision.leaseUntil,
        new Date(),
        decision.terminalAtClaim,
      );
      return reply.send({ success: true });
    } catch (error) {
      const teamErrorCode = error instanceof TeamRegistrationError ? error.code : null;
      if (shouldReleasePostbackLeaseAfterFailure(reconciliationCompleted, teamErrorCode)) {
        await releaseTeamPaymentInquiryLease(
          decision.attemptId,
          decision.leaseUntil,
          new Date(),
          decision.terminalAtClaim,
        ).catch(() => undefined);
      }
      const code = safeErrorCode(error);
      request.log.error({ code, referenceNo: identity.referenceNo, requestId: request.id }, "Team payment postback reconciliation failed");
      if (error instanceof TeamRegistrationError && error.code === "PAYMENT_PROVIDER_UNAVAILABLE") {
        return reply.status(202).send({ success: true, processing: true });
      }
      return reply.status(202).send({ success: true, processing: true });
    }
  });
}
