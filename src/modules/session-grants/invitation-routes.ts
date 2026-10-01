import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";
import { db } from "../../database/index.js";
import { invitationDecisionSchema } from "./schemas.js";
import { hashInvitationToken } from "./invitation-token.js";
import {
  lookupInvitation,
  respondToInvitation,
} from "./invitations.js";
import type { GrantDatabase } from "./types.js";
import { GrantError } from "./types.js";

export interface InvitationRouteOptions {
  database?: GrantDatabase;
  lookupInvitationFn?: typeof lookupInvitation;
  respondToInvitationFn?: typeof respondToInvitation;
}

function invitationCredential(
  header: string | string[] | undefined,
): string {
  if (typeof header !== "string") {
    throw new GrantError(
      401,
      "INVALID_INVITATION_TOKEN",
      "Invitation token required",
    );
  }

  const match = /^Bearer ([a-f0-9]{64})$/.exec(header);
  if (!match) {
    throw new GrantError(
      401,
      "INVALID_INVITATION_TOKEN",
      "Invalid invitation token",
    );
  }

  hashInvitationToken(match[1]);
  return match[1];
}

export function redactInvitationRequestUrl(
  rawUrl: string,
): string {
  if (!rawUrl.startsWith("/api/session-invitations")) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl, "http://session-invitations.local");
    url.searchParams.delete("token");
    const search = url.searchParams.toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  } catch {
    return rawUrl.replace(
      /([?&])token=[^&]*/gi,
      (_match, separator: string) =>
        separator === "?" ? "?" : "",
    );
  }
}

function sendInvitationError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof GrantError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }

  return reply.status(500).send({
    error: "Session invitation request failed",
    code: "SESSION_INVITATION_REQUEST_FAILED",
  });
}

export default async function invitationRoutes(
  fastify: FastifyInstance,
  options: InvitationRouteOptions = {},
) {
  const database = options.database ?? db;
  const lookupInvitationFn =
    options.lookupInvitationFn ?? lookupInvitation;
  const respondToInvitationFn =
    options.respondToInvitationFn ?? respondToInvitation;
  const sharedRateLimit = fastify.rateLimit({
    max: 30,
    timeWindow: "1 minute",
    groupId: "session-invitations",
  });

  fastify.addHook(
    "onSend",
    async (_request, reply, payload) => {
      reply.header("Cache-Control", "no-store");
      return payload;
    },
  );

  fastify.get(
    "/current",
    {
      config: { rateLimit: false },
      preHandler: sharedRateLimit,
    },
    async (request, reply) => {
      try {
        const token = invitationCredential(
          request.headers.authorization,
        );
        const invitation = await lookupInvitationFn(
          database,
          token,
        );
        return reply.send(invitation);
      } catch (error) {
        if (!(error instanceof GrantError)) {
          request.log.error(
            { code: "SESSION_INVITATION_LOOKUP_FAILED" },
            "Session invitation lookup failed",
          );
        }
        return sendInvitationError(reply, error);
      }
    },
  );

  fastify.put(
    "/current/response",
    {
      config: { rateLimit: false },
      preHandler: sharedRateLimit,
      bodyLimit: 1024,
    },
    async (request, reply) => {
      try {
        const token = invitationCredential(
          request.headers.authorization,
        );
        const bodyResult =
          invitationDecisionSchema.safeParse(request.body);
        if (!bodyResult.success) {
          return reply.status(400).send({
            error: "Invalid invitation response",
            code: "INVALID_INVITATION_RESPONSE",
          });
        }

        const invitation = await respondToInvitationFn(
          database,
          token,
          bodyResult.data.decision,
        );
        return reply.send(invitation);
      } catch (error) {
        if (!(error instanceof GrantError)) {
          request.log.error(
            { code: "SESSION_INVITATION_RESPONSE_FAILED" },
            "Session invitation response failed",
          );
        }
        return sendInvitationError(reply, error);
      }
    },
  );
}
