import { merchAuditLog } from "../../database/schema.js";
import type { MerchDb } from "./db.js";

export type AuditEntry = {
  eventId: number;
  entityType: string;
  entityId: string;
  action: string;
  actorId: number | null;
  reason?: string | null;
  contactConfirmed?: boolean | null;
  contactNote?: string | null;
  before?: unknown;
  after?: unknown;
};

export async function writeAudit(tx: Pick<MerchDb, "insert">, entry: AuditEntry): Promise<void> {
  await tx.insert(merchAuditLog).values({
    eventId: entry.eventId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    actorBackofficeUserId: entry.actorId,
    reason: entry.reason ?? null,
    contactConfirmed: entry.contactConfirmed ?? null,
    contactNote: entry.contactNote ?? null,
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
  });
}
