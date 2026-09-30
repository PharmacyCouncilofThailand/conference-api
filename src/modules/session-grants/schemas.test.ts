import assert from "node:assert/strict";
import test from "node:test";
import {
  createGrantSchema,
  idempotencyKeySchema,
  resultQuerySchema,
  retryEmailsSchema,
} from "./schemas.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

test("createGrantSchema accepts one through 500 raw registration IDs", () => {
  const parsed = createGrantSchema.parse({
    sessionId: 9,
    registrationIds: Array.from({ length: 500 }, (_, index) => index + 1),
  });

  assert.equal(parsed.registrationIds.length, 500);
});

test("createGrantSchema rejects more than 500 raw IDs without truncating or deduping first", () => {
  const result = createGrantSchema.safeParse({
    sessionId: 9,
    registrationIds: Array.from({ length: 501 }, () => 1),
  });

  assert.equal(result.success, false);
});

test("createGrantSchema rejects empty, invalid IDs and mass-assignment fields", () => {
  assert.equal(
    createGrantSchema.safeParse({ sessionId: 9, registrationIds: [] }).success,
    false,
  );
  assert.equal(
    createGrantSchema.safeParse({ sessionId: 0, registrationIds: [1] }).success,
    false,
  );
  assert.equal(
    createGrantSchema.safeParse({ sessionId: 9, registrationIds: [1.5] })
      .success,
    false,
  );
  assert.equal(
    createGrantSchema.safeParse({
      sessionId: 9,
      registrationIds: [1],
      actorId: 123,
    }).success,
    false,
  );
});

test("idempotency key must be a UUID", () => {
  assert.equal(idempotencyKeySchema.safeParse(uuid).success, true);
  assert.equal(idempotencyKeySchema.safeParse("not-a-uuid").success, false);
});

test("retry schema defaults acknowledgement false and enforces a 500 item hard limit", () => {
  const parsed = retryEmailsSchema.parse({ itemIds: [uuid] });
  assert.equal(parsed.acknowledgeUnknown, false);

  assert.equal(
    retryEmailsSchema.safeParse({
      itemIds: Array.from({ length: 501 }, () => uuid),
      acknowledgeUnknown: true,
    }).success,
    false,
  );
});

test("result query defaults to page 1 / 50 and caps limit at 100", () => {
  assert.deepEqual(resultQuerySchema.parse({}), { page: 1, limit: 50 });
  assert.deepEqual(resultQuerySchema.parse({ page: "2", limit: "100" }), {
    page: 2,
    limit: 100,
  });
  assert.equal(resultQuerySchema.safeParse({ limit: 101 }).success, false);
});
