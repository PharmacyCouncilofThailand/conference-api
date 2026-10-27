import assert from "node:assert/strict";
import test from "node:test";
import { bangkokDay, checkDailyWindow, isWithinSession } from "./policy.js";

test("server instants use Bangkok midnight and an exclusive session end", () => {
  assert.equal(bangkokDay(new Date("2026-10-29T16:59:59.999Z")), "2026-10-29");
  assert.equal(bangkokDay(new Date("2026-10-29T17:00:00Z")), "2026-10-30");
  const start = new Date("2026-10-29T02:00:00Z");
  const end = new Date("2026-10-30T10:00:00Z");
  assert.equal(isWithinSession(start, start, end), true);
  assert.equal(isWithinSession(end, start, end), false);
});

test("daily window opens 06:00 and closes 18:00 Bangkok on every session day", () => {
  // PRIS: session 29 Oct 09:30 – 30 Oct 17:30 Bangkok, desk open 06:00–18:00.
  const start = new Date("2026-10-29T02:30:00Z");
  const end = new Date("2026-10-30T10:30:00Z");
  const at = (iso: string) => checkDailyWindow(new Date(iso), start, end, "06:00", "18:00");
  assert.equal(at("2026-10-28T23:59:59Z"), "open"); // 29 Oct 06:59
  assert.equal(at("2026-10-28T22:59:59Z"), "before_open"); // 29 Oct 05:59
  assert.equal(at("2026-10-28T23:00:00Z"), "open"); // 29 Oct 06:00
  assert.equal(at("2026-10-29T10:59:59Z"), "open"); // 29 Oct 17:59
  assert.equal(at("2026-10-29T11:00:00Z"), "after_close"); // 29 Oct 18:00
  assert.equal(at("2026-10-29T16:00:00Z"), "after_close"); // 29 Oct 23:00
  assert.equal(at("2026-10-30T10:45:00Z"), "open"); // 30 Oct 17:45, after session end time
  assert.equal(at("2026-10-30T11:00:00Z"), "after_close"); // 30 Oct 18:00
  assert.equal(at("2026-10-28T05:00:00Z"), "before_event"); // 28 Oct 12:00
  assert.equal(at("2026-10-31T01:00:00Z"), "after_event"); // 31 Oct 08:00
});
