import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { events, registrations, registrationSessions, sessions, sessionInvitations } from "../../database/schema.js";
import { buildEventEmailContext } from "../../services/emailTemplates.types.js";
import { renderGrantEmail, renderInvitationEmail } from "./email-template.js";
import { participantKey } from "./invitation-policy.js";
import { canonicalRequest, registrationBlock, sessionBlock } from "./policy.js";
import { GrantError, type GrantDatabase, type SkipCode } from "./types.js";

export interface GrantEmailPreview {
  emails: { registrationId: number; name: string; recipient: string; subject: string; html: string }[];
  skipped: { registrationId: number; reasonCode: SkipCode }[];
}

export async function previewGrantEmails(
  database: GrantDatabase,
  input: { sessionId: number; registrationIds: number[] },
): Promise<GrantEmailPreview> {
  const canonical = canonicalRequest(input.sessionId, input.registrationIds);
  const [session] = await database.select({
    id: sessions.id, eventId: sessions.eventId, sessionName: sessions.sessionName,
    sessionType: sessions.sessionType, startTime: sessions.startTime, endTime: sessions.endTime,
    room: sessions.room, isActive: sessions.isActive,
    requiresConfirmation: sessions.adminGrantRequiresConfirmation,
    eventName: events.eventName, startDate: events.startDate, endDate: events.endDate,
    location: events.location,
  }).from(sessions).innerJoin(events, eq(sessions.eventId, events.id))
    .where(eq(sessions.id, canonical.sessionId)).limit(1);
  if (!session) throw new GrantError(404, "SESSION_NOT_FOUND", "Session not found");
  const [{ now: rawNow }] = await database.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  const now = rawNow instanceof Date ? rawNow : new Date(rawNow);
  const blocked = session.requiresConfirmation
    ? !session.isActive ? "SESSION_INACTIVE"
      : !Number.isFinite(session.startTime.getTime()) || session.startTime <= now ? "SESSION_RESPONSE_CLOSED" : null
    : sessionBlock(session, now);
  if (blocked) throw new GrantError(409, blocked, "Session is unavailable");

  const rows = await database.select({
    id: registrations.id, userId: registrations.userId, eventId: registrations.eventId,
    status: registrations.status, regCode: registrations.regCode, email: registrations.email,
    firstName: registrations.firstName, lastName: registrations.lastName,
  }).from(registrations).where(inArray(registrations.id, canonical.registrationIds)).orderBy(asc(registrations.id));
  const userIds = rows.map(row => row.userId).filter((id): id is number => id !== null);
  const scope = or(inArray(registrations.id, canonical.registrationIds),
    userIds.length ? inArray(registrations.userId, userIds) : undefined);
  const existing = await database.select({
    id: registrations.id, userId: registrations.userId,
    hasSession: exists(database.select({ id: registrationSessions.id }).from(registrationSessions)
      .where(and(eq(registrationSessions.registrationId, registrations.id), eq(registrationSessions.sessionId, session.id)))),
    hasInvitation: exists(database.select({ id: sessionInvitations.id }).from(sessionInvitations)
      .where(and(eq(sessionInvitations.registrationId, registrations.id), eq(sessionInvitations.sessionId, session.id),
        eq(sessionInvitations.status, "pending"), sql`${sessionInvitations.expiresAt} > ${now.toISOString()}::timestamptz`))),
  }).from(registrations).where(and(scope, eq(registrations.eventId, session.eventId), eq(registrations.status, "confirmed")));
  const enrolled = new Set(existing.filter(row => row.hasSession).map(participantKey));
  const invited = new Set(existing.filter(row => row.hasInvitation && session.startTime > now).map(participantKey));
  const selected = new Set<string>();
  const byId = new Map(rows.map(row => [row.id, row]));
  const context = buildEventEmailContext({
    eventName: session.eventName, startDate: session.startDate, endDate: session.endDate,
    location: session.location, websiteUrl: null, shortName: null,
  });
  const result: GrantEmailPreview = { emails: [], skipped: [] };
  for (const registrationId of canonical.registrationIds) {
    const row = byId.get(registrationId) ?? null;
    let reasonCode = registrationBlock(row, session.eventId, false);
    if (!reasonCode && row) {
      const key = participantKey(row);
      reasonCode = enrolled.has(key) ? "ALREADY_REGISTERED" : invited.has(key) ? "ALREADY_INVITED"
        : selected.has(key) ? "DUPLICATE_PARTICIPANT" : null;
      if (!reasonCode) selected.add(key);
    }
    if (reasonCode || !row) {
      result.skipped.push({ registrationId, reasonCode: reasonCode ?? "REGISTRATION_NOT_FOUND" });
      continue;
    }
    const name = `${row.firstName} ${row.lastName}`.trim();
    const snapshot = {
      personName: name, regCode: row.regCode, eventName: context.eventName,
      eventShortName: context.shortName, eventDates: context.dates, eventVenue: context.venue,
      sessionName: session.sessionName, sessionType: session.sessionType,
      startTime: session.startTime.toISOString(), endTime: session.endTime.toISOString(), room: session.room,
      participantUrl: null,
    };
    const rendered = session.requiresConfirmation
      ? renderInvitationEmail(snapshot, "https://preview.invalid/", session.startTime.toISOString())
      : renderGrantEmail(snapshot);
    result.emails.push({ registrationId, name, recipient: row.email, subject: rendered.subject, html: rendered.html });
  }
  return result;
}
