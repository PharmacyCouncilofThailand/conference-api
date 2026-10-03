import { createHash, randomInt, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { db } from "../../database/index.js";
import { isWithinSession } from "../attendance/policy.js";
import { candidateSegments, chooseSegment } from "./policy.js";
import {
  readRewardEncryptionKey,
  retryRewardProof,
  RewardCredentialError,
} from "./rewards.js";
import {
  wheelConfigurationSchema,
} from "./schemas.js";
import type { BlockCode, SpinInput, WheelSegment } from "./types.js";

export type WheelDatabase = typeof db;
export type WheelActor = { id: number; role?: string | null; email?: string | null };
export type AdminWheelActor = { id: number; role: "admin"; email: string | null };
export type WheelConfiguration = z.infer<typeof wheelConfigurationSchema>;

export type EligibilityResult = {
  eventId: number;
  userId: number;
  eligible: boolean;
  blockCode: BlockCode | null;
  serverNow: string;
  playDate: string;
  configurationVersion: number | null;
  poolRevision: number | null;
  paused: boolean;
  configuration: WheelConfiguration | null;
  availability: WheelSegment[];
  existingSpin: SpinDto | null;
};

export type SpinDto = {
  id: string;
  eventId: number;
  userId: number;
  playDate: string;
  attendanceId: string;
  attendanceCheckedInAt: string;
  segmentId: string;
  outcomeKind: "prize" | "no_prize";
  awardedName: { th: string; en: string };
  awardedImageKey: string | null;
  configurationVersion: number;
  poolRevision: number;
  createdAt: string;
  configurationSnapshot: unknown;
  outcomeSnapshot: unknown;
};

export type AdminSpinQuery = {
  date?: string;
  segmentId?: string;
  claimStatus?: "none" | "open" | "redeemed";
  page?: number;
  pageSize?: number;
};

export type AdminSpinDto = SpinDto & {
  claim: null | {
    generation: number;
    status: "open" | "redeemed";
    redeemedAt: string | null;
    redeemedBy: number | null;
    collectionPoint: string | null;
    deliveredDetails: string | null;
  };
};

type WheelRow = {
  id: string;
  event_id: number;
  main_session_id: number;
  enabled: boolean;
  paused: boolean;
  version: number;
  pool_revision: number;
  published_configuration: WheelConfiguration | null;
  collection_instructions: { th: string; en: string } | null;
  collection_deadline: Date | string | null;
  session_start: Date | string;
  session_end: Date | string;
};

type SegmentRow = {
  id: string;
  kind: "prize" | "no_prize";
  name_th: string;
  name_en: string;
  image_id: string | null;
  image_key: string | null;
  enabled: boolean;
  position: number;
  remaining: number | null;
  retired_at: Date | string | null;
};

type SpinRow = {
  id: string;
  event_id: number;
  user_id: number;
  play_date: string | Date;
  attendance_id: string;
  attendance_checked_in_at: Date | string;
  segment_id: string;
  outcome_kind: "prize" | "no_prize";
  awarded_name_th: string;
  awarded_name_en: string;
  awarded_image_key: string | null;
  configuration_version: number;
  pool_revision: number;
  configuration_snapshot: unknown;
  outcome_snapshot: unknown;
  request_hash: string;
  created_at: Date | string;
};

export class WheelError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code:
      | BlockCode
      | "INVALID_WHEEL_REQUEST"
      | "WHEEL_NOT_FOUND"
      | "INSUFFICIENT_STOCK"
      | "REWARD_CONFIG_ERROR"
      | "REWARD_CREDENTIAL_COLLISION",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WheelError";
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asDay(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function toWheelSegment(row: SegmentRow): WheelSegment {
  return {
    id: row.id,
    kind: row.kind,
    name: { th: row.name_th, en: row.name_en },
    imageKey: row.image_key,
    enabled: row.enabled,
    position: row.position,
    remaining: row.remaining,
  };
}

function toSpinDto(row: SpinRow): SpinDto {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    playDate: asDay(row.play_date),
    attendanceId: row.attendance_id,
    attendanceCheckedInAt: asDate(row.attendance_checked_in_at).toISOString(),
    segmentId: row.segment_id,
    outcomeKind: row.outcome_kind,
    awardedName: { th: row.awarded_name_th, en: row.awarded_name_en },
    awardedImageKey: row.awarded_image_key,
    configurationVersion: row.configuration_version,
    poolRevision: row.pool_revision,
    createdAt: asDate(row.created_at).toISOString(),
    configurationSnapshot: row.configuration_snapshot,
    outcomeSnapshot: row.outcome_snapshot,
  };
}

async function clock(database: WheelDatabase): Promise<{ now: Date; day: string }> {
  const rows = await database.execute(sql`
    SELECT
      clock_timestamp() AS db_now,
      ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS bangkok_day
  `);
  const row = (rows as unknown as Array<{ db_now: Date | string; bangkok_day: string }>)[0];
  return { now: asDate(row.db_now), day: row.bangkok_day };
}

async function wheelRow(
  database: WheelDatabase,
  eventId: number,
  lock: boolean,
): Promise<WheelRow | null> {
  const suffix = lock ? sql` FOR UPDATE OF w` : sql``;
  const rows = await database.execute(sql`
    SELECT
      w.id, w.event_id, w.main_session_id, w.enabled, w.paused,
      w.version, w.pool_revision, w.published_configuration,
      w.collection_instructions, w.collection_deadline,
      (s.start_time AT TIME ZONE 'UTC') AS session_start,
      (s.end_time AT TIME ZONE 'UTC') AS session_end
    FROM lucky_wheels w
    JOIN sessions s ON s.id = w.main_session_id AND s.event_id = w.event_id
    WHERE w.event_id = ${eventId}
    ${suffix}
  `);
  return (rows as unknown as WheelRow[])[0] ?? null;
}

async function segmentRows(
  database: WheelDatabase,
  wheelId: string,
  lock: boolean,
): Promise<SegmentRow[]> {
  const suffix = lock ? sql` FOR UPDATE OF seg` : sql``;
  const rows = await database.execute(sql`
    SELECT
      seg.id, seg.kind, seg.name_th, seg.name_en, seg.image_id,
      img.object_key AS image_key,
      seg.enabled, seg.position, seg.remaining, seg.retired_at
    FROM lucky_wheel_segments seg
    LEFT JOIN lucky_wheel_images img ON img.id = seg.image_id
    WHERE seg.wheel_id = ${wheelId}
      AND seg.retired_at IS NULL
    ORDER BY seg.position, seg.id
    ${suffix}
  `);
  return rows as unknown as SegmentRow[];
}

async function spinByRequest(
  database: WheelDatabase,
  eventId: number,
  userId: number,
  idempotencyKey: string,
): Promise<SpinRow | null> {
  const rows = await database.execute(sql`
    SELECT *
    FROM lucky_wheel_spins
    WHERE event_id = ${eventId}
      AND user_id = ${userId}
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  return (rows as unknown as SpinRow[])[0] ?? null;
}

async function spinByDay(
  database: WheelDatabase,
  eventId: number,
  userId: number,
  day: string,
): Promise<SpinRow | null> {
  const rows = await database.execute(sql`
    SELECT *
    FROM lucky_wheel_spins
    WHERE event_id = ${eventId}
      AND user_id = ${userId}
      AND play_date = ${day}::date
    LIMIT 1
  `);
  return (rows as unknown as SpinRow[])[0] ?? null;
}

async function requireActiveUser(database: WheelDatabase, userId: number): Promise<void> {
  const rows = await database.execute(sql`
    SELECT id
    FROM users
    WHERE id = ${userId}
      AND status = 'active'
    LIMIT 1
  `);
  if (!(rows as unknown as Array<{ id: number }>)[0]) {
    throw new WheelError(401, "ACCOUNT_UNAVAILABLE", "Active attendee account is required");
  }
}

async function confirmedEntitlements(
  database: WheelDatabase,
  eventId: number,
  userId: number,
  sessionId: number,
  lock: boolean,
): Promise<Array<{ registration_id: number; registration_session_id: number }>> {
  const suffix = lock ? sql` FOR UPDATE OF r, rs` : sql``;
  const rows = await database.execute(sql`
    SELECT r.id AS registration_id, rs.id AS registration_session_id
    FROM registrations r
    JOIN registration_sessions rs
      ON rs.registration_id = r.id
      AND rs.session_id = ${sessionId}
    WHERE r.event_id = ${eventId}
      AND r.user_id = ${userId}
      AND r.status = 'confirmed'
    ORDER BY r.created_at DESC, r.id DESC, rs.id DESC
    ${suffix}
  `);
  return rows as unknown as Array<{ registration_id: number; registration_session_id: number }>;
}

async function activeAttendance(
  database: WheelDatabase,
  eventId: number,
  userId: number,
  sessionId: number,
  day: string,
  lock: boolean,
): Promise<{ id: string; checked_in_at: Date | string } | null> {
  const suffix = lock ? sql` FOR UPDATE OF dc` : sql``;
  const rows = await database.execute(sql`
    SELECT dc.id, dc.checked_in_at
    FROM session_daily_checkins dc
    JOIN registration_sessions rs ON rs.id = dc.registration_session_id
    JOIN registrations r ON r.id = rs.registration_id
    WHERE r.event_id = ${eventId}
      AND r.user_id = ${userId}
      AND r.status = 'confirmed'
      AND rs.session_id = ${sessionId}
      AND dc.attendance_date = ${day}::date
      AND dc.cancelled_at IS NULL
    ORDER BY dc.checked_in_at DESC, dc.id
    LIMIT 1
    ${suffix}
  `);
  return (rows as unknown as Array<{ id: string; checked_in_at: Date | string }>)[0] ?? null;
}

export async function validateAdminActor(
  database: WheelDatabase,
  claimed: WheelActor,
  eventId: number,
): Promise<AdminWheelActor | null> {
  if (
    !Number.isInteger(claimed.id) ||
    claimed.id <= 0 ||
    claimed.role !== "admin"
  ) {
    return null;
  }
  const rows = await database.execute(sql`
    SELECT bo.id, bo.email
    FROM backoffice_users bo
    JOIN events e ON e.id = ${eventId}
    WHERE bo.id = ${claimed.id}
      AND bo.role = 'admin'
      AND bo.is_active = true
    LIMIT 1
  `);
  const row = (rows as unknown as Array<{ id: number; email: string }>)[0];
  if (!row) return null;
  if (
    claimed.email &&
    row.email.toLowerCase() !== claimed.email.toLowerCase()
  ) {
    return null;
  }
  return { id: row.id, role: "admin", email: row.email };
}

async function requireAdmin(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
): Promise<AdminWheelActor> {
  const admin = await validateAdminActor(database, actor, eventId);
  if (!admin) {
    throw new WheelError(403, "ADMIN_REQUIRED", "Active admin access is required");
  }
  return admin;
}

export async function readAdminWheelState(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
) {
  const admin = await requireAdmin(database, actor, eventId);
  const wheel = await wheelRow(database, eventId, false);
  if (!wheel) {
    throw new WheelError(404, "WHEEL_NOT_FOUND", "Lucky wheel was not found for this event");
  }

  const segmentResult = await database.execute(sql`
    SELECT
      seg.id, seg.kind, seg.name_th, seg.name_en, seg.image_id,
      img.object_key AS image_key, img.public_url AS image_url,
      seg.enabled, seg.position, seg.remaining, seg.retired_at,
      (
        SELECT count(*)::int
        FROM lucky_wheel_spins spin
        WHERE spin.segment_id = seg.id
          AND spin.event_id = ${eventId}
          AND spin.outcome_kind = 'prize'
      ) AS allocated_count,
      (
        SELECT count(*)::int
        FROM lucky_wheel_redemptions redemption
        JOIN lucky_wheel_spins spin
          ON spin.id = redemption.spin_id
          AND spin.event_id = redemption.event_id
        WHERE spin.segment_id = seg.id
          AND spin.event_id = ${eventId}
          AND redemption.status = 'redeemed'
      ) AS collected_count
    FROM lucky_wheel_segments seg
    LEFT JOIN lucky_wheel_images img
      ON img.id = seg.image_id
      AND img.deleted_at IS NULL
    WHERE seg.wheel_id = ${wheel.id}
      AND seg.retired_at IS NULL
    ORDER BY seg.position, seg.id
  `);
  const segments = segmentResult as unknown as Array<
    SegmentRow & {
      image_url: string | null;
      allocated_count: number;
      collected_count: number;
    }
  >;

  const auditResult = await database.execute(sql`
    SELECT
      a.id::text AS id,
      a.operation,
      a.reason,
      a.actor_backoffice_user_id,
      bo.email AS actor_email,
      a.before_snapshot,
      a.after_snapshot,
      a.created_at
    FROM lucky_wheel_audit_events a
    LEFT JOIN backoffice_users bo ON bo.id = a.actor_backoffice_user_id
    WHERE a.event_id = ${eventId}
      AND a.wheel_id = ${wheel.id}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100
  `);
  const audit = auditResult as unknown as Array<{
    id: string;
    operation: string;
    reason: string | null;
    actor_backoffice_user_id: number;
    actor_email: string | null;
    before_snapshot: unknown;
    after_snapshot: unknown;
    created_at: Date | string;
  }>;

  return {
    eventId,
    actorId: admin.id,
    wheel: {
      id: wheel.id,
      mainSessionId: wheel.main_session_id,
      enabled: wheel.enabled,
      paused: wheel.paused,
      version: wheel.version,
      poolRevision: wheel.pool_revision,
      configuration: wheel.published_configuration,
      collectionInstructions: wheel.collection_instructions,
      collectionDeadline: wheel.collection_deadline
        ? asDate(wheel.collection_deadline).toISOString()
        : null,
    },
    segments: segments.map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      name: { th: segment.name_th, en: segment.name_en },
      imageId: segment.image_id,
      imageKey: segment.image_key,
      imageUrl: segment.image_url,
      enabled: segment.enabled,
      position: segment.position,
      remaining: segment.remaining,
      allocated: segment.allocated_count,
      collected: segment.collected_count,
    })),
    audit: audit.map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      reason: entry.reason,
      actorId: entry.actor_backoffice_user_id,
      actorEmail: entry.actor_email,
      before: entry.before_snapshot,
      after: entry.after_snapshot,
      createdAt: asDate(entry.created_at).toISOString(),
    })),
  };
}

export async function publishWheel(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
  expectedVersion: number,
  configurationInput: WheelConfiguration,
  reason?: string,
) {
  const configurationResult = wheelConfigurationSchema.safeParse(configurationInput);
  if (!configurationResult.success) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Invalid wheel configuration");
  }
  const configuration = configurationResult.data;
  if (!configuration.segments.some((segment) => segment.kind === "prize")) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "At least one physical prize segment is required");
  }

  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await wheelRow(txDb, eventId, true);
    if (!wheel) {
      throw new WheelError(409, "WHEEL_NOT_READY", "Lucky wheel has not been configured for this event");
    }
    const admin = await requireAdmin(txDb, actor, eventId);
    const previousDeadline = wheel.collection_deadline
      ? asDate(wheel.collection_deadline).toISOString()
      : null;
    const nextDeadline = new Date(configuration.collectionDeadline).toISOString();
    const deadlineChanged = previousDeadline !== null && previousDeadline !== nextDeadline;
    const normalizedReason = reason?.trim() || null;
    if (deadlineChanged && !normalizedReason) {
      throw new WheelError(
        400,
        "INVALID_WHEEL_REQUEST",
        "Changing an existing collection deadline requires an audit reason",
      );
    }

    if (wheel.version !== expectedVersion) {
      if (
        wheel.version === expectedVersion + 1 &&
        wheel.published_configuration &&
        canonicalize(wheel.published_configuration) === canonicalize(configuration)
      ) {
        return {
          eventId,
          version: wheel.version,
          poolRevision: wheel.pool_revision,
          paused: wheel.paused,
          configuration: wheel.published_configuration,
          replayed: true,
        };
      }
      throw new WheelError(409, "WHEEL_UPDATED", "Wheel configuration was updated; reload before publishing");
    }

    const existing = await segmentRows(txDb, wheel.id, true);
    const existingById = new Map(existing.map((segment) => [segment.id, segment]));
    const imageIds = Array.from(
      new Set(
        configuration.segments
          .map((segment) => segment.imageId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    if (imageIds.length > 0) {
      for (const imageId of imageIds) {
        const rows = await tx.execute(sql`
          SELECT id
          FROM lucky_wheel_images
          WHERE id = ${imageId}
            AND event_id = ${eventId}
            AND deleted_at IS NULL
          FOR SHARE
        `);
        if (!(rows as unknown as Array<{ id: string }>)[0]) {
          throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Wheel image does not belong to this event");
        }
      }
    }

    for (const segment of configuration.segments) {
      const prior = existingById.get(segment.id);
      if (prior && prior.kind !== segment.kind) {
        throw new WheelError(
          409,
          "WHEEL_UPDATED",
          "A retained segment ID cannot change prize type",
          { segmentId: segment.id },
        );
      }
      if (prior) {
        await tx.execute(sql`
          UPDATE lucky_wheel_segments
          SET name_th = ${segment.name.th},
              name_en = ${segment.name.en},
              image_id = ${segment.imageId},
              enabled = ${segment.enabled},
              position = ${segment.position},
              retired_at = NULL,
              updated_at = clock_timestamp()
          WHERE id = ${segment.id}
            AND wheel_id = ${wheel.id}
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO lucky_wheel_segments (
            id, wheel_id, kind, name_th, name_en, image_id,
            enabled, position, remaining
          )
          VALUES (
            ${segment.id}, ${wheel.id}, ${segment.kind},
            ${segment.name.th}, ${segment.name.en}, ${segment.imageId},
            ${segment.enabled}, ${segment.position},
            ${segment.kind === "prize" ? 0 : null}
          )
        `);
      }
    }

    const retainedIds = new Set(configuration.segments.map((segment) => segment.id));
    for (const prior of existing) {
      if (!retainedIds.has(prior.id)) {
        await tx.execute(sql`
          UPDATE lucky_wheel_segments
          SET enabled = false,
              retired_at = COALESCE(retired_at, clock_timestamp()),
              updated_at = clock_timestamp()
          WHERE id = ${prior.id}
            AND wheel_id = ${wheel.id}
        `);
      }
    }

    const nextVersion = wheel.version + 1;
    await tx.execute(sql`
      UPDATE lucky_wheels
      SET published_configuration = ${JSON.stringify(configuration)}::jsonb,
          collection_instructions = ${JSON.stringify(configuration.collectionInstructions)}::jsonb,
          collection_deadline = ${configuration.collectionDeadline}::timestamptz,
          enabled = true,
          version = ${nextVersion},
          updated_at = clock_timestamp()
      WHERE id = ${wheel.id}
    `);
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        reason, before_snapshot, after_snapshot
      )
      VALUES (
        ${wheel.id}, ${eventId}, ${admin.id}, 'publish',
        ${normalizedReason ?? "publish wheel configuration"},
        ${JSON.stringify({ version: wheel.version, configuration: wheel.published_configuration })}::jsonb,
        ${JSON.stringify({ version: nextVersion, configuration })}::jsonb
      )
    `);

    return {
      eventId,
      version: nextVersion,
      poolRevision: wheel.pool_revision,
      paused: wheel.paused,
      configuration,
      replayed: false,
    };
  });
}

export async function adjustStock(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
  segmentId: string,
  delta: number,
  reason: string,
  idempotencyKey: string,
) {
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await wheelRow(txDb, eventId, true);
    if (!wheel) {
      throw new WheelError(409, "WHEEL_NOT_READY", "Lucky wheel has not been configured for this event");
    }
    const admin = await requireAdmin(txDb, actor, eventId);

    const replayRows = await tx.execute(sql`
      SELECT before_snapshot, after_snapshot
      FROM lucky_wheel_audit_events
      WHERE event_id = ${eventId}
        AND actor_backoffice_user_id = ${admin.id}
        AND operation = 'stock_adjust'
        AND idempotency_key = ${idempotencyKey}
      LIMIT 1
      FOR UPDATE
    `);
    const replay = (
      replayRows as unknown as Array<{
        before_snapshot: Record<string, unknown>;
        after_snapshot: Record<string, unknown>;
      }>
    )[0];
    if (replay) {
      const after = replay.after_snapshot;
      if (
        after.segmentId !== segmentId ||
        after.delta !== delta ||
        after.reason !== reason.trim()
      ) {
        throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another stock request");
      }
      return {
        eventId,
        segmentId,
        before: Number(replay.before_snapshot.remaining),
        after: Number(after.remaining),
        delta,
        reason: String(after.reason),
        idempotencyKey,
        poolRevision: Number(after.poolRevision),
        replayed: true,
      };
    }

    const segmentRowsResult = await tx.execute(sql`
      SELECT id, kind, enabled, remaining
      FROM lucky_wheel_segments
      WHERE id = ${segmentId}
        AND wheel_id = ${wheel.id}
        AND retired_at IS NULL
      FOR UPDATE
    `);
    const segment = (
      segmentRowsResult as unknown as Array<{
        id: string;
        kind: string;
        enabled: boolean;
        remaining: number | null;
      }>
    )[0];
    if (!segment || segment.kind !== "prize" || segment.remaining === null) {
      throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Stock can only be adjusted for a current physical prize");
    }

    const before = segment.remaining;
    const after = before + delta;
    if (after < 0) {
      throw new WheelError(409, "INSUFFICIENT_STOCK", "Stock adjustment would make inventory negative");
    }
    const availabilityChanged =
      segment.enabled && (before > 0) !== (after > 0);
    const nextPoolRevision = availabilityChanged
      ? wheel.pool_revision + 1
      : wheel.pool_revision;

    await tx.execute(sql`
      UPDATE lucky_wheel_segments
      SET remaining = ${after},
          updated_at = clock_timestamp()
      WHERE id = ${segmentId}
        AND wheel_id = ${wheel.id}
    `);
    if (availabilityChanged) {
      await tx.execute(sql`
        UPDATE lucky_wheels
        SET pool_revision = ${nextPoolRevision},
            updated_at = clock_timestamp()
        WHERE id = ${wheel.id}
      `);
    }
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, reason, before_snapshot, after_snapshot
      )
      VALUES (
        ${wheel.id}, ${eventId}, ${admin.id}, 'stock_adjust',
        ${idempotencyKey}, ${reason.trim()},
        ${JSON.stringify({ segmentId, remaining: before })}::jsonb,
        ${JSON.stringify({
          segmentId,
          delta,
          reason: reason.trim(),
          remaining: after,
          poolRevision: nextPoolRevision,
        })}::jsonb
      )
    `);

    return {
      eventId,
      segmentId,
      before,
      after,
      delta,
      reason: reason.trim(),
      idempotencyKey,
      poolRevision: nextPoolRevision,
      replayed: false,
    };
  });
}

export async function setWheelPaused(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
  paused: boolean,
  reason: string,
  idempotencyKey?: string,
) {
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await wheelRow(txDb, eventId, true);
    if (!wheel) {
      throw new WheelError(409, "WHEEL_NOT_READY", "Lucky wheel has not been configured for this event");
    }
    const admin = await requireAdmin(txDb, actor, eventId);

    if (idempotencyKey) {
      const replayRows = await tx.execute(sql`
        SELECT before_snapshot, after_snapshot
        FROM lucky_wheel_audit_events
        WHERE event_id = ${eventId}
          AND actor_backoffice_user_id = ${admin.id}
          AND operation = 'pause'
          AND idempotency_key = ${idempotencyKey}
        LIMIT 1
        FOR UPDATE
      `);
      const replay = (
        replayRows as unknown as Array<{
          before_snapshot: Record<string, unknown>;
          after_snapshot: Record<string, unknown>;
        }>
      )[0];
      if (replay) {
        if (
          replay.after_snapshot.paused !== paused ||
          replay.after_snapshot.reason !== reason.trim()
        ) {
          throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another pause request");
        }
        return {
          eventId,
          paused,
          reason: reason.trim(),
          idempotencyKey,
          actorId: admin.id,
          replayed: true,
        };
      }
    }

    await tx.execute(sql`
      UPDATE lucky_wheels
      SET paused = ${paused},
          updated_at = clock_timestamp()
      WHERE id = ${wheel.id}
    `);
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, reason, before_snapshot, after_snapshot
      )
      VALUES (
        ${wheel.id}, ${eventId}, ${admin.id}, 'pause',
        ${idempotencyKey ?? null}, ${reason.trim()},
        ${JSON.stringify({ paused: wheel.paused })}::jsonb,
        ${JSON.stringify({ paused, reason: reason.trim() })}::jsonb
      )
    `);

    return {
      eventId,
      paused,
      reason: reason.trim(),
      idempotencyKey: idempotencyKey ?? null,
      actorId: admin.id,
      replayed: false,
    };
  });
}

export async function getEligibility(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
): Promise<EligibilityResult> {
  if (!Number.isInteger(actor.id) || actor.id <= 0) {
    throw new WheelError(401, "ACCOUNT_UNAVAILABLE", "Authenticated attendee account is required");
  }
  const currentClock = await clock(database);
  const wheel = await wheelRow(database, eventId, false);
  await requireActiveUser(database, actor.id);

  const existingSpin = await spinByDay(database, eventId, actor.id, currentClock.day);
  if (existingSpin) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "ALREADY_SPUN",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel?.version ?? null,
      poolRevision: wheel?.pool_revision ?? null,
      paused: wheel?.paused ?? false,
      configuration: wheel?.published_configuration ?? null,
      availability: wheel ? (await segmentRows(database, wheel.id, false)).map(toWheelSegment) : [],
      existingSpin: toSpinDto(existingSpin),
    };
  }

  if (!wheel || !wheel.enabled || !wheel.published_configuration) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "WHEEL_NOT_READY",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel?.version ?? null,
      poolRevision: wheel?.pool_revision ?? null,
      paused: wheel?.paused ?? false,
      configuration: wheel?.published_configuration ?? null,
      availability: [],
      existingSpin: null,
    };
  }

  const entitlements = await confirmedEntitlements(
    database,
    eventId,
    actor.id,
    wheel.main_session_id,
    false,
  );
  if (entitlements.length === 0) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "REGISTRATION_REQUIRED",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel.version,
      poolRevision: wheel.pool_revision,
      paused: wheel.paused,
      configuration: wheel.published_configuration,
      availability: [],
      existingSpin: null,
    };
  }

  const attendance = await activeAttendance(
    database,
    eventId,
    actor.id,
    wheel.main_session_id,
    currentClock.day,
    false,
  );
  if (!attendance) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "CHECKIN_REQUIRED",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel.version,
      poolRevision: wheel.pool_revision,
      paused: wheel.paused,
      configuration: wheel.published_configuration,
      availability: [],
      existingSpin: null,
    };
  }

  if (!isWithinSession(currentClock.now, asDate(wheel.session_start), asDate(wheel.session_end))) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "SESSION_CLOSED",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel.version,
      poolRevision: wheel.pool_revision,
      paused: wheel.paused,
      configuration: wheel.published_configuration,
      availability: [],
      existingSpin: null,
    };
  }

  const availability = (await segmentRows(database, wheel.id, false)).map(toWheelSegment);
  if (wheel.paused) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "WHEEL_PAUSED",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel.version,
      poolRevision: wheel.pool_revision,
      paused: true,
      configuration: wheel.published_configuration,
      availability,
      existingSpin: null,
    };
  }
  if (candidateSegments(availability).length === 0) {
    return {
      eventId,
      userId: actor.id,
      eligible: false,
      blockCode: "OUT_OF_STOCK",
      serverNow: currentClock.now.toISOString(),
      playDate: currentClock.day,
      configurationVersion: wheel.version,
      poolRevision: wheel.pool_revision,
      paused: wheel.paused,
      configuration: wheel.published_configuration,
      availability,
      existingSpin: null,
    };
  }

  return {
    eventId,
    userId: actor.id,
    eligible: true,
    blockCode: null,
    serverNow: currentClock.now.toISOString(),
    playDate: currentClock.day,
    configurationVersion: wheel.version,
    poolRevision: wheel.pool_revision,
    paused: false,
    configuration: wheel.published_configuration,
    availability,
    existingSpin: null,
  };
}

export async function createSpin(
  database: WheelDatabase,
  actor: WheelActor,
  input: SpinInput,
): Promise<{ created: boolean; spin: SpinDto }> {
  if (!Number.isInteger(actor.id) || actor.id <= 0) {
    throw new WheelError(401, "ACCOUNT_UNAVAILABLE", "Authenticated attendee account is required");
  }
  const hash = requestHash({
    eventId: input.eventId,
    configurationVersion: input.configurationVersion,
    poolRevision: input.poolRevision,
  });

  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await wheelRow(txDb, input.eventId, true);
    if (!wheel) {
      throw new WheelError(409, "WHEEL_NOT_READY", "Lucky wheel has not been configured for this event");
    }
    const currentClock = await clock(txDb);

    const replay = await spinByRequest(txDb, input.eventId, actor.id, input.idempotencyKey);
    if (replay) {
      if (replay.request_hash !== hash) {
        throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another spin request");
      }
      return { created: false, spin: toSpinDto(replay) };
    }

    await requireActiveUser(txDb, actor.id);

    const existingDay = await spinByDay(txDb, input.eventId, actor.id, currentClock.day);
    if (existingDay) {
      return { created: false, spin: toSpinDto(existingDay) };
    }

    if (!wheel.enabled || !wheel.published_configuration) {
      throw new WheelError(409, "WHEEL_NOT_READY", "Lucky wheel is not published");
    }
    if (wheel.version !== input.configurationVersion || wheel.pool_revision !== input.poolRevision) {
      throw new WheelError(409, "WHEEL_UPDATED", "Wheel changed; reload before spinning");
    }
    if (wheel.paused) {
      throw new WheelError(409, "WHEEL_PAUSED", "Lucky wheel is paused");
    }
    if (!isWithinSession(currentClock.now, asDate(wheel.session_start), asDate(wheel.session_end))) {
      throw new WheelError(409, "SESSION_CLOSED", "Main Session is not open");
    }

    const entitlements = await confirmedEntitlements(
      txDb,
      input.eventId,
      actor.id,
      wheel.main_session_id,
      true,
    );
    if (entitlements.length === 0) {
      throw new WheelError(403, "REGISTRATION_REQUIRED", "Confirmed Main Session registration is required");
    }
    const attendance = await activeAttendance(
      txDb,
      input.eventId,
      actor.id,
      wheel.main_session_id,
      currentClock.day,
      true,
    );
    if (!attendance) {
      throw new WheelError(409, "CHECKIN_REQUIRED", "Today's Main Session check-in is required");
    }

    const rows = await segmentRows(txDb, wheel.id, true);
    const candidates = candidateSegments(rows.map(toWheelSegment));
    if (candidates.length === 0) {
      throw new WheelError(409, "OUT_OF_STOCK", "Physical prizes are currently out of stock");
    }
    const selected = chooseSegment(candidates, (max) => randomInt(max));
    const source = rows.find((row) => row.id === selected.id);
    if (!source) {
      throw new WheelError(409, "WHEEL_UPDATED", "Selected wheel segment is no longer available");
    }

    const spinId = randomUUID();
    let rewardKey: Buffer | null = null;
    if (selected.kind === "prize") {
      try {
        rewardKey = readRewardEncryptionKey(process.env);
      } catch {
        throw new WheelError(
          503,
          "REWARD_CONFIG_ERROR",
          "Reward encryption is not configured",
        );
      }
    }

    let nextPoolRevision = wheel.pool_revision;
    if (selected.kind === "prize") {
      const updatedRows = await tx.execute(sql`
        UPDATE lucky_wheel_segments
        SET remaining = remaining - 1,
            updated_at = clock_timestamp()
        WHERE id = ${selected.id}
          AND wheel_id = ${wheel.id}
          AND kind = 'prize'
          AND enabled = true
          AND remaining > 0
        RETURNING remaining
      `);
      const updated = (updatedRows as unknown as Array<{ remaining: number }>)[0];
      if (!updated) {
        throw new WheelError(409, "WHEEL_UPDATED", "Selected prize is no longer available");
      }
      if (updated.remaining === 0) {
        nextPoolRevision = wheel.pool_revision + 1;
        await tx.execute(sql`
          UPDATE lucky_wheels
          SET pool_revision = ${nextPoolRevision},
              updated_at = clock_timestamp()
          WHERE id = ${wheel.id}
        `);
      }
    }

    const orderedPool = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      enabled: row.enabled,
      position: row.position,
      remaining:
        row.id === selected.id && selected.kind === "prize" && row.remaining !== null
          ? row.remaining - 1
          : row.remaining,
    }));
    const outcomeSnapshot = {
      segmentId: selected.id,
      kind: selected.kind,
      name: selected.name,
      imageKey: selected.imageKey,
    };
    const insertSpin = async (
      reward: null | {
        tokenDigest: string;
        envelope: string;
        codeDigest: string;
      },
    ): Promise<SpinRow | null> => {
      const insertedRows = await tx.execute(sql`
        INSERT INTO lucky_wheel_spins (
          id, wheel_id, event_id, user_id, play_date,
          attendance_id, attendance_checked_in_at,
          segment_id, outcome_kind,
          awarded_name_th, awarded_name_en, awarded_image_key,
          configuration_version, pool_revision,
          configuration_snapshot, outcome_snapshot,
          idempotency_key, request_hash,
          reward_token_digest, reward_token_envelope, reward_code_digest
        )
        VALUES (
          ${spinId}, ${wheel.id}, ${input.eventId}, ${actor.id}, ${currentClock.day}::date,
          ${attendance.id}, ${asDate(attendance.checked_in_at).toISOString()}::timestamptz,
          ${selected.id}, ${selected.kind},
          ${selected.name.th}, ${selected.name.en}, ${selected.imageKey},
          ${wheel.version}, ${wheel.pool_revision},
          ${JSON.stringify({ configuration: wheel.published_configuration, pool: orderedPool })}::jsonb,
          ${JSON.stringify(outcomeSnapshot)}::jsonb,
          ${input.idempotencyKey}, ${hash},
          ${reward?.tokenDigest ?? null},
          ${reward?.envelope ?? null},
          ${reward?.codeDigest ?? null}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `);
      const row = (insertedRows as unknown as SpinRow[])[0] ?? null;
      if (row) return row;

      const byRequest = await spinByRequest(txDb, input.eventId, actor.id, input.idempotencyKey);
      const byDay = await spinByDay(txDb, input.eventId, actor.id, currentClock.day);
      if (byRequest || byDay) {
        throw new WheelError(
          409,
          "WHEEL_UPDATED",
          "Spin state changed during allocation; retry from the committed server state",
        );
      }
      return null;
    };

    let inserted: SpinRow;
    if (selected.kind === "prize") {
      try {
        inserted = await retryRewardProof(
          spinId,
          rewardKey as Buffer,
          async (proof) =>
            insertSpin({
              tokenDigest: proof.tokenDigest,
              envelope: JSON.stringify(proof.envelope),
              codeDigest: proof.codeDigest,
            }),
        );
      } catch (error) {
        if (error instanceof RewardCredentialError) {
          throw new WheelError(
            503,
            "REWARD_CREDENTIAL_COLLISION",
            "Unable to issue a unique reward credential",
          );
        }
        throw error;
      }

      await tx.execute(sql`
        INSERT INTO lucky_wheel_redemptions (
          spin_id, event_id, claim_generation, status
        )
        VALUES (${inserted.id}, ${input.eventId}, 1, 'open')
      `);
    } else {
      const noPrize = await insertSpin(null);
      if (!noPrize) {
        throw new WheelError(409, "WHEEL_UPDATED", "Spin state changed; reload before retrying");
      }
      inserted = noPrize;
    }

    return { created: true, spin: toSpinDto(inserted) };
  });
}

export async function readAdminSpins(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
  query: AdminSpinQuery = {},
) {
  const admin = await requireAdmin(database, actor, eventId);
  const date = query.date ?? null;
  const segmentId = query.segmentId ?? null;
  const claimStatus = query.claimStatus ?? null;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRows = await database.execute(sql`
    SELECT count(*)::int AS total
    FROM lucky_wheel_spins s
    LEFT JOIN lucky_wheel_redemptions r
      ON r.spin_id = s.id
      AND r.event_id = s.event_id
    WHERE s.event_id = ${eventId}
      AND (${date}::date IS NULL OR s.play_date = ${date}::date)
      AND (${segmentId}::uuid IS NULL OR s.segment_id = ${segmentId}::uuid)
      AND (
        ${claimStatus}::text IS NULL
        OR CASE
          WHEN s.outcome_kind = 'no_prize' THEN 'none'
          WHEN r.id IS NULL THEN 'none'
          ELSE r.status
        END = ${claimStatus}
      )
  `);
  const total = Number(
    (countRows as unknown as Array<{ total: number }>)[0]?.total ?? 0,
  );

  const rows = await database.execute(sql`
    SELECT
      s.*,
      r.id AS redemption_id,
      r.claim_generation,
      r.status AS redemption_status,
      r.redeemed_at,
      r.redeemed_by,
      r.collection_point,
      r.delivered_details
    FROM lucky_wheel_spins s
    LEFT JOIN lucky_wheel_redemptions r
      ON r.spin_id = s.id
      AND r.event_id = s.event_id
    WHERE s.event_id = ${eventId}
      AND (${date}::date IS NULL OR s.play_date = ${date}::date)
      AND (${segmentId}::uuid IS NULL OR s.segment_id = ${segmentId}::uuid)
      AND (
        ${claimStatus}::text IS NULL
        OR CASE
          WHEN s.outcome_kind = 'no_prize' THEN 'none'
          WHEN r.id IS NULL THEN 'none'
          ELSE r.status
        END = ${claimStatus}
      )
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `);
  const mapped = rows as unknown as Array<SpinRow & {
    redemption_id: string | null;
    claim_generation: number | null;
    redemption_status: "open" | "redeemed" | null;
    redeemed_at: Date | string | null;
    redeemed_by: number | null;
    collection_point: string | null;
    delivered_details: string | null;
  }>;

  return {
    eventId,
    actorId: admin.id,
    spins: mapped.map((row): AdminSpinDto => ({
      ...toSpinDto(row),
      claim: row.redemption_id && row.claim_generation && row.redemption_status
        ? {
            generation: row.claim_generation,
            status: row.redemption_status,
            redeemedAt: row.redeemed_at ? asDate(row.redeemed_at).toISOString() : null,
            redeemedBy: row.redeemed_by,
            collectionPoint: row.collection_point,
            deliveredDetails: row.delivered_details,
          }
        : null,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
  };
}
