import assert from "node:assert/strict";
import test from "node:test";
import { planHolderTypeImport } from "./import-plan.js";
import type { HolderTypeKey } from "./catalog.js";

const entry = { row: 2, regCode: "REG-SYNTH", email: "person@example.invalid", holderType: "vip" as HolderTypeKey };
const registration = { id: 1, regCode: entry.regCode, email: entry.email, eventCode: "PRIS-2026", holderType: null as string | null };

test("plans null assignments and normalizes email without mutating inputs", () => {
  const rows = [{ ...registration, email: " PERSON@EXAMPLE.INVALID " }];
  const result = planHolderTypeImport([{ ...entry }], rows);
  assert.equal(result.errors.length, 0);
  assert.equal(result.unchanged, 0);
  assert.deepEqual(result.changes, [{ id: 1, regCode: entry.regCode, previousType: null, holderType: "vip" }]);
  assert.equal(rows[0].holderType, null);
});

test("repeated imports are idempotent", () => {
  const result = planHolderTypeImport([entry], [{ ...registration, holderType: "vip" }]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.changes.length, 0);
  assert.equal(result.unchanged, 1);
});

test("refuses to overwrite a different existing category", () => {
  for (const holderType of ["speaker", "unknown", ""]) {
    const result = planHolderTypeImport([entry], [{ ...registration, holderType }]);
    assert.equal(result.changes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /conflicts/);
  }
});

test("rejects missing registrations and does not normalize Reg Code", () => {
  for (const rows of [[], [{ ...registration, regCode: "reg-synth" }]]) {
    const result = planHolderTypeImport([entry], rows);
    assert.equal(result.changes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /not found/);
  }
});

test("rejects foreign events, email mismatches, and blank emails", () => {
  for (const row of [
    { ...registration, eventCode: "OTHER" },
    { ...registration, email: "other@example.invalid" },
    { ...registration, email: " " },
  ]) {
    const result = planHolderTypeImport([entry], [row]);
    assert.equal(result.changes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].row, 2);
    assert.equal(result.errors[0].message.includes("@"), false);
  }
});

test("rejects duplicate inputs, duplicate database codes and shared IDs", () => {
  const duplicateInput = planHolderTypeImport([entry, { ...entry, row: 3 }], [registration]);
  assert.equal(duplicateInput.errors.length, 2);
  assert.equal(duplicateInput.changes.length, 0);
  const duplicateRows = planHolderTypeImport([entry], [registration, { ...registration, id: 2 }]);
  assert.equal(duplicateRows.errors.length, 1);
  assert.match(duplicateRows.errors[0].message, /Duplicate registration rows/);
  const duplicateIds = planHolderTypeImport([entry], [registration, { ...registration, regCode: "REG-OTHER" }]);
  assert.equal(duplicateIds.errors.length, 1);
  assert.match(duplicateIds.errors[0].message, /Duplicate registration ID/);
});

test("rejects unknown types, empty codes and invalid IDs", () => {
  assert.equal(planHolderTypeImport([{ ...entry, holderType: "invalid" as HolderTypeKey }], [registration]).errors.length, 1);
  assert.equal(planHolderTypeImport([{ ...entry, regCode: " " }], [registration]).errors.length, 1);
  for (const id of [0, -1, 1.5, NaN]) {
    assert.equal(planHolderTypeImport([entry], [{ ...registration, id }]).errors.length, 1);
  }
});

test("retains row errors alongside valid changes so caller can abort entire import", () => {
  const result = planHolderTypeImport([entry, { ...entry, row: 3, regCode: "REG-MISSING" }], [registration]);
  assert.equal(result.changes.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 3);
});
