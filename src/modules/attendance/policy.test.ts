import assert from "node:assert/strict";
import test from "node:test";
import { bangkokDay, isWithinSession } from "./policy.js";

test("server instants use Bangkok midnight and an exclusive session end", () => {
  assert.equal(bangkokDay(new Date("2026-10-29T16:59:59.999Z")), "2026-10-29");
  assert.equal(bangkokDay(new Date("2026-10-29T17:00:00Z")), "2026-10-30");
  const start = new Date("2026-10-29T02:00:00Z");
  const end = new Date("2026-10-30T10:00:00Z");
  assert.equal(isWithinSession(start, start, end), true);
  assert.equal(isWithinSession(end, start, end), false);
});
