import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import { bangkokDay, isWithinSession } from "./policy.js";

export type AttendanceActor = {
  id: number;
  role?: string | null;
};

export type AttendanceState = {
  mode: "daily" | "single";
  registrationSessionId: number;
  attendanceId: string | null;
  attendanceDate: string | null;
  checkedInAt: Date | null;
  checkedInBy: number | null;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  cancellationReason: string | null;
  serverNow: Date;
};

type Database = typeof db;

type EntitlementRow = {
  registration_session_id: number;
  registration_id: number;
  registration_status: string;
  event_id: number;
  session_id: number;
  session_start: Date | string;
  session_end: Date | string;
  legacy_checked_in_at: Date | string | null;
  legacy_checked_in_by: number | null;
  daily_enabled: boolean;
};

type DailyRow = {
  id: string;
  attendance_date: string | Date;
  checked_in_at: Date | string;
  checked_in_by: number | null;
  cancelled_at: Date | string | null;
  cancelled_by: number | null;
  cancellation_reason: string | null;
};

export class AttendanceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceError";
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asDay(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

async function databaseClock(database: Database): Promise<{ now: Date; day: string }> {
  const rows = await database.execute(sql`
    SELECT
      clock_timestamp() AS db_now,
      ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS bangkok_day
  `);
  const row = (rows as unknown as Array<{ db_now: Date | string; bangkok_day: string }>)[0];
  return { now: asDate(row.db_now), day: row.bangkok_day };
}

async function entitlement(
  database: Database,
  registrationSessionId: number,
  lock = false,
): Promise<EntitlementRow> {
  const lockSql = lock ? sql` FOR UPDATE OF rs` : sql``;
  const rows = await database.execute(sql`
    SELECT
      rs.id AS registration_session_id,
      rs.registration_id,
      r.status AS registration_status,
      r.event_id,
      rs.session_id,
      (s.start_time AT TIME ZONE 'UTC') AS session_start,
      (s.end_time AT TIME ZONE 'UTC') AS session_end,
      (rs.checked_in_at AT TIME ZONE 'UTC') AS legacy_checked_in_at,
      rs.checked_in_by AS legacy_checked_in_by,
      COALESCE(p.enabled = true AND p.mode = 'daily', false) AS daily_enabled
    FROM registration_sessions rs
    JOIN registrations r ON r.id = rs.registration_id
    JOIN sessions s ON s.id = rs.session_id AND s.event_id = r.event_id
    LEFT JOIN session_attendance_policies p
      ON p.event_id = r.event_id AND p.session_id = rs.session_id
    WHERE rs.id = ${registrationSessionId}
    ${lockSql}
  `);
  const row = (rows as unknown as EntitlementRow[])[0];
  if (!row) {
    throw new AttendanceError(400, "NO_ACCESS", "Registration has no entitlement for this session");
  }
  return row;
}

async function authorizeActor(
  database: Database,
  actor: AttendanceActor,
  eventId: number,
  sessionId: number,
): Promise<void> {
  if (!Number.isInteger(actor.id) || actor.id <= 0) {
    throw new AttendanceError(401, "UNAUTHENTICATED", "Authenticated staff actor is required");
  }
  if (actor.role === "admin") return;

  const rows = await database.execute(sql`
    SELECT 1 AS allowed
    FROM staff_event_assignments
    WHERE staff_id = ${actor.id}
      AND event_id = ${eventId}
      AND (session_id IS NULL OR session_id = ${sessionId})
    LIMIT 1
  `);
  if (!(rows as unknown as Array<{ allowed: number }>)[0]) {
    throw new AttendanceError(403, "SESSION_NOT_ASSIGNED", "Staff is not assigned to this event/session");
  }
}

async function activeDailyRow(
  database: Database,
  registrationSessionId: number,
  day: string,
): Promise<DailyRow | null> {
  const rows = await database.execute(sql`
    SELECT
      id,
      attendance_date,
      checked_in_at,
      checked_in_by,
      cancelled_at,
      cancelled_by,
      cancellation_reason
    FROM session_daily_checkins
    WHERE registration_session_id = ${registrationSessionId}
      AND attendance_date = ${day}::date
      AND cancelled_at IS NULL
    ORDER BY checked_in_at, id
    LIMIT 1
  `);
  return (rows as unknown as DailyRow[])[0] ?? null;
}

function dailyState(
  registrationSessionId: number,
  now: Date,
  day: string,
  row: DailyRow | null,
): AttendanceState {
  return {
    mode: "daily",
    registrationSessionId,
    attendanceId: row?.id ?? null,
    attendanceDate: row ? asDay(row.attendance_date) : day,
    checkedInAt: row ? asDate(row.checked_in_at) : null,
    checkedInBy: row?.checked_in_by ?? null,
    cancelledAt: row?.cancelled_at ? asDate(row.cancelled_at) : null,
    cancelledBy: row?.cancelled_by ?? null,
    cancellationReason: row?.cancellation_reason ?? null,
    serverNow: now,
  };
}

function singleState(row: EntitlementRow, now: Date): AttendanceState {
  return {
    mode: "single",
    registrationSessionId: row.registration_session_id,
    attendanceId: null,
    attendanceDate: null,
    checkedInAt: row.legacy_checked_in_at ? asDate(row.legacy_checked_in_at) : null,
    checkedInBy: row.legacy_checked_in_by,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    serverNow: now,
  };
}

export async function readAttendanceState(
  database: Database,
  registrationSessionId: number,
  now: Date,
): Promise<AttendanceState> {
  const row = await entitlement(database, registrationSessionId);
  if (!row.daily_enabled) return singleState(row, now);
  const day = bangkokDay(now);
  return dailyState(
    registrationSessionId,
    now,
    day,
    await activeDailyRow(database, registrationSessionId, day),
  );
}

export async function checkInSession(
  database: Database,
  input: { registrationSessionId: number; actor: AttendanceActor },
): Promise<{ created: boolean; state: AttendanceState }> {
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const row = await entitlement(txDb, input.registrationSessionId, true);
    await authorizeActor(txDb, input.actor, row.event_id, row.session_id);

    if (row.registration_status !== "confirmed") {
      throw new AttendanceError(400, "INVALID_STATUS", "Registration must be confirmed");
    }

    const clock = await databaseClock(txDb);
    const start = asDate(row.session_start);
    const end = asDate(row.session_end);
    if (!isWithinSession(clock.now, start, end)) {
      if (clock.now < start) {
        throw new AttendanceError(400, "SESSION_NOT_STARTED", "Session has not started yet");
      }
      throw new AttendanceError(400, "SESSION_ENDED", "Session has already ended");
    }

    if (!row.daily_enabled) {
      if (row.legacy_checked_in_at) {
        return { created: false, state: singleState(row, clock.now) };
      }
      await tx.execute(sql`
        UPDATE registration_sessions
        SET checked_in_at = (clock_timestamp() AT TIME ZONE 'UTC'),
            checked_in_by = ${input.actor.id}
        WHERE id = ${row.registration_session_id}
          AND checked_in_at IS NULL
      `);
      const refreshed = await entitlement(txDb, row.registration_session_id, false);
      return { created: true, state: singleState(refreshed, clock.now) };
    }

    const attendanceId = randomUUID();
    const insertedRows = await tx.execute(sql`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at, checked_in_by
      )
      VALUES (
        ${attendanceId}, ${row.registration_session_id}, ${clock.day}::date,
        clock_timestamp(), ${input.actor.id}
      )
      ON CONFLICT (registration_session_id, attendance_date)
        WHERE cancelled_at IS NULL
      DO NOTHING
      RETURNING
        id, attendance_date, checked_in_at, checked_in_by,
        cancelled_at, cancelled_by, cancellation_reason
    `);
    const inserted = (insertedRows as unknown as DailyRow[])[0] ?? null;
    if (inserted) {
      return {
        created: true,
        state: dailyState(row.registration_session_id, clock.now, clock.day, inserted),
      };
    }

    const existing = await activeDailyRow(txDb, row.registration_session_id, clock.day);
    if (!existing) {
      throw new AttendanceError(409, "ATTENDANCE_CONFLICT", "Daily attendance changed; retry");
    }
    return {
      created: false,
      state: dailyState(row.registration_session_id, clock.now, clock.day, existing),
    };
  });
}

export async function cancelDailyCheckin(
  database: Database,
  input: { attendanceId: string; actor: AttendanceActor; reason: string },
): Promise<AttendanceState> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AttendanceError(400, "CANCELLATION_REASON_REQUIRED", "Cancellation reason is required");
  }

  const discoveryRows = await database.execute(sql`
    SELECT registration_session_id
    FROM session_daily_checkins
    WHERE id = ${input.attendanceId}
    LIMIT 1
  `);
  const registrationSessionId = (
    discoveryRows as unknown as Array<{ registration_session_id: number }>
  )[0]?.registration_session_id;
  if (!registrationSessionId) {
    throw new AttendanceError(404, "ATTENDANCE_NOT_FOUND", "Daily attendance not found");
  }

  return database.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const row = await entitlement(txDb, registrationSessionId, true);
    await authorizeActor(txDb, input.actor, row.event_id, row.session_id);

    const attendanceRows = await tx.execute(sql`
      SELECT
        id, attendance_date, checked_in_at, checked_in_by,
        cancelled_at, cancelled_by, cancellation_reason
      FROM session_daily_checkins
      WHERE id = ${input.attendanceId}
        AND registration_session_id = ${registrationSessionId}
      FOR UPDATE
    `);
    const attendance = (attendanceRows as unknown as DailyRow[])[0];
    if (!attendance) {
      throw new AttendanceError(404, "ATTENDANCE_NOT_FOUND", "Daily attendance not found");
    }

    const clock = await databaseClock(txDb);
    if (attendance.cancelled_at) {
      return {
        ...dailyState(registrationSessionId, clock.now, asDay(attendance.attendance_date), attendance),
        checkedInAt: null,
      };
    }

    const checkedInAt = asDate(attendance.checked_in_at);
    if (
      input.actor.role !== "admin" &&
      clock.now.getTime() - checkedInAt.getTime() > 5 * 60 * 1000
    ) {
      throw new AttendanceError(
        403,
        "UNDO_TIMEOUT",
        "สามารถยกเลิกเช็คอินได้ภายใน 5 นาทีเท่านั้น กรุณาติดต่อ admin",
      );
    }

    const updatedRows = await tx.execute(sql`
      UPDATE session_daily_checkins
      SET cancelled_at = clock_timestamp(),
          cancelled_by = ${input.actor.id},
          cancellation_reason = ${reason}
      WHERE id = ${input.attendanceId}
        AND cancelled_at IS NULL
      RETURNING
        id, attendance_date, checked_in_at, checked_in_by,
        cancelled_at, cancelled_by, cancellation_reason
    `);
    const updated = (updatedRows as unknown as DailyRow[])[0];
    if (!updated) {
      throw new AttendanceError(409, "ATTENDANCE_CONFLICT", "Daily attendance changed; retry");
    }

    return {
      ...dailyState(registrationSessionId, clock.now, asDay(updated.attendance_date), updated),
      checkedInAt: null,
    };
  });
}
