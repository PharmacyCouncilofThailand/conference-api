import type { Sql } from "postgres";
import { z } from "zod";
import { HOLDER_TYPE_KEYS } from "./catalog.js";

export class HolderRollbackError extends Error {}

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/);
const metadata = z.object({
  holderType: z.enum(HOLDER_TYPE_KEYS).nullable(),
  holderTypeSource: z.string().nullable(),
  holderTypeUpdatedAt: timestamp.nullable(),
}).strict();
const backupSchema = z.object({
  version: z.literal(1), eventId: z.literal(2), eventCode: z.literal("PRIS-2026"),
  workbookSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  status: z.literal("pre-transaction-backup; verify database before rollback"),
  changes: z.array(z.object({
    id: z.number().int().positive().safe(), regCode: z.string().min(1).refine((value) => value === value.trim()),
    before: metadata,
    after: metadata.extend({ holderType: z.enum(HOLDER_TYPE_KEYS), holderTypeSource: z.string(), holderTypeUpdatedAt: timestamp }).strict(),
    nonHolderFingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  }).strict()),
}).strict();

export function parseHolderRollbackBackup(input: unknown) {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) throw new HolderRollbackError("Invalid holder rollback backup schema");
  const backup = parsed.data;
  const ids = new Set<number>();
  const codes = new Set<string>();
  for (const change of backup.changes) {
    if (ids.has(change.id) || codes.has(change.regCode)) throw new HolderRollbackError("Duplicate registration in rollback backup");
    ids.add(change.id); codes.add(change.regCode);
    if (change.after.holderTypeSource !== `excel:${backup.workbookSha256}`) {
      throw new HolderRollbackError("Rollback source does not match workbook hash");
    }
    // The import only assigns previously unclassified registrations.
    if (change.before.holderType !== null) throw new HolderRollbackError("Backup does not describe a null-only holder import");
  }
  return backup;
}

const INPUT_COLUMNS = `id integer, reg_code text, before_type text, before_source text, before_stamp timestamp,
  after_type text, after_source text, after_stamp timestamp`;
type VerifiedRow = { id: number; matches: boolean; fingerprint: string };

export async function runHolderTypeRollback(sql: Sql, input: unknown, options: { apply?: boolean } = {}) {
  const backup = parseHolderRollbackBackup(input);
  const payload = JSON.stringify(backup.changes.map((change) => ({
    id: change.id, reg_code: change.regCode,
    before_type: change.before.holderType, before_source: change.before.holderTypeSource, before_stamp: change.before.holderTypeUpdatedAt,
    after_type: change.after.holderType, after_source: change.after.holderTypeSource, after_stamp: change.after.holderTypeUpdatedAt,
  })));
  return await sql.begin(options.apply ? "" : "read only", async (transaction) => {
    // postgres TransactionSql's Omit-based declaration loses the runtime template call signature.
    const tx = transaction as unknown as Sql;
    await tx.unsafe("SET LOCAL search_path=public; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
    if (options.apply) {
      const [lock] = await tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('registration-holder-types:PRIS-2026')) AS acquired`;
      if (!lock.acquired) throw new HolderRollbackError("Another holder metadata operation is running");
    }
    const events = await tx.unsafe<{ id: number }[]>(
      `SELECT id FROM public.events WHERE event_code='PRIS-2026'${options.apply ? " FOR SHARE" : ""}`,
    );
    if (events.length !== 1 || events[0].id !== 2) throw new HolderRollbackError("Rollback event identity mismatch");

    const select = (stage: "before" | "after", lock: boolean) => `
      SELECT r.id,
        (r.reg_code = x.reg_code AND r.event_id = 2
          AND r.holder_type IS NOT DISTINCT FROM x.${stage}_type
          AND r.holder_type_source IS NOT DISTINCT FROM x.${stage}_source
          AND r.holder_type_updated_at IS NOT DISTINCT FROM x.${stage}_stamp) AS matches,
        md5((to_jsonb(r) - ARRAY['holder_type','holder_type_source','holder_type_updated_at'])::text) AS fingerprint
      FROM public.registrations r JOIN jsonb_to_recordset($1::text::jsonb) AS x(${INPUT_COLUMNS}) ON r.id=x.id
      ORDER BY r.id${lock ? " FOR UPDATE OF r" : ""}`;
    const before = await tx.unsafe<VerifiedRow[]>(select("after", Boolean(options.apply)), [payload]);
    if (before.length !== backup.changes.length || before.some((row) => !row.matches)) {
      throw new HolderRollbackError("Current registration identity or holder metadata differs from backup; rollback refused");
    }
    if (!options.apply) return { applied: false, changes: before.length };
    const updated = await tx.unsafe<{ id: number }[]>(`
      UPDATE public.registrations r SET holder_type=x.before_type, holder_type_source=x.before_source,
        holder_type_updated_at=x.before_stamp
      FROM jsonb_to_recordset($1::text::jsonb) AS x(${INPUT_COLUMNS})
      WHERE r.id=x.id AND r.reg_code=x.reg_code AND r.event_id=2
        AND r.holder_type IS NOT DISTINCT FROM x.after_type
        AND r.holder_type_source IS NOT DISTINCT FROM x.after_source
        AND r.holder_type_updated_at IS NOT DISTINCT FROM x.after_stamp
      RETURNING r.id`, [payload]);
    if (updated.length !== backup.changes.length) throw new HolderRollbackError("Rollback affected count mismatch");
    const after = await tx.unsafe<VerifiedRow[]>(select("before", false), [payload]);
    const fingerprints = new Map(before.map((row) => [row.id, row.fingerprint]));
    if (after.length !== before.length || after.some((row) => !row.matches || fingerprints.get(row.id) !== row.fingerprint)) {
      throw new HolderRollbackError("Rollback verification failed; transaction aborted");
    }
    return { applied: true, changes: updated.length };
  });
}
