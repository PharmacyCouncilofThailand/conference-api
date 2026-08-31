import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAbstractSubmissionWindow } from "./submission-window.js";

const startDate = new Date("2026-07-01T03:00:00.000Z");
const endDate = new Date("2026-09-20T16:59:59.999Z");

test("closes before configured abstract start", () => {
  assert.deepEqual(
    evaluateAbstractSubmissionWindow({
      startDate,
      endDate,
      now: new Date(startDate.getTime() - 1),
    }),
    { open: false, code: "ABSTRACT_NOT_OPEN" },
  );
});

test("opens at exact start boundary", () => {
  assert.deepEqual(
    evaluateAbstractSubmissionWindow({ startDate, endDate, now: startDate }),
    { open: true },
  );
});

test("stays open across Round 1 to Round 2 transition", () => {
  assert.deepEqual(
    evaluateAbstractSubmissionWindow({
      startDate,
      endDate,
      now: new Date("2026-08-31T17:00:00.000Z"),
    }),
    { open: true },
  );
});

test("keeps final configured millisecond open", () => {
  assert.deepEqual(
    evaluateAbstractSubmissionWindow({ startDate, endDate, now: endDate }),
    { open: true },
  );
});

test("closes immediately after configured end", () => {
  assert.deepEqual(
    evaluateAbstractSubmissionWindow({
      startDate,
      endDate,
      now: new Date(endDate.getTime() + 1),
    }),
    { open: false, code: "ABSTRACT_SUBMISSION_CLOSED" },
  );
});

test("legacy event without dates remains unrestricted", () => {
  assert.deepEqual(
    evaluateAbstractSubmissionWindow({
      startDate: null,
      endDate: null,
      now: new Date("2030-01-01T00:00:00.000Z"),
    }),
    { open: true },
  );
});
