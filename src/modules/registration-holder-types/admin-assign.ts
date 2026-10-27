import { eq, sql } from "drizzle-orm";
import type { db } from "../../database/index.js";
import { events, registrationHolderTypeEvents, registrations } from "../../database/schema.js";
import { getHolderType, type HolderTypeKey } from "./catalog.js";
import { PRIS_EVENT_CODE } from "./auto-assign.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class HolderTypeUpdateError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HolderTypeUpdateError";
  }
}

export interface AdminHolderTypeInput {
  registrationId: number;
  holderType: HolderTypeKey | null;
  actorId: number;
  reason?: string | null;
  /** Value the admin saw; a mismatch means someone else changed it first. */
  expectedHolderType?: string | null;
}

/**
 * Sets (or clears) a PRIS holder type on behalf of an admin. The row is
 * locked, the expected previous value is checked and every change is
 * written to the audit table.
 */
export async function setAdminHolderType(tx: Transaction, input: AdminHolderTypeInput) {
  if (input.holderType !== null && !getHolderType(input.holderType))
    throw new HolderTypeUpdateError(400, "INVALID_HOLDER_TYPE", "Unknown holder type");

  const [current] = await tx
    .select({
      id: registrations.id,
      holderType: registrations.holderType,
      holderTypeSource: registrations.holderTypeSource,
      eventCode: events.eventCode,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(eq(registrations.id, input.registrationId))
    .for("update", { of: registrations });
  if (!current) throw new HolderTypeUpdateError(404, "REGISTRATION_NOT_FOUND", "Registration not found");
  if (current.eventCode !== PRIS_EVENT_CODE)
    throw new HolderTypeUpdateError(400, "HOLDER_TYPE_NOT_SUPPORTED", "Holder types apply to PRIS-2026 only");
  if (input.expectedHolderType !== undefined && current.holderType !== input.expectedHolderType)
    throw new HolderTypeUpdateError(409, "HOLDER_TYPE_CHANGED", "Holder type changed by someone else; reload");
  if (current.holderType === input.holderType && current.holderTypeSource?.startsWith("manual:"))
    return current;

  const source = `manual:admin:${input.actorId}`;
  const [updated] = await tx
    .update(registrations)
    .set({ holderType: input.holderType, holderTypeSource: source, holderTypeUpdatedAt: sql`now()` })
    .where(eq(registrations.id, current.id))
    .returning({
      id: registrations.id,
      holderType: registrations.holderType,
      holderTypeSource: registrations.holderTypeSource,
      holderTypeUpdatedAt: registrations.holderTypeUpdatedAt,
    });
  await tx.insert(registrationHolderTypeEvents).values({
    registrationId: current.id,
    previousType: current.holderType,
    newType: input.holderType,
    previousSource: current.holderTypeSource,
    newSource: source,
    actorId: input.actorId,
    reason: input.reason?.trim() || null,
  });
  return updated;
}
