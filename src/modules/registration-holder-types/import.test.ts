import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { HOLDER_TYPES } from "./catalog.js";
import { parseHolderTypeWorkbook } from "./import.js";

const headers = ["Reg Code", "Email", "Typeตั๋ว", "ของมอบ"];
function workbook(rows: unknown[][] = []) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return book;
}

test("imports 560 synthetic rows across all canonical holder types", () => {
  const rows = Array.from({ length: 560 }, (_, index) => {
    const type = HOLDER_TYPES[index % HOLDER_TYPES.length];
    return [`REG-SYNTH-${index}`, `person${index}@example.invalid`, type.label, type.giftLabel];
  });
  const result = parseHolderTypeWorkbook(workbook(rows));
  assert.equal(result.entries.length, 560);
  assert.equal(result.errors.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.entries[559].row, 561);
  assert.equal(new Set(result.entries.map((entry) => entry.holderType)).size, HOLDER_TYPES.length);
});

test("explicit aliases match canonical types and the gift/blank rule", () => {
  const result = parseHolderTypeWorkbook(workbook([
    ["REG-1", "ONE@EXAMPLE.INVALID", "VIP (วิทยากร)", ""],
    ["REG-2", "two@example.invalid", "VIPVIP (วิทยากร)", "-"],
    ["REG-3", "three@example.invalid", "VIP", "ให้"],
    ["REG-4", "four@example.invalid", HOLDER_TYPES.find((type) => type.key === "health_hack")!.label, "-"],
  ]));
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.entries.map((entry) => entry.holderType), ["speaker", "speaker", "vip", "health_hack"]);
  assert.equal(result.entries[0].email, "one@example.invalid");
});

test("BOOTH requires explicit resolution and gift agreement", () => {
  const book = workbook([["REG-1", "one@example.invalid", "BOOTH", ""]]);
  assert.equal(parseHolderTypeWorkbook(book).errors.length, 1);
  for (const boothType of ["exhibitor", "staff_mc"] as const) {
    const result = parseHolderTypeWorkbook(book, { boothType });
    assert.equal(result.errors.length, 0);
    assert.equal(result.entries[0].holderType, boothType);
  }
});

test("accepts legacy exhibitor labels after the canonical label changes", () => {
  const result = parseHolderTypeWorkbook(workbook([
    ["REG-1", "one@example.invalid", "เจ้าหน้าที่บูธ/Exhibitor", ""],
    ["REG-2", "two@example.invalid", "เจ้าหน้าที่บูธ(Exhibitor)", "-"],
  ]));
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.entries.map((entry) => entry.holderType), ["exhibitor", "exhibitor"]);
});

test("duplicates are reported, including codes seen in invalid or skipped rows", () => {
  const result = parseHolderTypeWorkbook(workbook([
    ["REG-1", "one@example.invalid", "VIP", "wrong gift"],
    ["REG-1", "one@example.invalid", "VIP", "ให้"],
    ["REG-2", "two@example.invalid", "Test", ""],
    ["REG-2", "two@example.invalid", "VIP", "ให้"],
  ]));
  assert.equal(result.entries.length, 0);
  assert.equal(result.errors.length, 3);
  assert.equal(result.errors.filter((error) => error.message === "Duplicate Reg Code").length, 2);
  assert.equal(result.skipped.length, 1);
});

test("ignores Sheet2 entirely and skips Test without accepting it as a type", () => {
  const book = workbook([["REG-1", "one@example.invalid", "Test", ""]]);
  book.addWorksheet("Sheet2").addRow([{ formula: "1+1", result: 2 }, "invalid"]);
  const result = parseHolderTypeWorkbook(book);
  assert.equal(result.errors.length, 0);
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped.length, 1);
});

test("rejects missing headers, duplicate headers, and missing Sheet1", () => {
  assert.equal(parseHolderTypeWorkbook(new ExcelJS.Workbook()).errors.length, 1);
  const missing = workbook();
  missing.getWorksheet("Sheet1")!.getCell("D1").value = "wrong";
  assert.equal(parseHolderTypeWorkbook(missing).errors.length, 1);
  const duplicate = workbook();
  duplicate.getWorksheet("Sheet1")!.getCell("E1").value = "Email";
  assert.equal(parseHolderTypeWorkbook(duplicate).errors.length, 1);
});

test("rejects formulas even with cached valid results in each required field", () => {
  for (let column = 0; column < 4; column++) {
    const row: unknown[] = ["REG-1", "one@example.invalid", "VIP", "ให้"];
    row[column] = { formula: '"cached"', result: row[column] };
    const result = parseHolderTypeWorkbook(workbook([row]));
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /Formula/);
  }
});

test("rejects missing registration, email, type and wrong/blank gift; ignores blank rows", () => {
  const result = parseHolderTypeWorkbook(workbook([
    [],
    ["", "one@example.invalid", "VIP", "ให้"],
    ["REG-2", "", "VIP", "ให้"],
    ["REG-3", "three@example.invalid", "", "ให้"],
    ["REG-4", "four@example.invalid", "ผู้เข้าร่วมงาน", "ให้"],
    ["REG-5", "five@example.invalid", "VIP", ""],
  ]));
  assert.equal(result.entries.length, 0);
  assert.equal(result.errors.length, 5);
});

test("retired set gift labels are rejected", () => {
  const result = parseHolderTypeWorkbook(workbook([
    ["REG-1", "one@example.invalid", "VIP", "แก้ว Mug set1"],
    ["REG-2", "two@example.invalid", "VIP", "Mug SET1"],
    ["REG-3", "three@example.invalid", "ผู้เข้าร่วมงาน", "กิจกรรม set2"],
    ["REG-4", "four@example.invalid", "วิทยากร", "ชุดใหญ่ไฟกระพริบ"],
  ]));
  assert.equal(result.entries.length, 0);
  assert.equal(result.errors.length, 4);
});
