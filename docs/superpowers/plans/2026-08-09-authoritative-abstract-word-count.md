# Authoritative Abstract Word Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Pris2026` display exactly the same abstract counts that `conference-api` uses for submit/resubmit validation, while measuring and optimizing compatibility with Microsoft Word without claiming exact Word parity.

**Architecture:** `conference-api` owns one canonical `Intl.Segmenter`-based utility and exposes an authenticated JSON count endpoint. Submit, resubmit, and the count endpoint call that utility. `Pris2026` removes authoritative browser-side tokenization, requests debounced server counts, and performs an immediate server refresh before passing count-dependent steps.

**Tech Stack:** Node.js 20, TypeScript 5, Fastify 5, Zod 3, Node test runner through `tsx`, Next.js 16, React 19, next-intl.

## Global Constraints

- Keep production counting on native `Intl.Segmenter`; add no tokenizer, Python, or Microsoft Word runtime dependency.
- Preserve the first-release segmentation policy exactly: locales `["th", "en"]`, granularity `"word"`, count only `isWordLike`, and normalize with `trim()` only.
- Backend count is authoritative; browser ICU output must never decide acceptance.
- Title maximum is 30 words; keyword maximum is 6 comma-separated items; every content section minimum is 10 words; total content maximum is 300 words.
- Total content is the sum of `background`, `objective`, `methods`, `results`, and `conclusion`; it excludes title, keywords, authors, affiliations, section labels, and PDF content.
- The word-count endpoint accepts incomplete form values, returns HTTP 200 for count-rule issues, and returns HTTP 400 only for malformed/oversized input.
- Do not log abstract text. Log only counts, policy name, Node version, ICU version, and resolved locale.
- Do not modify database tables.
- Do not change locale or Unicode normalization behavior until a Microsoft Word corpus shows an improvement.
- Preserve unrelated existing changes in `conference-api/src/modules/team-registrations/`.

---

## File Structure

### `conference-api`

- Create `src/utils/abstractWordCount.ts` — canonical policy, counting, validation, issue formatting, and runtime metadata.
- Create `src/utils/abstractWordCount.test.ts` — deterministic unit and boundary tests.
- Modify `src/schemas/abstracts.schema.ts` — JSON schema for live count requests.
- Create `src/routes/public/abstracts/word-count.ts` — authenticated authoritative count endpoint.
- Create `src/routes/public/abstracts/word-count.test.ts` — Fastify injection tests for the endpoint contract.
- Modify `src/routes/public/abstracts/submit.ts` — remove duplicated counting and call the canonical validator.
- Modify `src/routes/public/abstracts/user.ts` — remove duplicated counting and call the canonical validator for resubmission.
- Modify `src/index.ts` — register the new route.
- Create `src/utils/fixtures/abstract-word-count-word-corpus.json` — approved Word baseline cases.
- Create `src/scripts/benchmark-abstract-word-count.ts` — compatibility report for Word baseline cases.
- Modify `package.json` — add the benchmark command.

### `Pris2026`

- Create `src/lib/abstractWordCount.ts` — request/response types and fetch client; no tokenizer.
- Create `src/lib/abstractWordCount.test.ts` — API client contract tests.
- Create `src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts` — debounce, abort, stale-result protection, and forced refresh.
- Modify `src/app/[locale]/abstract-submission/page.tsx` — consume server counts, remove local tokenizer/truncation, and block navigation on unavailable/stale counts.
- Modify `messages/th.json` — count loading/error/policy copy and comma-separated keyword wording.
- Modify `messages/en.json` — matching English copy.
- Modify `package.json` and `package-lock.json` — add the TypeScript Node test runner used by the new client test.

---

### Task 1: Build the Canonical Backend Counting Utility

**Repository:** `conference-api`

**Files:**

- Create: `src/utils/abstractWordCount.test.ts`
- Create: `src/utils/abstractWordCount.ts`

**Interfaces:**

- Produces: `ABSTRACT_WORD_COUNT_POLICY`, `ABSTRACT_WORD_LIMITS`, `ABSTRACT_SECTION_NAMES`, `AbstractWordCountInput`, `AbstractWordCountResult`, `AbstractWordCountIssue`, `countWords`, `parseKeywords`, `validateAbstractWords`, `formatAbstractWordCountIssue`, and `getAbstractWordCountRuntimeInfo`.
- Consumes: built-in `Intl.Segmenter` only.

- [ ] **Step 1: Write failing utility tests**

Create `src/utils/abstractWordCount.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSTRACT_WORD_COUNT_POLICY,
  countWords,
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

test("runtime supports Thai Intl.Segmenter", () => {
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

test("counts English words and numbers as word-like segments", () => {
  assert.equal(countWords("alpha beta 25 95%"), 4);
});

test("locks the current Thai ICU segmentation behavior", () => {
  assert.equal(
    countWords("การวิจัยนี้ศึกษาผลของยาในผู้ป่วยโรคเบาหวาน"),
    13,
  );
});

test("counts mixed Thai and English text", () => {
  assert.ok(countWords("ผู้ป่วยได้รับยา metformin 500 mg วันละ 2 ครั้ง") > 1);
});

test("parses comma-separated keyword items", () => {
  assert.deepEqual(parseKeywords(" Pharmacy, Clinical, , Outcomes "), [
    "Pharmacy",
    "Clinical",
    "Outcomes",
  ]);
});

test("returns section counts and total as the sum of sections", () => {
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

test("returns issues in title, keywords, section, total order", () => {
  const input = validInput();
  input.title = words(31);
  input.keywords = "one,two,three,four,five,six,seven";
  input.sections.background = words(9);
  input.sections.objective = words(261);

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
  assert.equal(validateAbstractWords(atLimit).counts.total, 300);
  assert.equal(
    validateAbstractWords(atLimit).issues.some(
      (issue) => issue.code === "TOTAL_TOO_LONG",
    ),
    false,
  );

  const aboveLimit = validInput();
  aboveLimit.sections.background = words(261);
  assert.equal(validateAbstractWords(aboveLimit).counts.total, 301);
  assert.equal(
    validateAbstractWords(aboveLimit).issues.some(
      (issue) => issue.code === "TOTAL_TOO_LONG",
    ),
    true,
  );
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```powershell
npx.cmd tsx --test src/utils/abstractWordCount.test.ts
```

Expected: FAIL because `src/utils/abstractWordCount.ts` does not exist.

- [ ] **Step 3: Implement the canonical utility**

Create `src/utils/abstractWordCount.ts` with these exact public shapes and behavior:

```ts
export const ABSTRACT_WORD_COUNT_POLICY = "intl-segmenter-th-en-v1" as const;

export const ABSTRACT_WORD_LIMITS = {
  titleMax: 30,
  keywordMax: 6,
  sectionMin: 10,
  totalMax: 300,
} as const;

export const ABSTRACT_SECTION_NAMES = [
  "background",
  "objective",
  "methods",
  "results",
  "conclusion",
] as const;

export type AbstractSectionName = (typeof ABSTRACT_SECTION_NAMES)[number];
export type AbstractSections = Record<AbstractSectionName, string>;

export type AbstractWordCountInput = {
  title: string;
  keywords: string;
  sections: AbstractSections;
};

export type AbstractWordCountIssue = {
  code:
    | "TITLE_TOO_LONG"
    | "TOO_MANY_KEYWORDS"
    | "SECTION_TOO_SHORT"
    | "TOTAL_TOO_LONG";
  field: "title" | "keywords" | AbstractSectionName | "abstract";
  current: number;
  limit: number;
};

export type AbstractWordCountResult = {
  policy: typeof ABSTRACT_WORD_COUNT_POLICY;
  limits: typeof ABSTRACT_WORD_LIMITS;
  counts: {
    title: number;
    keywords: number;
    sections: Record<AbstractSectionName, number>;
    total: number;
  };
  issues: AbstractWordCountIssue[];
};

type WordSegment = {
  segment: string;
  isWordLike?: boolean;
};

type SegmenterInstance = {
  segment(input: string): Iterable<WordSegment>;
  resolvedOptions(): { locale: string };
};

type SegmenterConstructor = {
  new (
    locales?: string | string[],
    options?: { granularity: "word" },
  ): SegmenterInstance;
  supportedLocalesOf(locales: string[]): string[];
};

const Segmenter = (Intl as typeof Intl & {
  Segmenter?: SegmenterConstructor;
}).Segmenter;

if (!Segmenter) {
  throw new Error(
    "Intl.Segmenter is required for authoritative Thai abstract word counting",
  );
}

if (Segmenter.supportedLocalesOf(["th"]).length !== 1) {
  throw new Error(
    "Thai locale data is required for authoritative abstract word counting",
  );
}

const wordSegmenter = new Segmenter(["th", "en"], {
  granularity: "word",
});

export function countWords(text: string): number {
  const value = text.trim();
  if (!value) return 0;

  let count = 0;
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

export function parseKeywords(text: string): string[] {
  return text
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

export function validateAbstractWords(
  input: AbstractWordCountInput,
): AbstractWordCountResult {
  const sectionCounts = Object.fromEntries(
    ABSTRACT_SECTION_NAMES.map((name) => [name, countWords(input.sections[name])]),
  ) as Record<AbstractSectionName, number>;

  const counts = {
    title: countWords(input.title),
    keywords: parseKeywords(input.keywords).length,
    sections: sectionCounts,
    total: ABSTRACT_SECTION_NAMES.reduce(
      (sum, name) => sum + sectionCounts[name],
      0,
    ),
  };

  const issues: AbstractWordCountIssue[] = [];

  if (counts.title > ABSTRACT_WORD_LIMITS.titleMax) {
    issues.push({
      code: "TITLE_TOO_LONG",
      field: "title",
      current: counts.title,
      limit: ABSTRACT_WORD_LIMITS.titleMax,
    });
  }

  if (counts.keywords > ABSTRACT_WORD_LIMITS.keywordMax) {
    issues.push({
      code: "TOO_MANY_KEYWORDS",
      field: "keywords",
      current: counts.keywords,
      limit: ABSTRACT_WORD_LIMITS.keywordMax,
    });
  }

  for (const name of ABSTRACT_SECTION_NAMES) {
    if (sectionCounts[name] < ABSTRACT_WORD_LIMITS.sectionMin) {
      issues.push({
        code: "SECTION_TOO_SHORT",
        field: name,
        current: sectionCounts[name],
        limit: ABSTRACT_WORD_LIMITS.sectionMin,
      });
    }
  }

  if (counts.total > ABSTRACT_WORD_LIMITS.totalMax) {
    issues.push({
      code: "TOTAL_TOO_LONG",
      field: "abstract",
      current: counts.total,
      limit: ABSTRACT_WORD_LIMITS.totalMax,
    });
  }

  return {
    policy: ABSTRACT_WORD_COUNT_POLICY,
    limits: ABSTRACT_WORD_LIMITS,
    counts,
    issues,
  };
}

export function formatAbstractWordCountIssue(
  issue: AbstractWordCountIssue,
): string {
  switch (issue.code) {
    case "TITLE_TOO_LONG":
      return `Abstract title must not exceed ${issue.limit} words. Current: ${issue.current} words`;
    case "TOO_MANY_KEYWORDS":
      return `Keywords must not exceed ${issue.limit} comma-separated items. Current: ${issue.current}`;
    case "SECTION_TOO_SHORT":
      return `${issue.field} must be at least ${issue.limit} words. Current: ${issue.current} words`;
    case "TOTAL_TOO_LONG":
      return `Abstract word count must not exceed ${issue.limit} words. Current: ${issue.current} words`;
  }
}

export function getAbstractWordCountRuntimeInfo() {
  return {
    policy: ABSTRACT_WORD_COUNT_POLICY,
    node: process.version,
    icu: process.versions.icu ?? "unknown",
    resolvedLocale: wordSegmenter.resolvedOptions().locale,
    segmenterAvailable: true,
    thaiLocaleSupported:
      Segmenter.supportedLocalesOf(["th"]).length === 1,
  } as const;
}
```

Keep this local constructor type instead of weakening project-wide compiler settings.

- [ ] **Step 4: Run focused tests and build**

Run:

```powershell
npx.cmd tsx --test src/utils/abstractWordCount.test.ts
npm.cmd run build
```

Expected: all utility tests PASS and TypeScript build exits 0.

- [ ] **Step 5: Commit the backend utility**

```powershell
git add src/utils/abstractWordCount.ts src/utils/abstractWordCount.test.ts
git commit -m "feat(abstracts): centralize authoritative word counting"
```

---

### Task 2: Refactor Submit and Resubmit to Use the Utility

**Repository:** `conference-api`

**Files:**

- Modify: `src/routes/public/abstracts/submit.ts:38`
- Modify: `src/routes/public/abstracts/submit.ts:297`
- Modify: `src/routes/public/abstracts/user.ts:29`
- Modify: `src/routes/public/abstracts/user.ts:478`

**Interfaces:**

- Consumes: `validateAbstractWords`, `formatAbstractWordCountIssue`.
- Produces: identical structured count validation for submit and resubmit.

- [ ] **Step 1: Add a regression assertion that issue ordering preserves existing behavior**

Extend `src/utils/abstractWordCount.test.ts`:

```ts
test("formats the first issue for the existing API error field", () => {
  const input = validInput();
  input.title = words(31);
  const result = validateAbstractWords(input);
  assert.equal(
    formatAbstractWordCountIssue(result.issues[0]),
    "Abstract title must not exceed 30 words. Current: 31 words",
  );
});
```

Add `formatAbstractWordCountIssue` to the test import.

- [ ] **Step 2: Run the focused test**

```powershell
npx.cmd tsx --test src/utils/abstractWordCount.test.ts
```

Expected: PASS before route refactoring, proving the route-facing contract is ready.

- [ ] **Step 3: Replace local submit counting**

In `src/routes/public/abstracts/submit.ts`:

1. Import the canonical functions.
2. Delete `TITLE_WORD_LIMIT`, `KEYWORD_LIMIT`, `SECTION_MIN_WORDS`, `WordSegment`, `getWordSegments`, `countWords`, `parseKeywords`, `validateWordCount`, and `validateSectionWordMinimum`.
3. Replace lines that separately validate title, keywords, section minimums, and total with one call:

```ts
import {
  formatAbstractWordCountIssue,
  validateAbstractWords,
} from "../../../utils/abstractWordCount.js";

const abstractWordValidation = validateAbstractWords({
  title,
  keywords,
  sections: {
    background,
    objective,
    methods,
    results,
    conclusion,
  },
});

const firstWordIssue = abstractWordValidation.issues[0];
if (firstWordIssue) {
  return reply.status(400).send({
    success: false,
    code: firstWordIssue.code,
    error: formatAbstractWordCountIssue(firstWordIssue),
    details: abstractWordValidation,
  });
}
```

Place this block immediately after Zod parsing/destructuring and before checking uploaded files.

- [ ] **Step 4: Replace local resubmit counting**

Apply the same import/deletion/replacement in `src/routes/public/abstracts/user.ts`. Use the exact input mapping shown in Step 3 and keep it before replacement-file upload and database work.

- [ ] **Step 5: Prove no duplicate route counter remains**

Run:

```powershell
rg -n "function countWords|getWordSegments|validateWordCount|validateSectionWordMinimum" src/routes/public/abstracts
```

Expected: no matches in `submit.ts` or `user.ts`.

- [ ] **Step 6: Run backend verification**

```powershell
npm.cmd test
npm.cmd run build
```

Expected: all tests PASS and build exits 0.

- [ ] **Step 7: Commit route refactoring**

```powershell
git add src/routes/public/abstracts/submit.ts src/routes/public/abstracts/user.ts src/utils/abstractWordCount.test.ts
git commit -m "refactor(abstracts): share submit and resubmit word validation"
```

---

### Task 3: Add the Authoritative Count Endpoint

**Repository:** `conference-api`

**Files:**

- Modify: `src/schemas/abstracts.schema.ts`
- Create: `src/routes/public/abstracts/word-count.ts`
- Create: `src/routes/public/abstracts/word-count.test.ts`
- Modify: `src/index.ts:174`
- Modify: `src/index.ts:230`

**Interfaces:**

- Consumes: `abstractWordCountRequestSchema`, `validateAbstractWords`.
- Produces: authenticated `POST /api/abstracts/word-count`.

- [ ] **Step 1: Add the live-request schema**

Append to `src/schemas/abstracts.schema.ts`:

```ts
const liveTitleSchema = z.string().max(500, "Title too long").default("");
const liveKeywordsSchema = z.string().max(2000, "Keywords too long").default("");
const liveSectionSchema = z
  .string()
  .max(20000, "Abstract section too long")
  .default("");

export const abstractWordCountRequestSchema = z.object({
  title: liveTitleSchema,
  keywords: liveKeywordsSchema,
  background: liveSectionSchema,
  objective: liveSectionSchema,
  methods: liveSectionSchema,
  results: liveSectionSchema,
  conclusion: liveSectionSchema,
});
```

The defaults are required because the endpoint runs while fields are incomplete.

- [ ] **Step 2: Write failing route tests**

Create `src/routes/public/abstracts/word-count.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import wordCountRoutes from "./word-count.js";

const words = (count: number) =>
  Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");

async function buildApp() {
  const app = Fastify();
  app.decorate("authenticate", async () => undefined);
  await app.register(wordCountRoutes, { prefix: "/api/abstracts" });
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
  assert.equal(body.policy, "intl-segmenter-th-en-v1");
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
  assert.equal(atLimit.json().counts.total, 300);

  const aboveLimit = await app.inject({
    method: "POST",
    url: "/api/abstracts/word-count",
    payload: { ...base, background: words(261) },
  });
  assert.equal(aboveLimit.json().counts.total, 301);
  assert.equal(
    aboveLimit.json().issues.some(
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
    payload: { background: "ก".repeat(20001) },
  });
  await app.close();

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "INVALID_WORD_COUNT_INPUT");
});
```

- [ ] **Step 3: Run the route test and verify failure**

```powershell
npx.cmd tsx --test src/routes/public/abstracts/word-count.test.ts
```

Expected: FAIL because `word-count.ts` does not exist.

- [ ] **Step 4: Implement the route**

Create `src/routes/public/abstracts/word-count.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { abstractWordCountRequestSchema } from "../../../schemas/abstracts.schema.js";
import { validateAbstractWords } from "../../../utils/abstractWordCount.js";

export default async function wordCountRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/word-count",
    {
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 150,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsed = abstractWordCountRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          code: "INVALID_WORD_COUNT_INPUT",
          error: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }

      const {
        title,
        keywords,
        background,
        objective,
        methods,
        results,
        conclusion,
      } = parsed.data;

      const result = validateAbstractWords({
        title,
        keywords,
        sections: {
          background,
          objective,
          methods,
          results,
          conclusion,
        },
      });

      return reply.send({
        success: true,
        ...result,
      });
    },
  );
}
```

Do not log `request.body` or any individual text field.

- [ ] **Step 5: Register the route**

In `src/index.ts`, add:

```ts
import abstractWordCountRoutes from "./routes/public/abstracts/word-count.js";
```

Register beside the existing abstract routes:

```ts
fastify.register(abstractWordCountRoutes, { prefix: "/api/abstracts" });
```

- [ ] **Step 6: Run route and full backend verification**

```powershell
npx.cmd tsx --test src/routes/public/abstracts/word-count.test.ts
npm.cmd test
npm.cmd run build
```

Expected: focused route tests PASS, full test suite PASS, and build exits 0.

- [ ] **Step 7: Commit the endpoint**

```powershell
git add src/schemas/abstracts.schema.ts src/routes/public/abstracts/word-count.ts src/routes/public/abstracts/word-count.test.ts src/index.ts
git commit -m "feat(abstracts): expose authoritative word count endpoint"
```

---

### Task 4: Add Microsoft Word Compatibility Corpus and Report

**Repository:** `conference-api`

**Files:**

- Create: `src/utils/fixtures/abstract-word-count-word-corpus.json`
- Create: `src/scripts/benchmark-abstract-word-count.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: exact selected-body counts manually measured in Microsoft Word Desktop.
- Produces: exact-match rate, mean/max absolute error, and 300-word boundary disagreements.

- [ ] **Step 1: Create the corpus format with a verified smoke case**

Create `src/utils/fixtures/abstract-word-count-word-corpus.json`:

```json
{
  "baseline": {
    "application": "Microsoft Word Desktop",
    "countScope": "Selected abstract body only; title, keywords, authors, affiliations and section labels excluded",
    "proofingLanguage": "Thai",
    "normalization": "Exact Unicode copied from the API payload"
  },
  "cases": [
    {
      "id": "english-smoke-001",
      "category": "english",
      "sections": {
        "background": "alpha beta gamma",
        "objective": "",
        "methods": "",
        "results": "",
        "conclusion": ""
      },
      "wordCount": 3
    }
  ]
}
```

Before production rollout, expand this file to at least 50 approved cases including Thai-only, Thai/English mixed, medical terms, numbers, percentages, abbreviations, slash/hyphen punctuation, invisible Unicode, and Word totals from 295 through 305. Real abstracts must be anonymized and approved before commit.

- [ ] **Step 2: Create the benchmark script**

Create `src/scripts/benchmark-abstract-word-count.ts`. The script must:

1. Load the JSON corpus and validate that every case has exactly the five section strings and a non-negative integer `wordCount`.
2. Count each case using four variants: `["th", "en"]` trim-only, `"th"` trim-only, `["th", "en"]` NFC, and `"th"` NFC.
3. Print per-variant case count, exact matches, exact-match percentage, mean absolute error, maximum absolute error, false accepts, and false rejects.
4. Treat Word `<= 300` and engine `> 300` as a false reject.
5. Treat Word `> 300` and engine `<= 300` as a false accept.
6. Exit non-zero only for malformed corpus data, not for compatibility differences.

Use this counter inside the script so benchmark variants cannot alter production code, and sum the five section results for each case:

```ts
function countWith(
  text: string,
  locales: string | string[],
  normalization: "trim" | "nfc",
): number {
  const normalized =
    normalization === "nfc" ? text.normalize("NFC").trim() : text.trim();
  if (!normalized) return 0;

  const segmenter = new Intl.Segmenter(locales, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

function countCase(
  sections: Record<string, string>,
  locales: string | string[],
  normalization: "trim" | "nfc",
): number {
  return ["background", "objective", "methods", "results", "conclusion"]
    .reduce(
      (sum, field) => sum + countWith(sections[field], locales, normalization),
      0,
    );
}
```

- [ ] **Step 3: Add the package script**

Add to `conference-api/package.json`:

```json
"benchmark:abstract-word-count": "tsx src/scripts/benchmark-abstract-word-count.ts"
```

- [ ] **Step 4: Run the smoke corpus**

```powershell
npm.cmd run benchmark:abstract-word-count
```

Expected: all four variants report one exact match and zero absolute error for `english-smoke-001`.

- [ ] **Step 5: Capture runtime metadata beside benchmark output**

Run in the same Node/Docker runtime intended for production:

```powershell
node -e "console.log(JSON.stringify({node:process.version,icu:process.versions.icu,thai:Intl.Segmenter.supportedLocalesOf(['th'])}))"
```

Record the output in the PR description and the internal release record. Do not expose Node/ICU versions in the public count API.

- [ ] **Step 6: Commit benchmark tooling**

```powershell
git add src/utils/fixtures/abstract-word-count-word-corpus.json src/scripts/benchmark-abstract-word-count.ts package.json
git commit -m "test(abstracts): add Microsoft Word count benchmark"
```

Do not change the production locale or normalization policy in this commit.

---

### Task 5: Add a Typed Frontend Count API Client

**Repository:** `Pris2026`

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/abstractWordCount.ts`
- Create: `src/lib/abstractWordCount.test.ts`

**Interfaces:**

- Produces: `AbstractWordCountRequest`, `AbstractWordCountResponse`, `AbstractWordCountIssue`, and `fetchAbstractWordCount`.
- Consumes: `POST /api/abstracts/word-count`.

- [ ] **Step 1: Add the existing backend test runner to the frontend dev toolchain**

Run:

```powershell
npm.cmd install --save-dev tsx@^4.19.2
```

Add this script to `Pris2026/package.json`:

```json
"test": "tsx --test src/**/*.test.ts"
```

- [ ] **Step 2: Write failing API client tests**

Create `src/lib/abstractWordCount.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { fetchAbstractWordCount } from "./abstractWordCount.js";

const responseFixture = {
  success: true as const,
  policy: "intl-segmenter-th-en-v1",
  limits: { titleMax: 30, keywordMax: 6, sectionMin: 10, totalMax: 300 },
  counts: {
    title: 3,
    keywords: 2,
    sections: {
      background: 10,
      objective: 10,
      methods: 10,
      results: 10,
      conclusion: 10,
    },
    total: 50,
  },
  issues: [],
};

const input = {
  title: "Clinical pharmacy outcomes",
  keywords: "Pharmacy, Outcomes",
  background: "background",
  objective: "objective",
  methods: "methods",
  results: "results",
  conclusion: "conclusion",
};

test("posts the exact authenticated count request and returns server counts", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responseFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await fetchAbstractWordCount(
    "https://api.example.test",
    "jwt-token",
    input,
    undefined,
    fakeFetch,
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.example.test/api/abstracts/word-count",
  );
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(calls[0].init?.headers, {
    Authorization: "Bearer jwt-token",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), input);
  assert.deepEqual(result, responseFixture);
});

test("throws the server error message for a non-success response", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: "Invalid count payload",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );

  await assert.rejects(
    fetchAbstractWordCount(
      "https://api.example.test",
      "jwt-token",
      input,
      undefined,
      fakeFetch,
    ),
    /Invalid count payload/,
  );
});
```

- [ ] **Step 3: Run the test and verify failure**

```powershell
npx.cmd tsx --test src/lib/abstractWordCount.test.ts
```

Expected: FAIL because `src/lib/abstractWordCount.ts` does not exist.

- [ ] **Step 4: Implement the API client**

Create `src/lib/abstractWordCount.ts` with no call to `Intl.Segmenter` and these exports:

```ts
export const ABSTRACT_SECTION_NAMES = [
  "background",
  "objective",
  "methods",
  "results",
  "conclusion",
] as const;

export type AbstractSectionName = (typeof ABSTRACT_SECTION_NAMES)[number];

export type AbstractWordCountRequest = {
  title: string;
  keywords: string;
  background: string;
  objective: string;
  methods: string;
  results: string;
  conclusion: string;
};

export type AbstractWordCountIssue = {
  code:
    | "TITLE_TOO_LONG"
    | "TOO_MANY_KEYWORDS"
    | "SECTION_TOO_SHORT"
    | "TOTAL_TOO_LONG";
  field: "title" | "keywords" | AbstractSectionName | "abstract";
  current: number;
  limit: number;
};

export type AbstractWordCountResponse = {
  success: true;
  policy: string;
  limits: {
    titleMax: number;
    keywordMax: number;
    sectionMin: number;
    totalMax: number;
  };
  counts: {
    title: number;
    keywords: number;
    sections: Record<AbstractSectionName, number>;
    total: number;
  };
  issues: AbstractWordCountIssue[];
};

type FetchLike = typeof fetch;

export async function fetchAbstractWordCount(
  apiUrl: string,
  token: string,
  input: AbstractWordCountRequest,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<AbstractWordCountResponse> {
  const response = await fetchImpl(`${apiUrl}/api/abstracts/word-count`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });

  const body = await response.json();
  if (!response.ok || body.success !== true) {
    throw new Error(body.error || "Unable to calculate abstract word count");
  }
  return body as AbstractWordCountResponse;
}
```

- [ ] **Step 5: Run client tests and type checking**

```powershell
npx.cmd tsx --test src/lib/abstractWordCount.test.ts
npx.cmd tsc --noEmit
```

Expected: client tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the frontend client**

```powershell
git add package.json package-lock.json src/lib/abstractWordCount.ts src/lib/abstractWordCount.test.ts
git commit -m "feat(abstracts): add authoritative word count client"
```

---

### Task 6: Add the Debounced Authoritative Count Hook

**Repository:** `Pris2026`

**Files:**

- Create: `src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts`

**Interfaces:**

- Consumes: `fetchAbstractWordCount`, `AbstractWordCountRequest`.
- Produces: `{ status, result, error, isStale, refresh }`.

- [ ] **Step 1: Implement the hook as a focused client module**

Create `src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts`:

```ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAbstractWordCount,
  type AbstractWordCountRequest,
  type AbstractWordCountResponse,
} from "@/lib/abstractWordCount";

export const ABSTRACT_WORD_COUNT_DEBOUNCE_MS = 500;

export type AuthoritativeWordCountStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

type HookState = {
  status: AuthoritativeWordCountStatus;
  result: AbstractWordCountResponse | null;
  error: string | null;
  isStale: boolean;
};

type HookInput = {
  apiUrl: string;
  token: string | null;
  input: AbstractWordCountRequest;
  enabled: boolean;
};

export function useAuthoritativeWordCount({
  apiUrl,
  token,
  input,
  enabled,
}: HookInput) {
  const [state, setState] = useState<HookState>({
    status: "idle",
    result: null,
    error: null,
    isStale: true,
  });
  const signature = useMemo(() => JSON.stringify(input), [input]);
  const latestInputRef = useRef(input);
  const lastSuccessfulSignatureRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSequenceRef = useRef(0);
  latestInputRef.current = input;

  const execute = useCallback(
    async (nextInput: AbstractWordCountRequest) => {
      if (!token) throw new Error("Authentication is required for word counting");

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const sequence = ++requestSequenceRef.current;
      const nextSignature = JSON.stringify(nextInput);

      setState((previous) => ({
        ...previous,
        status: "loading",
        error: null,
        isStale: true,
      }));

      try {
        const result = await fetchAbstractWordCount(
          apiUrl,
          token,
          nextInput,
          controller.signal,
        );
        if (sequence === requestSequenceRef.current) {
          lastSuccessfulSignatureRef.current = nextSignature;
          setState({
            status: "ready",
            result,
            error: null,
            isStale: false,
          });
        }
        return result;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        if (sequence === requestSequenceRef.current) {
          setState((previous) => ({
            ...previous,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Unable to calculate abstract word count",
            isStale: true,
          }));
        }
        throw error;
      }
    },
    [apiUrl, token],
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    requestSequenceRef.current += 1;

    if (!enabled || !token) {
      setState((previous) => ({
        ...previous,
        status: "idle",
        isStale: true,
      }));
      return;
    }

    setState((previous) => ({
      ...previous,
      status: "loading",
      error: null,
      isStale:
        lastSuccessfulSignatureRef.current !== signature,
    }));

    timerRef.current = setTimeout(() => {
      void execute(latestInputRef.current).catch(() => undefined);
    }, ABSTRACT_WORD_COUNT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, execute, signature, token]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
      requestSequenceRef.current += 1;
    },
    [],
  );

  const refresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    return execute(latestInputRef.current);
  }, [execute]);

  return {
    ...state,
    refresh,
  };
}
```

- [ ] **Step 2: Type-check the hook**

```powershell
npx.cmd tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit the hook**

```powershell
git add "src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts"
git commit -m "feat(abstracts): debounce authoritative count requests"
```

---

### Task 7: Replace Browser Counting in the Submission Page

**Repository:** `Pris2026`

**Files:**

- Modify: `src/app/[locale]/abstract-submission/page.tsx:35`
- Modify: `src/app/[locale]/abstract-submission/page.tsx:100`
- Modify: `src/app/[locale]/abstract-submission/page.tsx:370`
- Modify: `src/app/[locale]/abstract-submission/page.tsx:641`
- Modify: `src/app/[locale]/abstract-submission/page.tsx:848`
- Modify: `src/app/[locale]/abstract-submission/page.tsx:989`

**Interfaces:**

- Consumes: `useAuthoritativeWordCount` and server response types.
- Produces: server-backed title, section, and total count UI plus authoritative Step 3/4 navigation.

- [ ] **Step 1: Remove browser-authoritative helpers**

Delete from `page.tsx`:

- `WordSegment` type used only for word counting;
- `getWordSegments`;
- `countWords`;
- `limitWords`;
- `parseKeywords`;
- `limitCommaSeparatedKeywords`;
- local title/keyword/section/total constants once response limits replace them.

Do not truncate title or keywords while typing. The server count decides whether the user can advance, and the raw text remains available for correction.

- [ ] **Step 2: Build one request object and call the hook**

After `formData` state is declared, add a memoized request:

```ts
const wordCountInput = useMemo(
  () => ({
    title: formData.abstract.title,
    keywords: formData.abstract.keywords,
    background: formData.content.background,
    objective: formData.content.objective,
    methods: formData.content.methods,
    results: formData.content.results,
    conclusion: formData.content.conclusion,
  }),
  [formData.abstract.title, formData.abstract.keywords, formData.content],
);

const authoritativeCount = useAuthoritativeWordCount({
  apiUrl: API_URL,
  token,
  input: wordCountInput,
  enabled: isAuthenticated && Boolean(token),
});
```

Import `useMemo` if it is not already imported and import the hook from `./useAuthoritativeWordCount`.

- [ ] **Step 3: Make Step 3 and Step 4 navigation await a fresh server result**

Change `handleNext` to `async`. At the start of count-dependent validation:

```ts
let freshWordCount = authoritativeCount.result;
if (currentStep === 3 || currentStep === 4) {
  try {
    freshWordCount = await authoritativeCount.refresh();
  } catch {
    toast.error(ts("wordCountUnavailable"));
    return;
  }
}
```

For Step 3:

- use `freshWordCount.counts.title` for the 30-word check;
- use `freshWordCount.counts.keywords` for the keyword-item check;
- use `freshWordCount.limits` rather than local numeric constants.

For Step 4:

- use `freshWordCount.counts.sections[field]` for every minimum check;
- use `freshWordCount.counts.total` for the maximum check;
- delete the joined-text local count.

Do not advance when `freshWordCount` is absent.

- [ ] **Step 4: Stop truncating title and keywords in the browser**

In `Step3Details.handleChange`, assign the raw `value` for title and keywords. Preserve the existing 500-character title limit through input validation. This prevents the browser from deleting text based on a count or delimiter interpretation that may differ from the server.

- [ ] **Step 5: Pass authoritative counts to child steps**

Add these props to `Step3Details`:

```ts
titleWordCount: number | null;
titleWordLimit: number;
keywordCount: number | null;
keywordLimit: number;
wordCountLoading: boolean;
```

Add these props to `Step4Content`:

```ts
sectionWordCounts: Record<AbstractSectionName, number> | null;
totalWords: number | null;
totalWordLimit: number;
wordCountLoading: boolean;
wordCountStale: boolean;
```

Pass values from `authoritativeCount.result`. While no result exists, render an em dash instead of zero. While loading/stale, show the localized checking label and retain the previous numeric value with subdued styling.

- [ ] **Step 6: Replace Step 3 count usage**

Replace all `countWords(data.title)` calls with the `titleWordCount` prop and all `parseKeywords(data.keywords)` calls with the `keywordCount` prop. Use `titleWordLimit` and `keywordLimit` from the response. The input error state should apply only when `showErrors` is true and a fresh server count exceeds its limit. Do not mark a field invalid solely because a stale count is over the limit.

- [ ] **Step 7: Replace Step 4 count usage**

Delete the locally constructed `sectionWordCounts` and `totalWords`. Use props for:

- per-section labels;
- total badge;
- progress percentage;
- amber threshold at 250;
- red threshold above the server-provided total limit.

Calculate progress only when `totalWords !== null`; otherwise use zero width and show the checking state.

- [ ] **Step 8: Disable count-dependent navigation during forced refresh**

Add a dedicated `isCountingForNavigation` state around `refresh()`. Disable the Next button when `isSubmitting || isCountingForNavigation`, and show the localized checking label while counting. Do not reuse `isSubmitting`, because submission and count requests have different user messages.

- [ ] **Step 9: Verify local tokenizer removal**

```powershell
rg -n "Intl\.Segmenter|getWordSegments|function countWords|limitWords|parseKeywords|limitCommaSeparatedKeywords" "src/app/[locale]/abstract-submission/page.tsx"
```

Expected: no matches.

- [ ] **Step 10: Run frontend verification**

```powershell
npm.cmd test
npx.cmd tsc --noEmit
npx.cmd eslint "src/app/[locale]/abstract-submission/page.tsx" "src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts" src/lib/abstractWordCount.ts src/lib/abstractWordCount.test.ts
npm.cmd run build
```

Expected: tests PASS, type checking exits 0, touched-file ESLint exits 0, and production build succeeds with required environment variables supplied.

- [ ] **Step 11: Commit page integration**

```powershell
git add "src/app/[locale]/abstract-submission/page.tsx" "src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts"
git commit -m "fix(abstracts): display backend-authoritative word counts"
```

---

### Task 8: Add Localized Count Status and Policy Copy

**Repository:** `Pris2026`

**Files:**

- Modify: `messages/th.json:320`
- Modify: `messages/th.json:372`
- Modify: `messages/th.json:877`
- Modify: `messages/en.json:320`
- Modify: `messages/en.json:372`
- Modify: `messages/en.json:877`

**Interfaces:**

- Produces: localized loading, unavailable, stale, and system-policy wording.

- [ ] **Step 1: Add Thai strings under `abstractSubmission.ui`**

```json
"wordCountChecking": "กำลังตรวจจำนวนคำตามระบบ...",
"wordCountStale": "กำลังอัปเดตจำนวนคำ...",
"wordCountPolicyNote": "ระบบใช้จำนวนคำที่แสดงบนหน้านี้ในการตรวจสอบ จำนวนใน Microsoft Word อาจแตกต่างเล็กน้อย"
```

Add under `abstractSubmissionToasts`:

```json
"wordCountUnavailable": "ไม่สามารถตรวจจำนวนคำกับระบบได้ กรุณาลองอีกครั้ง"
```

- [ ] **Step 2: Add matching English strings**

```json
"wordCountChecking": "Checking the system word count...",
"wordCountStale": "Updating the word count...",
"wordCountPolicyNote": "The count shown by this submission system is used for validation. Microsoft Word may differ slightly."
```

Add under `abstractSubmissionToasts`:

```json
"wordCountUnavailable": "The system word count is unavailable. Please try again."
```

- [ ] **Step 3: Correct the existing keyword delimiter copy**

Change the Step 3 keyword label and placeholder in both languages from semicolon examples to comma examples because frontend and backend parse commas:

```text
คำสำคัญ (คั่นด้วยเครื่องหมายจุลภาค ,)
Key Terminologies (comma separated)
```

- [ ] **Step 4: Render the policy note in Step 4**

Place `wordCountPolicyNote` immediately below the total badge/progress area so users see the counting policy before attaching files or advancing.

- [ ] **Step 5: Validate translation JSON and frontend build**

```powershell
node -e "JSON.parse(require('fs').readFileSync('messages/th.json','utf8')); JSON.parse(require('fs').readFileSync('messages/en.json','utf8')); console.log('translations valid')"
npx.cmd tsc --noEmit
npm.cmd run build
```

Expected: prints `translations valid`, type checking exits 0, and build succeeds.

- [ ] **Step 6: Commit copy changes**

```powershell
git add messages/th.json messages/en.json "src/app/[locale]/abstract-submission/page.tsx"
git commit -m "fix(abstracts): clarify authoritative word count policy"
```

---

### Task 9: Cross-Repository Integration and Boundary Verification

**Repositories:** `conference-api`, `Pris2026`

**Files:**

- No production file is added in this task.
- Add discovered regression cases to `conference-api/src/utils/abstractWordCount.test.ts` and the approved Word corpus before closing the task.

**Interfaces:**

- Verifies the complete browser → count endpoint → submit/resubmit contract.

- [ ] **Step 1: Start the API in the production Node family**

From `conference-api`:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Expected: API starts on its configured port and logs startup without an `Intl.Segmenter`/Thai-locale error.

- [ ] **Step 2: Start the frontend against the API**

From `Pris2026`, configure `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_EVENT_CODE`, then run:

```powershell
npm.cmd run dev
```

Expected: authenticated abstract submission loads and the count endpoint returns HTTP 200 after text changes.

- [ ] **Step 3: Verify exact UI/API agreement**

For each of the following inputs, capture the `POST /api/abstracts/word-count` response and assert the UI displays the same title, section, and total values:

1. Thai-only text without spaces.
2. English-only text.
3. Mixed Thai/English medical text.
4. Numbers, decimals, percentages, and units.
5. Hyphens, slashes, parentheses, email, and URL.
6. Multiple spaces and newlines.
7. Non-breaking space and zero-width characters.
8. Exactly 299, 300, and 301 total words.

Expected: UI and endpoint values are identical in every browser because the UI renders the endpoint response.

- [ ] **Step 4: Verify navigation behavior**

- Step 3 blocks a 31-word title using the refreshed server count.
- Step 4 blocks any section under 10 words.
- Step 4 accepts 300 total words.
- Step 4 blocks 301 total words.
- Network failure blocks Step 3/4 navigation and displays `wordCountUnavailable`.
- Restored network allows Retry/Next to refresh and continue.
- Rapid typing never lets an older response overwrite the newest count.

- [ ] **Step 5: Verify submit/resubmit agreement**

Submit and resubmit the same valid payload used by the count endpoint. Confirm neither route rejects the payload for a different word count. Send a 301-word payload and confirm both routes return:

```json
{
  "success": false,
  "code": "TOTAL_TOO_LONG"
}
```

with `details.counts.total` equal to the preview endpoint total.

- [ ] **Step 6: Verify production Docker ICU support**

From `conference-api`:

```powershell
docker build -t conference-api-word-count-check .
docker run --rm conference-api-word-count-check node -e "console.log(JSON.stringify({node:process.version,icu:process.versions.icu,thai:Intl.Segmenter.supportedLocalesOf(['th']),locale:new Intl.Segmenter(['th','en'],{granularity:'word'}).resolvedOptions().locale}))"
```

Expected: `thai` contains `th` and `locale` is `th`.

- [ ] **Step 7: Run the Word compatibility benchmark**

```powershell
npm.cmd run benchmark:abstract-word-count
```

Review exact-match rate and every false accept/reject from 295–305. Choose a different locale/normalization only in a separate reviewed change with before/after metrics.

- [ ] **Step 8: Run final automated verification**

From `conference-api`:

```powershell
npm.cmd test
npm.cmd run build
```

From `Pris2026`:

```powershell
npm.cmd test
npx.cmd tsc --noEmit
npx.cmd eslint "src/app/[locale]/abstract-submission/page.tsx" "src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts" src/lib/abstractWordCount.ts src/lib/abstractWordCount.test.ts
npm.cmd run build
```

Expected: every command exits 0. Existing unrelated repository-wide lint failures are not part of this change, but touched-file ESLint must be clean.

- [ ] **Step 9: Record release evidence**

The PR/release record must include:

- backend test/build results;
- frontend test/type-check/touched-file lint/build results;
- Docker Node, ICU, and resolved locale values;
- Word corpus size and metric summary;
- screenshots or network evidence showing UI total equals endpoint total at 300 and 301;
- explicit statement that the system count is authoritative and exact Microsoft Word parity is not guaranteed.

---

## Deployment Order

1. Deploy `conference-api` utility, route refactor, and `/word-count` endpoint first.
2. Smoke-test the endpoint with the production JWT/CORS configuration.
3. Deploy `Pris2026` after the endpoint is confirmed available.
4. Keep the old submit/resubmit API fields and error string so no older frontend breaks.
5. Monitor count-endpoint latency, rate-limit responses, and `TITLE_TOO_LONG`/`SECTION_TOO_SHORT`/`TOTAL_TOO_LONG` rates.
6. Roll back the frontend independently if preview requests cause operational issues; backend centralization remains safe.

## Definition of Done

- `submit.ts` and `user.ts` contain no local tokenizer or word-count business constants.
- The count endpoint, submit, and resubmit use `validateAbstractWords`.
- `Pris2026` contains no authoritative `Intl.Segmenter` for abstract counting.
- The page displays server counts and blocks stale/unavailable count-dependent navigation.
- UI/API/submit/resubmit agree for all integration fixtures and 299/300/301 boundaries.
- Thai ICU support is verified inside the production Docker image.
- At least 50 approved Microsoft Word cases are benchmarked before changing counting policy.
- No database migration and no production tokenizer dependency are introduced.
- Thai and English UI copy states the system-count policy and uses comma-separated keyword wording consistently.
