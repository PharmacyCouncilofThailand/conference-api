import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { sql } from "drizzle-orm";
import { validatePrisWheelClaimOrigin } from "../../config/env.js";
import {
  activeAttendance,
  clock,
  confirmedEntitlements,
  requireActiveUser,
  WheelError,
  type WheelDatabase,
} from "./access.js";
import { isWithinDayWindow, readDayWindowForSpin } from "./day-schedule.js";
import type { AdminWheelActor, WheelActor } from "./service.js";

export type QrStatus = "closed" | "open";
export type QrBatchInput = { date: string; names: string[]; idempotencyKey: string };
export type QrStatusInput = { status: QrStatus; reason?: string; idempotencyKey: string };
export type QrRevocationInput = { reason: string; idempotencyKey: string };

type QrRow = {
  id: string;
  event_id: number;
  day_id: string;
  play_date: string | Date;
  name: string;
  status: QrStatus;
  created_by: number;
  created_at: Date | string;
  opened_by: number | null;
  opened_at: Date | string | null;
  opened_reason: string | null;
  closed_by: number | null;
  closed_at: Date | string | null;
  closed_reason: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toDate(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function toQr(row: QrRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    date: toDate(row.play_date),
    name: row.name,
    status: row.status,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) as string,
    openedBy: row.opened_by,
    openedAt: toIso(row.opened_at),
    openedReason: row.opened_reason,
    closedBy: row.closed_by,
    closedAt: toIso(row.closed_at),
    closedReason: row.closed_reason,
  };
}

type QrDto = ReturnType<typeof toQr>;
type RevocationDto = {
  claimId: string; revokedAt: string; revokedBy: number; reason: string;
};

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function lockedWheel(database: WheelDatabase, eventId: number): Promise<{ id: string }> {
  const rows = await database.execute(sql`
    SELECT id FROM lucky_wheels WHERE event_id = ${eventId} FOR UPDATE
  `);
  const wheel = (rows as unknown as Array<{ id: string }>)[0];
  if (!wheel) throw new WheelError(404, "WHEEL_NOT_FOUND", "Lucky wheel was not found for this event");
  return wheel;
}

async function qrById(
  database: WheelDatabase,
  eventId: number,
  qrId: string,
  lock: boolean,
): Promise<QrRow | null> {
  const suffix = lock ? sql` FOR UPDATE OF q` : sql``;
  const rows = await database.execute(sql`
    SELECT q.*
    FROM lucky_wheel_qr_codes q
    WHERE q.id = ${qrId} AND q.event_id = ${eventId}
    ${suffix}
  `);
  return (rows as unknown as QrRow[])[0] ?? null;
}

async function auditByKey(
  database: WheelDatabase,
  eventId: number,
  actorId: number,
  operation: string,
  key: string,
): Promise<{ before_snapshot: Record<string, unknown> | null; after_snapshot: Record<string, unknown> | null } | null> {
  const rows = await database.execute(sql`
    SELECT before_snapshot, after_snapshot
    FROM lucky_wheel_audit_events
    WHERE event_id = ${eventId}
      AND actor_backoffice_user_id = ${actorId}
      AND operation = ${operation}
      AND idempotency_key = ${key}
    LIMIT 1
  `);
  return (rows as unknown as Array<{
    before_snapshot: Record<string, unknown> | null;
    after_snapshot: Record<string, unknown> | null;
  }>)[0] ?? null;
}

export async function createQrBatch(
  database: WheelDatabase,
  actor: AdminWheelActor,
  eventId: number,
  input: QrBatchInput,
) {
  const requestHash = hashRequest({ date: input.date, names: input.names });
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await lockedWheel(txDb, eventId);
    const prior = await auditByKey(txDb, eventId, actor.id, "qr_batch_create", input.idempotencyKey);
    if (prior) {
      if (prior.before_snapshot?.requestHash !== requestHash) {
        throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "QR batch key was used for different input");
      }
      const ids = prior.after_snapshot?.ids;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        throw new WheelError(500, "INVALID_WHEEL_REQUEST", "QR batch audit is incomplete");
      }
      const qrCodes = [];
      for (const id of ids) {
        const row = await qrById(txDb, eventId, id, false);
        if (!row) throw new WheelError(500, "INVALID_WHEEL_REQUEST", "QR batch is incomplete");
        qrCodes.push(toQr(row));
      }
      return { eventId, date: input.date, qrCodes, replayed: true };
    }
    const day = await readDayWindowForSpin(txDb, wheel.id, input.date, true);
    if (!day) throw new WheelError(404, "WHEEL_NOT_FOUND", "Create the day window before QR codes");
    const qrCodes = [];
    for (const name of input.names) {
      const rows = await tx.execute(sql`
        INSERT INTO lucky_wheel_qr_codes (
          day_id, event_id, play_date, name, created_by
        ) VALUES (
          ${day.id}, ${eventId}, ${input.date}::date, ${name}, ${actor.id}
        ) RETURNING *
      `);
      qrCodes.push(toQr((rows as unknown as QrRow[])[0]));
    }
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, before_snapshot, after_snapshot
      ) VALUES (
        ${wheel.id}, ${eventId}, ${actor.id}, 'qr_batch_create',
        ${input.idempotencyKey}, ${JSON.stringify({ requestHash })}::jsonb,
        ${JSON.stringify({ date: input.date, ids: qrCodes.map((qr) => qr.id) })}::jsonb
      )
    `);
    return { eventId, date: input.date, qrCodes, replayed: false };
  });
}

export async function setQrStatus(
  database: WheelDatabase,
  actor: AdminWheelActor,
  eventId: number,
  qrId: string,
  input: QrStatusInput,
): Promise<QrDto & { replayed: boolean }> {
  const operation = input.status === "open" ? "qr_open" : "qr_close";
  const reason = input.reason?.trim() || null;
  const requestHash = hashRequest({ qrId, status: input.status, reason });
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await lockedWheel(txDb, eventId);
    const meta = await qrById(txDb, eventId, qrId, false);
    if (!meta) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
    const day = await readDayWindowForSpin(txDb, wheel.id, toDate(meta.play_date), true);
    if (!day || day.id !== meta.day_id) {
      throw new WheelError(404, "WHEEL_NOT_FOUND", "QR day was not found for this event");
    }
    const prior = await auditByKey(txDb, eventId, actor.id, operation, input.idempotencyKey);
    if (prior) {
      if (prior.before_snapshot?.requestHash !== requestHash) {
        throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "QR status key was used for different input");
      }
      return { ...(prior.after_snapshot?.result as QrDto), replayed: true };
    }
    const current = await qrById(txDb, eventId, qrId, true);
    if (!current) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
    if (current.status === input.status) {
      return { ...toQr(current), replayed: false };
    }
    const rows = input.status === "open"
      ? await tx.execute(sql`
        UPDATE lucky_wheel_qr_codes
        SET status = 'open', opened_by = ${actor.id}, opened_at = clock_timestamp(),
            opened_reason = ${reason},
            closed_by = NULL, closed_at = NULL, closed_reason = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${qrId} RETURNING *
      `)
      : await tx.execute(sql`
        UPDATE lucky_wheel_qr_codes
        SET status = 'closed', closed_by = ${actor.id}, closed_at = clock_timestamp(),
            closed_reason = ${reason}, updated_at = clock_timestamp()
        WHERE id = ${qrId} RETURNING *
      `);
    const result = toQr((rows as unknown as QrRow[])[0]);
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, reason, before_snapshot, after_snapshot
      ) VALUES (
        ${wheel.id}, ${eventId}, ${actor.id}, ${operation},
        ${input.idempotencyKey}, ${reason},
        ${JSON.stringify({ requestHash, qr: toQr(current) })}::jsonb,
        ${JSON.stringify({ result })}::jsonb
      )
    `);
    return { ...result, replayed: false };
  });
}

export async function readQrCodes(
  database: WheelDatabase,
  _actor: AdminWheelActor,
  eventId: number,
  query: { date: string; page: number; pageSize: number },
) {
  const offset = (query.page - 1) * query.pageSize;
  const countRows = await database.execute(sql`
    SELECT count(*)::int AS total FROM lucky_wheel_qr_codes
    WHERE event_id = ${eventId} AND play_date = ${query.date}::date
  `);
  const total = (countRows as unknown as Array<{ total: number }>)[0].total;
  const rows = await database.execute(sql`
    SELECT q.*, d.end_at AS current_deadline,
      (SELECT count(*)::int FROM lucky_wheel_credit_claims c WHERE c.qr_id = q.id) AS claim_count,
      (SELECT count(*)::int FROM lucky_wheel_credit_claims c WHERE c.qr_id = q.id AND c.spent_at IS NOT NULL) AS spent_count,
      (SELECT count(*)::int FROM lucky_wheel_credit_claims c WHERE c.qr_id = q.id AND c.revoked_at IS NOT NULL) AS revoked_count
    FROM lucky_wheel_qr_codes q
    JOIN lucky_wheel_days d ON d.id = q.day_id
    WHERE q.event_id = ${eventId} AND q.play_date = ${query.date}::date
    ORDER BY q.created_at, q.id
    LIMIT ${query.pageSize} OFFSET ${offset}
  `);
  type ListRow = QrRow & {
    current_deadline: Date | string; claim_count: number; spent_count: number; revoked_count: number;
  };
  return {
    eventId,
    date: query.date,
    items: (rows as unknown as ListRow[]).map((row) => ({
      ...toQr(row),
      currentDeadline: toIso(row.current_deadline) as string,
      claimCount: row.claim_count,
      spentCount: row.spent_count,
      revokedCount: row.revoked_count,
    })),
    pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
  };
}

export async function readQrProjection(
  database: WheelDatabase,
  _actor: AdminWheelActor,
  eventId: number,
  qrId: string,
  backofficeOrigin: string | null = null,
) {
  const rows = await database.execute(sql`
    SELECT q.*, d.end_at AS current_deadline, e.website_url
    FROM lucky_wheel_qr_codes q
    JOIN lucky_wheel_days d ON d.id = q.day_id
    JOIN events e ON e.id = q.event_id
    WHERE q.event_id = ${eventId} AND q.id = ${qrId}
    LIMIT 1
  `);
  const row = (rows as unknown as Array<QrRow & { current_deadline: Date | string; website_url: string | null }>)[0];
  if (!row) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
  let origin: string;
  try {
    origin = validatePrisWheelClaimOrigin(row.website_url, backofficeOrigin);
  } catch (error) {
    throw new WheelError(503, "WHEEL_NOT_READY", error instanceof Error ? error.message : "Event PRIS website URL is invalid");
  }
  const claimUrl = `${origin}/th/lucky-wheel/claim#${qrId}`;
  return {
    ...toQr(row),
    currentDeadline: toIso(row.current_deadline) as string,
    claimUrl,
    qrDataUrl: await QRCode.toDataURL(claimUrl, { width: 512, margin: 2, errorCorrectionLevel: "M" }),
  };
}

export async function readQrClaims(
  database: WheelDatabase,
  _actor: AdminWheelActor,
  eventId: number,
  qrId: string,
  query: { page: number; pageSize: number },
) {
  const qr = await qrById(database, eventId, qrId, false);
  if (!qr) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
  const offset = (query.page - 1) * query.pageSize;
  const countRows = await database.execute(sql`
    SELECT count(*)::int AS total FROM lucky_wheel_credit_claims WHERE qr_id = ${qrId}
  `);
  const total = (countRows as unknown as Array<{ total: number }>)[0].total;
  const rows = await database.execute(sql`
    SELECT c.id, c.user_id, c.attendance_id, c.claimed_at,
           c.displayed_deadline_at, c.revoked_at, c.revoked_by,
           c.revocation_reason, c.spent_at,
           u.first_name, u.last_name, u.email
    FROM lucky_wheel_credit_claims c
    JOIN users u ON u.id = c.user_id
    WHERE c.qr_id = ${qrId} AND c.event_id = ${eventId}
    ORDER BY c.claimed_at, c.id
    LIMIT ${query.pageSize} OFFSET ${offset}
  `);
  type ClaimRow = {
    id: string; user_id: number; attendance_id: string; claimed_at: Date | string;
    displayed_deadline_at: Date | string; revoked_at: Date | string | null;
    revoked_by: number | null; revocation_reason: string | null; spent_at: Date | string | null;
    first_name: string; last_name: string; email: string;
  };
  return {
    eventId,
    qrId,
    items: (rows as unknown as ClaimRow[]).map((row) => ({
      id: row.id, userId: row.user_id,
      recipient: { firstName: row.first_name, lastName: row.last_name, email: row.email },
      attendanceId: row.attendance_id,
      claimedAt: toIso(row.claimed_at) as string,
      displayedDeadlineAt: toIso(row.displayed_deadline_at) as string,
      revokedAt: toIso(row.revoked_at), revokedBy: row.revoked_by,
      revocationReason: row.revocation_reason, spentAt: toIso(row.spent_at),
    })),
    pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
  };
}

export async function revokeCreditClaim(
  database: WheelDatabase,
  actor: AdminWheelActor,
  eventId: number,
  claimId: string,
  input: QrRevocationInput,
): Promise<RevocationDto & { replayed: boolean }> {
  const requestHash = hashRequest({ claimId, reason: input.reason });
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await lockedWheel(txDb, eventId);
    const metaRows = await tx.execute(sql`
      SELECT c.qr_id, c.play_date, q.day_id
      FROM lucky_wheel_credit_claims c
      JOIN lucky_wheel_qr_codes q ON q.id = c.qr_id
      WHERE c.id = ${claimId} AND c.event_id = ${eventId}
    `);
    const meta = (metaRows as unknown as Array<{ qr_id: string; play_date: Date | string; day_id: string }>)[0];
    if (!meta) throw new WheelError(404, "WHEEL_NOT_FOUND", "Credit was not found for this event");
    const day = await readDayWindowForSpin(txDb, wheel.id, toDate(meta.play_date), true);
    if (!day || day.id !== meta.day_id) {
      throw new WheelError(404, "WHEEL_NOT_FOUND", "Credit day was not found for this event");
    }
    await qrById(txDb, eventId, meta.qr_id, true);
    const prior = await auditByKey(txDb, eventId, actor.id, "credit_revoke", input.idempotencyKey);
    if (prior) {
      if (prior.before_snapshot?.requestHash !== requestHash) {
        throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "Revocation key was used for different input");
      }
      return { ...(prior.after_snapshot?.result as RevocationDto), replayed: true };
    }
    const rows = await tx.execute(sql`
      SELECT id, spent_at, revoked_at
      FROM lucky_wheel_credit_claims
      WHERE id = ${claimId} AND event_id = ${eventId}
      FOR UPDATE
    `);
    const claim = (rows as unknown as Array<{
      id: string; spent_at: Date | string | null; revoked_at: Date | string | null;
    }>)[0];
    if (!claim) throw new WheelError(404, "WHEEL_NOT_FOUND", "Credit was not found for this event");
    if (claim.spent_at || claim.revoked_at) {
      throw new WheelError(409, "WHEEL_UPDATED", "Only an unspent active credit can be revoked");
    }
    const updated = await tx.execute(sql`
      UPDATE lucky_wheel_credit_claims
      SET revoked_at = clock_timestamp(), revoked_by = ${actor.id},
          revocation_reason = ${input.reason}
      WHERE id = ${claimId} AND spent_at IS NULL AND revoked_at IS NULL
      RETURNING revoked_at
    `);
    const revokedAt = (updated as unknown as Array<{ revoked_at: Date | string }>)[0]?.revoked_at;
    if (!revokedAt) throw new WheelError(409, "WHEEL_UPDATED", "Credit was changed during revocation");
    const result = {
      claimId, revokedAt: toIso(revokedAt) as string,
      revokedBy: actor.id, reason: input.reason,
    };
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, reason, before_snapshot, after_snapshot
      ) VALUES (
        ${wheel.id}, ${eventId}, ${actor.id}, 'credit_revoke',
        ${input.idempotencyKey}, ${input.reason},
        ${JSON.stringify({ requestHash, claimId, revokedAt: null })}::jsonb,
        ${JSON.stringify({ result })}::jsonb
      )
    `);
    return { ...result, replayed: false };
  });
}

type ClaimWheelRow = {
  id: string;
  main_session_id: number;
  enabled: boolean;
  paused: boolean;
  published_configuration: unknown | null;
};

async function claimWheel(
  database: WheelDatabase,
  eventId: number,
): Promise<ClaimWheelRow> {
  const rows = await database.execute(sql`
    SELECT id, main_session_id, enabled, paused, published_configuration
    FROM lucky_wheels WHERE event_id = ${eventId} FOR UPDATE
  `);
  const wheel = (rows as unknown as ClaimWheelRow[])[0];
  if (!wheel) throw new WheelError(404, "WHEEL_NOT_FOUND", "Lucky wheel was not found for this event");
  return wheel;
}

async function hasPhysicalStock(database: WheelDatabase, wheelId: string): Promise<boolean> {
  const rows = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM lucky_wheel_segments
      WHERE wheel_id = ${wheelId}
        AND kind = 'prize' AND enabled = true
        AND retired_at IS NULL AND remaining > 0
    ) AS available
  `);
  return (rows as unknown as Array<{ available: boolean }>)[0].available;
}

export async function previewQrCredit(
  database: WheelDatabase,
  _actor: WheelActor,
  eventId: number,
  qrId: string,
) {
  const rows = await database.execute(sql`
    SELECT q.id, q.name, q.status, q.play_date, d.start_at, d.end_at, d.version
    FROM lucky_wheel_qr_codes q
    JOIN lucky_wheel_days d ON d.id = q.day_id
    WHERE q.id = ${qrId} AND q.event_id = ${eventId}
    LIMIT 1
  `);
  const row = (rows as unknown as Array<{
    id: string; name: string; status: QrStatus; play_date: Date | string;
    start_at: Date | string; end_at: Date | string; version: number;
  }>)[0];
  if (!row) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
  return {
    qrId: row.id,
    name: row.name,
    status: row.status,
    date: toDate(row.play_date),
    startAt: toIso(row.start_at) as string,
    currentDeadline: toIso(row.end_at) as string,
    scheduleVersion: row.version,
  };
}

type CreditState = "spendable" | "outside_window" | "blocked" | "spent" | "revoked" | "prior_day_expired";
type CreditRow = {
  id: string;
  claimed_at: Date | string;
  revoked_at: Date | string | null;
  spent_at: Date | string | null;
};

export async function claimQrCredit(
  database: WheelDatabase,
  actor: WheelActor,
  eventId: number,
  qrId: string,
) {
  if (!Number.isInteger(actor.id) || actor.id <= 0) {
    throw new WheelError(401, "ACCOUNT_UNAVAILABLE", "Authenticated attendee account is required");
  }
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheel = await claimWheel(txDb, eventId);
    const meta = await qrById(txDb, eventId, qrId, false);
    if (!meta) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
    const date = toDate(meta.play_date);
    const day = await readDayWindowForSpin(txDb, wheel.id, date, true);
    if (!day || day.id !== meta.day_id) {
      throw new WheelError(404, "WHEEL_NOT_FOUND", "QR day was not found for this event");
    }
    const qr = await qrById(txDb, eventId, qrId, true);
    if (!qr) throw new WheelError(404, "WHEEL_NOT_FOUND", "QR code was not found for this event");
    const existingRows = await tx.execute(sql`
      SELECT id, claimed_at, revoked_at, spent_at
      FROM lucky_wheel_credit_claims
      WHERE qr_id = ${qrId} AND user_id = ${actor.id}
      FOR UPDATE
    `);
    const existing = (existingRows as unknown as CreditRow[])[0] ?? null;
    const current = await clock(txDb);
    if (existing) {
      let state: CreditState;
      if (existing.spent_at) state = "spent";
      else if (existing.revoked_at) state = "revoked";
      else if (date !== current.day) state = "prior_day_expired";
      else if (!isWithinDayWindow(current.now, day)) state = "outside_window";
      else {
        const entitlements = await confirmedEntitlements(
          txDb, eventId, actor.id, wheel.main_session_id, false,
        );
        const attendance = await activeAttendance(
          txDb, eventId, actor.id, wheel.main_session_id, date, false,
        );
        const userRows = await tx.execute(sql`
          SELECT id FROM users WHERE id = ${actor.id} AND status = 'active' LIMIT 1
        `);
        const canPlay = wheel.enabled && wheel.published_configuration && !wheel.paused
          && Boolean((userRows as unknown as Array<{ id: number }>)[0])
          && entitlements.length > 0 && Boolean(attendance)
          && await hasPhysicalStock(txDb, wheel.id);
        state = canPlay ? "spendable" : "blocked";
      }
      return {
        created: false, qrId, qrName: qr.name, creditId: existing.id,
        date, claimedAt: toIso(existing.claimed_at) as string,
        currentDeadline: day.endAt, state,
      };
    }
    await requireActiveUser(txDb, actor.id);
    const entitlements = await confirmedEntitlements(
      txDb, eventId, actor.id, wheel.main_session_id, true,
    );
    if (entitlements.length === 0) {
      throw new WheelError(409, "REGISTRATION_REQUIRED", "Confirmed Main Session registration is required");
    }
    const attendance = await activeAttendance(
      txDb, eventId, actor.id, wheel.main_session_id, date, true,
    );
    if (!attendance) {
      throw new WheelError(409, "CHECKIN_REQUIRED", "Today's Main Session check-in is required");
    }
    if (date !== current.day || !isWithinDayWindow(current.now, day)) {
      throw new WheelError(409, "SESSION_CLOSED", "QR claiming is outside today's wheel window");
    }
    if (qr.status !== "open") {
      throw new WheelError(409, "WHEEL_NOT_READY", "QR code is not open for claiming");
    }
    if (!wheel.enabled || !wheel.published_configuration) {
      throw new WheelError(409, "WHEEL_NOT_READY", "Lucky wheel is not published");
    }
    if (wheel.paused) {
      throw new WheelError(409, "WHEEL_PAUSED", "Lucky wheel is paused");
    }
    if (!(await hasPhysicalStock(txDb, wheel.id))) {
      throw new WheelError(409, "OUT_OF_STOCK", "Physical prizes are currently out of stock");
    }
    const inserted = await tx.execute(sql`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, claimed_at,
        displayed_deadline_at
      ) VALUES (
        ${qrId}, ${eventId}, ${date}::date, ${actor.id},
        ${attendance.id}, clock_timestamp(), ${day.endAt}::timestamptz
      )
      RETURNING id, claimed_at
    `);
    const credit = (inserted as unknown as Array<{ id: string; claimed_at: Date | string }>)[0];
    return {
      created: true, qrId, qrName: qr.name, creditId: credit.id,
      date, claimedAt: toIso(credit.claimed_at) as string,
      currentDeadline: day.endAt, state: "spendable" as const,
    };
  });
}
