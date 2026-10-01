import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveDeadline,
  effectiveInvitationStatus,
  participantKey,
} from "./invitation-policy.js";

test("pending expires exactly at the earlier session deadline", () => {
  const snapshot = new Date("2026-10-29T06:00:00.000Z");
  const earlier = new Date("2026-10-29T05:00:00.000Z");
  const input = {
    status: "pending" as const,
    expiresAt: snapshot,
    startTime: earlier,
    isActive: true,
    registrationConfirmed: true,
    eventMatches: true,
  };

  assert.equal(effectiveDeadline(snapshot, earlier).toISOString(), earlier.toISOString());
  assert.equal(
    effectiveInvitationStatus(input, new Date("2026-10-29T04:59:59.999Z")),
    "pending",
  );
  assert.equal(effectiveInvitationStatus(input, earlier), "expired");
  assert.equal(participantKey({ id: 2, userId: 7 }), "user:7");
  assert.equal(participantKey({ id: 2, userId: null }), "registration:2");
});

test("terminal accepted and declined states remain terminal after deadline", () => {
  const base = {
    expiresAt: new Date("2026-10-29T05:00:00.000Z"),
    startTime: new Date("2026-10-29T05:00:00.000Z"),
    isActive: true,
    registrationConfirmed: true,
    eventMatches: true,
  };
  const after = new Date("2026-10-30T00:00:00.000Z");

  assert.equal(effectiveInvitationStatus({ ...base, status: "accepted" }, after), "accepted");
  assert.equal(effectiveInvitationStatus({ ...base, status: "declined" }, after), "declined");
});

test("pending becomes revoked when server-owned eligibility becomes invalid", () => {
  const base = {
    status: "pending" as const,
    expiresAt: new Date("2026-10-29T06:00:00.000Z"),
    startTime: new Date("2026-10-29T05:00:00.000Z"),
  };
  const before = new Date("2026-10-29T04:00:00.000Z");

  assert.equal(
    effectiveInvitationStatus(
      { ...base, isActive: false, registrationConfirmed: true, eventMatches: true },
      before,
    ),
    "revoked",
  );
  assert.equal(
    effectiveInvitationStatus(
      { ...base, isActive: true, registrationConfirmed: false, eventMatches: true },
      before,
    ),
    "revoked",
  );
  assert.equal(
    effectiveInvitationStatus(
      { ...base, isActive: true, registrationConfirmed: true, eventMatches: false },
      before,
    ),
    "revoked",
  );
});

test("later current start never extends stored expiry snapshot", () => {
  const snapshot = new Date("2026-10-29T05:00:00.000Z");
  const movedLater = new Date("2026-10-29T07:00:00.000Z");
  assert.equal(effectiveDeadline(snapshot, movedLater).toISOString(), snapshot.toISOString());
});

test("malformed deadlines fail closed as expired", () => {
  const invalid = new Date(Number.NaN);
  const now = new Date("2026-10-29T04:00:00.000Z");
  assert.equal(
    effectiveInvitationStatus(
      {
        status: "pending",
        expiresAt: invalid,
        startTime: new Date("2026-10-29T05:00:00.000Z"),
        isActive: true,
        registrationConfirmed: true,
        eventMatches: true,
      },
      now,
    ),
    "expired",
  );
  assert.equal(
    effectiveInvitationStatus(
      {
        status: "pending",
        expiresAt: new Date("2026-10-29T06:00:00.000Z"),
        startTime: invalid,
        isActive: true,
        registrationConfirmed: true,
        eventMatches: true,
      },
      now,
    ),
    "expired",
  );
});
