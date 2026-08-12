import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
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
    "teamRegistrationJobState",
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
    "cancelled",
    "duplicate_paid",
    "refunded",
  ]);
});

test("exports payment retry registration and attempt columns", () => {
  assert.equal(schema.teamRegistrations.revision.name, "revision");
  assert.equal(
    schema.teamRegistrations.paymentReservationExpiresAt.name,
    "payment_reservation_expires_at",
  );

  const expectedAttemptColumns = {
    registrationRevisionSnapshot: "registration_revision_snapshot",
    isWinner: "is_winner",
    customerEmailSnapshot: "customer_email_snapshot",
    customerNameSnapshot: "customer_name_snapshot",
    productDetailSnapshot: "product_detail_snapshot",
    formActionUrlSnapshot: "form_action_url_snapshot",
    cancelledAt: "cancelled_at",
    refundedAt: "refunded_at",
    cancellationReason: "cancellation_reason",
    supersededByAttemptId: "superseded_by_attempt_id",
    reviewReason: "review_reason",
    actionRequired: "action_required",
    actionResolvedAt: "action_resolved_at",
    actionResolution: "action_resolution",
    actionResolutionNote: "action_resolution_note",
    nextReconcileAt: "next_reconcile_at",
    reconciliationDeadlineAt: "reconciliation_deadline_at",
    inquiryLeaseUntil: "inquiry_lease_until",
    terminalReconciliationCount: "terminal_reconciliation_count",
  } as const;

  for (const [property, columnName] of Object.entries(expectedAttemptColumns)) {
    const column = schema.teamRegistrationPaymentAttempts[
      property as keyof typeof expectedAttemptColumns
    ];
    assert.equal(column.name, columnName, `unexpected column for ${property}`);
  }

  assert.equal(schema.teamRegistrationPaymentAttempts.registrationRevisionSnapshot.notNull, true);
  assert.equal(schema.teamRegistrationPaymentAttempts.isWinner.notNull, true);
  assert.equal(schema.teamRegistrationPaymentAttempts.terminalReconciliationCount.notNull, true);
  assert.equal(schema.teamRegistrationPaymentAttempts.customerEmailSnapshot.notNull, false);
  assert.equal(schema.teamRegistrationPaymentAttempts.customerNameSnapshot.notNull, false);
  assert.equal(schema.teamRegistrationPaymentAttempts.productDetailSnapshot.notNull, false);
  assert.equal(schema.teamRegistrationPaymentAttempts.formActionUrlSnapshot.notNull, false);
});

test("exports retry safety indexes, checks, and successor foreign key", () => {
  const configIndexes = getTableConfig(schema.teamRegistrationConfigs).indexes.map(
    (value) => value.config.name,
  );
  assert.ok(configIndexes.includes("team_registration_configs_enabled_profile_unique"));

  const attemptConfig = getTableConfig(schema.teamRegistrationPaymentAttempts);
  const attemptIndexes = attemptConfig.indexes.map((value) => value.config.name);
  assert.ok(attemptIndexes.includes("team_registration_payment_active_unique"));
  assert.ok(attemptIndexes.includes("team_registration_payment_winner_unique"));
  assert.ok(attemptIndexes.includes("team_registration_payment_reconcile_due_idx"));
  assert.ok(attemptIndexes.includes("team_registration_payment_action_required_idx"));

  const expectedChecks = [
    "team_registration_payment_revision_check",
    "team_registration_payment_terminal_count_check",
    "team_registration_payment_cancellation_pair_check",
    "team_registration_payment_winner_paid_check",
    "team_registration_payment_refunded_check",
    "team_registration_payment_duplicate_not_winner_check",
    "team_registration_payment_cancellation_reason_check",
    "team_registration_payment_review_reason_check",
    "team_registration_payment_action_resolution_check",
    "team_registration_payment_action_fields_check",
  ];
  assert.deepEqual(
    attemptConfig.checks.map((value) => value.name).sort(),
    expectedChecks.sort(),
  );

  const successorForeignKey = attemptConfig.foreignKeys.find((foreignKey) =>
    foreignKey.getName().includes("superseded_by_attempt_id"),
  );
  assert.ok(successorForeignKey, "missing successor attempt foreign key");
  assert.equal(successorForeignKey.onDelete, "set null");

  const eventIndexes = getTableConfig(schema.teamRegistrationPaymentEvents).indexes.map(
    (value) => value.config.name,
  );
  assert.ok(
    eventIndexes.includes("team_registration_payment_event_reference_type_created_idx"),
  );
});

test("exports the worker heartbeat table", () => {
  const config = getTableConfig(schema.teamRegistrationJobState);
  assert.equal(config.name, "team_registration_job_state");
  assert.deepEqual(
    config.columns.map((column) => column.name),
    [
      "job_name",
      "last_started_at",
      "last_succeeded_at",
      "last_error_code",
      "updated_at",
    ],
  );
  assert.equal(config.primaryKeys.length, 0);
  assert.equal(schema.teamRegistrationJobState.jobName.primary, true);
});
