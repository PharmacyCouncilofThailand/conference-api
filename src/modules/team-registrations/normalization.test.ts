import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEmail, normalizeTeamName } from "./normalization.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail(" Leader@Example.COM "), "leader@example.com");
});

test("normalizeTeamName applies NFKC, trims, collapses whitespace, and lowercases", () => {
  assert.equal(normalizeTeamName("  Team   Alpha  "), "team alpha");
});

test("normalizeTeamName normalizes compatible Unicode forms", () => {
  assert.equal(normalizeTeamName("Ｔｅａｍ Alpha"), "team alpha");
});
