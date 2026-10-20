import assert from "node:assert/strict";
import test from "node:test";
import { MerchError } from "./errors.js";
import { assertOrderTotalAllowed, formatProviderTotal, parseProviderTotal } from "./money.js";
import { storeState } from "./store-window.js";

test("formatProviderTotal", () => {
  assert.equal(formatProviderTotal(6), "6.00");
  assert.equal(formatProviderTotal(56), "56.00");
  assert.equal(formatProviderTotal(0), "0.00");
});
test("parseProviderTotal accepts whole baht as number or string", () => {
  assert.equal(parseProviderTotal(56), 56);
  assert.equal(parseProviderTotal("56"), 56);
  assert.equal(parseProviderTotal("56.0"), 56);
  assert.equal(parseProviderTotal(" 56.00 "), 56);
});
test("parseProviderTotal rejects satang fractions instead of rounding", () => {
  assert.equal(parseProviderTotal("56.50"), null);
  assert.equal(parseProviderTotal("0.06"), null);
  assert.equal(parseProviderTotal(56.5), null);
  assert.equal(parseProviderTotal(0.06), null);
});
test("parseProviderTotal rejects malformed values", () => {
  for (const v of ["", "  ", "abc", "1e3", "0x10", "1.005", -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(parseProviderTotal(v), null, String(v));
  }
});
test("assertOrderTotalAllowed caps at 2,000,000 baht", () => {
  assert.doesNotThrow(() => assertOrderTotalAllowed(2_000_000));
  assert.throws(() => assertOrderTotalAllowed(2_000_001), (e: MerchError) =>
    e.code === "MERCH_ORDER_TOO_LARGE" && (e.details as { maxTotalBaht: number }).maxTotalBaht === 2_000_000);
});test("storeState transitions", () => {
  const now = new Date("2026-11-01T05:00:00Z");
  assert.equal(storeState(null, now), "disabled");
  assert.equal(storeState({ enabled: false, opensAt: null, closesAt: null }, now), "disabled");
  assert.equal(storeState({ enabled: true, opensAt: null, closesAt: null }, now), "not_open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-11-02T00:00:00Z"), closesAt: new Date("2026-11-03T00:00:00Z") }, now), "not_open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-11-01T05:00:00Z"), closesAt: new Date("2026-11-03T00:00:00Z") }, now), "open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-10-01T00:00:00Z"), closesAt: new Date("2026-11-01T05:00:00Z") }, now), "closed");
});
