import { sql } from "drizzle-orm";
import { db } from "../../database/index.js";

type Database = typeof db;

export type AttendanceReaderActor = {
  id: number;
  role?: string | null;
};

export type AttendanceHistoryFilter = "active" | "cancelled" | "all";

export type AttendanceSummary = {
  serverNow: Date;
  serverDate: string;
  selectedDate: string;
  attendanceMode: "daily" | "single";
  eligibleRegistrations: number;
  checkedInPeopleOnDate: number;
  uniquePeople: number;
  attendanceOccurrences: number;
  unlinkedRegistrationCount: number;
};

export type AttendanceRow =
  | {
      kind: "daily";
      id: string;
      attendanceId: string;
      registrationSessionId: number;
      attendanceDate: string;
      scannedAt: Date;
      cancelledAt: Date | null;
      cancelledBy: number | null;
      cancellationReason: string | null;
      scannedBy: { id: number | null; firstName: string | null; lastName: string | null };
      regCode: string;
      registrationId: number;
      userId: number | null;
      firstName: string;
      lastName: string;
      email: string;
      university: string | null;
      institution: string | null;
      sessionId: number;
      sessionName: string;
      eventId: number;
      eventName: string;
    }
  | {
      kind: "single";
      id: number;
      attendanceId: null;
      registrationSessionId: number;
      attendanceDate: null;
      scannedAt: Date;
      cancelledAt: null;
      cancelledBy: null;
      cancellationReason: null;
      scannedBy: { id: number | null; firstName: string | null; lastName: string | null };
      regCode: string;
      registrationId: number;
      userId: number | null;
      firstName: string;
      lastName: string;
      email: string;
      university: string | null;
      institution: string | null;
      sessionId: number;
      sessionName: string;
      eventId: number;
      eventName: string;
    };

export class AttendanceReaderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceReaderError";
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asDay(value: string | Date): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AttendanceReaderError(400, "INVALID_DATE", "date must be YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new AttendanceReaderError(400, "INVALID_DATE", "date is not a real calendar date");
  }
  return value;
}

async function authorize(
  database: Database,
  actor: AttendanceReaderActor,
  eventId: number,
  sessionId: number,
): Promise<void> {
  if (!Number.isInteger(actor.id) || actor.id <= 0) {
    throw new AttendanceReaderError(401, "UNAUTHENTICATED", "Authenticated staff actor is required");
  }
  if (actor.role === "admin") return;
  const rows = await database.execute(sql`
    SELECT 1 AS allowed
    FROM staff_event_assignments
    WHERE staff_id=${actor.id}
      AND event_id=${eventId}
      AND (session_id IS NULL OR session_id=${sessionId})
    LIMIT 1
  `);
  if (!(rows as unknown as Array<{ allowed: number }>)[0]) {
    throw new AttendanceReaderError(403, "SESSION_NOT_ASSIGNED", "Staff is not assigned to this event/session");
  }
}

async function clock(database: Database): Promise<{ now: Date; day: string }> {
  const rows = await database.execute(sql`
    SELECT
      clock_timestamp() AS now,
      ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS day
  `);
  const row = (rows as unknown as Array<{ now: Date | string; day: string }>)[0];
  return { now: asDate(row.now), day: row.day };
}

async function isDailyPolicy(
  database: Database,
  eventId: number,
  sessionId: number,
): Promise<boolean> {
  const rows = await database.execute(sql`
    SELECT 1 AS enabled
    FROM session_attendance_policies
    WHERE event_id=${eventId} AND session_id=${sessionId}
      AND mode='daily' AND enabled=true
    LIMIT 1
  `);
  return Boolean((rows as unknown as Array<{ enabled: number }>)[0]);
}

export async function readAttendanceSummary(
  database: Database,
  input: {
    eventId: number;
    sessionId: number;
    date?: string;
    actor: AttendanceReaderActor;
  },
): Promise<AttendanceSummary> {
  await authorize(database, input.actor, input.eventId, input.sessionId);
  const server = await clock(database);
  const selectedDate = input.date ? parseIsoDate(input.date) : server.day;

  const [eligibility] = (await database.execute(sql`
    SELECT
      count(*)::int AS eligible_registrations,
      count(*) FILTER (WHERE r.user_id IS NULL)::int AS unlinked_registration_count
    FROM registration_sessions rs
    JOIN registrations r ON r.id=rs.registration_id
    WHERE r.event_id=${input.eventId}
      AND rs.session_id=${input.sessionId}
      AND r.status='confirmed'
  `)) as unknown as Array<{
    eligible_registrations: number;
    unlinked_registration_count: number;
  }>;

  if (!(await isDailyPolicy(database, input.eventId, input.sessionId))) {
    const [legacy] = (await database.execute(sql`
      SELECT
        count(DISTINCT r.user_id) FILTER (
          WHERE r.user_id IS NOT NULL AND rs.checked_in_at IS NOT NULL
        )::int AS unique_people,
        count(*) FILTER (WHERE rs.checked_in_at IS NOT NULL)::int AS attendance_occurrences,
        count(DISTINCT r.user_id) FILTER (
          WHERE r.user_id IS NOT NULL
            AND rs.checked_in_at IS NOT NULL
            AND ((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date
                = ${selectedDate}::date
        )::int AS checked_in_people_on_date
      FROM registration_sessions rs
      JOIN registrations r ON r.id=rs.registration_id
      WHERE r.event_id=${input.eventId}
        AND rs.session_id=${input.sessionId}
        AND r.status='confirmed'
    `)) as unknown as Array<{
      unique_people: number;
      attendance_occurrences: number;
      checked_in_people_on_date: number;
    }>;
    return {
      serverNow: server.now,
      serverDate: server.day,
      selectedDate,
      attendanceMode: "single",
      eligibleRegistrations: eligibility.eligible_registrations,
      checkedInPeopleOnDate: legacy.checked_in_people_on_date,
      uniquePeople: legacy.unique_people,
      attendanceOccurrences: legacy.attendance_occurrences,
      unlinkedRegistrationCount: eligibility.unlinked_registration_count,
    };
  }

  const [attendance] = (await database.execute(sql`
    WITH active_people_days AS (
      SELECT DISTINCT r.user_id, c.attendance_date
      FROM session_daily_checkins c
      JOIN registration_sessions rs ON rs.id = c.registration_session_id
      JOIN registrations r ON r.id = rs.registration_id
      WHERE c.cancelled_at IS NULL
        AND r.status = 'confirmed'
        AND r.user_id IS NOT NULL
        AND r.event_id = ${input.eventId}
        AND rs.session_id = ${input.sessionId}
    )
    SELECT
      COUNT(DISTINCT user_id)::integer AS unique_people,
      COUNT(*)::integer AS attendance_occurrences,
      COUNT(DISTINCT user_id) FILTER (
        WHERE attendance_date = ${selectedDate}::date
      )::integer AS checked_in_people_on_date
    FROM active_people_days
  `)) as unknown as Array<{
    unique_people: number;
    attendance_occurrences: number;
    checked_in_people_on_date: number;
  }>;

  return {
    serverNow: server.now,
    serverDate: server.day,
    selectedDate,
    attendanceMode: "daily",
    eligibleRegistrations: eligibility.eligible_registrations,
    checkedInPeopleOnDate: attendance.checked_in_people_on_date,
    uniquePeople: attendance.unique_people,
    attendanceOccurrences: attendance.attendance_occurrences,
    unlinkedRegistrationCount: eligibility.unlinked_registration_count,
  };
}

export async function readAttendanceRows(
  database: Database,
  input: {
    eventId: number;
    sessionId: number;
    date?: string;
    history?: AttendanceHistoryFilter;
    university?: string;
    search?: string;
    page?: number;
    limit?: number;
    actor: AttendanceReaderActor;
  },
): Promise<{
  rows: AttendanceRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  serverNow: Date;
  serverDate: string;
  selectedDate: string | null;
}> {
  await authorize(database, input.actor, input.eventId, input.sessionId);
  const server = await clock(database);
  const selectedDate = input.date ? parseIsoDate(input.date) : null;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(500, Math.max(1, input.limit ?? 50));
  const offset = (page - 1) * limit;
  const history = input.history ?? "active";
  const search = input.search?.trim() || null;
  const university = input.university?.trim() || null;

  if (!(await isDailyPolicy(database, input.eventId, input.sessionId))) {
    if (history === "cancelled") {
      return {
        rows: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        serverNow: server.now,
        serverDate: server.day,
        selectedDate,
      };
    }
    const result = await database.execute(sql`
      SELECT
        rs.id,
        rs.id AS registration_session_id,
        (rs.checked_in_at AT TIME ZONE 'UTC') AS scanned_at,
        rs.checked_in_by,
        scanner.first_name AS scanner_first_name,
        scanner.last_name AS scanner_last_name,
        r.id AS registration_id,
        r.reg_code,
        r.user_id,
        r.first_name,
        r.last_name,
        r.email,
        u.university,
        u.institution,
        s.id AS session_id,
        s.session_name,
        e.id AS event_id,
        e.event_name,
        count(*) OVER()::int AS total_count
      FROM registration_sessions rs
      JOIN registrations r ON r.id=rs.registration_id
      JOIN sessions s ON s.id=rs.session_id
      JOIN events e ON e.id=r.event_id
      LEFT JOIN users u ON u.id=r.user_id
      LEFT JOIN backoffice_users scanner ON scanner.id=rs.checked_in_by
      WHERE r.event_id=${input.eventId}
        AND rs.session_id=${input.sessionId}
        AND r.status='confirmed'
        AND rs.checked_in_at IS NOT NULL
        AND (${selectedDate}::text IS NULL OR
          (((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date = ${selectedDate}::date))
        AND (${university}::text IS NULL OR u.university=${university})
        AND (${search}::text IS NULL OR
          r.first_name ILIKE '%' || ${search} || '%' OR
          r.last_name ILIKE '%' || ${search} || '%' OR
          r.reg_code ILIKE '%' || ${search} || '%')
      ORDER BY rs.checked_in_at DESC, rs.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const raw = result as unknown as Array<any>;
    const rows: AttendanceRow[] = raw.map((row) => ({
      kind: "single" as const,
      id: row.id,
      attendanceId: null,
      registrationSessionId: row.registration_session_id,
      attendanceDate: null,
      scannedAt: asDate(row.scanned_at),
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      scannedBy: {
        id: row.checked_in_by,
        firstName: row.scanner_first_name,
        lastName: row.scanner_last_name,
      },
      regCode: row.reg_code,
      registrationId: row.registration_id,
      userId: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      university: row.university,
      institution: row.institution,
      sessionId: row.session_id,
      sessionName: row.session_name,
      eventId: row.event_id,
      eventName: row.event_name,
    }));
    const total = Number(raw[0]?.total_count ?? 0);
    return {
      rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      serverNow: server.now,
      serverDate: server.day,
      selectedDate,
    };
  }

  const result = await database.execute(sql`
    SELECT
      c.id AS attendance_id,
      c.attendance_date,
      c.checked_in_at AS scanned_at,
      c.checked_in_by,
      c.cancelled_at,
      c.cancelled_by,
      c.cancellation_reason,
      scanner.first_name AS scanner_first_name,
      scanner.last_name AS scanner_last_name,
      r.id AS registration_id,
      r.reg_code,
      r.user_id,
      r.first_name,
      r.last_name,
      r.email,
      u.university,
      u.institution,
      rs.id AS registration_session_id,
      s.id AS session_id,
      s.session_name,
      e.id AS event_id,
      e.event_name,
      count(*) OVER()::int AS total_count
    FROM session_daily_checkins c
    JOIN registration_sessions rs ON rs.id=c.registration_session_id
    JOIN registrations r ON r.id=rs.registration_id
    JOIN sessions s ON s.id=rs.session_id
    JOIN events e ON e.id=r.event_id
    LEFT JOIN users u ON u.id=r.user_id
    LEFT JOIN backoffice_users scanner ON scanner.id=c.checked_in_by
    WHERE r.event_id=${input.eventId}
      AND rs.session_id=${input.sessionId}
      AND r.status='confirmed'
      AND (${selectedDate}::text IS NULL OR c.attendance_date=${selectedDate}::date)
      AND (
        ${history}='all'
        OR (${history}='active' AND c.cancelled_at IS NULL)
        OR (${history}='cancelled' AND c.cancelled_at IS NOT NULL)
      )
      AND (${university}::text IS NULL OR u.university=${university})
      AND (${search}::text IS NULL OR
        r.first_name ILIKE '%' || ${search} || '%' OR
        r.last_name ILIKE '%' || ${search} || '%' OR
        r.reg_code ILIKE '%' || ${search} || '%')
    ORDER BY c.checked_in_at DESC, c.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const raw = result as unknown as Array<any>;
  const rows: AttendanceRow[] = raw.map((row) => ({
    kind: "daily" as const,
    id: row.attendance_id,
    attendanceId: row.attendance_id,
    registrationSessionId: row.registration_session_id,
    attendanceDate: asDay(row.attendance_date),
    scannedAt: asDate(row.scanned_at),
    cancelledAt: row.cancelled_at ? asDate(row.cancelled_at) : null,
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason,
    scannedBy: {
      id: row.checked_in_by,
      firstName: row.scanner_first_name,
      lastName: row.scanner_last_name,
    },
    regCode: row.reg_code,
    registrationId: row.registration_id,
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    university: row.university,
    institution: row.institution,
    sessionId: row.session_id,
    sessionName: row.session_name,
    eventId: row.event_id,
    eventName: row.event_name,
  }));
  const total = Number(raw[0]?.total_count ?? 0);
  return {
    rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    serverNow: server.now,
    serverDate: server.day,
    selectedDate,
  };
}

export async function readRegistrationAttendanceHistory(
  database: Database,
  input: {
    registrationId: number;
    date?: string;
    actor: AttendanceReaderActor;
  },
): Promise<{
  serverNow: Date;
  serverDate: string;
  selectedDate: string;
  sessions: Array<{
    registrationSessionId: number;
    sessionId: number;
    mode: "daily" | "single";
    selectedDay: AttendanceRow | null;
    history: AttendanceRow[];
  }>;
}> {
  const sessionRows = await database.execute(sql`
    SELECT rs.id AS registration_session_id, rs.session_id, r.event_id
    FROM registration_sessions rs
    JOIN registrations r ON r.id=rs.registration_id
    WHERE r.id=${input.registrationId}
    ORDER BY rs.id
  `);
  const scoped = sessionRows as unknown as Array<{
    registration_session_id: number;
    session_id: number;
    event_id: number;
  }>;
  const server = await clock(database);
  const selectedDate = input.date ? parseIsoDate(input.date) : server.day;
  const sessions = [];
  for (const item of scoped) {
    await authorize(database, input.actor, item.event_id, item.session_id);
    const page = await readAttendanceRows(database, {
      eventId: item.event_id,
      sessionId: item.session_id,
      history: "all",
      actor: input.actor,
      limit: 500,
    });
    const history = page.rows.filter((row) => row.registrationSessionId === item.registration_session_id);
    const mode: "daily" | "single" =
      (await isDailyPolicy(database, item.event_id, item.session_id)) ? "daily" : "single";
    const selectedDay =
      mode === "daily"
        ? history.find((row) => row.kind === "daily" && row.attendanceDate === selectedDate && !row.cancelledAt) ?? null
        : history.find((row) => row.kind === "single") ?? null;
    sessions.push({
      registrationSessionId: item.registration_session_id,
      sessionId: item.session_id,
      mode,
      selectedDay,
      history,
    });
  }
  return {
    serverNow: server.now,
    serverDate: server.day,
    selectedDate,
    sessions,
  };
}
