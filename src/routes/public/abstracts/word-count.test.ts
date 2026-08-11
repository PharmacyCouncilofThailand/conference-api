import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import wordCountRoutes from "./word-count.js";
import {
  countWords,
  validateAbstractWords,
} from "../../../utils/abstractWordCount.js";

const words = (count: number) =>
  Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");

async function buildApp() {
  const app = Fastify();
  app.decorate("authenticate", async () => undefined);
  await app.register(wordCountRoutes, {
    prefix: "/api/abstracts",
    validateWords: (input) =>
      validateAbstractWords(input, async (texts) => texts.map(countWords)),
  });
  return app;
}

test("returns authoritative counts for incomplete input", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/abstracts/word-count",
    payload: { title: "การวิจัยทางเภสัชกรรม" },
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.success, true);
  assert.equal(body.policy, "ensemble-intl-pythainlp-50-50-v2");
  assert.equal(typeof body.counts.title, "number");
  assert.equal(body.counts.total, 0);
});

test("returns 300 and 301 boundary results", async () => {
  const app = await buildApp();
  const base = {
    title: "Clinical pharmacy",
    keywords: "one,two",
    objective: words(10),
    methods: words(10),
    results: words(10),
    conclusion: words(10),
  };

  const atLimit = await app.inject({
    method: "POST",
    url: "/api/abstracts/word-count",
    payload: { ...base, background: words(260) },
  });
  assert.equal(atLimit.statusCode, 200);
  assert.equal(atLimit.json().counts.total, 300);

  const aboveLimit = await app.inject({
    method: "POST",
    url: "/api/abstracts/word-count",
    payload: { ...base, background: words(261) },
  });
  const aboveLimitBody = aboveLimit.json();
  assert.equal(aboveLimit.statusCode, 200);
  assert.equal(aboveLimitBody.counts.total, 301);
  assert.equal(
    aboveLimitBody.issues.some(
      (issue: { code: string }) => issue.code === "TOTAL_TOO_LONG",
    ),
    true,
  );
  await app.close();
});

test("rejects oversized live-count input", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/abstracts/word-count",
    payload: { background: "ก".repeat(20_001) },
  });
  await app.close();

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "INVALID_WORD_COUNT_INPUT");
});
