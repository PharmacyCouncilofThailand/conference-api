import { sql } from "drizzle-orm";
import type { WheelDatabase } from "../lucky-wheel/access.js";

/** Must be called inside the writer's transaction, before any attendance row lock. */
export async function lockAttendanceCutover(database: WheelDatabase, eventId: number,
  sessionId: number, mode: "shared" | "exclusive"): Promise<void> {
  const key = `pris:attendance:${eventId}:${sessionId}`;
  if (mode === "shared") {
    await database.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
  } else {
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
