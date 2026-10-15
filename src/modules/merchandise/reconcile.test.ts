import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCheckAt } from "./payments/reconcile.js";

const at = (hhmmss: string, dayOffset = 0) =>
  new Date(Date.parse(`2026-10-16T${hhmmss}Z`) + dayOffset * 24 * 3600_000);

const created = at("10:00:00");
const expires = at("10:10:00");

test("active: every 60 seconds, capped at the expiry", () => {
  const attempt = { status: "active", createdAt: created, expiresAt: expires };
  assert.deepEqual(nextCheckAt(attempt, at("10:05:00")), at("10:06:00"));
  assert.deepEqual(nextCheckAt(attempt, at("10:09:30")), at("10:10:00"));
});

test("expired: +1, +5, +15, +60 minutes after expiry, then daily", () => {
  const attempt = { status: "expired", createdAt: created, expiresAt: expires };
  assert.deepEqual(nextCheckAt(attempt, at("10:10:30")), at("10:11:00"));
  assert.deepEqual(nextCheckAt(attempt, at("10:11:00")), at("10:15:00"));
  assert.deepEqual(nextCheckAt(attempt, at("10:16:00")), at("10:25:00"));
  assert.deepEqual(nextCheckAt(attempt, at("10:30:00")), at("11:10:00"));
  assert.deepEqual(nextCheckAt(attempt, at("11:10:00")), at("11:10:00", 1));
});

test("stops 7 days after creation", () => {
  const attempt = { status: "expired", createdAt: created, expiresAt: expires };
  assert.equal(nextCheckAt(attempt, at("10:01:00", 7)), null);
});

test("paid and create_failed are never checked", () => {
  assert.equal(nextCheckAt({ status: "paid", createdAt: created, expiresAt: expires }, at("10:05:00")), null);
  assert.equal(nextCheckAt({ status: "create_failed", createdAt: created, expiresAt: null }, at("10:05:00")), null);
});

test("create_unknown without expiry uses createdAt as the base", () => {
  const attempt = { status: "create_unknown", createdAt: created, expiresAt: null };
  assert.deepEqual(nextCheckAt(attempt, at("10:00:30")), at("10:01:00"));
  assert.deepEqual(nextCheckAt(attempt, at("10:02:00")), at("10:05:00"));
});
