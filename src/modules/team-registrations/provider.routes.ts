import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import { teamRegistrationPaymentAttempts, teamRegistrationPaymentEvents } from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import { createTeamPaySolutionsClient, getTeamPaySolutionsConfig } from "./paysolutions.client.js";
import { reconcileTeamPaymentAttempt } from "./payment-verification.service.js";

function postbackReference(payload: Record<string, unknown>): string {
  return String(payload.ReferenceNo ?? payload.referenceNo ?? payload.refNo ?? payload.refno ?? "").trim();
}

function redactedPostback(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    referenceNo: postbackReference(payload),
    orderNo: payload.OrderNo ?? payload.orderNo ?? null,
    merchantId: payload.MerchantID ?? payload.merchantId ?? null,
    status: payload.Status ?? payload.status ?? null,
    statusName: payload.StatusName ?? payload.statusName ?? null,
    total: payload.Total ?? payload.total ?? null,
    currencyCode: payload.CurrencyCode ?? payload.currencyCode ?? null,
  };
}

export default async function teamRegistrationProviderRoutes(fastify: FastifyInstance) {
  fastify.post("/payment-providers/paysolutions/postback", async (request, reply) => {
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const referenceNo = postbackReference(payload);
    if (!referenceNo) return reply.status(400).send({ success: false, error: "missing reference" });
    const [attempt] = await db.select().from(teamRegistrationPaymentAttempts)
      .where(eq(teamRegistrationPaymentAttempts.referenceNo, referenceNo)).limit(1);
    await db.insert(teamRegistrationPaymentEvents).values({
      paymentAttemptId: attempt?.id ?? null,
      eventType: "postback_received",
      referenceNo,
      providerStatus: String(payload.Status ?? payload.status ?? ""),
      payloadRedacted: redactedPostback(payload),
      createdAt: new Date(),
    });
    if (!attempt) return reply.send({ success: true });
    try {
      await reconcileTeamPaymentAttempt(attempt.id, createTeamPaySolutionsClient(getTeamPaySolutionsConfig()));
      return reply.send({ success: true });
    } catch (error) {
      request.log.error({ error, referenceNo }, "Team payment postback reconciliation failed");
      if (error instanceof TeamRegistrationError && error.code === "PAYMENT_PROVIDER_UNAVAILABLE") {
        return reply.status(202).send({ success: true, processing: true });
      }
      return reply.status(500).send({ success: false });
    }
  });
}
