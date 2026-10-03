import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptRewardCode,
  decryptRewardToken,
  hashRewardCredential,
  issueRewardProof,
  issueRewardToken,
  normalizeRewardCredential,
  readRewardEncryptionKey,
  retryRewardProof,
} from "./rewards.js";

const spinId = "123e4567-e89b-42d3-a456-426614174000";
const key = Buffer.alloc(32, 11);
const encodedKey = key.toString("base64");

test("reward token uses PRIS-REWARD QR prefix, stable digest and award-bound AES-GCM envelope", () => {
  const first = issueRewardToken(spinId, key);
  const second = issueRewardToken(spinId, key);
  assert.match(first.rawToken, /^[a-f0-9]{64}$/);
  assert.equal(first.qrPayload, `PRIS-REWARD:${first.rawToken}`);
  assert.equal(first.tokenDigest, hashRewardCredential(first.rawToken));
  assert.notEqual(first.tokenDigest, first.rawToken);
  assert.notEqual(first.rawToken, second.rawToken);
  assert.notEqual(first.envelope.nonce, second.envelope.nonce);
  assert.equal(decryptRewardToken(spinId, first.envelope, key), first.rawToken);
});

test("reward proof keeps an encrypted recoverable 80-bit human code with the token", () => {
  const proof = issueRewardProof(spinId, key);
  assert.match(proof.rawCode, /^[A-F0-9]{20}$/);
  assert.match(proof.displayCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/);
  assert.equal(proof.codeDigest, hashRewardCredential(proof.rawCode));
  assert.equal(decryptRewardToken(spinId, proof.envelope, key), proof.rawToken);
  assert.equal(decryptRewardCode(spinId, proof.envelope, key), proof.rawCode);
});

test("reward credential collision retry stops after at most three attempts", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      retryRewardProof(spinId, key, async (_proof, attempt) => {
        attempts = attempt;
        return null;
      }),
    /collision limit/i,
  );
  assert.equal(attempts, 3);

  attempts = 0;
  const value = await retryRewardProof(spinId, key, async (_proof, attempt) => {
    attempts = attempt;
    return attempt === 2 ? "persisted" : null;
  });
  assert.equal(value, "persisted");
  assert.equal(attempts, 2);
});

test("reward token fails closed for tampering, wrong key and wrong award", () => {
  const issued = issueRewardToken(spinId, key);
  const cases = [
    () => decryptRewardToken(spinId, { ...issued.envelope, tag: Buffer.alloc(16, 1).toString("base64") }, key),
    () => decryptRewardToken(spinId, { ...issued.envelope, ciphertext: Buffer.from("tampered").toString("base64") }, key),
    () => decryptRewardToken(spinId, issued.envelope, Buffer.alloc(32, 12)),
    () => decryptRewardToken("223e4567-e89b-42d3-a456-426614174000", issued.envelope, key),
  ];
  for (const run of cases) assert.throws(run, /reward credential/i);
});

test("reward encryption key is a separate canonical base64 32-byte secret", () => {
  assert.equal(readRewardEncryptionKey({ LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY: encodedKey }).equals(key), true);
  for (const value of [undefined, "", "bad", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")]) {
    assert.throws(() => readRewardEncryptionKey({ LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY: value }), /reward encryption/i);
  }
  assert.throws(
    () => readRewardEncryptionKey({ SESSION_INVITATION_ENCRYPTION_KEY: encodedKey }),
    /reward encryption/i,
  );
});

test("lookup normalization accepts QR token and grouped human code without mixing formats", () => {
  const issued = issueRewardToken(spinId, key);
  assert.deepEqual(normalizeRewardCredential(`PRIS-REWARD:${issued.rawToken}`), {
    kind: "token",
    normalized: issued.rawToken,
  });
  assert.deepEqual(normalizeRewardCredential("a1b2-c3d4-e5f6-7890-abcd"), {
    kind: "code",
    normalized: "A1B2C3D4E5F67890ABCD",
  });
  for (const value of ["", "PRIS-REWARD:", "PRIS-REWARD:ABC", "not-a-code", "A1B2"]) {
    assert.throws(() => normalizeRewardCredential(value), /reward credential/i);
  }
});
