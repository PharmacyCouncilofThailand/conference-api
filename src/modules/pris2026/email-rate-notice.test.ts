import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPris2026RegistrationRateNotice,
  registrationRateNoticeFromPricing,
} from "./email-rate-notice.js";

const eligiblePricing = {
  applies: true,
  policyCode: "pris2026_abstract_early_bird" as const,
  phase: "extended_early_bird" as const,
  qualifiedForExtension: true,
  effectivePriority: "early_bird" as const,
  offerExpiresAt: new Date("2026-09-15T17:00:00.000Z"),
  reason: "eligible_extension" as const,
  eventId: 1,
  effectiveTicketTypeId: 2,
};

test("eligible extended Early Bird pricing produces the PRIS result-email notice", () => {
  assert.deepEqual(
    registrationRateNoticeFromPricing(eligiblePricing),
    buildPris2026RegistrationRateNotice(),
  );
});

test("regular or non-qualified pricing produces no result-email notice", () => {
  assert.equal(
    registrationRateNoticeFromPricing({
      ...eligiblePricing,
      qualifiedForExtension: false,
      effectivePriority: "regular",
      reason: "no_qualifying_abstract",
    }),
    undefined,
  );

  assert.equal(
    registrationRateNoticeFromPricing({
      ...eligiblePricing,
      phase: "regular",
      effectivePriority: "regular",
      reason: "offer_expired",
    }),
    undefined,
  );
});
