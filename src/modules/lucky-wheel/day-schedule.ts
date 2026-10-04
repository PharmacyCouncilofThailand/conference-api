import { sql } from "drizzle-orm";
import { WheelError, type WheelDatabase } from "./access.js";
import type { AdminWheelActor } from "./service.js";

export type DayWindow = {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  version: number;
};

export type DayWindowInput = {
  date: string;
  startAt: string;
  endAt: string;
  expectedVersion: number | null;
  reason: string | null;
};

type DayRow = {
  id: string;
  play_date: string | Date;
  start_at: Date | string;
  end_at: Date | string;
  version: number;
};

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toDay(value: string | Date): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function toWindow(row: DayRow): DayWindow {
  return {
    id: row.id,
    date: toDay(row.play_date),
    startAt: toIso(row.start_at),
    endAt: toIso(row.end_at),
    version: row.version,
  };
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validateWindow(input: DayWindowInput): void {
  if (!validDate(input.date)) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Invalid Bangkok date");
  }
  const start = new Date(input.startAt);
  const end = new Date(input.endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Day window start must precede end");
  }
  const dayStart = new Date(input.date + "T00:00:00.000+07:00");
  const nextMidnight = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  if (start < dayStart || end > nextMidnight) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Day window must stay within its Bangkok date");
  }
  if (
    (input.expectedVersion !== null && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1))
    || (input.expectedVersion !== null && (!input.reason || !input.reason.trim()))
  ) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Schedule edit requires a version and reason");
  }
}

export function isWithinDayWindow(now: Date, day: DayWindow): boolean {
  return now >= new Date(day.startAt) && now < new Date(day.endAt);
}

export async function readDayWindowForSpin(
  database: WheelDatabase,
  wheelId: string,
  date: string,
  lock: boolean,
): Promise<DayWindow | null> {
  const suffix = lock ? sql` FOR UPDATE OF d` : sql``;
  const rows = await database.execute(sql`
    SELECT d.id, d.play_date, d.start_at, d.end_at, d.version
    FROM lucky_wheel_days d
    WHERE d.wheel_id = ${wheelId}
      AND d.play_date = ${date}::date
    ${suffix}
  `);
  const row = (rows as unknown as DayRow[])[0];
  return row ? toWindow(row) : null;
}

export async function readDayWindow(
  database: WheelDatabase,
  _actor: AdminWheelActor,
  eventId: number,
  date: string,
): Promise<DayWindow | null> {
  if (!validDate(date)) throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Invalid Bangkok date");
  const rows = await database.execute(sql`
    SELECT d.id, d.play_date, d.start_at, d.end_at, d.version
    FROM lucky_wheel_days d
    JOIN lucky_wheels w ON w.id = d.wheel_id
    WHERE w.event_id = ${eventId}
      AND d.play_date = ${date}::date
    LIMIT 1
  `);
  const row = (rows as unknown as DayRow[])[0];
  return row ? toWindow(row) : null;
}

export async function listDayWindows(
  database: WheelDatabase,
  _actor: AdminWheelActor,
  eventId: number,
): Promise<DayWindow[]> {
  const rows = await database.execute(sql`
    SELECT d.id, d.play_date, d.start_at, d.end_at, d.version
    FROM lucky_wheel_days d
    JOIN lucky_wheels w ON w.id = d.wheel_id
    WHERE w.event_id = ${eventId}
    ORDER BY d.play_date ASC
  `);
  return (rows as unknown as DayRow[]).map(toWindow);
}

export async function editDayWindow(
  database: WheelDatabase,
  actor: AdminWheelActor,
  eventId: number,
  input: DayWindowInput,
): Promise<DayWindow> {
  validateWindow(input);
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as WheelDatabase;
    const wheelRows = await tx.execute(sql`
      SELECT id FROM lucky_wheels WHERE event_id = ${eventId} FOR UPDATE
    `);
    const wheel = (wheelRows as unknown as Array<{ id: string }>)[0];
    if (!wheel) throw new WheelError(404, "WHEEL_NOT_FOUND", "Lucky wheel was not found for this event");
    const before = await readDayWindowForSpin(txDb, wheel.id, input.date, true);
    if ((before?.version ?? null) !== input.expectedVersion) {
      throw new WheelError(409, "WHEEL_UPDATED", "Day window version changed", {
        currentVersion: before?.version ?? null,
      });
    }
    let rows;
    if (before) {
      rows = await tx.execute(sql`
        UPDATE lucky_wheel_days
        SET start_at = ${input.startAt}::timestamptz,
            end_at = ${input.endAt}::timestamptz,
            version = version + 1,
            updated_at = clock_timestamp()
        WHERE id = ${before.id}
        RETURNING id, play_date, start_at, end_at, version
      `);
    } else {
      rows = await tx.execute(sql`
        INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
        VALUES (
          ${wheel.id}, ${eventId}, ${input.date}::date,
          ${input.startAt}::timestamptz, ${input.endAt}::timestamptz
        )
        RETURNING id, play_date, start_at, end_at, version
      `);
    }
    const after = toWindow((rows as unknown as DayRow[])[0]);
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        reason, before_snapshot, after_snapshot
      ) VALUES (
        ${wheel.id}, ${eventId}, ${actor.id},
        ${before ? "day_window_edit" : "day_window_create"},
        ${input.reason}, ${before ? JSON.stringify(before) : null}::jsonb,
        ${JSON.stringify(after)}::jsonb
      )
    `);
    return after;
  });
}

export async function readDayChanges(
  database: WheelDatabase,
  _actor: AdminWheelActor,
  eventId: number,
  date: string,
  query: { page: number; pageSize: number },
) {
  if (!validDate(date)) throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Invalid Bangkok date");
  const offset = (query.page - 1) * query.pageSize;
  const countRows = await database.execute(sql`
    SELECT count(*)::int AS total
    FROM lucky_wheel_audit_events a
    WHERE a.event_id = ${eventId}
      AND a.operation IN ('day_window_create', 'day_window_edit')
      AND a.after_snapshot->>'date' = ${date}
  `);
  const total = (countRows as unknown as Array<{ total: number }>)[0].total;
  const rows = await database.execute(sql`
    SELECT a.id, a.actor_backoffice_user_id, a.operation, a.reason,
           a.before_snapshot, a.after_snapshot, a.created_at
    FROM lucky_wheel_audit_events a
    WHERE a.event_id = ${eventId}
      AND a.operation IN ('day_window_create', 'day_window_edit')
      AND a.after_snapshot->>'date' = ${date}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${query.pageSize} OFFSET ${offset}
  `);
  type AuditRow = {
    id: number; actor_backoffice_user_id: number; operation: string;
    reason: string | null; before_snapshot: DayWindow | null;
    after_snapshot: DayWindow; created_at: Date | string;
  };
  return {
    date,
    items: (rows as unknown as AuditRow[]).map((row) => ({
      id: row.id,
      actorId: row.actor_backoffice_user_id,
      operation: row.operation,
      reason: row.reason,
      before: row.before_snapshot,
      after: row.after_snapshot,
      createdAt: toIso(row.created_at),
    })),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}
