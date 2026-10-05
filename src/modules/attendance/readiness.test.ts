import assert from "node:assert/strict";
import test from "node:test";
import { classifyLegacy, type LegacySource, type LegacyHistory } from "./readiness.js";

test("legacy evidence never invents attendance or resurrects cancellation", () => {
  const source: LegacySource = { entitlementId: 1, sourceKey: "registration_sessions:1",
    instant: "2026-10-05T08:00:00.123456Z", day: "2026-10-05", scannerId: 2,
    timeValid: true, scannerExists: true };
  const history: LegacyHistory = { sourceAlreadyRecorded: false, active: null, cancelledOnDay: false };
  assert.equal(classifyLegacy(null, history), "absent");
  assert.equal(classifyLegacy(source, history), "import");
  assert.equal(classifyLegacy(source, { ...history, sourceAlreadyRecorded: true, cancelledOnDay: true }), "alreadyImported");
  assert.equal(classifyLegacy(source, { ...history, active: { sameEvidence: true } }), "alreadyCovered");
  assert.equal(classifyLegacy(source, { ...history, active: { sameEvidence: false } }), "LEGACY_DAILY_CONFLICT");
  assert.equal(classifyLegacy(source, { ...history, cancelledOnDay: true }), "CANCELLATION_CONFLICT");
  assert.equal(classifyLegacy({ ...source, scannerExists: false }, history), "LEGACY_SCANNER_MISSING");
  assert.equal(classifyLegacy({ ...source, scannerId: null }, history), "LEGACY_SCANNER_MISSING");
  assert.equal(classifyLegacy({ ...source, timeValid: false }, history), "LEGACY_TIME_INVALID");
});
