import { db } from "../database/index.js";
import {
  sessions,
  registrations,
  registrationSessions,
  ticketTypes,
} from "../database/schema.js";
import { and, count, eq, inArray } from "drizzle-orm";
import { parseAllowedList } from "./ticketEligibility.js";

export async function countSessionEnrollments(
  eventId: number,
  sessionId: number
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(registrationSessions)
    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
    .where(
      and(
        eq(registrationSessions.sessionId, sessionId),
        eq(registrations.eventId, eventId),
        eq(registrations.status, "confirmed")
      )
    );

  return row?.count ?? 0;
}

export function isUndergraduateOnlyTicket(
  allowedRoles: string | null | undefined,
  allowedStudentLevels: string | null | undefined
): boolean {
  const roles = parseAllowedList(allowedRoles);
  const levels = parseAllowedList(allowedStudentLevels);
  return roles.includes("student") && levels.length === 1 && levels[0] === "undergraduate";
}

export function ticketAllowsOptionalSessionOptIn(
  allowedRoles: string | null | undefined,
  allowedStudentLevels: string | null | undefined
): boolean {
  return !isUndergraduateOnlyTicket(allowedRoles, allowedStudentLevels);
}

export type OptionalSessionValidationResult =
  | { ok: true; sessionIds: number[] }
  | { ok: false; error: string; code?: string };

export async function validateOptionalSessionSelections(
  eventId: number,
  primaryTicketId: number,
  optionalSessionIds: number[]
): Promise<OptionalSessionValidationResult> {
  const uniqueIds = [...new Set(optionalSessionIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length === 0) {
    return { ok: true, sessionIds: [] };
  }

  const [ticket] = await db
    .select({
      id: ticketTypes.id,
      eventId: ticketTypes.eventId,
      category: ticketTypes.category,
      allowedRoles: ticketTypes.allowedRoles,
      allowedStudentLevels: ticketTypes.allowedStudentLevels,
    })
    .from(ticketTypes)
    .where(eq(ticketTypes.id, primaryTicketId))
    .limit(1);

  if (!ticket || ticket.eventId !== eventId || ticket.category !== "primary") {
    return { ok: false, error: "Invalid ticket for optional session selection", code: "INVALID_TICKET" };
  }

  if (!ticketAllowsOptionalSessionOptIn(ticket.allowedRoles, ticket.allowedStudentLevels)) {
    return {
      ok: false,
      error: "Your ticket type cannot register for optional limited sessions",
      code: "OPTIONAL_SESSION_NOT_ALLOWED",
    };
  }

  const sessionRows = await db
    .select({
      id: sessions.id,
      eventId: sessions.eventId,
      requiresOptIn: sessions.requiresOptIn,
      maxCapacity: sessions.maxCapacity,
      isActive: sessions.isActive,
      sessionName: sessions.sessionName,
    })
    .from(sessions)
    .where(and(eq(sessions.eventId, eventId), inArray(sessions.id, uniqueIds)));

  if (sessionRows.length !== uniqueIds.length) {
    return { ok: false, error: "One or more selected sessions are invalid", code: "INVALID_SESSION" };
  }

  for (const session of sessionRows) {
    if (!session.isActive) {
      return { ok: false, error: `Session "${session.sessionName}" is not available`, code: "SESSION_INACTIVE" };
    }
    if (!session.requiresOptIn) {
      return {
        ok: false,
        error: `Session "${session.sessionName}" does not require opt-in registration`,
        code: "SESSION_NOT_OPT_IN",
      };
    }

    const enrolled = await countSessionEnrollments(eventId, session.id);
    if (session.maxCapacity && enrolled >= session.maxCapacity) {
      return {
        ok: false,
        error: `Session "${session.sessionName}" is full`,
        code: "SESSION_FULL",
      };
    }
  }

  return { ok: true, sessionIds: uniqueIds };
}

export async function enrichSessionsWithEnrollment(
  eventId: number,
  sessionList: Array<{
    id: number;
    requiresOptIn?: boolean | null;
    maxCapacity?: number | null;
    [key: string]: unknown;
  }>
) {
  const enriched = await Promise.all(
    sessionList.map(async (session) => {
      const enrolledCount = await countSessionEnrollments(eventId, session.id);
      const capacity = session.maxCapacity ?? 0;
      const seatsRemaining =
        capacity > 0 ? Math.max(0, capacity - enrolledCount) : null;

      return {
        ...session,
        enrolledCount,
        seatsRemaining,
        isFull: capacity > 0 ? enrolledCount >= capacity : false,
      };
    })
  );

  return enriched;
}
