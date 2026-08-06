import assert from "node:assert/strict";
import test from "node:test";
import * as schema from "../../database/schema.js";

test("exports every isolated team registration table", () => {
  const tableNames = [
    "teamRegistrationConfigs",
    "teamRegistrationCategories",
    "teamRegistrationPricingRounds",
    "teamRegistrationPrices",
    "teamRegistrationOtpChallenges",
    "teamRegistrationAccessSessions",
    "teamRegistrations",
    "teamRegistrationMembers",
    "teamRegistrationEmailClaims",
    "teamRegistrationPaymentAttempts",
    "teamRegistrationPaymentEvents",
    "teamRegistrationEmailOutbox",
    "teamRegistrationAuditLogs",
  ] as const;

  for (const name of tableNames) {
    assert.ok(name in schema, `missing ${name}`);
  }
});

test("exports stable team registration state enums", () => {
  assert.deepEqual(schema.teamRegistrationStatusEnum.enumValues, [
    "draft",
    "ready_for_payment",
    "payment_pending",
    "paid",
    "expired",
  ]);
  assert.deepEqual(schema.teamRegistrationPaymentStatusEnum.enumValues, [
    "creating",
    "pending",
    "paid",
    "failed",
    "expired",
    "verification_required",
  ]);
});
