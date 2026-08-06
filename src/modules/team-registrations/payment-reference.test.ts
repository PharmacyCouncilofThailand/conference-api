import assert from "node:assert/strict";
import test from "node:test";
import { TeamRegistrationError } from "./errors.js";
import {
  createReferenceNo,
  insertWithUniquePaymentReference,
  MAX_PAYMENT_REFERENCE_ATTEMPTS,
} from "./payment-reference.js";

test("creates a twelve-digit payment reference that starts with 4", () => {
  assert.match(createReferenceNo(), /^4\d{11}$/);
});

test("retries with a new reference when the database reports a conflict", async () => {
  const generated = ["400000000001", "400000000002"];
  const attempted: string[] = [];

  const result = await insertWithUniquePaymentReference(
    async (referenceNo) => {
      attempted.push(referenceNo);
      return referenceNo === "400000000002" ? { referenceNo } : undefined;
    },
    { referenceFactory: () => generated.shift()! },
  );

  assert.deepEqual(attempted, ["400000000001", "400000000002"]);
  assert.deepEqual(result, { referenceNo: "400000000002" });
});

test("returns a controlled error after all reference attempts collide", async () => {
  const attempted: string[] = [];

  await assert.rejects(
    insertWithUniquePaymentReference(
      async (referenceNo) => {
        attempted.push(referenceNo);
        return undefined;
      },
      { referenceFactory: () => "400000000001" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TeamRegistrationError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "PAYMENT_REFERENCE_GENERATION_FAILED");
      return true;
    },
  );

  assert.equal(attempted.length, MAX_PAYMENT_REFERENCE_ATTEMPTS);
});
