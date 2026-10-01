import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, or, sql } from "drizzle-orm";
import {
  backofficeUsers,
  events,
  registrationSessionGrantBatches,
  registrationSessionGrantItems,
  registrationSessions,
  registrations,
  sessionInvitations,
  sessions,
} from "../../database/schema.js";
import { buildEventEmailContext } from "../../services/emailTemplates.types.js";
import {
  effectiveDeadline,
  effectiveInvitationStatus,
  participantKey,
} from "./invitation-policy.js";
import {
  issueInvitationToken,
  readInvitationConfig,
} from "./invitation-token.js";
import { readInvitationCapacity } from "./invitations.js";
import {
  canonicalRequest,
  registrationBlock,
  requestHash,
  sessionBlock,
} from "./policy.js";
import type {
  EmailStatus,
  GrantBatchDto,
  GrantDatabase,
  GrantInput,
  GrantItemDto,
  InvitationMetadata,
  InvitationStatus,
} from "./types.js";
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
  return Object.fromEntries(
    emailStatuses.map((status) => [status, 0]),
  ) as Record<EmailStatus, number>;
}

function toItemDto(
  row: typeof registrationSessionGrantItems.$inferSelect,
  invitation: InvitationMetadata | null,
): GrantItemDto {
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
    invitation,
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

  const [session] = await database
    .select({
      id: sessions.id,
      eventId: sessions.eventId,
      startTime: sessions.startTime,
      isActive: sessions.isActive,
      adminGrantRequiresConfirmation:
        sessions.adminGrantRequiresConfirmation,
    })
    .from(sessions)
    .where(eq(sessions.id, batch.sessionId))
    .limit(1);
  if (!session) {
    throw new GrantError(
      500,
      "BATCH_SESSION_NOT_FOUND",
      "Grant batch session could not be read",
    );
  }

  const [{ now: rawNow }] = await database.execute<{ now: Date | string }>(
    sql`SELECT clock_timestamp() AS now`,
  );
  const now = rawNow instanceof Date ? rawNow : new Date(rawNow);
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
      .innerJoin(
        registrations,
        eq(registrationSessions.registrationId, registrations.id),
      )
      .where(
        and(
          eq(registrationSessions.sessionId, batch.sessionId),
          eq(registrations.status, "confirmed"),
        ),
      ),
    database
      .select({
        status: registrationSessionGrantItems.emailStatus,
        total: count(),
      })
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.batchId, batchId))
      .groupBy(registrationSessionGrantItems.emailStatus),
  ]);

  const invitationRows =
    items.length === 0
      ? []
      : await database
          .select({
            grantItemId: sessionInvitations.grantItemId,
            invitationId: sessionInvitations.id,
            status: sessionInvitations.status,
            expiresAt: sessionInvitations.expiresAt,
            respondedAt: sessionInvitations.respondedAt,
            registrationStatus: registrations.status,
            registrationEventId: registrations.eventId,
          })
          .from(sessionInvitations)
          .innerJoin(
            registrations,
            eq(sessionInvitations.registrationId, registrations.id),
          )
          .where(
            inArray(
              sessionInvitations.grantItemId,
              items.map((item) => item.id),
            ),
          );

  const invitationByItem = new Map<string, InvitationMetadata>();
  for (const row of invitationRows) {
    const status = effectiveInvitationStatus(
      {
        status: row.status as InvitationStatus,
        expiresAt: row.expiresAt,
        startTime: session.startTime,
        isActive: session.isActive,
        registrationConfirmed: row.registrationStatus === "confirmed",
        eventMatches: row.registrationEventId === session.eventId,
      },
      now,
    );
    invitationByItem.set(row.grantItemId, {
      invitationId: row.invitationId,
      invitationStatus: status,
      expiresAt: row.expiresAt.toISOString(),
      effectiveDeadline: effectiveDeadline(
        row.expiresAt,
        session.startTime,
      ).toISOString(),
      respondedAt: row.respondedAt?.toISOString() ?? null,
    });
  }

  const total = totalRows[0]?.total ?? 0;
  const emailCounts = emptyEmailCounts();
  for (const row of statusRows) {
    const status = row.status as EmailStatus;
    if (status in emailCounts) emailCounts[status] = row.total;
  }

  let reservedCount = 0;
  let occupiedCount = enrollmentRows[0]?.total ?? 0;
  let seatsRemaining: number | null = null;
  if (session.adminGrantRequiresConfirmation) {
    const capacity = await readInvitationCapacity(
      database,
      batch.sessionId,
      now,
    );
    reservedCount = capacity.reservedCount;
    occupiedCount = capacity.occupiedCount;
    seatsRemaining = capacity.seatsRemaining;
  }

  return {
    batchId: batch.id,
    sessionId: batch.sessionId,
    eventId: batch.eventId,
    requestedCount: batch.requestedCount,
    addedCount: batch.addedCount,
    invitedCount: batch.invitedCount,
    skippedCount: batch.skippedCount,
    currentEnrollmentCount: enrollmentRows[0]?.total ?? 0,
    reservedCount,
    occupiedCount,
    seatsRemaining,
    createdAt: batch.createdAt.toISOString(),
    results: items.map((item) =>
      toItemDto(item, invitationByItem.get(item.id) ?? null),
    ),
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

function invitationCloseReason(
  registration: {
    eventId: number;
    status: string;
  },
  session: {
    eventId: number;
    isActive: boolean;
  },
  status: InvitationStatus,
): string {
  if (status === "expired") return "SESSION_DEADLINE_EXPIRED";
  if (registration.status !== "confirmed") {
    return "REGISTRATION_NOT_CONFIRMED";
  }
  if (registration.eventId !== session.eventId) return "EVENT_MISMATCH";
  if (!session.isActive) return "SESSION_INACTIVE";
  return "INVITATION_REVOKED";
}

export async function createGrant(
  database: GrantDatabase,
  input: GrantInput,
): Promise<{ replayed: boolean; batch: GrantBatchDto }> {
  const canonical = canonicalRequest(
    input.sessionId,
    input.registrationIds,
  );
  if (
    canonical.registrationIds.length === 0 ||
    canonical.registrationIds.length > 500
  ) {
    throw new GrantError(
      400,
      "INVALID_REGISTRATION_IDS",
      "registrationIds must contain 1 to 500 distinct IDs",
    );
  }
  const hash = requestHash(
    canonical.sessionId,
    canonical.registrationIds,
  );

  const result = await database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.actorId}:${input.idempotencyKey}`}, 0))`,
    );

    const [existingBatch] = await tx
      .select()
      .from(registrationSessionGrantBatches)
      .where(
        and(
          eq(
            registrationSessionGrantBatches.actorId,
            input.actorId,
          ),
          eq(
            registrationSessionGrantBatches.idempotencyKey,
            input.idempotencyKey,
          ),
        ),
      )
      .limit(1);

    if (existingBatch) {
      if (existingBatch.requestHash !== hash) {
        throw new GrantError(
          409,
          "IDEMPOTENCY_KEY_MISMATCH",
          "Idempotency key was already used with a different request",
        );
      }
      return { replayed: true, batchId: existingBatch.id };
    }

    const [actor] = await tx
      .select({
        firstName: backofficeUsers.firstName,
        lastName: backofficeUsers.lastName,
      })
      .from(backofficeUsers)
      .where(eq(backofficeUsers.id, input.actorId))
      .limit(1);
    if (!actor) {
      throw new GrantError(
        403,
        "ACTOR_NOT_FOUND",
        "Admin actor not found",
      );
    }

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
        adminGrantRequiresConfirmation:
          sessions.adminGrantRequiresConfirmation,
        eventName: events.eventName,
        eventStartDate: events.startDate,
        eventEndDate: events.endDate,
        eventLocation: events.location,
      })
      .from(sessions)
      .innerJoin(events, eq(sessions.eventId, events.id))
      .where(eq(sessions.id, canonical.sessionId))
      .limit(1)
      .for("update");
    if (!session) {
      throw new GrantError(
        404,
        "SESSION_NOT_FOUND",
        "Session not found",
      );
    }

    if (!session.adminGrantRequiresConfirmation) {
      const [pendingInvitation] = await tx
        .select({ id: sessionInvitations.id })
        .from(sessionInvitations)
        .where(
          and(
            eq(sessionInvitations.sessionId, session.id),
            eq(sessionInvitations.status, "pending"),
          ),
        )
        .limit(1);
      if (pendingInvitation) {
        throw new GrantError(
          409,
          "SESSION_INVITATION_REQUIRED",
          "Session still has outstanding invitations",
        );
      }
    }

    const discoveredRegistrations = await tx
      .select({
        id: registrations.id,
        userId: registrations.userId,
      })
      .from(registrations)
      .where(
        inArray(
          registrations.id,
          canonical.registrationIds,
        ),
      );
    const discoveredUserIds = [
      ...new Set(
        discoveredRegistrations
          .map((row) => row.userId)
          .filter((value): value is number => value !== null),
      ),
    ];

    const lockCondition =
      discoveredUserIds.length === 0
        ? inArray(
            registrations.id,
            canonical.registrationIds,
          )
        : or(
            inArray(
              registrations.id,
              canonical.registrationIds,
            ),
            and(
              eq(registrations.eventId, session.eventId),
              inArray(
                registrations.userId,
                discoveredUserIds,
              ),
            ),
          );

    const lockedRegistrations = await tx
      .select({
        id: registrations.id,
        eventId: registrations.eventId,
        status: registrations.status,
        userId: registrations.userId,
        regCode: registrations.regCode,
        email: registrations.email,
        firstName: registrations.firstName,
        lastName: registrations.lastName,
      })
      .from(registrations)
      .where(lockCondition)
      .orderBy(asc(registrations.id))
      .for("update");

    const lockedIds = lockedRegistrations.map(
      (registration) => registration.id,
    );

    const existingLinks =
      lockedIds.length === 0
        ? []
        : await tx
            .select({
              registrationId:
                registrationSessions.registrationId,
              userId: registrations.userId,
            })
            .from(registrationSessions)
            .innerJoin(
              registrations,
              eq(
                registrationSessions.registrationId,
                registrations.id,
              ),
            )
            .where(
              and(
                eq(
                  registrationSessions.sessionId,
                  session.id,
                ),
                inArray(
                  registrationSessions.registrationId,
                  lockedIds,
                ),
                eq(registrations.status, "confirmed"),
                eq(registrations.eventId, session.eventId),
              ),
            );

    const lockedInvitations =
      lockedIds.length === 0
        ? []
        : await tx
            .select({
              id: sessionInvitations.id,
              registrationId:
                sessionInvitations.registrationId,
              status: sessionInvitations.status,
              expiresAt: sessionInvitations.expiresAt,
            })
            .from(sessionInvitations)
            .where(
              and(
                eq(sessionInvitations.sessionId, session.id),
                eq(sessionInvitations.status, "pending"),
                inArray(
                  sessionInvitations.registrationId,
                  lockedIds,
                ),
              ),
            )
            .orderBy(asc(sessionInvitations.id))
            .for("update");

    const [{ now: rawNow }] = await tx.execute<{
      now: Date | string;
    }>(sql`SELECT clock_timestamp() AS now`);
    const now =
      rawNow instanceof Date ? rawNow : new Date(rawNow);

    if (session.adminGrantRequiresConfirmation) {
      if (!session.isActive) {
        throw new GrantError(
          409,
          "SESSION_INACTIVE",
          "Session is inactive",
        );
      }
      if (
        !Number.isFinite(session.startTime.getTime()) ||
        now.getTime() >= session.startTime.getTime()
      ) {
        throw new GrantError(
          409,
          "SESSION_RESPONSE_CLOSED",
          "Session response is closed",
        );
      }
    } else {
      const blocked = sessionBlock(session, now);
      if (blocked) {
        throw new GrantError(
          409,
          blocked,
          blocked === "SESSION_INACTIVE"
            ? "Session is inactive"
            : "Session has ended",
        );
      }
    }

    const registrationById = new Map(
      lockedRegistrations.map((row) => [row.id, row]),
    );
    const activeInvitationParticipants = new Set<string>();
    for (const invitation of lockedInvitations) {
      const registration = registrationById.get(
        invitation.registrationId,
      );
      if (!registration) continue;
      const effectiveStatus = effectiveInvitationStatus(
        {
          status: invitation.status as InvitationStatus,
          expiresAt: invitation.expiresAt,
          startTime: session.startTime,
          isActive: session.isActive,
          registrationConfirmed:
            registration.status === "confirmed",
          eventMatches:
            registration.eventId === session.eventId,
        },
        now,
      );
      if (effectiveStatus === "pending") {
        activeInvitationParticipants.add(
          participantKey(registration),
        );
        continue;
      }
      await tx
        .update(sessionInvitations)
        .set({
          status: effectiveStatus,
          tokenCiphertext: null,
          closedAt: now,
          closeReason: invitationCloseReason(
            registration,
            session,
            effectiveStatus,
          ),
        })
        .where(
          and(
            eq(sessionInvitations.id, invitation.id),
            eq(sessionInvitations.status, "pending"),
          ),
        );
    }

    const actualParticipants = new Set(
      existingLinks.map((row) =>
        participantKey({
          id: row.registrationId,
          userId: row.userId,
        }),
      ),
    );

    const selectedRegistrationById = new Map(
      canonical.registrationIds.map((id) => [
        id,
        registrationById.get(id) ?? null,
      ]),
    );

    const reasons = new Map<
      number,
      GrantItemDto["reasonCode"]
    >();
    const eligibleIds: number[] = [];
    const seenEligibleParticipants = new Set<string>();

    for (const registrationId of canonical.registrationIds) {
      const registration =
        selectedRegistrationById.get(registrationId) ?? null;
      let reasonCode = registrationBlock(
        registration,
        session.eventId,
        false,
      );
      if (!reasonCode && registration) {
        const key = participantKey(registration);
        if (actualParticipants.has(key)) {
          reasonCode = "ALREADY_REGISTERED";
        } else if (
          activeInvitationParticipants.has(key)
        ) {
          reasonCode = "ALREADY_INVITED";
        } else if (seenEligibleParticipants.has(key)) {
          reasonCode = "DUPLICATE_PARTICIPANT";
        } else {
          seenEligibleParticipants.add(key);
          eligibleIds.push(registrationId);
        }
      }
      reasons.set(registrationId, reasonCode);
    }

    let invitationConfig:
      | ReturnType<typeof readInvitationConfig>
      | null = null;
    let configuredCapacity:
      | Awaited<ReturnType<typeof readInvitationCapacity>>
      | null = null;
    if (session.adminGrantRequiresConfirmation) {
      invitationConfig = readInvitationConfig(process.env);
      configuredCapacity = await readInvitationCapacity(
        tx,
        session.id,
        now,
      );
      if (
        eligibleIds.length >
        configuredCapacity.seatsRemaining
      ) {
        throw new GrantError(
          409,
          "SESSION_CAPACITY_EXCEEDED",
          "Not enough session capacity for invitations",
          { capacity: configuredCapacity },
        );
      }
    }

    const eventEmailContext = buildEventEmailContext({
      eventName: session.eventName,
      startDate: session.eventStartDate,
      endDate: session.eventEndDate,
      location: session.eventLocation,
      websiteUrl: null,
      shortName: null,
    });

    const batchId = randomUUID();
    await tx
      .insert(registrationSessionGrantBatches)
      .values({
        id: batchId,
        actorId: input.actorId,
        actorNameSnapshot:
          `${actor.firstName} ${actor.lastName}`.trim(),
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        sessionId: session.id,
        eventId: session.eventId,
        sessionNameSnapshot: session.sessionName,
        requestedCount: canonical.registrationIds.length,
      });

    let addedCount = 0;
    let invitedCount = 0;
    let skippedCount = 0;

    for (const registrationId of canonical.registrationIds) {
      const registration =
        selectedRegistrationById.get(registrationId) ?? null;
      let reasonCode = reasons.get(registrationId) ?? null;
      let registrationSessionId: number | null = null;
      const itemId = randomUUID();
      const nameSnapshot = registration
        ? `${registration.firstName} ${registration.lastName}`.trim()
        : null;

      if (
        session.adminGrantRequiresConfirmation &&
        !reasonCode &&
        registration &&
        invitationConfig
      ) {
        const invitationId = randomUUID();
        const issued = issueInvitationToken(
          invitationId,
          invitationConfig.key,
        );

        await tx
          .insert(registrationSessionGrantItems)
          .values({
            id: itemId,
            batchId,
            requestedRegistrationId: registration.id,
            registrationSessionId: null,
            regCodeSnapshot: registration.regCode,
            nameSnapshot,
            outcome: "invited",
            reasonCode: null,
            recipientEmailSnapshot: registration.email,
            notificationSnapshot: {
              registrationId,
              regCode: registration.regCode,
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
              participantUrl: null,
            },
            emailStatus: "pending",
          });

        await tx.insert(sessionInvitations).values({
          id: invitationId,
          registrationId: registration.id,
          sessionId: session.id,
          grantItemId: itemId,
          status: "pending",
          tokenHash: issued.tokenHash,
          tokenCiphertext: issued.envelope,
          expiresAt: session.startTime,
          respondedAt: null,
          closedAt: null,
          closeReason: null,
          createdBy: input.actorId,
        });
        invitedCount += 1;
        continue;
      }

      if (
        !session.adminGrantRequiresConfirmation &&
        !reasonCode &&
        registration
      ) {
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
            target: [
              registrationSessions.registrationId,
              registrationSessions.sessionId,
            ],
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
      await tx
        .insert(registrationSessionGrantItems)
        .values({
          id: itemId,
          batchId,
          requestedRegistrationId: registrationId,
          registrationSessionId,
          regCodeSnapshot: registration?.regCode ?? null,
          nameSnapshot,
          outcome: reasonCode ? "skipped" : "added",
          reasonCode: reasonCode ?? null,
          recipientEmailSnapshot: reasonCode
            ? null
            : registration?.email ?? null,
          notificationSnapshot: reasonCode
            ? null
            : {
                registrationId,
                regCode: registration?.regCode ?? "",
                personName: nameSnapshot,
                eventId: session.eventId,
                eventName: eventEmailContext.eventName,
                eventShortName:
                  eventEmailContext.shortName,
                eventDates: eventEmailContext.dates,
                eventVenue: eventEmailContext.venue,
                sessionId: session.id,
                sessionName: session.sessionName,
                sessionType: session.sessionType,
                startTime:
                  session.startTime.toISOString(),
                endTime: session.endTime.toISOString(),
                room: session.room,
                participantUrl:
                  eventEmailContext.websiteUrl,
              },
          emailStatus: reasonCode
            ? "not_applicable"
            : "pending",
        });
    }

    await tx
      .update(registrationSessionGrantBatches)
      .set({
        addedCount,
        invitedCount,
        skippedCount,
        completedAt: now,
      })
      .where(
        eq(
          registrationSessionGrantBatches.id,
          batchId,
        ),
      );

    return { replayed: false, batchId };
  });

  const batch = await readBatch(
    database,
    result.batchId,
    1,
    500,
  );
  if (!batch) {
    throw new GrantError(
      500,
      "BATCH_READ_FAILED",
      "Grant batch could not be read after commit",
    );
  }
  return { replayed: result.replayed, batch };
}
