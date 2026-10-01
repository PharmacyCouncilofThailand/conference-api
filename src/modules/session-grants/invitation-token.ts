import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { TokenEnvelope } from "./types.js";
import { GrantError } from "./types.js";

const tokenPattern = /^[a-f0-9]{64}$/;

export function hashInvitationToken(rawToken: string): string {
  if (!tokenPattern.test(rawToken)) {
    throw new GrantError(
      401,
      "INVALID_INVITATION_TOKEN",
      "Invalid invitation token",
    );
  }
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function readInvitationConfig(
  env: NodeJS.ProcessEnv,
): { key: Buffer; frontendOrigin: string } {
  const encoded = env.SESSION_INVITATION_ENCRYPTION_KEY?.trim() ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Invitation encryption is not configured",
    );
  }

  let url: URL;
  try {
    url = new URL(env.PRIS_FRONTEND_URL ?? "");
  } catch {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Invitation frontend is not configured",
    );
  }

  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const localHttp =
    env.NODE_ENV !== "production" && localhost && url.protocol === "http:";
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Invitation frontend must be a trusted origin",
    );
  }

  return { key, frontendOrigin: url.origin };
}

export function issueInvitationToken(
  invitationId: string,
  key: Buffer,
): { rawToken: string; tokenHash: string; envelope: TokenEnvelope } {
  const rawToken = randomBytes(32).toString("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(invitationId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(rawToken, "utf8"),
    cipher.final(),
  ]);
  const envelope: TokenEnvelope = {
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return {
    rawToken,
    tokenHash: hashInvitationToken(rawToken),
    envelope,
  };
}

export function decryptInvitationToken(
  invitationId: string,
  envelope: TokenEnvelope,
  key: Buffer,
): string {
  try {
    if (envelope.version !== 1) throw new Error("version");
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("envelope");

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(invitationId, "utf8"));
    decipher.setAuthTag(tag);
    const token = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    hashInvitationToken(token);
    return token;
  } catch {
    throw new GrantError(
      503,
      "INVITATION_PAYLOAD_INVALID",
      "Invitation email payload is unavailable",
    );
  }
}

export function buildInvitationUrl(
  rawToken: string,
  frontendOrigin: string,
): string {
  hashInvitationToken(rawToken);
  const url = new URL("/th/sessions/confirm", frontendOrigin);
  url.searchParams.set("token", rawToken);
  return url.toString();
}
