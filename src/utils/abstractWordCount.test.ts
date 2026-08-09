import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSTRACT_WORD_COUNT_POLICY,
  countWords,
  formatAbstractWordCountIssue,
  getAbstractWordCountRuntimeInfo,
  parseKeywords,
  validateAbstractWords,
} from "./abstractWordCount.js";

const words = (count: number) =>
  Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");

const validInput = () => ({
  title: "Clinical pharmacy outcomes",
  keywords: "Pharmacy, Clinical, Outcomes",
  sections: {
    background: words(10),
    objective: words(10),
    methods: words(10),
    results: words(10),
    conclusion: words(10),
  },
});

test("reports a Thai-capable authoritative runtime", () => {
  const runtime = getAbstractWordCountRuntimeInfo();

  assert.equal(runtime.segmenterAvailable, true);
  assert.equal(runtime.thaiLocaleSupported, true);
  assert.equal(runtime.policy, ABSTRACT_WORD_COUNT_POLICY);
  assert.equal(runtime.resolvedLocale, "th");
});

test("counts empty and whitespace-only input as zero", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  \n\t  "), 0);
});

test("counts English words, numbers, and percentages as word-like segments", () => {
  assert.equal(countWords("alpha beta 25 95%"), 4);
});

test("locks the current Thai ICU segmentation behavior", () => {
  assert.equal(
    countWords("การวิจัยนี้ศึกษาผลของยาในผู้ป่วยโรคเบาหวาน"),
    13,
  );
});

test("counts mixed Thai and English text as more than one word", () => {
  assert.ok(countWords("ผู้ป่วยได้รับยา metformin 500 mg วันละ 2 ครั้ง") > 1);
});

test("parses non-empty comma-separated keyword items", () => {
  assert.deepEqual(parseKeywords(" Pharmacy, Clinical, , Outcomes "), [
    "Pharmacy",
    "Clinical",
    "Outcomes",
  ]);
});

test("returns per-section counts and their sum as the total", () => {
  const result = validateAbstractWords(validInput());

  assert.deepEqual(result.counts.sections, {
    background: 10,
    objective: 10,
    methods: 10,
    results: 10,
    conclusion: 10,
  });
  assert.equal(result.counts.total, 50);
  assert.deepEqual(result.issues, []);
});

test("returns issues in title, keywords, section, and total order", () => {
  const input = validInput();
  input.title = words(31);
  input.keywords = "one,two,three,four,five,six,seven";
  input.sections.background = words(9);
  input.sections.objective = words(262);

  const result = validateAbstractWords(input);

  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "TITLE_TOO_LONG",
    "TOO_MANY_KEYWORDS",
    "SECTION_TOO_SHORT",
    "TOTAL_TOO_LONG",
  ]);
});

test("accepts 300 total words and rejects 301", () => {
  const atLimit = validInput();
  atLimit.sections.background = words(260);
  const atLimitResult = validateAbstractWords(atLimit);

  assert.equal(atLimitResult.counts.total, 300);
  assert.equal(
    atLimitResult.issues.some((issue) => issue.code === "TOTAL_TOO_LONG"),
    false,
  );

  const aboveLimit = validInput();
  aboveLimit.sections.background = words(261);
  const aboveLimitResult = validateAbstractWords(aboveLimit);

  assert.equal(aboveLimitResult.counts.total, 301);
  assert.equal(
    aboveLimitResult.issues.some((issue) => issue.code === "TOTAL_TOO_LONG"),
    true,
  );
});

test("formats the first issue for the existing API error field", () => {
  const input = validInput();
  input.title = words(31);
  const result = validateAbstractWords(input);

  assert.equal(
    formatAbstractWordCountIssue(result.issues[0]),
    "Abstract title must not exceed 30 words. Current: 31 words",
  );
});
