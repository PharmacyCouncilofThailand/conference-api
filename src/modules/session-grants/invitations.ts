import { sql } from "drizzle-orm";
import {
  effectiveDeadline,
  effectiveInvitationStatus,
} from "./invitation-policy.js";
import { hashInvitationToken } from "./invitation-token.js";
import type {
  GrantDatabase,
  GrantTransaction,
  InvitationCapacity,
  InvitationDecision,
  InvitationStatus,
  PublicInvitationDto,
} from "./types.js";
import { GrantError } from "./types.js";

type CapacityRow = {
  entitled: number | string | bigint;
  reserved: number | string | bigint;
  capacity: number | string | bigint | null;
};

function safeCount(
  value: number | string | bigint,
  label: string,
): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      `Invalid invitation ${label}`,
    );
  }
  return converted;
}

export async function readInvitationCapacity(
  database: GrantDatabase | GrantTransaction,
  sessionId: number,
  now: Date,
): Promise<InvitationCapacity> {
  const nowIso = now.toISOString();
  const rows = await database.execute(sql`
    WITH actual AS (
      SELECT rs.id FROM registration_sessions rs
      JOIN registrations r ON r.id=rs.registration_id
      JOIN sessions s ON s.id=rs.session_id
      WHERE rs.session_id=${sessionId}
        AND r.status='confirmed'
        AND r.event_id=s.event_id
    ), pending AS (
      SELECT i.id FROM session_invitations i
      JOIN registrations r ON r.id=i.registration_id
      JOIN sessions s ON s.id=i.session_id
      WHERE i.session_id=${sessionId}
        AND i.status='pending'
        AND r.status='confirmed'
        AND r.event_id=s.event_id
        AND s.is_active
        AND i.expires_at>${nowIso}::timestamptz
        AND (s.start_time AT TIME ZONE 'UTC')>${nowIso}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM registration_sessions rs2
          JOIN registrations r2 ON r2.id=rs2.registration_id
          WHERE rs2.session_id=i.session_id
            AND r2.status='confirmed'
            AND r2.event_id=r.event_id
            AND (
              r2.id=r.id
              OR (r.user_id IS NOT NULL AND r2.user_id=r.user_id)
            )
        )
    )
    SELECT
      (SELECT count(*) FROM actual) AS entitled,
      (SELECT count(*) FROM pending) AS reserved,
      s.max_capacity AS capacity
    FROM sessions s
    WHERE s.id=${sessionId}
  `);

  const row = (rows as unknown as CapacityRow[])[0];
  if (!row) {
    throw new GrantError(
      404,
      "SESSION_NOT_FOUND",
      "Session not found",
    );
  }

  const currentEnrollmentCount = safeCount(
    row.entitled,
    "entitlement count",
  );
  const reservedCount = safeCount(
    row.reserved,
    "reservation count",
  );
  const capacity =
    row.capacity === null ? Number.NaN : Number(row.capacity);
  if (
    !Number.isSafeInteger(capacity) ||
    capacity <= 0
  ) {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Invitation session capacity is not configured",
    );
  }

  const occupiedCount =
    currentEnrollmentCount + reservedCount;
  return {
    currentEnrollmentCount,
    reservedCount,
    occupiedCount,
    seatsRemaining: Math.max(
      0,
      capacity - occupiedCount,
    ),
  };
}

type LookupRow = {
  invitation_id: string;
  invitation_status: InvitationStatus;
  expires_at: Date;
  responded_at: Date | null;
  recipient_first_name: string | null;
  registration_status: string;
  registration_event_id: number;
  session_event_id: number;
  session_is_active: boolean;
  session_name: string;
  session_type: string | null;
  start_time: Date;
  end_time: Date;
  room: string | null;
  db_now: Date;
};

function publicDto(
  row: LookupRow,
  status: InvitationStatus,
  respondedAtOverride?: Date | null,
): PublicInvitationDto {
  const expiresAt = new Date(row.expires_at);
  const startTime = new Date(row.start_time);
  const respondedAt =
    respondedAtOverride === undefined
      ? row.responded_at
      : respondedAtOverride;
  return {
    invitationId: row.invitation_id,
    status,
    respondedAt: respondedAt
      ? new Date(respondedAt).toISOString()
      : null,
    effectiveDeadline: effectiveDeadline(
      expiresAt,
      startTime,
    ).toISOString(),
    recipientFirstName: row.recipient_first_name,
    session: {
      sessionName: row.session_name,
      sessionType: row.session_type,
      startTime: startTime.toISOString(),
      endTime: new Date(row.end_time).toISOString(),
      room: row.room,
    },
  };
}

export async function lookupInvitation(
  database: GrantDatabase,
  rawToken: string,
): Promise<PublicInvitationDto> {
  const tokenHash = hashInvitationToken(rawToken);
  const rows = await database.execute(sql`
    SELECT
      i.id AS invitation_id,
      i.status AS invitation_status,
      i.expires_at,
      i.responded_at,
      r.first_name AS recipient_first_name,
      r.status AS registration_status,
      r.event_id AS registration_event_id,
      s.event_id AS session_event_id,
      s.is_active AS session_is_active,
      s.session_name,
      s.session_type,
      (s.start_time AT TIME ZONE 'UTC') AS start_time,
      (s.end_time AT TIME ZONE 'UTC') AS end_time,
      s.room,
      clock_timestamp() AS db_now
    FROM session_invitations i
    JOIN registrations r ON r.id=i.registration_id
    JOIN sessions s ON s.id=i.session_id
    WHERE i.token_hash=${tokenHash}
    LIMIT 1
  `);

  const row = (rows as unknown as LookupRow[])[0];
  if (!row) {
    throw new GrantError(
      401,
      "INVALID_INVITATION_TOKEN",
      "Invalid invitation token",
    );
  }

  const effectiveStatus = effectiveInvitationStatus(
    {
      status: row.invitation_status,
      expiresAt: new Date(row.expires_at),
      startTime: new Date(row.start_time),
      isActive: Boolean(row.session_is_active),
      registrationConfirmed:
        row.registration_status === "confirmed",
      eventMatches:
        Number(row.registration_event_id) ===
        Number(row.session_event_id),
    },
    new Date(row.db_now),
  );
  const invitation = publicDto(row, effectiveStatus);

  if (effectiveStatus === "expired") {
    throw new GrantError(
      410,
      "INVITATION_EXPIRED",
      "Invitation has expired",
      { invitation },
    );
  }

  if (effectiveStatus === "revoked") {
    if (row.registration_status !== "confirmed") {
      throw new GrantError(
        409,
        "REGISTRATION_NOT_CONFIRMED",
        "Registration is not confirmed",
      );
    }
    if (!row.session_is_active) {
      throw new GrantError(
        409,
        "SESSION_RESPONSE_CLOSED",
        "Session response is closed",
      );
    }
    throw new GrantError(
      409,
      "INVITATION_REVOKED",
      "Invitation is no longer available",
    );
  }

  return invitation;
}

type DiscoveryRow = {
  invitation_id: string;
  registration_id: number;
  session_id: number;
};

type ResponseSessionRow = {
  id: number;
  event_id: number;
  is_active: boolean;
  session_name: string;
  session_type: string | null;
  start_time: Date;
  end_time: Date;
  room: string | null;
};

type ResponseRegistrationRow = {
  id: number;
  event_id: number;
  user_id: number | null;
  status: string;
  first_name: string | null;
};

type ResponseInvitationRow = {
  id: string;
  registration_id: number;
  session_id: number;
  grant_item_id: string;
  status: InvitationStatus;
  token_hash: string;
  expires_at: Date;
  responded_at: Date | null;
  created_by: number;
};

type ResponseGrantItemRow = {
  id: string;
  registration_session_id: number | null;
};

type EntitlementRow = {
  id: number;
  registration_id: number;
  user_id: number | null;
};

type ResponseTxResult =
  | {
      kind: "success";
      invitation: PublicInvitationDto;
    }
  | {
      kind: "error";
      statusCode: number;
      code: string;
      message: string;
      invitation?: PublicInvitationDto;
    };

function responseLookupRow(
  invitation: ResponseInvitationRow,
  registration: ResponseRegistrationRow,
  session: ResponseSessionRow,
  now: Date,
): LookupRow {
  return {
    invitation_id: invitation.id,
    invitation_status: invitation.status,
    expires_at: new Date(invitation.expires_at),
    responded_at: invitation.responded_at
      ? new Date(invitation.responded_at)
      : null,
    recipient_first_name:
      registration.first_name ?? null,
    registration_status: registration.status,
    registration_event_id: registration.event_id,
    session_event_id: session.event_id,
    session_is_active: session.is_active,
    session_name: session.session_name,
    session_type: session.session_type,
    start_time: new Date(session.start_time),
    end_time: new Date(session.end_time),
    room: session.room,
    db_now: now,
  };
}

function closeReason(
  registration: ResponseRegistrationRow,
  session: ResponseSessionRow,
  status: InvitationStatus,
): string {
  if (status === "expired") {
    return "SESSION_DEADLINE_EXPIRED";
  }
  if (registration.status !== "confirmed") {
    return "REGISTRATION_NOT_CONFIRMED";
  }
  if (registration.event_id !== session.event_id) {
    return "EVENT_MISMATCH";
  }
  if (!session.is_active) return "SESSION_INACTIVE";
  return "INVITATION_REVOKED";
}

function unavailableError(
  registration: ResponseRegistrationRow,
  session: ResponseSessionRow,
): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (registration.status !== "confirmed") {
    return {
      statusCode: 409,
      code: "REGISTRATION_NOT_CONFIRMED",
      message: "Registration is not confirmed",
    };
  }
  if (!session.is_active) {
    return {
      statusCode: 409,
      code: "SESSION_RESPONSE_CLOSED",
      message: "Session response is closed",
    };
  }
  return {
    statusCode: 409,
    code: "INVITATION_REVOKED",
    message: "Invitation is no longer available",
  };
}

export async function respondToInvitation(
  database: GrantDatabase,
  rawToken: string,
  decision: InvitationDecision,
): Promise<PublicInvitationDto> {
  const tokenHash = hashInvitationToken(rawToken);
  const discoveryRows = await database.execute(sql`
    SELECT
      id AS invitation_id,
      registration_id,
      session_id
    FROM session_invitations
    WHERE token_hash=${tokenHash}
    LIMIT 1
  `);
  const discovery = (
    discoveryRows as unknown as DiscoveryRow[]
  )[0];
  if (!discovery) {
    throw new GrantError(
      401,
      "INVALID_INVITATION_TOKEN",
      "Invalid invitation token",
    );
  }

  const result = await database.transaction<ResponseTxResult>(
    async (tx) => {
      const sessionRows = await tx.execute(sql`
        SELECT
          id,
          event_id,
          is_active,
          session_name,
          session_type,
          (start_time AT TIME ZONE 'UTC') AS start_time,
          (end_time AT TIME ZONE 'UTC') AS end_time,
          room
        FROM sessions
        WHERE id=${discovery.session_id}
        FOR UPDATE
      `);
      const session = (
        sessionRows as unknown as ResponseSessionRow[]
      )[0];
      if (!session) {
        return {
          kind: "error",
          statusCode: 409,
          code: "INVITATION_REVOKED",
          message: "Invitation session is unavailable",
        };
      }

      const identityRows = await tx.execute(sql`
        SELECT user_id
        FROM registrations
        WHERE id=${discovery.registration_id}
        LIMIT 1
      `);
      const discoveredUserId = (
        identityRows as unknown as Array<{
          user_id: number | null;
        }>
      )[0]?.user_id;

      const registrationRows =
        discoveredUserId === null ||
        discoveredUserId === undefined
          ? await tx.execute(sql`
              SELECT
                id,event_id,user_id,status,first_name
              FROM registrations
              WHERE id=${discovery.registration_id}
              ORDER BY id
              FOR UPDATE
            `)
          : await tx.execute(sql`
              SELECT
                id,event_id,user_id,status,first_name
              FROM registrations
              WHERE id=${discovery.registration_id}
                 OR (
                   event_id=${session.event_id}
                   AND user_id=${discoveredUserId}
                 )
              ORDER BY id
              FOR UPDATE
            `);
      const lockedRegistrations =
        registrationRows as unknown as ResponseRegistrationRow[];
      const registration =
        lockedRegistrations.find(
          (row) => row.id === discovery.registration_id,
        ) ?? null;
      if (!registration) {
        return {
          kind: "error",
          statusCode: 409,
          code: "INVITATION_REVOKED",
          message: "Invitation registration is unavailable",
        };
      }

      const invitationRows = await tx.execute(sql`
        SELECT
          id,
          registration_id,
          session_id,
          grant_item_id,
          status,
          token_hash,
          expires_at,
          responded_at,
          created_by
        FROM session_invitations
        WHERE id=${discovery.invitation_id}
          AND token_hash=${tokenHash}
        ORDER BY id
        FOR UPDATE
      `);
      const invitation = (
        invitationRows as unknown as ResponseInvitationRow[]
      )[0];
      if (!invitation) {
        return {
          kind: "error",
          statusCode: 401,
          code: "INVALID_INVITATION_TOKEN",
          message: "Invalid invitation token",
        };
      }

      const itemRows = await tx.execute(sql`
        SELECT id,registration_session_id
        FROM registration_session_grant_items
        WHERE id=${invitation.grant_item_id}
        FOR UPDATE
      `);
      const item = (
        itemRows as unknown as ResponseGrantItemRow[]
      )[0];
      if (!item) {
        return {
          kind: "error",
          statusCode: 409,
          code: "INVITATION_REVOKED",
          message: "Invitation audit item is unavailable",
        };
      }

      const [{ db_now: rawNow }] =
        (await tx.execute(sql`
          SELECT clock_timestamp() AS db_now
        `)) as unknown as Array<{
          db_now: Date | string;
        }>;
      const now =
        rawNow instanceof Date
          ? rawNow
          : new Date(rawNow);
      const nowIso = now.toISOString();
      const lookupRow = responseLookupRow(
        invitation,
        registration,
        session,
        now,
      );

      if (
        invitation.status === "accepted" ||
        invitation.status === "declined"
      ) {
        if (
          registration.status !== "confirmed" ||
          registration.event_id !== session.event_id ||
          !session.is_active
        ) {
          const error = unavailableError(
            registration,
            session,
          );
          return { kind: "error", ...error };
        }
        if (invitation.status === decision) {
          return {
            kind: "success",
            invitation: publicDto(
              lookupRow,
              invitation.status,
            ),
          };
        }
        return {
          kind: "error",
          statusCode: 409,
          code: "RESPONSE_ALREADY_RECORDED",
          message: "Invitation response was already recorded",
          invitation: publicDto(
            lookupRow,
            invitation.status,
          ),
        };
      }

      if (invitation.status === "expired") {
        return {
          kind: "error",
          statusCode: 410,
          code: "INVITATION_EXPIRED",
          message: "Invitation has expired",
          invitation: publicDto(
            lookupRow,
            "expired",
          ),
        };
      }
      if (invitation.status === "revoked") {
        const error = unavailableError(
          registration,
          session,
        );
        return {
          kind: "error",
          ...error,
          invitation: publicDto(
            lookupRow,
            "revoked",
          ),
        };
      }

      const effectiveStatus = effectiveInvitationStatus(
        {
          status: invitation.status,
          expiresAt: new Date(
            invitation.expires_at,
          ),
          startTime: new Date(session.start_time),
          isActive: session.is_active,
          registrationConfirmed:
            registration.status === "confirmed",
          eventMatches:
            registration.event_id === session.event_id,
        },
        now,
      );
      if (effectiveStatus !== "pending") {
        await tx.execute(sql`
          UPDATE session_invitations
          SET
            status=${effectiveStatus},
            token_ciphertext=NULL,
            closed_at=${nowIso}::timestamptz,
            close_reason=${closeReason(
              registration,
              session,
              effectiveStatus,
            )}
          WHERE id=${invitation.id}
            AND status='pending'
        `);
        const normalized = publicDto(
          lookupRow,
          effectiveStatus,
        );
        if (effectiveStatus === "expired") {
          return {
            kind: "error",
            statusCode: 410,
            code: "INVITATION_EXPIRED",
            message: "Invitation has expired",
            invitation: normalized,
          };
        }
        const error = unavailableError(
          registration,
          session,
        );
        return {
          kind: "error",
          ...error,
          invitation: normalized,
        };
      }

      if (decision === "declined") {
        await tx.execute(sql`
          UPDATE session_invitations
          SET
            status='declined',
            responded_at=${nowIso}::timestamptz,
            closed_at=${nowIso}::timestamptz,
            token_ciphertext=NULL,
            close_reason=NULL
          WHERE id=${invitation.id}
            AND status='pending'
        `);
        return {
          kind: "success",
          invitation: publicDto(
            lookupRow,
            "declined",
            now,
          ),
        };
      }

      const registrationIds =
        lockedRegistrations.map((row) => row.id);
      const entitlementRows =
        registrationIds.length === 0
          ? []
          : ((await tx.execute(sql`
              SELECT
                rs.id,
                rs.registration_id,
                r.user_id
              FROM registration_sessions rs
              JOIN registrations r
                ON r.id=rs.registration_id
              WHERE rs.session_id=${session.id}
                AND r.status='confirmed'
                AND r.event_id=${session.event_id}
                AND rs.registration_id IN (
                  SELECT id FROM registrations
                  WHERE id=${registration.id}
                     OR (
                       ${registration.user_id}::int IS NOT NULL
                       AND event_id=${session.event_id}
                       AND user_id=${registration.user_id}
                     )
                )
              ORDER BY rs.registration_id,rs.id
              FOR UPDATE OF rs
            `)) as unknown as EntitlementRow[]);
      const exactEntitlement =
        entitlementRows.find(
          (row) =>
            row.registration_id ===
            registration.id,
        ) ?? null;
      const siblingEntitlement =
        registration.user_id === null
          ? null
          : entitlementRows.find(
              (row) =>
                row.registration_id !==
                  registration.id &&
                row.user_id ===
                  registration.user_id,
            ) ?? null;

      if (
        !exactEntitlement &&
        siblingEntitlement
      ) {
        await tx.execute(sql`
          UPDATE session_invitations
          SET
            status='revoked',
            token_ciphertext=NULL,
            closed_at=${nowIso}::timestamptz,
            close_reason='PARTICIPANT_ALREADY_REGISTERED'
          WHERE id=${invitation.id}
            AND status='pending'
        `);
        return {
          kind: "error",
          statusCode: 409,
          code: "PARTICIPANT_ALREADY_REGISTERED",
          message:
            "Participant already has access through another registration",
          invitation: publicDto(
            lookupRow,
            "revoked",
          ),
        };
      }

      let registrationSessionId =
        exactEntitlement?.id ?? null;
      if (registrationSessionId === null) {
        const insertedRows = await tx.execute(sql`
          INSERT INTO registration_sessions (
            registration_id,
            session_id,
            ticket_type_id,
            source,
            added_by
          ) VALUES (
            ${registration.id},
            ${session.id},
            NULL,
            'admin_grant',
            ${invitation.created_by}
          )
          ON CONFLICT (
            registration_id,
            session_id
          ) DO NOTHING
          RETURNING id
        `);
        registrationSessionId =
          (
            insertedRows as unknown as Array<{
              id: number;
            }>
          )[0]?.id ?? null;

        if (registrationSessionId === null) {
          const existingRows = await tx.execute(sql`
            SELECT id
            FROM registration_sessions
            WHERE registration_id=${registration.id}
              AND session_id=${session.id}
            LIMIT 1
          `);
          registrationSessionId =
            (
              existingRows as unknown as Array<{
                id: number;
              }>
            )[0]?.id ?? null;
        }
      }

      if (registrationSessionId === null) {
        throw new GrantError(
          409,
          "ENTITLEMENT_CONFLICT",
          "Session entitlement could not be reconciled",
        );
      }

      const linkageOwnerRows = await tx.execute(sql`
        SELECT id
        FROM registration_session_grant_items
        WHERE registration_session_id=${registrationSessionId}
          AND id<>${item.id}
        LIMIT 1
      `);
      const hasDifferentLinkageOwner =
        (
          linkageOwnerRows as unknown as Array<{
            id: string;
          }>
        ).length > 0;
      if (!hasDifferentLinkageOwner) {
        await tx.execute(sql`
          UPDATE registration_session_grant_items
          SET registration_session_id=${registrationSessionId}
          WHERE id=${item.id}
            AND registration_session_id IS NULL
        `);
      }

      await tx.execute(sql`
        UPDATE session_invitations
        SET
          status='accepted',
          responded_at=${now.toISOString()}::timestamptz,
          closed_at=${now.toISOString()}::timestamptz,
          token_ciphertext=NULL,
          close_reason=NULL
        WHERE id=${invitation.id}
          AND status='pending'
      `);

      return {
        kind: "success",
        invitation: publicDto(
          lookupRow,
          "accepted",
          now,
        ),
      };
    },
  );

  if (result.kind === "error") {
    throw new GrantError(
      result.statusCode,
      result.code,
      result.message,
      result.invitation
        ? { invitation: result.invitation }
        : undefined,
    );
  }
  return result.invitation;
}

export async function closeInactiveInvitations(
  database: GrantDatabase,
  sessionId: number,
): Promise<number> {
  return database.transaction(async (tx) => {
    const sessionRows = await tx.execute(sql`
      SELECT
        id,
        event_id,
        is_active,
        session_name,
        session_type,
        (start_time AT TIME ZONE 'UTC') AS start_time,
        (end_time AT TIME ZONE 'UTC') AS end_time,
        room
      FROM sessions
      WHERE id=${sessionId}
      FOR UPDATE
    `);
    const session = (
      sessionRows as unknown as ResponseSessionRow[]
    )[0];
    if (!session) {
      throw new GrantError(
        404,
        "SESSION_NOT_FOUND",
        "Session not found",
      );
    }

    const registrationRows = await tx.execute(sql`
      SELECT
        id,event_id,user_id,status,first_name
      FROM registrations
      WHERE id IN (
        SELECT registration_id
        FROM session_invitations
        WHERE session_id=${sessionId}
          AND status='pending'
      )
      ORDER BY id
      FOR UPDATE
    `);
    const lockedRegistrations =
      registrationRows as unknown as ResponseRegistrationRow[];
    const registrationById = new Map(
      lockedRegistrations.map((row) => [
        row.id,
        row,
      ]),
    );

    const invitationRows = await tx.execute(sql`
      SELECT
        id,
        registration_id,
        session_id,
        grant_item_id,
        status,
        token_hash,
        expires_at,
        responded_at,
        created_by
      FROM session_invitations
      WHERE session_id=${sessionId}
        AND status='pending'
      ORDER BY id
      FOR UPDATE
    `);
    const invitations =
      invitationRows as unknown as ResponseInvitationRow[];

    const [{ db_now: rawNow }] =
      (await tx.execute(sql`
        SELECT clock_timestamp() AS db_now
      `)) as unknown as Array<{
        db_now: Date | string;
      }>;
    const now =
      rawNow instanceof Date
        ? rawNow
        : new Date(rawNow);

    let changed = 0;
    for (const invitation of invitations) {
      const registration =
        registrationById.get(
          invitation.registration_id,
        );
      if (!registration) continue;
      const effectiveStatus = effectiveInvitationStatus(
        {
          status: invitation.status,
          expiresAt: new Date(
            invitation.expires_at,
          ),
          startTime: new Date(
            session.start_time,
          ),
          isActive: session.is_active,
          registrationConfirmed:
            registration.status === "confirmed",
          eventMatches:
            registration.event_id ===
            session.event_id,
        },
        now,
      );
      if (effectiveStatus === "pending") continue;
      const updateRows = await tx.execute(sql`
        UPDATE session_invitations
        SET
          status=${effectiveStatus},
          token_ciphertext=NULL,
          closed_at=${now.toISOString()}::timestamptz,
          close_reason=${closeReason(
            registration,
            session,
            effectiveStatus,
          )}
        WHERE id=${invitation.id}
          AND status='pending'
        RETURNING id
      `);
      changed += (
        updateRows as unknown as Array<{
          id: string;
        }>
      ).length;
    }
    return changed;
  });
}
