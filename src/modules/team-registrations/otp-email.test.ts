import assert from "node:assert/strict";
import test from "node:test";
import { buildTeamOtpEmail } from "./otp-email.js";

test("builds an escaped OTP email with code, reference, and one-hour expiry", () => {
  const email = buildTeamOtpEmail({
    eventName: "Event <script>alert(1)</script>",
    otp: "123456",
    referenceCode: "ABCDE",
    expiresAt: new Date("2026-08-15T01:00:00.000Z"),
  });
  assert.match(email.subject, /OTP/);
  assert.match(email.html, /123456/);
  assert.match(email.html, /ABCDE/);
  assert.doesNotMatch(email.html, /<script>/);
});
