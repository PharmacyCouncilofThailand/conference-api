import assert from "node:assert/strict";
import test from "node:test";
import { buildResendSnapshot } from "./resend-readers.js";
import { GrantError } from "./types.js";
import type { ResendCandidate } from "./resend-types.js";
const original = { personName: "Original Person", regCode: "ORIGINAL", eventName: "Old Event", eventShortName: "OLD",
  eventDates: "Old dates", eventVenue: "Old venue", sessionName: "Old Session", sessionType: "other", startTime: "2026-01-01Z", endTime: "2026-01-02Z",
  room: "Old Room", participantUrl: "https://original.invalid/participant", responseOrigin: "https://original.invalid" };
const candidate = { notificationSnapshot: original, eventName: "Current Event", eventStartDate: new Date("2026-10-29Z"), eventEndDate: new Date("2026-10-30Z"),
  eventLocation: "Current Venue", sessionName: "Current Session", sessionType: "workshop", sessionStartTime: new Date("2026-10-29T01:00:00Z"),
  sessionEndTime: new Date("2026-10-29T03:00:00Z"), room: "Current Room" } as ResendCandidate;
test("current display snapshot preserves original identity/origin without mutating stored snapshot", () => {
  const before = JSON.stringify(original);
  const result = buildResendSnapshot(candidate);
  assert.equal(result.personName, original.personName); assert.equal(result.regCode, original.regCode);
  assert.equal(result.responseOrigin, original.responseOrigin); assert.equal(result.participantUrl, original.participantUrl);
  assert.equal(result.eventName, candidate.eventName); assert.equal(result.eventVenue, candidate.eventLocation);
  assert.equal(result.sessionName, candidate.sessionName); assert.equal(result.startTime, "2026-10-29T01:00:00.000Z");
  assert.equal(JSON.stringify(original), before); assert.notEqual(result, original);
});
test("missing/malformed snapshots and dates return a bounded error", () => {
  for (const changed of [{ notificationSnapshot: null }, { notificationSnapshot: {} }, { notificationSnapshot: { ...original, responseOrigin: "javascript:bad" } }, { sessionStartTime: new Date("bad") }])
    assert.throws(() => buildResendSnapshot({ ...candidate, ...changed } as ResendCandidate), error => error instanceof GrantError && error.code === "INVITATION_PAYLOAD_INVALID" && !error.message.includes("javascript"));
});
