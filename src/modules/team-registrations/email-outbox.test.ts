import assert from "node:assert/strict";
import test from "node:test";
import { processSequentiallyWithDelay } from "./email-outbox.js";

test("waits 700ms between each team confirmation email send", async () => {
  const sent: string[] = [];
  const sleepCalls: number[] = [];
  let secondStarted = false;
  let releaseDelay!: () => void;
  const delayGate = new Promise<void>((resolve) => {
    releaseDelay = resolve;
  });

  const processing = processSequentiallyWithDelay(
    ["first", "second"],
    async (recipient) => {
      sent.push(recipient);
      if (recipient === "second") secondStarted = true;
    },
    undefined,
    async (delayMs) => {
      sleepCalls.push(delayMs);
      await delayGate;
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(sleepCalls, [700]);
  assert.equal(secondStarted, false);

  releaseDelay();
  await processing;

  assert.deepEqual(sent, ["first", "second"]);
  assert.equal(secondStarted, true);
});

test("does not wait after the last team confirmation email", async () => {
  const sleepCalls: number[] = [];

  await processSequentiallyWithDelay(
    ["only"],
    async () => {},
    undefined,
    async (delayMs) => {
      sleepCalls.push(delayMs);
    },
  );

  assert.deepEqual(sleepCalls, []);
});
