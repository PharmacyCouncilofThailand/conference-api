import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  registrationSessionGrantBatches as batches,
  registrationSessionGrantItems as items,
  registrations,
  sessionInvitations as invitations,
  sessions,
} from "../../database/schema.js";
import { effectiveDeadline, effectiveInvitationStatus } from "./invitation-policy.js";
import type {
  EmailStatus, GrantDatabase, GrantOutcome, GrantTrackingDto,
  GrantTrackingQuery, InvitationStatus,
} from "./types.js";

export async function getGrantTracking(
  database: GrantDatabase,
  query: GrantTrackingQuery,
): Promise<GrantTrackingDto> {
  return database.transaction(async (tx) => {
    const [clock] = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
    const now = clock.now instanceof Date ? clock.now : new Date(clock.now);
    const start = sql<Date>`(${sessions.startTime} AT TIME ZONE 'UTC')`
      .mapWith((value: string) => new Date(value));
    // SQL filtering mirrors invitation-policy; the integration test checks their parity.
    const effectiveStatus = sql<InvitationStatus | null>`CASE
      WHEN ${invitations.id} IS NULL THEN NULL
      WHEN ${invitations.status} <> 'pending' THEN ${invitations.status}
      WHEN ${sessions.isActive} IS NOT TRUE
        OR ${registrations.status} IS DISTINCT FROM 'confirmed'
        OR ${registrations.eventId} IS DISTINCT FROM ${sessions.eventId} THEN 'revoked'
      WHEN ${now.toISOString()}::timestamptz >= LEAST(${invitations.expiresAt}, ${start}) THEN 'expired'
      ELSE 'pending' END`;
    const source = tx.$with("grant_tracking_source").as(tx.select({
      id: items.id, batchId: items.batchId,
      registrationId: items.requestedRegistrationId,
      regCode: items.regCodeSnapshot, name: items.nameSnapshot,
      recipientEmail: items.recipientEmailSnapshot,
      eventId: batches.eventId, sessionId: batches.sessionId,
      sessionName: batches.sessionNameSnapshot, actorName: batches.actorNameSnapshot,
      createdAt: batches.createdAt,
      outcome: items.outcome, reasonCode: items.reasonCode,
      emailStatus: items.emailStatus, attemptCount: items.attemptCount,
      lastErrorCode: items.lastErrorCode, sentAt: items.sentAt,
      lastAttemptAt: items.lastAttemptAt,
      invitationId: sql<string | null>`${invitations.id}`.as("invitation_id"),
      invitationStoredStatus: sql<InvitationStatus | null>`${invitations.status}`.as("invitation_stored_status"),
      invitationExpiresAt: invitations.expiresAt,
      invitationRespondedAt: invitations.respondedAt,
      invitationEffectiveStatus: effectiveStatus.as("invitation_effective_status"),
      sessionStartTime: start.as("session_start_time"),
      sessionIsActive: sessions.isActive,
      sessionEventId: sql<number>`${sessions.eventId}`.as("session_event_id"),
      registrationStatus: sql<string | null>`${registrations.status}`.as("registration_status"),
      registrationEventId: sql<number | null>`${registrations.eventId}`.as("registration_event_id"),
    }).from(items)
      .innerJoin(batches, eq(items.batchId, batches.id))
      .innerJoin(sessions, eq(batches.sessionId, sessions.id))
      .leftJoin(invitations, eq(invitations.grantItemId, items.id))
      .leftJoin(registrations, eq(invitations.registrationId, registrations.id)));

    const filters: SQL[] = [];
    if (query.eventId !== undefined) filters.push(eq(source.eventId, query.eventId));
    if (query.sessionId !== undefined) filters.push(eq(source.sessionId, query.sessionId));
    if (query.outcome) filters.push(eq(source.outcome, query.outcome));
    if (query.emailStatus) filters.push(eq(source.emailStatus, query.emailStatus));
    if (query.responseStatus === "not_required") filters.push(eq(source.outcome, "added"));
    else if (query.responseStatus) filters.push(eq(source.invitationEffectiveStatus, query.responseStatus));
    if (query.search) {
      const pattern = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      filters.push(or(ilike(source.name, pattern), ilike(source.regCode, pattern), ilike(source.recipientEmail, pattern))!);
    }
    const where = and(...filters);
    const groups = await tx.with(source).select({
      outcome: source.outcome,
      emailStatus: source.emailStatus,
      invitationStatus: source.invitationEffectiveStatus,
      total: count(),
    }).from(source).where(where)
      .groupBy(source.outcome, source.emailStatus, source.invitationEffectiveStatus);
    const rows = await tx.with(source).select().from(source).where(where)
      .orderBy(desc(source.createdAt), desc(source.id))
      .limit(query.limit).offset((query.page - 1) * query.limit);
    const summary: GrantTrackingDto["summary"] = {
      total: 0,
      outcomeCounts: { added: 0, invited: 0, skipped: 0 },
      invitationCounts: { pending: 0, accepted: 0, declined: 0, expired: 0, revoked: 0 },
      emailCounts: { not_applicable: 0, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 },
    };
    for (const group of groups) {
      summary.total += group.total;
      summary.outcomeCounts[group.outcome as GrantOutcome] += group.total;
      summary.emailCounts[group.emailStatus as EmailStatus] += group.total;
      if (group.invitationStatus) summary.invitationCounts[group.invitationStatus] += group.total;
    }
    return {
      items: rows.map((row) => ({
        id: row.id, batchId: row.batchId, registrationId: row.registrationId,
        regCode: row.regCode, name: row.name, recipientEmail: row.recipientEmail,
        eventId: row.eventId, sessionId: row.sessionId, sessionName: row.sessionName,
        actorName: row.actorName, createdAt: row.createdAt.toISOString(),
        outcome: row.outcome as GrantOutcome,
        reasonCode: row.reasonCode as GrantTrackingDto["items"][number]["reasonCode"],
        emailStatus: row.emailStatus as EmailStatus, attemptCount: row.attemptCount,
        lastErrorCode: row.lastErrorCode,
        sentAt: row.sentAt?.toISOString() ?? null,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        invitation: row.invitationId && row.invitationStoredStatus && row.invitationExpiresAt ? {
          invitationId: row.invitationId,
          invitationStatus: effectiveInvitationStatus({
            status: row.invitationStoredStatus as InvitationStatus,
            expiresAt: row.invitationExpiresAt, startTime: row.sessionStartTime,
            isActive: row.sessionIsActive === true,
            registrationConfirmed: row.registrationStatus === "confirmed",
            eventMatches: row.registrationEventId === row.sessionEventId,
          }, now),
          expiresAt: row.invitationExpiresAt.toISOString(),
          effectiveDeadline: effectiveDeadline(row.invitationExpiresAt, row.sessionStartTime).toISOString(),
          respondedAt: row.invitationRespondedAt?.toISOString() ?? null,
        } : null,
      })),
      summary,
      pagination: {
        page: query.page, limit: query.limit, total: summary.total,
        totalPages: summary.total === 0 ? 0 : Math.ceil(summary.total / query.limit),
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
