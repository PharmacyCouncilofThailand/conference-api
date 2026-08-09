import assert from "node:assert/strict";
import test from "node:test";
import {
  countCase,
  countWith,
  summarizeCompatibility,
} from "./benchmark-abstract-word-count.js";

test("counts a corpus case as the sum of five sections", () => {
  const total = countCase(
    {
      background: "alpha beta",
      objective: "gamma",
      methods: "delta",
      results: "epsilon",
      conclusion: "",
    },
    ["th", "en"],
    "trim",
  );

  assert.equal(total, 5);
});

test("supports trim-only and NFC benchmark variants", () => {
  assert.equal(countWith(" alpha beta ", ["th", "en"], "trim"), 2);
  assert.equal(countWith(" alpha beta ", "th", "nfc"), 2);
});

test("reports exact matches, absolute error, and boundary disagreements", () => {
  const summary = summarizeCompatibility([
    { expected: 300, actual: 300 },
    { expected: 300, actual: 301 },
    { expected: 301, actual: 300 },
    { expected: 100, actual: 102 },
  ]);

  assert.deepEqual(summary, {
    cases: 4,
    exactMatches: 1,
    exactMatchPercent: 25,
    meanAbsoluteError: 1,
    maximumAbsoluteError: 2,
    falseAccepts: 1,
    falseRejects: 1,
  });
});
