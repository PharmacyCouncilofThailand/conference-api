import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTrackingId,
  parseStructuredTrackingId,
  validateTrackingPrefix,
} from "./tracking-format.js";

test("formats oral/poster IDs without truncating numbers beyond padding", () => {
  assert.equal(formatTrackingId({ prefix: "PRIS-2026", presentationType: "poster", sequenceNumber: 22n, paddingWidth: 3 }), "PRIS-2026-P022");
  assert.equal(formatTrackingId({ prefix: "PRIS-2026", presentationType: "oral", sequenceNumber: 1000n, paddingWidth: 3 }), "PRIS-2026-O1000");
});

test("historical floor advances the next identifier without touching the old ID", () => {
  const approvedFloor = 22n;
  const next = approvedFloor + 1n;
  assert.equal(formatTrackingId({ prefix: "PRIS-2026", presentationType: "poster", sequenceNumber: next, paddingWidth: 3 }), "PRIS-2026-P023");
  assert.equal(parseStructuredTrackingId("PRIS-2026-P022")?.sequenceNumber, approvedFloor);
});

test("parses structured IDs using final marker and numeric suffix", () => {
  assert.deepEqual(parseStructuredTrackingId("PRIS-2026-P022"), {
    trackingId: "PRIS-2026-P022",
    prefix: "PRIS-2026",
    marker: "P",
    presentationType: "poster",
    sequenceNumber: 22n,
  });
});

test("rejects unsafe native prefixes", () => {
  assert.throws(() => validateTrackingPrefix("pris_2026"));
  assert.throws(() => validateTrackingPrefix(""));
});
