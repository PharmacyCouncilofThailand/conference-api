import { eq, sql } from "drizzle-orm";
import { events, merchStores } from "../../database/schema.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";

export type StoreRow = typeof merchStores.$inferSelect;
export type StoreState = "disabled" | "not_open" | "open" | "closed";

export function storeState(
  row: { enabled: boolean; opensAt: Date | null; closesAt: Date | null } | null,
  now: Date,
): StoreState {
  if (!row || !row.enabled) return "disabled";
  if (!row.opensAt || !row.closesAt) return "not_open";
  if (now.getTime() < row.opensAt.getTime()) return "not_open";
  if (now.getTime() >= row.closesAt.getTime()) return "closed";
  return "open";
}

export async function dbNow(db: MerchDb): Promise<Date> {
  const rows = (await db.execute(sql`SELECT clock_timestamp() AS now`)) as unknown as Array<{
    now: Date | string;
  }>;
  return new Date(rows[0].now);
}

export async function readStore(
  db: MerchDb,
  eventId: number,
): Promise<{ row: StoreRow | null; state: StoreState; now: Date }> {
  const [row] = await db.select().from(merchStores).where(eq(merchStores.eventId, eventId)).limit(1);
  const now = await dbNow(db);
  return { row: row ?? null, state: storeState(row ?? null, now), now };
}

export async function eventByCode(
  db: MerchDb,
  code: string,
): Promise<{ id: number; eventCode: string }> {
  const [row] = await db
    .select({ id: events.id, eventCode: events.eventCode })
    .from(events)
    .where(eq(events.eventCode, code))
    .limit(1);
  if (!row) throw new MerchError(404, "MERCH_EVENT_NOT_FOUND", "ไม่พบงานที่ระบุ");
  return row;
}
