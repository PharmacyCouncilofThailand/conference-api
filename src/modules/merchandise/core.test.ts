import assert from "node:assert/strict";
import test from "node:test";
import { formatProviderTotal, parseProviderTotal } from "./money.js";
import { storeState } from "./store-window.js";

test("formatProviderTotal", () => {
  assert.equal(formatProviderTotal(12345), "123.45");
  assert.equal(formatProviderTotal(5000), "50.00");
  assert.equal(formatProviderTotal(7), "0.07");
});
test("parseProviderTotal accepts numbers and strings, rejects junk", () => {
  assert.equal(parseProviderTotal(123.45), 12345);
  assert.equal(parseProviderTotal("3900.0"), 390000);
  assert.equal(parseProviderTotal(12.1), 1210);
  assert.equal(parseProviderTotal("abc"), null);
  assert.equal(parseProviderTotal(-1), null);
  assert.equal(parseProviderTotal(null), null);
});
test("storeState transitions", () => {
  const now = new Date("2026-11-01T05:00:00Z");
  assert.equal(storeState(null, now), "disabled");
  assert.equal(storeState({ enabled: false, opensAt: null, closesAt: null }, now), "disabled");
  assert.equal(storeState({ enabled: true, opensAt: null, closesAt: null }, now), "not_open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-11-02T00:00:00Z"), closesAt: new Date("2026-11-03T00:00:00Z") }, now), "not_open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-11-01T05:00:00Z"), closesAt: new Date("2026-11-03T00:00:00Z") }, now), "open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-10-01T00:00:00Z"), closesAt: new Date("2026-11-01T05:00:00Z") }, now), "closed");
});
