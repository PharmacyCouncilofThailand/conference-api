import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRequest,
  registrationBlock,
  requestHash,
  sessionBlock,
} from "./policy.js";

test("sessionBlock rejects inactive and exact/expired end boundaries", () => {
  const end = new Date("2026-10-01T03:00:00.000Z");

  assert.equal(
    sessionBlock({ isActive: false, endTime: end }, new Date(end.getTime() - 1)),
    "SESSION_INACTIVE",
  );
  assert.equal(
    sessionBlock({ isActive: true, endTime: end }, new Date(end.getTime() - 1)),
    null,
  );
  assert.equal(
    sessionBlock({ isActive: true, endTime: end }, end),
    "SESSION_ENDED",
  );
  assert.equal(
    sessionBlock({ isActive: true, endTime: end }, new Date(end.getTime() + 1)),
    "SESSION_ENDED",
  );
  assert.equal(
    sessionBlock(
      { isActive: true, endTime: new Date("invalid") },
      new Date("2026-10-01T03:00:00.000Z"),
    ),
    "SESSION_ENDED",
  );
});

test("registrationBlock returns the exact per-registration reason", () => {
  assert.equal(registrationBlock(null, 10, false), "REGISTRATION_NOT_FOUND");
  assert.equal(
    registrationBlock({ eventId: 11, status: "confirmed" }, 10, false),
    "EVENT_MISMATCH",
  );
  assert.equal(
    registrationBlock({ eventId: 10, status: "cancelled" }, 10, false),
    "REGISTRATION_NOT_CONFIRMED",
  );
  assert.equal(
    registrationBlock({ eventId: 10, status: "confirmed" }, 10, true),
    "ALREADY_REGISTERED",
  );
  assert.equal(
    registrationBlock({ eventId: 10, status: "confirmed" }, 10, false),
    null,
  );
});

test("canonical request deduplicates and sorts only after boundary validation", () => {
  assert.deepEqual(canonicalRequest(7, [3, 2, 3, 1]), {
    sessionId: 7,
    registrationIds: [1, 2, 3],
  });
});

test("request hash is stable for equivalent ID sets and changes with payload", () => {
  assert.equal(requestHash(7, [3, 2, 3]), requestHash(7, [2, 3]));
  assert.notEqual(requestHash(8, [2, 3]), requestHash(7, [2, 3]));
  assert.notEqual(requestHash(7, [2, 4]), requestHash(7, [2, 3]));
});
