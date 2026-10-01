import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvitationUrl,
  decryptInvitationToken,
  hashInvitationToken,
  issueInvitationToken,
  readInvitationConfig,
} from "./invitation-token.js";
import { GrantError } from "./types.js";

const key = Buffer.alloc(32, 7);
const keyBase64 = key.toString("base64");
const invitationId = "123e4567-e89b-42d3-a456-426614174000";

function assertSafeError(
  fn: () => unknown,
  expectedCode: string,
  forbidden: string[],
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof GrantError);
    assert.equal(error.code, expectedCode);
    const message = error.message;
    for (const secret of forbidden) assert.equal(message.includes(secret), false);
    return true;
  });
}

test("invitation token round trips while hash and nonce remain non-recoverable metadata", () => {
  const first = issueInvitationToken(invitationId, key);
  const second = issueInvitationToken(invitationId, key);

  assert.match(first.rawToken, /^[a-f0-9]{64}$/);
  assert.equal(first.tokenHash, hashInvitationToken(first.rawToken));
  assert.notEqual(first.tokenHash, first.rawToken);
  assert.notEqual(first.rawToken, second.rawToken);
  assert.notEqual(first.envelope.nonce, second.envelope.nonce);
  assert.equal(
    decryptInvitationToken(invitationId, first.envelope, key),
    first.rawToken,
  );

  const url = new URL(buildInvitationUrl(first.rawToken, "https://pris.example.test"));
  assert.equal(url.origin, "https://pris.example.test");
  assert.equal(url.pathname, "/th/sessions/confirm");
  assert.equal(url.searchParams.get("token"), first.rawToken);
});

test("tampered invitation payloads and wrong binding fail closed without leaking token", () => {
  const issued = issueInvitationToken(invitationId, key);
  const wrongKey = Buffer.alloc(32, 8);
  const otherInvitationId = "223e4567-e89b-42d3-a456-426614174000";

  const cases = [
    () => decryptInvitationToken(
      invitationId,
      { ...issued.envelope, tag: Buffer.alloc(16, 1).toString("base64") },
      key,
    ),
    () => decryptInvitationToken(
      invitationId,
      { ...issued.envelope, version: 2 as 1 },
      key,
    ),
    () => decryptInvitationToken(
      invitationId,
      { ...issued.envelope, ciphertext: Buffer.from("tampered").toString("base64") },
      key,
    ),
    () => decryptInvitationToken(invitationId, issued.envelope, wrongKey),
    () => decryptInvitationToken(otherInvitationId, issued.envelope, key),
  ];

  for (const run of cases) {
    assertSafeError(run, "INVITATION_PAYLOAD_INVALID", [issued.rawToken, keyBase64]);
  }
});

test("raw invitation credential format is exactly 64 lowercase hex characters", () => {
  for (const candidate of ["", "abc", "A".repeat(64), "g".repeat(64), "0".repeat(63), "0".repeat(65)]) {
    assertSafeError(
      () => hashInvitationToken(candidate),
      "INVALID_INVITATION_TOKEN",
      [candidate || "never-present-secret"],
    );
  }
});

test("invitation config requires exact 32-byte base64 key and trusted frontend origin", () => {
  const valid = readInvitationConfig({
    NODE_ENV: "production",
    SESSION_INVITATION_ENCRYPTION_KEY: keyBase64,
    PRIS_FRONTEND_URL: "https://pris.example.test",
  } as NodeJS.ProcessEnv);
  assert.equal(valid.key.equals(key), true);
  assert.equal(valid.frontendOrigin, "https://pris.example.test");

  const local = readInvitationConfig({
    NODE_ENV: "test",
    SESSION_INVITATION_ENCRYPTION_KEY: keyBase64,
    PRIS_FRONTEND_URL: "http://localhost:3004",
  } as NodeJS.ProcessEnv);
  assert.equal(local.frontendOrigin, "http://localhost:3004");

  const invalidEnvs: NodeJS.ProcessEnv[] = [
    { NODE_ENV: "production", SESSION_INVITATION_ENCRYPTION_KEY: "bad", PRIS_FRONTEND_URL: "https://pris.example.test" },
    { NODE_ENV: "production", SESSION_INVITATION_ENCRYPTION_KEY: keyBase64, PRIS_FRONTEND_URL: "http://pris.example.test" },
    { NODE_ENV: "production", SESSION_INVITATION_ENCRYPTION_KEY: keyBase64, PRIS_FRONTEND_URL: "https://user:pass@pris.example.test" },
    { NODE_ENV: "production", SESSION_INVITATION_ENCRYPTION_KEY: keyBase64, PRIS_FRONTEND_URL: "https://pris.example.test/path" },
    { NODE_ENV: "production", SESSION_INVITATION_ENCRYPTION_KEY: keyBase64, PRIS_FRONTEND_URL: "https://pris.example.test/?query=x" },
    { NODE_ENV: "production", SESSION_INVITATION_ENCRYPTION_KEY: keyBase64, PRIS_FRONTEND_URL: "not-a-url" },
  ];

  for (const env of invalidEnvs) {
    assertSafeError(
      () => readInvitationConfig(env),
      "SESSION_INVITATION_CONFIG_ERROR",
      [keyBase64, env.PRIS_FRONTEND_URL ?? ""],
    );
  }
});
