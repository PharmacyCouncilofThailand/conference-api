import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvitationUrl,
  decryptInvitationToken,
  hashInvitationToken,
  issueInvitationToken,
  readInvitationEncryptionKey,
  parseInvitationFrontendOrigin,
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

test("encryption key configuration requires only canonical base64 of exactly 32 bytes", () => {
  assert.equal(readInvitationEncryptionKey({
    SESSION_INVITATION_ENCRYPTION_KEY: keyBase64,
  }).equals(key), true);
  for (const encoded of [undefined, "", "bad", keyBase64.slice(0, -1),
    Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"),
    keyBase64.replace(/=$/, "==")]) {
    assertSafeError(
      () => readInvitationEncryptionKey({ SESSION_INVITATION_ENCRYPTION_KEY: encoded }),
      "SESSION_INVITATION_CONFIG_ERROR",
      [encoded || "never-present-secret"],
    );
  }
});

test("Event invitation origins normalize root URLs and enforce production/local rules", () => {
  for (const nodeEnv of ["production", "test", "development", undefined]) {
    for (const value of ["https://pris.example.test", "https://pris.example.test/"]) {
      assert.equal(parseInvitationFrontendOrigin(value, nodeEnv), "https://pris.example.test");
    }
  }
  for (const nodeEnv of ["test", "development"]) {
    for (const origin of ["http://localhost:3004", "http://127.0.0.1:3004", "http://[::1]:3004"]) {
      assert.equal(parseInvitationFrontendOrigin(`${origin}/`, nodeEnv), origin);
    }
  }
  for (const nodeEnv of ["production", "test", "development"]) {
    const invalid = [null, undefined, "", "   ", "not-a-url", "http://pris.example.test",
      "https://user:pass@pris.example.test", "https://pris.example.test/pris",
      "https://pris.example.test/?query=x", "https://pris.example.test/#fragment",
      "ftp://localhost:3004"];
    if (nodeEnv === "production") invalid.push("http://localhost:3004", "http://127.0.0.1:3004", "http://[::1]:3004");
    for (const value of invalid) {
      assertSafeError(() => parseInvitationFrontendOrigin(value, nodeEnv),
        "SESSION_INVITATION_CONFIG_ERROR", [value?.trim() || "never-present-secret"]);
    }
  }
});
