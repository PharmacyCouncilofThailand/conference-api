import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { merchPaymentEvents } from "../../database/schema.js";
import { merchRateLimit } from "./http.js";
import { contextFrom, logMerchError, type MerchContext } from "./payments/attempts.js";
import { parsePostback } from "./payments/payso-parse.js";
import { reconcileAttempt } from "./payments/reconcile.js";
import type { MerchRouteOptions } from "./types.js";

const POSTBACK_BODY_LIMIT = 16_384;
const REFERENCE_PATTERN = /^\d{12}$/;

export type MerchProviderRouteOptions = MerchRouteOptions & {
  /** What runs after the reply for a matched postback; tests inject a tracker. */
  reconcile?: (ctx: MerchContext, attemptId: string) => Promise<void>;
};

function decodeBody(request: FastifyRequest): unknown {
  const raw = typeof request.body === "string" ? request.body : "";
  if (raw === "") return {};
  const type = String(request.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function replyOk(reply: FastifyReply): FastifyReply {
  return reply.status(200).type("text/plain; charset=utf-8").send("OK");
}

/**
 * PaySolution postback (§7.7). It has no signature, so it never settles anything: it is
 * logged (sanitized), makes the matched attempt due and triggers an inquiry after the reply.
 * The provider always gets 200 `OK` (apart from the limiter's 429), whatever it sent.
 */
export async function merchandiseProviderRoutes(
  app: FastifyInstance,
  options: MerchProviderRouteOptions,
): Promise<void> {
  const db = options.database;
  const ctx = contextFrom(options, app.log);
  const reconcile = options.reconcile ?? reconcileAttempt;

  // Read every body as a string so a malformed or unexpected body never fails parsing.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    logMerchError(ctx.log, error, "merchandise postback rejected");
    return replyOk(reply);
  });

  const postbackRateLimit = merchRateLimit(app, { max: 120, groupId: "merchandise-postback" });

  app.post(
    "/provider/payso/postback",
    { bodyLimit: POSTBACK_BODY_LIMIT, config: { rateLimit: false }, preHandler: postbackRateLimit },
    async (request, reply) => {
      let matchedAttemptId: string | null = null;
      try {
        const parsed = parsePostback(decodeBody(request));
        const referenceNo = parsed.referenceNo;
        if (referenceNo !== null && REFERENCE_PATTERN.test(referenceNo)) {
          const rows = (await db.execute(sql`
            SELECT id FROM merch_payment_attempts WHERE reference_no = ${referenceNo} LIMIT 1`)) as unknown as Array<{
            id: string;
          }>;
          matchedAttemptId = rows[0]?.id ?? null;
        }
        await db.insert(merchPaymentEvents).values({
          attemptId: matchedAttemptId,
          kind: "postback",
          referenceNo: (referenceNo ?? "").slice(0, 64),
          receivedAt: sql`clock_timestamp()`,
          sanitized: { ...parsed.sanitized, fieldNames: parsed.fieldNames },
          result: matchedAttemptId ? "matched" : referenceNo ? "unmatched" : "no_reference",
        });
        if (matchedAttemptId) {
          await db.execute(sql`
            UPDATE merch_payment_attempts
            SET next_check_at = clock_timestamp(), updated_at = now()
            WHERE id = ${matchedAttemptId} AND status <> 'paid'`);
        }
      } catch (error) {
        logMerchError(ctx.log, error, "merchandise postback logging failed");
      }
      replyOk(reply);
      if (matchedAttemptId) {
        const attemptId = matchedAttemptId;
        void Promise.resolve()
          .then(() => reconcile(ctx, attemptId))
          .catch((error: unknown) => logMerchError(ctx.log, error, "merchandise postback reconcile failed"));
      }
      return reply;
    },
  );
}
