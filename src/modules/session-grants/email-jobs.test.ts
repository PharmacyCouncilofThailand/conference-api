import assert from "node:assert/strict";
import test from "node:test";
import { classifyGrantMailFailure } from "./email-jobs.js";

test("grant mail transport failure classification preserves definitive failure vs ambiguity", () => {
  const rejected = Object.assign(new Error("provider rejected"), {
    code: "NIPAMAIL_HTTP_400",
    deliveryState: "failed" as const,
  });
  assert.deepEqual(classifyGrantMailFailure(rejected), {
    state: "failed",
    code: "NIPAMAIL_HTTP_400",
    message: "provider rejected",
  });

  const timeout = Object.assign(new Error("timeout after dispatch"), {
    code: "NIPAMAIL_TIMEOUT",
    deliveryState: "unknown" as const,
  });
  assert.deepEqual(classifyGrantMailFailure(timeout), {
    state: "unknown",
    code: "NIPAMAIL_TIMEOUT",
    message: "timeout after dispatch",
  });

  const untyped = new Error("socket disappeared");
  assert.deepEqual(classifyGrantMailFailure(untyped), {
    state: "unknown",
    code: "MAIL_TRANSPORT_UNKNOWN",
    message: "socket disappeared",
  });
});

test("grant mail failure metadata is bounded before persistence", () => {
  const long = Object.assign(new Error("x".repeat(800)), {
    code: "C".repeat(200),
    deliveryState: "failed" as const,
  });
  const result = classifyGrantMailFailure(long);
  assert.equal(result.code.length, 100);
  assert.equal(result.message.length, 500);
});
