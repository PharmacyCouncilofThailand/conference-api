import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  backofficeUsers,
  events,
  registrationSessionGrantBatches,
  registrationSessionGrantItems,
  registrationSessions,
  registrations,
  sessions,
} from "../../database/schema.js";
import { buildEventEmailContext } from "../../services/emailTemplates.types.js";
import { canonicalRequest, registrationBlock, requestHash, sessionBlock } from "./policy.js";
import type { EmailStatus, GrantBatchDto, GrantDatabase, GrantInput, GrantItemDto } from "./types.js";
import { GrantError } from "./types.js";

const emailStatuses: EmailStatus[] = [
  "not_applicable",
  "pending",
  "sending",
  "sent",
  "failed",
  "unknown",
  "suppressed",
];

function emptyEmailCounts(): Record<EmailStatus, number> {
  return Object.fromEntries(emailStatuses.map((status) => [status, 0])) as Record<EmailStatus, number>;
}

function toItemDto(row: typeof registrationSessionGrantItems.$inferSelect): GrantItemDto {
  return {
    id: row.id,
    registrationId: row.requestedRegistrationId,
    regCode: row.regCodeSnapshot,
    name: row.nameSnapshot,
    outcome: row.outcome as GrantItemDto["outcome"],
    reasonCode: row.reasonCode as GrantItemDto["reasonCode"],
    registrationSessionId: row.registrationSessionId,
    emailStatus: row.emailStatus as EmailStatus,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
  };
}

async function readBatch(
  database: GrantDatabase,
  batchId: string,
  page: number,
  limit: number,
): Promise<GrantBatchDto | null> {
  const [batch] = await database
    .select()
    .from(registrationSessionGrantBatches)
    .where(eq(registrationSessionGrantBatches.id, batchId))
    .limit(1);
  if (!batch) return null;

  const offset = (page - 1) * limit;
  const [items, totalRows, enrollmentRows, statusRows] = await Promise.all([
    database
      .select()
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.batchId, batchId))
      .orderBy(
        asc(registrationSessionGrantItems.requestedRegistrationId),
        asc(registrationSessionGrantItems.id),
      )
      .limit(limit)
      .offset(offset),
    database
      .select({ total: count() })
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.batchId, batchId)),
    database
      .select({ total: count() })
      .from(registrationSessions)
      .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
      .where(
        and(
          eq(registrationSessions.sessionId, batch.sessionId),
          eq(registrations.status, "confirmed"),
        ),
      ),
    database
      .select({ status: registrationSessionGrantItems.emailStatus, total: count() })
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.batchId, batchId))
      .groupBy(registrationSessionGrantItems.emailStatus),
  ]);

  const total = totalRows[0]?.total ?? 0;
  const emailCounts = emptyEmailCounts();
  for (const row of statusRows) {
    const status = row.status as EmailStatus;
    if (status in emailCounts) emailCounts[status] = row.total;
  }

  return {
    batchId: batch.id,
    sessionId: batch.sessionId,
    eventId: batch.eventId,
    requestedCount: batch.requestedCount,
    addedCount: batch.addedCount,
    skippedCount: batch.skippedCount,
    currentEnrollmentCount: enrollmentRows[0]?.total ?? 0,
    createdAt: batch.createdAt.toISOString(),
    results: items.map(toItemDto),
    emailCounts,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}

export async function getGrantBatch(
  database: GrantDatabase,
  batchId: string,
  page: number,
  limit: number,
): Promise<GrantBatchDto | null> {
  return readBatch(database, batchId, page, limit);
}

export async function createGrant(
  database: GrantDatabase,
  input: GrantInput,
): Promise<{ replayed: boolean; batch: GrantBatchDto }> {
  const canonical = canonicalRequest(input.sessionId, input.registrationIds);
  if (canonical.registrationIds.length === 0 || canonical.registrationIds.length > 500) {
    throw new GrantError(400, "INVALID_REGISTRATION_IDS", "registrationIds must contain 1 to 500 distinct IDs");
  }
  const hash = requestHash(canonical.sessionId, canonical.registrationIds);

  const result = await database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.actorId}:${input.idempotencyKey}`}, 0))`,
    );

    const [existingBatch] = await tx
      .select()
      .from(registrationSessionGrantBatches)
      .where(
        and(
          eq(registrationSessionGrantBatches.actorId, input.actorId),
          eq(registrationSessionGrantBatches.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingBatch) {
      if (existingBatch.requestHash !== hash) {
        throw new GrantError(409, "IDEMPOTENCY_KEY_MISMATCH", "Idempotency key was already used with a different request");
      }
      return { replayed: true, batchId: existingBatch.id };
    }

    const [actor] = await tx
      .select({ firstName: backofficeUsers.firstName, lastName: backofficeUsers.lastName })
      .from(backofficeUsers)
      .where(eq(backofficeUsers.id, input.actorId))
      .limit(1);
    if (!actor) throw new GrantError(403, "ACTOR_NOT_FOUND", "Admin actor not found");

    const [session] = await tx
      .select({
        id: sessions.id,
        eventId: sessions.eventId,
        sessionName: sessions.sessionName,
        sessionType: sessions.sessionType,
        startTime: sessions.startTime,
        endTime: sessions.endTime,
        room: sessions.room,
        isActive: sessions.isActive,
        eventName: events.eventName,
        eventStartDate: events.startDate,
        eventEndDate: events.endDate,
        eventLocation: events.location,
      })
      .from(sessions)
      .innerJoin(events, eq(sessions.eventId, events.id))
      .where(eq(sessions.id, canonical.sessionId))
      .limit(1)
      .for("share");
    if (!session) throw new GrantError(404, "SESSION_NOT_FOUND", "Session not found");

    const lockedRegistrations = await tx
      .select({
        id: registrations.id,
        eventId: registrations.eventId,
        status: registrations.status,
        regCode: registrations.regCode,
        email: registrations.email,
        firstName: registrations.firstName,
        lastName: registrations.lastName,
      })
      .from(registrations)
      .where(inArray(registrations.id, canonical.registrationIds))
      .orderBy(asc(registrations.id))
      .for("update");

    const [{ now: rawNow }] = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
    const now = rawNow instanceof Date ? rawNow : new Date(rawNow);
    const blocked = sessionBlock(session, now);
    if (blocked) throw new GrantError(409, blocked, blocked === "SESSION_INACTIVE" ? "Session is inactive" : "Session has ended");
    const eventEmailContext = buildEventEmailContext({
      eventName: session.eventName,
      startDate: session.eventStartDate,
      endDate: session.eventEndDate,
      location: session.eventLocation,
      websiteUrl: null,
      shortName: null,
    });

    const existingLinks = await tx
      .select({ registrationId: registrationSessions.registrationId })
      .from(registrationSessions)
      .where(
        and(
          eq(registrationSessions.sessionId, canonical.sessionId),
          inArray(registrationSessions.registrationId, canonical.registrationIds),
        ),
      );
    const linkedIds = new Set(existingLinks.map((row) => row.registrationId));
    const registrationById = new Map(lockedRegistrations.map((row) => [row.id, row]));

    const batchId = randomUUID();
    await tx.insert(registrationSessionGrantBatches).values({
      id: batchId,
      actorId: input.actorId,
      actorNameSnapshot: `${actor.firstName} ${actor.lastName}`.trim(),
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      sessionId: session.id,
      eventId: session.eventId,
      sessionNameSnapshot: session.sessionName,
      requestedCount: canonical.registrationIds.length,
    });

    let addedCount = 0;
    let skippedCount = 0;
    for (const registrationId of canonical.registrationIds) {
      const registration = registrationById.get(registrationId) ?? null;
      let reasonCode = registrationBlock(registration, session.eventId, linkedIds.has(registrationId));
      let registrationSessionId: number | null = null;

      if (!reasonCode && registration) {
        const [inserted] = await tx
          .insert(registrationSessions)
          .values({
            registrationId: registration.id,
            sessionId: session.id,
            ticketTypeId: null,
            source: "admin_grant",
            addedBy: input.actorId,
          })
          .onConflictDoNothing({
            target: [registrationSessions.registrationId, registrationSessions.sessionId],
          })
          .returning({ id: registrationSessions.id });
        if (inserted) {
          registrationSessionId = inserted.id;
          addedCount += 1;
        } else {
          reasonCode = "ALREADY_REGISTERED";
        }
      }

      if (reasonCode) skippedCount += 1;
      const nameSnapshot = registration ? `${registration.firstName} ${registration.lastName}`.trim() : null;
      await tx.insert(registrationSessionGrantItems).values({
        id: randomUUID(),
        batchId,
        requestedRegistrationId: registrationId,
        registrationSessionId,
        regCodeSnapshot: registration?.regCode ?? null,
        nameSnapshot,
        outcome: reasonCode ? "skipped" : "added",
        reasonCode: reasonCode ?? null,
        recipientEmailSnapshot: reasonCode ? null : registration?.email ?? null,
        notificationSnapshot: reasonCode
          ? null
          : {
              registrationId,
              regCode: registration?.regCode ?? "",
              personName: nameSnapshot,
              eventId: session.eventId,
              eventName: eventEmailContext.eventName,
              eventShortName: eventEmailContext.shortName,
              eventDates: eventEmailContext.dates,
              eventVenue: eventEmailContext.venue,
              sessionId: session.id,
              sessionName: session.sessionName,
              sessionType: session.sessionType,
              startTime: session.startTime.toISOString(),
              endTime: session.endTime.toISOString(),
              room: session.room,
              participantUrl: eventEmailContext.websiteUrl,
            },
        emailStatus: reasonCode ? "not_applicable" : "pending",
      });
    }

    await tx
      .update(registrationSessionGrantBatches)
      .set({ addedCount, skippedCount, completedAt: now })
      .where(eq(registrationSessionGrantBatches.id, batchId));

    return { replayed: false, batchId };
  });

  const batch = await readBatch(database, result.batchId, 1, 500);
  if (!batch) throw new GrantError(500, "BATCH_READ_FAILED", "Grant batch could not be read after commit");
  return { replayed: result.replayed, batch };
}
