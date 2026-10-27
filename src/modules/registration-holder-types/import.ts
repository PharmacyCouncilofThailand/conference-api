import type ExcelJS from "exceljs";
import { HOLDER_TYPES, getHolderType, type HolderTypeKey } from "./catalog.js";

const HEADERS = ["Reg Code", "Email", "Typeตั๋ว", "ของมอบ"] as const;
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    // Never treat cached formula results as authoritative import data.
    if ("formula" in value || "sharedFormula" in value) throw new Error("Formula cells are not allowed");
    if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
    if ("hyperlink" in value) return value.text.trim();
  }
  throw new Error("Unsupported cell value");
}

export function parseHolderTypeWorkbook(
  workbook: ExcelJS.Workbook,
  options: { boothType?: "exhibitor" | "staff_mc" } = {},
) {
  const entries: { row: number; regCode: string; email: string; holderType: HolderTypeKey }[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const errors: { row: number; message: string }[] = [];
  const result = { entries, skipped, errors };
  const sheet = workbook.getWorksheet("Sheet1");
  if (!sheet) {
    errors.push({ row: 1, message: "Required worksheet Sheet1 is missing" });
    return result;
  }
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => {
    try {
      const name = cellText(cell);
      if (!name) return;
      if (columns.has(name)) errors.push({ row: 1, message: "Duplicate header" });
      else columns.set(name, column);
    } catch {
      errors.push({ row: 1, message: "Invalid header cell" });
    }
  });
  for (const header of HEADERS) {
    if (!columns.has(header)) errors.push({ row: 1, message: `Missing required header: ${header}` });
  }
  if (errors.length) return result;

  const types = new Map(HOLDER_TYPES.map((type) => [normalize(type.label), type.key]));
  types.set(normalize("VIP (วิทยากร)"), "speaker");
  types.set(normalize("VIPVIP (วิทยากร)"), "speaker");
  types.set("vip", "vip");
  types.set(normalize("เจ้าหน้าที่บูธ/Exhibitor"), "exhibitor");
  types.set(normalize("เจ้าหน้าที่บูธ(Exhibitor)"), "exhibitor");
  // Gift is "ให้" for gift recipients and blank (or a dash) for everyone else.
  // Retired set labels (Mug/กิจกรรม/ชุดใหญ่ไฟกระพริบ) are rejected.
  const gifts = new Map<string, string>([
    [normalize("ให้"), "gift"],
    ["", "none"],
    ["-", "none"],
    ["—", "none"],
  ]);
  const seen = new Set<string>();

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const hasData = row.values && Object.values(row.values).some((value) => value !== null && value !== undefined && String(value).trim() !== "");
    if (!hasData) return;
    try {
      const [regCode, rawEmail, rawType, rawGift] = HEADERS.map((header) => cellText(row.getCell(columns.get(header)!)));
      if (!regCode) throw new Error("Reg Code is required; new registrations cannot be imported");
      if (seen.has(regCode)) throw new Error("Duplicate Reg Code");
      seen.add(regCode);
      if (normalize(rawType) === "test") {
        skipped.push({ row: rowNumber, reason: "Test is outside the holder type catalog" });
        return;
      }
      if (!rawEmail) throw new Error("Email is required");
      if (!rawType) throw new Error("Holder type is required");
      let holderType: HolderTypeKey | undefined;
      if (normalize(rawType) === "booth") {
        if (options.boothType !== "exhibitor" && options.boothType !== "staff_mc") {
          throw new Error("BOOTH is ambiguous; specify exhibitor or staff_mc explicitly");
        }
        holderType = options.boothType;
      } else holderType = types.get(normalize(rawType));
      if (!holderType) throw new Error("Unknown holder type");
      const expected = getHolderType(holderType);
      if (!expected || gifts.get(normalize(rawGift)) !== expected.giftCode) {
        throw new Error("Gift is missing, unknown, or conflicts with holder type");
      }
      entries.push({ row: rowNumber, regCode, email: rawEmail.toLowerCase(), holderType });
    } catch (error) {
      errors.push({ row: rowNumber, message: error instanceof Error ? error.message : "Invalid row" });
    }
  });
  return result;
}
