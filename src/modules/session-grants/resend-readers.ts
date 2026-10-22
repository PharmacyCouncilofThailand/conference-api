import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { events, sessions, registrations, sessionInvitations as invitations,
  registrationSessionGrantItems as items, registrationSessionGrantEmailAttempts as attempts,
  sessionInvitationResendRequests as requests } from "../../database/schema.js";
import { buildEventEmailContext } from "../../services/emailTemplates.types.js";
import type { InvitationNotificationSnapshot } from "./email-template.js";
import type { ResendCandidate, ResendInput, ResendOperationDto, ResendResult, ResendDeliveryState } from "./resend-types.js";
import { GrantError, type GrantDatabase, type GrantTransaction } from "./types.js";

// Session/event columns are timestamp without time zone, storing UTC wall time.
const utc = (column: typeof sessions.startTime | typeof sessions.endTime | typeof events.startDate | typeof events.endDate) =>
  sql<Date>`(${column} AT TIME ZONE 'UTC')`.mapWith((value: string | Date) => new Date(value));

export async function readResendCandidates(tx: GrantTransaction, input: ResendInput): Promise<ResendCandidate[]> {
  if (!input.invitationIds.length) return [];
  const rows = await tx.select({
    invitationId: invitations.id, itemId: items.id, registrationId: invitations.registrationId,
    sessionId: invitations.sessionId, invitationStatus: invitations.status,
    expiresAt: invitations.expiresAt, tokenHash: invitations.tokenHash, tokenCiphertext: invitations.tokenCiphertext,
    emailStatus: items.emailStatus, recipientEmail: items.recipientEmailSnapshot, name: items.nameSnapshot,
    notificationSnapshot: items.notificationSnapshot,
    registrationStatus: registrations.status, registrationEventId: registrations.eventId,
    sessionEventId: sessions.eventId, sessionIsActive: sessions.isActive,
    sessionName: sessions.sessionName, sessionType: sessions.sessionType,
    sessionStartTime: utc(sessions.startTime), sessionEndTime: utc(sessions.endTime), room: sessions.room,
    eventName: events.eventName, eventStartDate: utc(events.startDate), eventEndDate: utc(events.endDate),
    eventLocation: events.location, lastResendQueuedAt: items.lastResendQueuedAt,
    lastSuccessfulSentAt: sql<Date | null>`(SELECT CASE WHEN count(*) FILTER (WHERE a.result = 'sent') > 0
      THEN max(a.finished_at) FILTER (WHERE a.result = 'sent') ELSE ${items.sentAt} END
      FROM registration_session_grant_email_attempts a WHERE a.item_id = ${items.id})`
      .mapWith((value: string | Date | null) => value === null ? null : new Date(value)),
  }).from(invitations).innerJoin(items, eq(invitations.grantItemId, items.id))
    .innerJoin(registrations, eq(invitations.registrationId, registrations.id))
    .innerJoin(sessions, eq(invitations.sessionId, sessions.id))
    .innerJoin(events, eq(sessions.eventId, events.id))
    .where(and(eq(invitations.sessionId, input.sessionId), eq(items.outcome, "invited"),
      inArray(invitations.id, input.invitationIds)));
  return rows as ResendCandidate[];
}

export function buildResendSnapshot(candidate: ResendCandidate): InvitationNotificationSnapshot {
  const original = candidate.notificationSnapshot;
  const invalid = () => new GrantError(422, "INVITATION_PAYLOAD_INVALID", "Invitation payload is unavailable or malformed");
  if (!original || typeof original !== "object" ||
    ["regCode", "eventName", "eventShortName", "eventDates", "eventVenue", "sessionName", "startTime", "endTime", "responseOrigin"]
      .some(key => typeof (original as unknown as Record<string, unknown>)[key] !== "string") ||
    !(original.personName === null || typeof original.personName === "string") ||
    !(original.participantUrl === null || typeof original.participantUrl === "string") ||
    !(original.room === null || typeof original.room === "string") ||
    !(original.sessionType === null || typeof original.sessionType === "string")) throw invalid();
  try {
    const origin = new URL(original.responseOrigin);
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) throw invalid();
    for (const value of [candidate.sessionStartTime, candidate.sessionEndTime, candidate.eventStartDate, candidate.eventEndDate]) {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalid();
    }
    const event = buildEventEmailContext({ eventName: candidate.eventName, startDate: candidate.eventStartDate,
      endDate: candidate.eventEndDate, location: candidate.eventLocation, shortName: original.eventShortName, websiteUrl: null });
    return { ...original, eventName: event.eventName, eventDates: event.dates, eventVenue: event.venue,
      sessionName: candidate.sessionName, sessionType: candidate.sessionType,
      startTime: candidate.sessionStartTime.toISOString(), endTime: candidate.sessionEndTime.toISOString(), room: candidate.room };
  } catch { throw invalid(); }
}

export async function getResendOperation(database: GrantDatabase, requestId: string, page: number, limit: number): Promise<ResendOperationDto | null> {
  return database.transaction(async tx => {
    const [request] = await tx.select({ result: requests.result, actorId: requests.actorId, createdAt: requests.createdAt })
      .from(requests).where(eq(requests.id, requestId)).limit(1);
    if (!request) return null;
    const result = request.result as ResendResult;
    const queuedIds = result.queued.map(entry => entry.itemId);
    const itemRows = queuedIds.length ? await tx.select({ id: items.id, batchId: items.batchId,
      recipient: items.recipientEmailSnapshot, name: items.nameSnapshot,
      emailStatus: items.emailStatus, nextResendRequestId: items.nextResendRequestId }).from(items).where(inArray(items.id, queuedIds)) : [];
    const attemptRows = queuedIds.length ? await tx.select({ itemId: attempts.itemId, attemptNo: attempts.attemptNo,
      result: attempts.result, finishedAt: attempts.finishedAt, errorCode: attempts.errorCode })
      .from(attempts).where(and(eq(attempts.resendRequestId, requestId), inArray(attempts.itemId, queuedIds)))
      .orderBy(desc(attempts.attemptNo)) : [];
    const byItem = new Map(itemRows.map(item => [item.id, item]));
    const latest = new Map<string, typeof attemptRows[number]>();
    for (const attempt of attemptRows) if (!latest.has(attempt.itemId)) latest.set(attempt.itemId, attempt);
    const summary: ResendOperationDto["summary"] = { waiting: 0, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 };
    const entries = result.queued.map(entry => {
      const item = byItem.get(entry.itemId);
      const attempt = latest.get(entry.itemId);
      // A retry may be queued before its next attempt exists. Only this operation's
      // active queue metadata can override its latest historical attempt.
      const activeState = item?.nextResendRequestId === requestId
        ? item.emailStatus === "pending" ? "waiting" : item.emailStatus === "sending" ? "sending" : null
        : null;
      const state = (activeState ?? attempt?.result ?? "waiting") as ResendDeliveryState;
      summary[state]++;
      return { ...entry, batchId: item?.batchId ?? "", recipient: item?.recipient ?? null, name: item?.name ?? null,
        state, attemptNo: attempt?.attemptNo ?? null, finishedAt: attempt?.finishedAt?.toISOString() ?? null, errorCode: attempt?.errorCode ?? null };
    });
    return { result, actorId: request.actorId, createdAt: request.createdAt.toISOString(), summary,
      entries: entries.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total: entries.length, totalPages: entries.length ? Math.ceil(entries.length / limit) : 0 } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

