import { createHash } from "node:crypto";
import type { SessionBlockCode, SkipCode } from "./types.js";

export function sessionBlock(
  session: { isActive: boolean; endTime: Date },
  now: Date,
): SessionBlockCode | null {
  if (!session.isActive) return "SESSION_INACTIVE";
  if (
    !Number.isFinite(session.endTime.getTime()) ||
    session.endTime.getTime() <= now.getTime()
  ) {
    return "SESSION_ENDED";
  }
  return null;
}

export function registrationBlock(
  row: { eventId: number; status: string } | null,
  eventId: number,
  alreadyLinked: boolean,
): SkipCode | null {
  if (!row) return "REGISTRATION_NOT_FOUND";
  if (row.eventId !== eventId) return "EVENT_MISMATCH";
  if (row.status !== "confirmed") return "REGISTRATION_NOT_CONFIRMED";
  return alreadyLinked ? "ALREADY_REGISTERED" : null;
}

export function canonicalRequest(sessionId: number, registrationIds: number[]) {
  return {
    sessionId,
    registrationIds: [...new Set(registrationIds)].sort((a, b) => a - b),
  };
}

export function requestHash(
  sessionId: number,
  registrationIds: number[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalRequest(sessionId, registrationIds)))
    .digest("hex");
}
