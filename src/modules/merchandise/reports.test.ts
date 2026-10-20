import assert from "node:assert/strict";
import { test } from "node:test";
import { safeCell } from "./reports.js";

test("safeCell prefixes formula characters and blanks null", () => {
  assert.equal(safeCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(safeCell("+66"), "'+66");
  assert.equal(safeCell("-1"), "'-1");
  assert.equal(safeCell("@x"), "'@x");
  assert.equal(safeCell("ABC"), "ABC");
  assert.equal(safeCell(null), "");
});
