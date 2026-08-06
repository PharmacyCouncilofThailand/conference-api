import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { TeamRegistrationError } from "./errors.js";
import { normalizeEmail } from "./normalization.js";

export interface OtpChallengeRecord {
  id: string;
  eventId: number;
  emailNormalized: string;
  otpHash: string;
  referenceCode: string;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
}

export interface OtpRepository {
  countRecentRequests(eventId: number, emailNormalized: string, since: Date): Promise<number>;
  supersedeActive(eventId: number, emailNormalized: string, at: Date): Promise<void>;
  createChallenge(input: {
    eventId: number;
    emailNormalized: string;
    otpHash: string;
    referenceCode: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<OtpChallengeRecord>;
  findChallenge(id: string): Promise<OtpChallengeRecord | null>;
  recordFailedAttempt(id: string): Promise<number>;
  markVerified(id: string, at: Date): Promise<void>;
  createAccessSession(input: {
    eventId: number;
    leaderEmailNormalized: string;
    tokenHash: string;
    otpChallengeId: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<void>;
}

export interface TeamOtpEmailInput {
  recipientEmail: string;
  eventName: string;
  otp: string;
  referenceCode: string;
  expiresAt: Date;
}

export function hashOtpSecret(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function createOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function createReferenceCode(): string {
  const bytes = randomBytes(5);
  return Array.from(bytes, (byte) => String.fromCharCode(65 + (byte % 26))).join("");
}

function secretsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createOtpService(dependencies: {
  repository: OtpRepository;
  secret: string;
  sendEmail: (input: TeamOtpEmailInput) => Promise<void>;
  now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async requestOtp(eventId: number, email: string, eventName: string) {
      const requestedAt = now();
      const emailNormalized = normalizeEmail(email);
      const cooldownCount = await dependencies.repository.countRecentRequests(
        eventId,
        emailNormalized,
        new Date(requestedAt.getTime() - 60 * 1000),
      );
      if (cooldownCount > 0) {
        throw new TeamRegistrationError(429, "OTP_RESEND_COOLDOWN", "กรุณารอ 1 นาทีก่อนขอรหัส OTP ใหม่");
      }
      const recentCount = await dependencies.repository.countRecentRequests(
        eventId,
        emailNormalized,
        new Date(requestedAt.getTime() - 60 * 60 * 1000),
      );
      if (recentCount >= 5) {
        throw new TeamRegistrationError(429, "OTP_RATE_LIMITED", "ขอรหัส OTP บ่อยเกินไป");
      }

      await dependencies.repository.supersedeActive(eventId, emailNormalized, requestedAt);
      const otp = createOtpCode();
      const referenceCode = createReferenceCode();
      const expiresAt = new Date(requestedAt.getTime() + 60 * 60 * 1000);
      const resendAvailableAt = new Date(requestedAt.getTime() + 60 * 1000);
      const challenge = await dependencies.repository.createChallenge({
        eventId,
        emailNormalized,
        otpHash: hashOtpSecret(otp, dependencies.secret),
        referenceCode,
        expiresAt,
        createdAt: requestedAt,
      });

      try {
        await dependencies.sendEmail({ recipientEmail: emailNormalized, eventName, otp, referenceCode, expiresAt });
      } catch (error) {
        await dependencies.repository.supersedeActive(eventId, emailNormalized, now());
        throw new TeamRegistrationError(503, "OTP_EMAIL_UNAVAILABLE", "ไม่สามารถส่ง OTP ได้ในขณะนี้");
      }

      return {
        challengeId: challenge.id,
        referenceCode,
        expiresAt: expiresAt.toISOString(),
        resendAvailableAt: resendAvailableAt.toISOString(),
      };
    },

    async verifyOtp(eventId: number, challengeId: string, otp: string, referenceCode: string) {
      const verifiedAt = now();
      const challenge = await dependencies.repository.findChallenge(challengeId);
      if (!challenge || challenge.eventId !== eventId) {
        throw new TeamRegistrationError(401, "OTP_INVALID", "รหัส OTP ไม่ถูกต้อง");
      }
      if (challenge.verifiedAt) {
        throw new TeamRegistrationError(409, "OTP_ALREADY_USED", "รหัส OTP ถูกใช้แล้ว");
      }
      if (challenge.supersededAt) {
        throw new TeamRegistrationError(401, "OTP_SUPERSEDED", "มีการขอรหัส OTP ใหม่แล้ว");
      }
      if (challenge.expiresAt.getTime() <= verifiedAt.getTime()) {
        throw new TeamRegistrationError(401, "OTP_EXPIRED", "รหัส OTP หมดอายุแล้ว");
      }
      if (challenge.attemptCount >= challenge.maxAttempts) {
        throw new TeamRegistrationError(429, "OTP_ATTEMPTS_EXCEEDED", "กรอกรหัส OTP ผิดเกินจำนวนครั้งที่กำหนด");
      }

      const otpMatches = secretsMatch(challenge.otpHash, hashOtpSecret(otp, dependencies.secret));
      const referenceMatches = secretsMatch(challenge.referenceCode, referenceCode);
      if (!otpMatches || !referenceMatches) {
        await dependencies.repository.recordFailedAttempt(challenge.id);
        throw new TeamRegistrationError(401, "OTP_INVALID", "รหัส OTP ไม่ถูกต้อง");
      }

      await dependencies.repository.markVerified(challenge.id, verifiedAt);
      const accessToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(verifiedAt.getTime() + 24 * 60 * 60 * 1000);
      await dependencies.repository.createAccessSession({
        eventId,
        leaderEmailNormalized: challenge.emailNormalized,
        tokenHash: hashOtpSecret(accessToken, dependencies.secret),
        otpChallengeId: challenge.id,
        expiresAt,
        createdAt: verifiedAt,
      });

      return { accessToken, expiresAt: expiresAt.toISOString(), leaderEmail: challenge.emailNormalized };
    },
  };
}
