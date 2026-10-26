import { getHolderType, type HolderTypeKey } from "./catalog.js";

interface ImportEntry {
  row: number;
  regCode: string;
  email: string;
  holderType: HolderTypeKey;
}

interface RegistrationRow {
  id: number;
  regCode: string;
  email: string;
  eventCode: string;
  holderType: string | null;
}

export function planHolderTypeImport(entries: ImportEntry[], rows: RegistrationRow[]) {
  const changes: { id: number; regCode: string; previousType: string | null; holderType: HolderTypeKey }[] = [];
  let unchanged = 0;
  const errors: { row: number; message: string }[] = [];
  const byCode = new Map<string, RegistrationRow[]>();
  const idCounts = new Map<number, number>();
  const inputCounts = new Map<string, number>();
  for (const entry of entries) inputCounts.set(entry.regCode, (inputCounts.get(entry.regCode) ?? 0) + 1);
  for (const row of rows) {
    const matches = byCode.get(row.regCode) ?? [];
    matches.push(row);
    byCode.set(row.regCode, matches);
    idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
  }

  for (const entry of entries) {
    let message: string | undefined;
    const matches = byCode.get(entry.regCode) ?? [];
    const matched = matches[0];
    if (!entry.regCode || !entry.regCode.trim()) message = "Reg Code is required";
    else if (inputCounts.get(entry.regCode)! > 1) message = "Duplicate input Reg Code";
    else if (!getHolderType(entry.holderType)) message = "Invalid holder type";
    else if (!matches.length) message = "Registration not found";
    else if (matches.length !== 1) message = "Duplicate registration rows";
    else if (!Number.isSafeInteger(matched.id) || matched.id <= 0) message = "Invalid registration ID";
    else if (idCounts.get(matched.id)! > 1) message = "Duplicate registration ID";
    else if (matched.eventCode !== "PRIS-2026") message = "Registration belongs to a different event";
    else if (!entry.email.trim() || !matched.email.trim() || entry.email.trim().toLowerCase() !== matched.email.trim().toLowerCase()) message = "Registration email mismatch";
    else if (matched.holderType !== null && matched.holderType !== entry.holderType) message = "Existing holder type conflicts with import";

    if (message) errors.push({ row: entry.row, message });
    else if (matched.holderType === entry.holderType) unchanged++;
    else changes.push({ id: matched.id, regCode: matched.regCode, previousType: matched.holderType, holderType: entry.holderType });
  }
  return { changes, unchanged, errors };
}
