import assert from "node:assert/strict";
import test from "node:test";
import * as abstractWordCountModule from "./abstractWordCount.js";
import {
  ABSTRACT_WORD_COUNT_POLICY,
  combineWordCounts,
  countWords,
  formatAbstractWordCountIssue,
  getAbstractWordCountRuntimeInfo,
  parseKeywords,
  validateAbstractWords,
  warmAbstractWordCountWorker,
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

const validateWithIntlParity = (input: ReturnType<typeof validInput>) =>
  validateAbstractWords(input, async (texts) => texts.map(countWords));

test("identifies the production counter as the 50/50 ensemble policy", () => {
  assert.equal(
    ABSTRACT_WORD_COUNT_POLICY,
    "ensemble-intl-pythainlp-50-50-v1",
  );
});

test("provides a production ensemble combiner", () => {
  assert.equal(
    "combineWordCounts" in abstractWordCountModule,
    true,
    "combineWordCounts must be exported",
  );
});

test("averages Intl and PyThaiNLP counts and rounds each section", () => {
  assert.equal(combineWordCounts(10, 9), 10);
  assert.equal(combineWordCounts(12, 10), 11);
  assert.equal(combineWordCounts(130, 106), 118);
});

test("uses one PyThaiNLP batch and sums rounded 50/50 section counts", async () => {
  const input = validInput();
  input.title = words(2);
  input.sections = {
    background: words(12),
    objective: words(10),
    methods: words(130),
    results: words(129),
    conclusion: words(19),
  };

  const result = await validateAbstractWords(
    input,
    async (texts) => {
      assert.equal(texts.length, 6);
      return [2, 10, 9, 106, 102, 16];
    },
  );

  assert.deepEqual(result.counts.sections, {
    background: 11,
    objective: 10,
    methods: 118,
    results: 116,
    conclusion: 18,
  });
  assert.equal(result.counts.total, 273);
});

test("warms the tokenizer with representative non-empty Thai text", async () => {
  let receivedTexts: string[] = [];
  const warmWithProvider = warmAbstractWordCountWorker as unknown as (
    provider: (texts: string[]) => Promise<number[]>,
  ) => Promise<void>;

  await warmWithProvider(async (texts) => {
    receivedTexts = texts;
    return [1];
  });

  assert.equal(receivedTexts.length, 1);
  assert.match(receivedTexts[0], /[ก-๙]/);
  assert.notEqual(receivedTexts[0].trim(), "");
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

test("returns per-section counts and their sum as the total", async () => {
  const result = await validateWithIntlParity(validInput());

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

test("returns issues in title, keywords, section, and total order", async () => {
  const input = validInput();
  input.title = words(31);
  input.keywords = "one,two,three,four,five,six,seven";
  input.sections.background = words(9);
  input.sections.objective = words(262);

  const result = await validateWithIntlParity(input);

  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "TITLE_TOO_LONG",
    "TOO_MANY_KEYWORDS",
    "SECTION_TOO_SHORT",
    "TOTAL_TOO_LONG",
  ]);
});

test("accepts 300 total words and rejects 301", async () => {
  const atLimit = validInput();
  atLimit.sections.background = words(260);
  const atLimitResult = await validateWithIntlParity(atLimit);

  assert.equal(atLimitResult.counts.total, 300);
  assert.equal(
    atLimitResult.issues.some((issue) => issue.code === "TOTAL_TOO_LONG"),
    false,
  );

  const aboveLimit = validInput();
  aboveLimit.sections.background = words(261);
  const aboveLimitResult = await validateWithIntlParity(aboveLimit);

  assert.equal(aboveLimitResult.counts.total, 301);
  assert.equal(
    aboveLimitResult.issues.some((issue) => issue.code === "TOTAL_TOO_LONG"),
    true,
  );
});

test("formats the first issue for the existing API error field", async () => {
  const input = validInput();
  input.title = words(31);
  const result = await validateWithIntlParity(input);

  assert.equal(
    formatAbstractWordCountIssue(result.issues[0]),
    "Abstract title must not exceed 30 words. Current: 31 words",
  );
});
