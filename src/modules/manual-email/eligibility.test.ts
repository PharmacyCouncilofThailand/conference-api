import assert from "node:assert/strict";
import test from "node:test";
import { PRIS_2026_EVENT_CODE } from "../pris2026/pricing-policy.js";
import { checkPris2026PreEventEligibility, checkPris2026TicketReminderEligibility, parseBatchId } from "./eligibility.js";

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

test("ticket reminder eligibility: active PRIS account of any role except speaker without a confirmed primary ticket", () => {
  const PRIS = PRIS_2026_EVENT_CODE;
  const user = { status: "active", role: "student", registeredFromEvent: PRIS };
  const check = (overrides: Partial<Parameters<typeof checkPris2026TicketReminderEligibility>[0]>) =>
    checkPris2026TicketReminderEligibility({ eventCode: PRIS, userId: 9, user, hasConfirmedPrimary: false, ...overrides });

  assert.deepEqual(check({}), { ok: true });
  assert.deepEqual(check({ user: { ...user, role: "general" } }), { ok: true });
  assert.deepEqual(check({ user: null }), { ok: false, reason: "User #9 not found" });
  assert.deepEqual(check({ eventCode: "OTHER" }), { ok: false, reason: "Template is only available for PRIS 2026" });
  assert.deepEqual(check({ user: { ...user, status: "pending_approval" } }),
    { ok: false, reason: 'User status is "pending_approval" (expected active)' });
  assert.deepEqual(check({ user: { ...user, registeredFromEvent: "OTHER-2025" } }),
    { ok: false, reason: "User did not register from PRIS 2026" });
  assert.deepEqual(check({ user: { ...user, role: "speaker" } }),
    { ok: false, reason: "Speakers do not need to buy a ticket" });
  assert.deepEqual(check({ hasConfirmedPrimary: true }),
    { ok: false, reason: "User already has a confirmed primary registration" });
});
