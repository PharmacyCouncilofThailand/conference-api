import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  registrationSessions,
  registrations,
  sessions,
  ticketTypes,
} from "../../database/schema.js";
import type { GrantDatabase } from "./types.js";

export async function getRegistrationSessionEntitlements(
  database: GrantDatabase,
  registrationId: number,
) {
  return database
    .select({
      sessionId: sessions.id,
      sessionName: sessions.sessionName,
      sessionType: sessions.sessionType,
      sessionStartTime: sessions.startTime,
      sessionEndTime: sessions.endTime,
      sessionRoom: sessions.room,
      source: registrationSessions.source,
      grantedAt: registrationSessions.createdAt,
    })
    .from(registrationSessions)
    .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
    .where(eq(registrationSessions.registrationId, registrationId))
    .orderBy(sessions.startTime);
}

export async function findOwnedSessionIds(
  database: GrantDatabase,
  userId: number,
  eventId: number,
  intendedSessionIds: number[],
): Promise<number[]> {
  if (intendedSessionIds.length === 0) return [];
  const rows = await database
    .select({ sessionId: registrationSessions.sessionId })
    .from(registrationSessions)
    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
    .where(and(
      eq(registrations.userId, userId),
      eq(registrations.eventId, eventId),
      eq(registrations.status, "confirmed"),
      inArray(registrationSessions.sessionId, intendedSessionIds),
    ));
  return [...new Set(rows.map((row) => row.sessionId))].sort((a, b) => a - b);
}

export async function hasWorkshopEntitlement(
  database: GrantDatabase,
  userId: number,
  eventId: number,
): Promise<boolean> {
  const rows = await database
    .select({ id: registrationSessions.id })
    .from(registrationSessions)
    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
    .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
    .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
    .where(and(
      eq(registrations.userId, userId),
      eq(registrations.eventId, eventId),
      eq(registrations.status, "confirmed"),
      or(
        eq(sessions.sessionType, "workshop"),
        sql`LOWER(COALESCE(${ticketTypes.groupName}, '')) = 'workshop'`,
      ),
    ))
    .limit(1);
  return rows.length > 0;
}
