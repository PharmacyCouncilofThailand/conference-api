import { sql, type SQL } from "drizzle-orm";
import type { db } from "../../database/index.js";
import { ApiError } from "../../errors/ApiError.js";
import type { DbCandidate, PresentationActor } from "./types.js";

export type PresentationDatabase = typeof db;
export type PresentationTx = Parameters<Parameters<PresentationDatabase["transaction"]>[0]>[0];
type Executor = Pick<PresentationDatabase, "execute">;

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

export async function requirePresentationStaff(q: Executor, actor: PresentationActor, eventId: number, manage: boolean): Promise<{manage: boolean; types: Array<'oral' | 'poster'>}> {
  if (!["admin", "organizer", "reviewer"].includes(actor.role)) fail("PRESENTATION_ACCESS_DENIED", 403);
  const [staff] = await rows<{ role: string; assignedPresentationTypes: unknown }>(q, sql`
    SELECT role,assigned_presentation_types AS "assignedPresentationTypes" FROM backoffice_users
    WHERE id=${actor.id} AND is_active=true AND role=${actor.role} AND email=${actor.email}
  `);
  if (!staff || (manage && staff.role !== "admin")) fail("PRESENTATION_ACCESS_DENIED", 403);
  const [event] = await rows<{ id: number }>(q, sql`
    SELECT id FROM events WHERE id=${eventId} AND event_code='PRIS-2026'
  `);
  if (!event) fail("PRESENTATION_EVENT_NOT_FOUND", 404);
  if (staff.role !== "admin") {
    const [assignment] = await rows<{ ok: number }>(q, sql`
      SELECT 1 AS ok FROM staff_event_assignments WHERE staff_id=${actor.id} AND event_id=${eventId} LIMIT 1
    `);
    if (!assignment) fail("PRESENTATION_ACCESS_DENIED", 403);
  }
  const types = staff.role === 'admin' ? ['oral','poster'] as const : Array.isArray(staff.assignedPresentationTypes)
    ? staff.assignedPresentationTypes.filter((type: unknown): type is 'oral' | 'poster' => type === 'oral' || type === 'poster') : [];
  return {manage: staff.role === 'admin', types: [...new Set(types)]};
}

export async function requirePresentationOwner(q: Executor, actor: PresentationActor, abstractId: number, lock = false): Promise<DbCandidate> {
  if (!["pharmacist", "medical_professional", "general", "student"].includes(actor.role)) fail("PRESENTATION_OWNER_REQUIRED", 403);
  const [candidate] = await rows<DbCandidate>(q, sql`
    SELECT a.id AS "abstractId",a.event_id AS "eventId",a.tracking_id AS "canonicalTrackingId",
      ARRAY[]::text[] AS aliases,a.title,a.presentation_type AS "presentationType",
      u.id AS "userId",u.first_name AS "firstName",u.last_name AS "lastName",u.email,
      e.event_code AS "eventCode",c.name AS "categoryName"
    FROM abstracts a JOIN users u ON u.id=a.user_id JOIN events e ON e.id=a.event_id
    LEFT JOIN abstract_categories c ON c.id=a.category_id AND c.event_id=a.event_id
    WHERE a.id=${abstractId} AND u.id=${actor.id} AND u.role=${actor.role} AND u.status='active'
      AND e.event_code='PRIS-2026' ${lock ? sql`FOR SHARE OF a,u` : sql``}
  `);
  if (!candidate) fail("PRESENTATION_OWNER_REQUIRED", 403);
  return candidate;
}
