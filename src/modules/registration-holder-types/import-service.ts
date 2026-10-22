import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, link, unlink, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Sql } from "postgres";
import { HOLDER_TYPE_KEYS } from "./catalog.js";
import { parseHolderTypeWorkbook } from "./import.js";
import { planHolderTypeImport } from "./import-plan.js";

// postgres TransactionSql's Omit-based type loses its runtime template call signature.
type QueryTransaction = Sql;

export class HolderImportError extends Error {
  constructor(message: string, public readonly rows: number[] = []) { super(message); }
}

export const HOLDER_IMPORT_MIGRATION = readFileSync(
  new URL("../../../drizzle/0047_registration_holder_types.sql", import.meta.url), "utf8",
);

interface ImportOptions {
  expectedCount: number;
  expectedEventId: number;
  apply?: boolean;
  backup?: string;
}
type Parsed = ReturnType<typeof parseHolderTypeWorkbook>;
interface StoredRow {
  id: number; regCode: string; email: string; eventCode: string;
  holderType: string | null; holderTypeSource: string | null;
  holderTypeUpdatedAt: string | null; fingerprint: string;
}

async function backupExclusive(path: string, data: unknown) {
  const target = resolve(path);
  const parent = await stat(dirname(target));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new HolderImportError("Backup parent must be an existing private directory (mode 0700)");
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    // Linking a complete file publishes it atomically and refuses an existing target.
    await link(temporary, target);
    const directory = await open(dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary); }
}

async function readRows(tx: QueryTransaction, codes: string[], lock: boolean): Promise<StoredRow[]> {
  const query = `SELECT r.id, r.reg_code AS "regCode", r.email, e.event_code AS "eventCode",
    to_jsonb(r)->>'holder_type' AS "holderType",
    to_jsonb(r)->>'holder_type_source' AS "holderTypeSource",
    to_jsonb(r)->>'holder_type_updated_at' AS "holderTypeUpdatedAt",
    md5((to_jsonb(r) - ARRAY['holder_type','holder_type_source','holder_type_updated_at'])::text) AS fingerprint
    FROM public.registrations r JOIN public.events e ON e.id = r.event_id
    WHERE r.reg_code IN (SELECT jsonb_array_elements_text($1::text::jsonb))
    ORDER BY r.id${lock ? " FOR UPDATE OF r" : ""}`;
  return await tx.unsafe<StoredRow[]>(query, [JSON.stringify(codes)]);
}

async function verifySchema(tx: QueryTransaction) {
  const columns = await tx<{ column_name: string; data_type: string; character_maximum_length: number | null; is_nullable: string }[]>`
    SELECT column_name, data_type, character_maximum_length, is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND table_name='registrations'
    AND column_name IN ('holder_type','holder_type_source','holder_type_updated_at')`;
  const expected = new Map([
    ["holder_type", "character varying"], ["holder_type_source", "text"],
    ["holder_type_updated_at", "timestamp without time zone"],
  ]);
  if (columns.length !== 3 || columns.some((column) =>
    expected.get(column.column_name) !== column.data_type || column.is_nullable !== "YES" ||
    (column.column_name === "holder_type" && column.character_maximum_length !== 32))) {
    throw new HolderImportError("Holder metadata schema does not match migration 0047");
  }
  const constraints = await tx<{ convalidated: boolean; definition: string }[]>`
    SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.registrations'::regclass AND conname='registrations_holder_type_check' AND contype='c'`;
  const constraint = constraints[0];
  // Compare PostgreSQL's own normalized expression, including operators. Merely
  // finding the eleven literals would also accept a permissive `OR TRUE` check.
  await tx.unsafe(`CREATE TEMP TABLE holder_type_constraint_probe (
    holder_type varchar(32), CHECK (holder_type IS NULL OR holder_type IN (
      ${HOLDER_TYPE_KEYS.map((key) => `'${key}'`).join(',')}
    ))) ON COMMIT DROP`);
  const [probe] = await tx<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='pg_temp.holder_type_constraint_probe'::regclass AND contype='c'`;
  const keys = constraint ? [...constraint.definition.matchAll(/'([^']*)'/g)].map((match) => match[1]).sort() : [];
  if (constraints.length !== 1 || !constraint.convalidated ||
      constraint.definition !== probe.definition ||
      JSON.stringify(keys) !== JSON.stringify([...HOLDER_TYPE_KEYS].sort()) ||
      !/holder_type IS NULL/.test(constraint.definition)) {
    throw new HolderImportError("Holder metadata CHECK constraint does not match the validated 11-type catalog");
  }
}

export async function runImport(sql: Sql, parsed: Parsed, hash: string, options: ImportOptions) {
  if (!Number.isSafeInteger(options.expectedCount) || options.expectedCount <= 0 ||
      !Number.isSafeInteger(options.expectedEventId) || options.expectedEventId <= 0 || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new HolderImportError("Invalid expected count, event ID, or workbook hash");
  }
  if (parsed.errors.length) throw new HolderImportError("Workbook validation failed", parsed.errors.map((error) => error.row));
  if (parsed.entries.length !== options.expectedCount) throw new HolderImportError("Workbook count does not match expected count");
  if (options.apply && !options.backup) throw new HolderImportError("Apply requires an explicit backup path");
  const counts: Record<string, number> = {};
  for (const entry of parsed.entries) counts[entry.holderType] = (counts[entry.holderType] ?? 0) + 1;

  return await sql.begin(options.apply ? "" : "read only", async (transaction) => {
    const tx = transaction as unknown as QueryTransaction;
    await tx.unsafe("SET LOCAL search_path=public");
    await tx.unsafe(options.apply
      ? "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'; SET LOCAL idle_in_transaction_session_timeout='30s'"
      : "SET LOCAL statement_timeout='30s'");
    if (options.apply) {
      const [lock] = await tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('registration-holder-types:PRIS-2026')) AS acquired`;
      if (!lock.acquired) throw new HolderImportError("Another holder import is running");
    }
    const events = await tx.unsafe<{ id: number }[]>(
      "SELECT id FROM public.events WHERE event_code='PRIS-2026'" + (options.apply ? " FOR SHARE" : ""),
    );
    if (events.length !== 1 || events[0].id !== options.expectedEventId) throw new HolderImportError("PRIS-2026 event identity does not match expected event");
    const codes = parsed.entries.map((entry) => entry.regCode);
    const before = await readRows(tx, codes, Boolean(options.apply));
    const plan = planHolderTypeImport(parsed.entries, before);
    if (plan.errors.length) throw new HolderImportError("Registration preflight failed", plan.errors.map((error) => error.row));
    const summary = { applied: Boolean(options.apply), entries: parsed.entries.length, changes: plan.changes.length,
      unchanged: plan.unchanged, skipped: parsed.skipped.length, errors: 0, categories: counts };
    if (!options.apply) return summary;

    const [clock] = await tx<{ stamp: string }[]>`SELECT to_jsonb(transaction_timestamp()::timestamp)#>>'{}' AS stamp`;
    await backupExclusive(options.backup!, {
      version: 1, eventId: options.expectedEventId, eventCode: "PRIS-2026", workbookSha256: hash,
      createdAt: new Date().toISOString(), status: "pre-transaction-backup; verify database before rollback",
      changes: plan.changes.map((change) => {
        const row = before.find((candidate) => candidate.id === change.id)!;
        return { id: row.id, regCode: row.regCode,
          before: { holderType: row.holderType, holderTypeSource: row.holderTypeSource, holderTypeUpdatedAt: row.holderTypeUpdatedAt },
          after: { holderType: change.holderType, holderTypeSource: `excel:${hash}`, holderTypeUpdatedAt: clock.stamp }, nonHolderFingerprint: row.fingerprint };
      }),
    });
    await tx.unsafe(HOLDER_IMPORT_MIGRATION);
    await verifySchema(tx);
    if (plan.changes.length) {
      const updated = await tx<{ id: number }[]>`
        UPDATE public.registrations AS r SET holder_type = input.holder_type,
          holder_type_source = ${`excel:${hash}`}, holder_type_updated_at = ${clock.stamp}::text::timestamp
        FROM jsonb_to_recordset(${tx.json(plan.changes.map((change) => ({ id: change.id, holder_type: change.holderType })))}::jsonb)
          AS input(id integer, holder_type text)
        WHERE r.id=input.id AND r.event_id=${options.expectedEventId} AND r.holder_type IS NULL
        RETURNING r.id`;
      if (updated.length !== plan.changes.length) throw new HolderImportError("Updated row count does not match the locked plan");
    }
    const after = await readRows(tx, codes, false);
    if (after.length !== before.length) throw new HolderImportError("Verification row count changed");
    const changes = new Map(plan.changes.map((change) => [change.id, change]));
    const oldRows = new Map(before.map((row) => [row.id, row]));
    for (const row of after) {
      const old = oldRows.get(row.id);
      const change = changes.get(row.id);
      if (!old || old.fingerprint !== row.fingerprint) throw new HolderImportError("Non-holder registration data changed; rolled back");
      if (change ? row.holderType !== change.holderType || row.holderTypeSource !== `excel:${hash}` || row.holderTypeUpdatedAt !== clock.stamp
        : row.holderType !== old.holderType || row.holderTypeSource !== old.holderTypeSource || row.holderTypeUpdatedAt !== old.holderTypeUpdatedAt) {
        throw new HolderImportError("Post-import holder metadata verification failed");
      }
    }
    return summary;
  });
}
