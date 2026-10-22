import assert from "node:assert/strict";
import test from "node:test";
import { parseHolderRollbackBackup, runHolderTypeRollback } from "./rollback.js";
import type { Sql } from "postgres";

function fixture() {
  return { version: 1, eventId: 2, eventCode: "PRIS-2026", workbookSha256: "a".repeat(64),
    createdAt: "2026-10-22T01:00:00.000Z", status: "pre-transaction-backup; verify database before rollback",
    changes: [{ id: 1, regCode: "REG-SYNTH", nonHolderFingerprint: "0".repeat(32),
      before: { holderType: null, holderTypeSource: "prior-source", holderTypeUpdatedAt: "2026-01-01T00:00:00.123456" },
      after: { holderType: "vip", holderTypeSource: `excel:${"a".repeat(64)}`, holderTypeUpdatedAt: "2026-10-22T01:00:00.123456" } }] };
}

test("validates actual backup shape without losing PostgreSQL microseconds", () => {
  const parsed = parseHolderRollbackBackup(fixture());
  assert.equal(parsed.changes[0].before.holderTypeUpdatedAt, "2026-01-01T00:00:00.123456");
  assert.equal(parsed.changes[0].after.holderTypeUpdatedAt, "2026-10-22T01:00:00.123456");
});

test("rejects duplicate identities even if other identity differs", () => {
  for (const duplicate of [
    { ...fixture().changes[0], regCode: "REG-OTHER" },
    { ...fixture().changes[0], id: 2 },
  ]) {
    const backup = fixture(); backup.changes.push(duplicate);
    assert.throws(() => parseHolderRollbackBackup(backup), /Duplicate/);
  }
});

test("rejects wrong event, unknown fields, tampered source and invalid holder types", () => {
  assert.throws(() => parseHolderRollbackBackup({ ...fixture(), eventId: 3 }), /schema/);
  assert.throws(() => parseHolderRollbackBackup({ ...fixture(), eventCode: "OTHER" }), /schema/);
  assert.throws(() => parseHolderRollbackBackup({ ...fixture(), extra: true }), /schema/);
  const source = fixture(); source.changes[0].after.holderTypeSource = "not-the-import";
  assert.throws(() => parseHolderRollbackBackup(source), /hash/);
  const type = fixture(); type.changes[0].after.holderType = "invalid";
  assert.throws(() => parseHolderRollbackBackup(type), /schema/);
});

test("rejects omitted metadata and timezone or truncated timestamp formats", () => {
  const backup = fixture();
  const { holderTypeSource: _source, ...missing } = backup.changes[0].before;
  assert.throws(() => parseHolderRollbackBackup({ ...backup, changes: [{ ...backup.changes[0], before: missing }] }), /schema/);
  for (const stamp of ["2026-10-22", "2026-10-22T01:00:00Z", "2026-10-22T01:00:00.1234567"]) {
    backup.changes[0].after.holderTypeUpdatedAt = stamp;
    assert.throws(() => parseHolderRollbackBackup(backup), /schema/);
  }
});

test("invalid backup fails before any database operation and errors contain no row values", async () => {
  const sql = { begin() { throw new Error("database must not be reached"); } } as unknown as Sql;
  await assert.rejects(() => runHolderTypeRollback(sql, { ...fixture(), version: 99 }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Invalid holder rollback backup schema");
    assert.equal(error.message.includes("REG-SYNTH"), false);
    return true;
  });
});

test("accepts empty idempotent-import backup and preserves input unchanged", () => {
  const backup = { ...fixture(), changes: [] };
  assert.deepEqual(parseHolderRollbackBackup(backup), backup);
  const original = fixture(); const copy = JSON.stringify(original);
  parseHolderRollbackBackup(original);
  assert.equal(JSON.stringify(original), copy);
});
