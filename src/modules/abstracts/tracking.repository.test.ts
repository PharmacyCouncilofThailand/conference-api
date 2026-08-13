import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../database/schema.js";

test("durable tracking tables and widened identifier column are present", () => {
  for (const name of [
    "abstractTrackingNamespaces",
    "abstractTrackingCounters",
    "abstractTrackingAllocations",
    "abstractTrackingIdentifiers",
    "abstractTrackingRuntime",
    "abstractTrackingAuditEvents",
    "abstractSubmissionIdempotencyKeys",
  ] as const) {
    assert.ok(name in schema, `missing ${name}`);
  }
  assert.equal(schema.abstracts.trackingId.name, "tracking_id");
  assert.equal(schema.abstracts.trackingId.columnType, "PgVarchar");
  assert.equal(schema.abstractTrackingCounters.presentationType.name, "presentation_type");
  assert.equal(schema.abstractTrackingCounters.lastIssuedNumber.name, "last_issued_number");
});

test("tracking counter uses a composite namespace/type primary key", () => {
  const config = getTableConfig(schema.abstractTrackingCounters);
  assert.deepEqual(
    config.primaryKeys.map((key) => key.columns.map((column) => column.name)),
    [["namespace_id", "presentation_type"]],
  );
});

test("idempotency key has a per-user unique index", () => {
  const config = getTableConfig(schema.abstractSubmissionIdempotencyKeys);
  assert.ok(config.indexes.some((index) => index.config.name === "abstract_submission_idempotency_user_key_unique"));
});
