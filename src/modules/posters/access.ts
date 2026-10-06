import { sql, type SQL } from "drizzle-orm";
import type { db } from "../../database/index.js";
import { ApiError } from "../../errors/ApiError.js";
import type { DbCandidate, PosterActor } from "./types.js";

export type PosterDatabase = typeof db;
export type PosterTx = Parameters<Parameters<PosterDatabase["transaction"]>[0]>[0];
type Executor = Pick<PosterDatabase, "execute">;

export const rows = async <T>(q: Executor, statement: SQL): Promise<T[]> =>
  await q.execute(statement) as unknown as T[];
export const fail = (code: string, status = 409): never => {
  throw new ApiError(code, code, status);
};

// Call after acquiring the operation's locks: transaction-start now() can be stale.
export async function dbNow(q: Executor): Promise<Date> {
  const [row] = await rows<{ now: Date | string }>(q, sql`SELECT clock_timestamp() AS now`);
  return new Date(row.now);
}

export async function requirePosterStaff(q: Executor, actor: PosterActor, eventId: number, manage: boolean): Promise<void> {
  if (!["admin", "organizer", "reviewer"].includes(actor.role)) fail("POSTER_ACCESS_DENIED", 403);
  const [staff] = await rows<{ role: string }>(q, sql`
    SELECT role FROM backoffice_users
    WHERE id=${actor.id} AND is_active=true AND role=${actor.role} AND email=${actor.email}
  `);
  if (!staff || (manage && staff.role !== "admin")) fail("POSTER_ACCESS_DENIED", 403);
  const [event] = await rows<{ id: number }>(q, sql`
    SELECT id FROM events WHERE id=${eventId} AND event_code='PRIS-2026'
  `);
  if (!event) fail("POSTER_EVENT_NOT_FOUND", 404);
  if (staff.role !== "admin") {
    const [assignment] = await rows<{ ok: number }>(q, sql`
      SELECT 1 AS ok FROM staff_event_assignments WHERE staff_id=${actor.id} AND event_id=${eventId} LIMIT 1
    `);
    if (!assignment) fail("POSTER_ACCESS_DENIED", 403);
  }
}

export async function requirePosterOwner(q: Executor, actor: PosterActor, abstractId: number, lock = false): Promise<DbCandidate> {
  if (!["pharmacist", "medical_professional", "general", "student"].includes(actor.role)) fail("POSTER_OWNER_REQUIRED", 403);
  const [candidate] = await rows<DbCandidate>(q, sql`
    SELECT a.id AS "abstractId",a.event_id AS "eventId",a.tracking_id AS "canonicalTrackingId",
      ARRAY[]::text[] AS aliases,a.title,a.presentation_type AS "presentationType",
      u.id AS "userId",u.first_name AS "firstName",u.last_name AS "lastName",u.email
    FROM abstracts a JOIN users u ON u.id=a.user_id JOIN events e ON e.id=a.event_id
    WHERE a.id=${abstractId} AND u.id=${actor.id} AND u.role=${actor.role} AND u.status='active'
      AND e.event_code='PRIS-2026' ${lock ? sql`FOR SHARE OF a,u` : sql``}
  `);
  if (!candidate) fail("POSTER_OWNER_REQUIRED", 403);
  return candidate;
}
