import assert from "node:assert/strict";
import test from "node:test";
import { PRIS_2026_EVENT_CODE } from "../pris2026/pricing-policy.js";
import { checkPris2026PreEventEligibility, parseBatchId } from "./eligibility.js";

test("pre-event eligibility rejects missing, non-PRIS and cancelled registrations", () => {
  const PRIS = PRIS_2026_EVENT_CODE;
  assert.deepEqual(
    checkPris2026PreEventEligibility({ eventCode: PRIS, registrationId: 7, registration: null }),
    { ok: false, reason: "Registration #7 not found for this event" },
  );
  assert.deepEqual(
    checkPris2026PreEventEligibility({ eventCode: "OTHER", registrationId: 7, registration: { status: "confirmed" } }),
    { ok: false, reason: "Template is only available for PRIS 2026" },
  );
  assert.deepEqual(
    checkPris2026PreEventEligibility({ eventCode: PRIS, registrationId: 7, registration: { status: "cancelled" } }),
    { ok: false, reason: 'Registration status is "cancelled" (expected confirmed)' },
  );
});

test("pre-event eligibility accepts confirmed PRIS registrations", () => {
  assert.deepEqual(
    checkPris2026PreEventEligibility({
      eventCode: PRIS_2026_EVENT_CODE,
      registrationId: 7,
      registration: { status: "confirmed" },
    }),
    { ok: true },
  );
});

test("batchId parsing generates, normalizes and rejects", () => {
  const generated = parseBatchId(undefined);
  assert.ok(generated.ok && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generated.batchId));
  assert.deepEqual(parseBatchId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), {
    ok: true,
    batchId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  });
  assert.deepEqual(parseBatchId("not-a-uuid"), { ok: false });
  assert.deepEqual(parseBatchId(123), { ok: false });
});
