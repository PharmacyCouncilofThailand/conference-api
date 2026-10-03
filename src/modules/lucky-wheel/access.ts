import { sql } from "drizzle-orm";
import type { db } from "../../database/index.js";
import type { BlockCode } from "./types.js";

export type WheelDatabase = typeof db;

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

export async function clock(database: WheelDatabase): Promise<{ now: Date; day: string }> {
  const rows = await database.execute(sql`
    SELECT
      clock_timestamp() AS db_now,
      ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS bangkok_day
  `);
  const row = (rows as unknown as Array<{ db_now: Date | string; bangkok_day: string }>)[0];
  return { now: row.db_now instanceof Date ? row.db_now : new Date(row.db_now), day: row.bangkok_day };
}

export async function requireActiveUser(database: WheelDatabase, userId: number): Promise<void> {
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

export async function confirmedEntitlements(
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

export async function activeAttendance(
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
