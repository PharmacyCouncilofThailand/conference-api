import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../database/index.js";
import { teamRegistrationAccessSessions } from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import { hashOtpSecret } from "./otp.service.js";
import type { VerifiedTeamAccess } from "./types.js";

export async function requireTeamAccess(
  eventId: number,
  authorizationHeader: string | undefined,
): Promise<VerifiedTeamAccess> {
  const [scheme, token] = authorizationHeader?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) {
    throw new TeamRegistrationError(401, "ACCESS_SESSION_REQUIRED", "กรุณายืนยัน Email ก่อนดำเนินการ");
  }
  const secret = process.env.TEAM_REGISTRATION_SESSION_SECRET;
  if (!secret) throw new TeamRegistrationError(500, "TEAM_REGISTRATION_CONFIG_ERROR", "ระบบยังไม่พร้อมใช้งาน");
  const tokenHash = hashOtpSecret(token, secret);
  const now = new Date();
  const [session] = await db
    .select()
    .from(teamRegistrationAccessSessions)
    .where(and(
      eq(teamRegistrationAccessSessions.eventId, eventId),
      eq(teamRegistrationAccessSessions.tokenHash, tokenHash),
      isNull(teamRegistrationAccessSessions.revokedAt),
      gt(teamRegistrationAccessSessions.expiresAt, now),
    ))
    .limit(1);
  if (!session) throw new TeamRegistrationError(401, "ACCESS_SESSION_EXPIRED", "Session หมดอายุ กรุณายืนยัน OTP ใหม่");
  await db.update(teamRegistrationAccessSessions).set({ lastActivityAt: now }).where(eq(teamRegistrationAccessSessions.id, session.id));
  return { eventId, leaderEmailNormalized: session.leaderEmailNormalized, sessionId: session.id };
}
