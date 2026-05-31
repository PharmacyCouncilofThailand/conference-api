import { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../../database/index.js";
import { abstracts, users } from "../../../database/schema.js";
import {
  consumeConfirmationToken,
  lookupConfirmation,
} from "../../../services/abstractConfirmation.js";

interface ConfirmQuery {
  token?: string;
}

interface ConfirmBody {
  token?: string;
}

/**
 * Public abstract-confirmation routes.
 *
 * GET  /api/abstracts/confirm?token=XXX  -> validate token, do not consume
 * POST /api/abstracts/confirm            -> consume token, set confirmed_at
 *
 * No authentication required: the raw token is the credential. Tokens are
 * 256-bit, hashed at rest (sha256), single-use, and time-limited.
 */
export default async function (fastify: FastifyInstance) {
  // Stricter rate-limit on the public endpoints to slow brute-force scraping.
  // Falls back gracefully if @fastify/rate-limit isn't registered globally.
  const rateLimitConfig = {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
  };

  fastify.get<{ Querystring: ConfirmQuery }>(
    "",
    rateLimitConfig,
    async (request, reply) => {
      const token = request.query?.token;
      if (!token) {
        return reply.status(400).send({ state: "invalid", error: "Missing token" });
      }

      try {
        const result = await lookupConfirmation(token);
        if (result.state === "invalid" || !result.abstract) {
          return reply.send({ state: result.state });
        }

        // Attach a minimal author display name (first name only) so the
        // confirmation page can show a friendly greeting without leaking PII.
        let presenterFirstName: string | null = null;
        const [absWithUser] = await db
          .select({ userId: abstracts.userId })
          .from(abstracts)
          .where(eq(abstracts.id, result.abstract.id))
          .limit(1);
        if (absWithUser?.userId) {
          const [u] = await db
            .select({ firstName: users.firstName })
            .from(users)
            .where(eq(users.id, absWithUser.userId))
            .limit(1);
          presenterFirstName = u?.firstName ?? null;
        }

        return reply.send({
          state: result.state,
          abstract: {
            id: result.abstract.id,
            trackingId: result.abstract.trackingId,
            title: result.abstract.title,
            presentationType: result.abstract.presentationType,
            confirmedAt: result.abstract.confirmedAt,
            deadline: result.abstract.deadline,
            presenterFirstName,
          },
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to validate confirmation token");
        return reply.status(500).send({ state: "error" });
      }
    },
  );

  fastify.post<{ Body: ConfirmBody }>(
    "",
    rateLimitConfig,
    async (request, reply) => {
      const token = request.body?.token;
      if (!token) {
        return reply.status(400).send({ state: "invalid", error: "Missing token" });
      }

      try {
        const result = await consumeConfirmationToken(token);

        if (result.state === "success" || result.state === "already_confirmed") {
          // Re-fetch a small abstract summary for the success page.
          const summary = result.abstractId
            ? await db
                .select({
                  id: abstracts.id,
                  trackingId: abstracts.trackingId,
                  title: abstracts.title,
                  presentationType: abstracts.presentationType,
                  confirmedAt: abstracts.confirmedAt,
                })
                .from(abstracts)
                .where(eq(abstracts.id, result.abstractId))
                .limit(1)
            : [];
          return reply.send({
            state: result.state,
            abstract: summary[0] ?? null,
          });
        }

        return reply.send({ state: result.state });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to consume confirmation token");
        return reply.status(500).send({ state: "error" });
      }
    },
  );
}
