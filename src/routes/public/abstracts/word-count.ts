import type { FastifyInstance } from "fastify";
import { abstractWordCountRequestSchema } from "../../../schemas/abstracts.schema.js";
import { validateAbstractWords } from "../../../utils/abstractWordCount.js";
import type {
  AbstractWordCountInput,
  AbstractWordCountResult,
} from "../../../utils/abstractWordCount.js";

type WordCountRouteOptions = {
  validateWords?: (
    input: AbstractWordCountInput,
  ) => Promise<AbstractWordCountResult>;
};

export default async function wordCountRoutes(
  fastify: FastifyInstance,
  options: WordCountRouteOptions,
) {
  const validateWords = options.validateWords ?? validateAbstractWords;
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

      const result = await validateWords({
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
