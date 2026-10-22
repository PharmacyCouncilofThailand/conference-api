import assert from "node:assert/strict";
import test from "node:test";
import { canonicalResendInput, resendCooldownUntil, resendDisabledReason } from "./resend-policy.js";
const now = new Date("2026-10-23T03:05:00Z");
const candidate = { invitationId: "one", invitationStatus: "pending", expiresAt: new Date("2099-01-01Z"),
  sessionStartTime: new Date("2099-01-01Z"), sessionIsActive: true, registrationStatus: "confirmed",
  registrationEventId: 1, sessionEventId: 1, emailStatus: "sent", lastSuccessfulSentAt: new Date("2026-10-23T03:00:00Z"),
  lastResendQueuedAt: null } satisfies Parameters<typeof resendDisabledReason>[0];
test("cooldown uses later delivery/request with an exact five minute boundary", () => {
  assert.equal(resendCooldownUntil(candidate.lastSuccessfulSentAt, null)?.toISOString(), "2026-10-23T03:05:00.000Z");
  assert.equal(resendCooldownUntil(null, null), null);
  assert.equal(resendCooldownUntil(candidate.lastSuccessfulSentAt, new Date("2026-10-23T03:02:00Z"))?.toISOString(), "2026-10-23T03:07:00.000Z");
  assert.equal(resendDisabledReason(candidate, now), null);
  assert.deepEqual(resendDisabledReason(candidate, new Date(now.getTime() - 1)), { invitationId: "one", reasonCode: "RESEND_COOLDOWN", retryAfter: now.toISOString() });
});
test("policy rejects terminal/effectively closed invitations before mail state", () => {
  for (const invitationStatus of ["accepted", "declined", "expired", "revoked"] as const)
    assert.equal(resendDisabledReason({ ...candidate, invitationStatus, emailStatus: "pending" }, now)?.reasonCode, "INVITATION_NOT_PENDING");
  for (const overrides of [{ expiresAt: now }, { sessionStartTime: now }, { sessionIsActive: false }, { registrationStatus: "cancelled" }, { registrationEventId: 2 }])
    assert.equal(resendDisabledReason({ ...candidate, ...overrides }, now)?.reasonCode, "INVITATION_NOT_PENDING");
});
test("busy and non-sent states fail closed", () => {
  for (const emailStatus of ["pending", "sending"] as const) assert.equal(resendDisabledReason({ ...candidate, emailStatus }, now)?.reasonCode, "EMAIL_BUSY");
  for (const emailStatus of ["failed", "unknown", "suppressed", "not_applicable"] as const)
    assert.equal(resendDisabledReason({ ...candidate, emailStatus }, now)?.reasonCode, "EMAIL_NOT_RESENDABLE");
  assert.equal(resendDisabledReason({ ...candidate, lastResendQueuedAt: new Date("bad") }, now)?.reasonCode, "INVITATION_PAYLOAD_INVALID");
  assert.equal(resendDisabledReason(candidate, new Date("bad"))?.reasonCode, "INVITATION_PAYLOAD_INVALID");
});
test("canonical input deduplicates and sorts without mutating caller", () => {
  const input = { sessionId: 2, invitationIds: ["b", "a", "b"] };
  assert.deepEqual(canonicalResendInput(input), { sessionId: 2, invitationIds: ["a", "b"] });
  assert.deepEqual(input.invitationIds, ["b", "a", "b"]);
});
