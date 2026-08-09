import type { FastifyInstance } from "fastify";
import { abstractWordCountRequestSchema } from "../../../schemas/abstracts.schema.js";
import { validateAbstractWords } from "../../../utils/abstractWordCount.js";

export default async function wordCountRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/word-count",
    {
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 150,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsed = abstractWordCountRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          code: "INVALID_WORD_COUNT_INPUT",
          error: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }

      const {
        title,
        keywords,
        background,
        objective,
        methods,
        results,
        conclusion,
      } = parsed.data;

      const result = validateAbstractWords({
        title,
        keywords,
        sections: {
          background,
          objective,
          methods,
          results,
          conclusion,
        },
      });

      return reply.send({
        success: true,
        ...result,
      });
    },
  );
}
