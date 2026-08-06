import assert from "node:assert/strict";
import test from "node:test";
import { createOtpService, hashOtpSecret, type OtpChallengeRecord, type OtpRepository } from "./otp.service.js";

function createMemoryRepository() {
  const challenges = new Map<string, OtpChallengeRecord>();
  const sessions: Array<{ eventId: number; email: string; tokenHash: string }> = [];
  let sequence = 0;
  const repository: OtpRepository = {
    async countRecentRequests(eventId, emailNormalized, since) {
      return Array.from(challenges.values()).filter((challenge) =>
        challenge.eventId === eventId
        && challenge.emailNormalized === emailNormalized
        && challenge.createdAt > since,
      ).length;
    },
    async supersedeActive(eventId, email, at) {
      for (const challenge of challenges.values()) {
        if (challenge.eventId === eventId && challenge.emailNormalized === email && !challenge.verifiedAt) challenge.supersededAt = at;
      }
    },
    async createChallenge(input) {
      const record: OtpChallengeRecord = { id: `challenge-${++sequence}`, ...input, attemptCount: 0, maxAttempts: 5, verifiedAt: null, supersededAt: null };
      challenges.set(record.id, record);
      return record;
    },
    async findChallenge(id) { return challenges.get(id) ?? null; },
    async recordFailedAttempt(id) { const row = challenges.get(id)!; row.attemptCount += 1; return row.attemptCount; },
    async markVerified(id, at) { challenges.get(id)!.verifiedAt = at; },
    async createAccessSession(input) { sessions.push({ eventId: input.eventId, email: input.leaderEmailNormalized, tokenHash: input.tokenHash }); },
  };
  return { repository, challenges, sessions };
}

test("requests a hashed OTP with one-hour expiry and five-letter reference", async () => {
  const memory = createMemoryRepository();
  const sent: Array<{ otp: string; referenceCode: string }> = [];
  const service = createOtpService({
    repository: memory.repository,
    secret: "test-secret",
    sendEmail: async (input) => { sent.push({ otp: input.otp, referenceCode: input.referenceCode }); },
    now: () => new Date("2026-08-15T00:00:00.000Z"),
  });

  const result = await service.requestOtp(7, " Leader@Example.com ", "Event");
  const stored = memory.challenges.get(result.challengeId)!;
  assert.match(sent[0].otp, /^\d{6}$/);
  assert.match(result.referenceCode, /^[A-Z]{5}$/);
  assert.equal(stored.otpHash, hashOtpSecret(sent[0].otp, "test-secret"));
  assert.notEqual(stored.otpHash, sent[0].otp);
  assert.equal(stored.expiresAt.toISOString(), "2026-08-15T01:00:00.000Z");
  assert.equal(result.resendAvailableAt, "2026-08-15T00:01:00.000Z");
});

test("requires a sixty-second cooldown before requesting another OTP", async () => {
  const memory = createMemoryRepository();
  let currentTime = new Date("2026-08-15T00:00:00.000Z");
  const service = createOtpService({
    repository: memory.repository,
    secret: "test-secret",
    sendEmail: async () => {},
    now: () => currentTime,
  });

  await service.requestOtp(7, "leader@example.com", "Event");
  currentTime = new Date("2026-08-15T00:00:59.000Z");
  await assert.rejects(
    service.requestOtp(7, "leader@example.com", "Event"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OTP_RESEND_COOLDOWN",
  );

  currentTime = new Date("2026-08-15T00:01:00.000Z");
  await assert.doesNotReject(service.requestOtp(7, "leader@example.com", "Event"));
});

test("verifies once and issues a hashed opaque access session", async () => {
  const memory = createMemoryRepository();
  let deliveredOtp = "";
  const service = createOtpService({
    repository: memory.repository,
    secret: "test-secret",
    sendEmail: async (input) => { deliveredOtp = input.otp; },
    now: () => new Date("2026-08-15T00:00:00.000Z"),
  });
  const requested = await service.requestOtp(7, "leader@example.com", "Event");
  const verified = await service.verifyOtp(7, requested.challengeId, deliveredOtp, requested.referenceCode);
  assert.ok(verified.accessToken.length >= 40);
  assert.notEqual(memory.sessions[0].tokenHash, verified.accessToken);
  await assert.rejects(
    service.verifyOtp(7, requested.challengeId, deliveredOtp, requested.referenceCode),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OTP_ALREADY_USED",
  );
});

test("locks a challenge after five invalid OTP attempts", async () => {
  const memory = createMemoryRepository();
  const service = createOtpService({ repository: memory.repository, secret: "test-secret", sendEmail: async () => {}, now: () => new Date("2026-08-15T00:00:00.000Z") });
  const requested = await service.requestOtp(7, "leader@example.com", "Event");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(service.verifyOtp(7, requested.challengeId, "000000", requested.referenceCode));
  }
  await assert.rejects(
    service.verifyOtp(7, requested.challengeId, "000000", requested.referenceCode),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OTP_ATTEMPTS_EXCEEDED",
  );
});
