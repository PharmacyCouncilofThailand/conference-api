# Authoritative Abstract Word Count Design

**Date:** 2026-08-09  
**Repositories:** `conference-api`, `Pris2026`  
**Status:** Approved through the preceding design discussion

## Problem

The abstract submission flow currently counts words independently in three places:

- `conference-api/src/routes/public/abstracts/submit.ts`
- `conference-api/src/routes/public/abstracts/user.ts`
- `Pris2026/src/app/[locale]/abstract-submission/page.tsx`

All three implementations use `Intl.Segmenter(["th", "en"], { granularity: "word" })`, but they execute in different runtimes. The API runs with the ICU bundled in Node.js, while the frontend runs with the browser's ICU implementation. The current whitespace fallback is unsafe for Thai text, and the frontend total is calculated by summing section counts while the backend counts a joined string. These differences can make the displayed count disagree with the count used for submission validation.

Microsoft Word uses its own word-boundary implementation. Therefore, matching frontend and backend can be guaranteed by using one server-side engine, while matching Microsoft Word can only be measured and optimized through a controlled compatibility corpus. This design does not claim 100% Microsoft Word parity.

## Goals

1. Make the count displayed by `Pris2026` equal the count used by `conference-api` for the same payload.
2. Use one backend utility for preview, submit, and resubmit.
3. Keep the current business limits: title maximum 30 words, keywords maximum 6 comma-separated items, each content section minimum 10 words, and total content maximum 300 words.
4. Continue using native `Intl.Segmenter`; add no production tokenizer dependency.
5. Remove the whitespace-only fallback from the backend.
6. Measure compatibility with Microsoft Word using exact text fixtures and recorded Word/runtime metadata.
7. Keep the change limited to abstract counting and its user-facing validation.

## Non-goals

- Parsing or counting text from uploaded PDF files.
- Guaranteeing 100% parity with Microsoft Word.
- Adding Python, PyThaiNLP, Microsoft Word COM automation, or a Windows service.
- Changing database tables or persisting word counts.
- Making event-specific word limits configurable.
- Refactoring unrelated abstract submission code.

## Chosen Architecture

The backend is the sole authoritative counting engine.

```text
Pris2026 page
    |
    | authenticated POST, debounced while typing
    v
POST /api/abstracts/word-count
    |
    v
conference-api/src/utils/abstractWordCount.ts
    ^                    ^
    |                    |
POST /submit       PATCH /user/:id/resubmit
```

The frontend may temporarily retain a local value only as a non-authoritative loading placeholder during migration. The completed implementation displays server counts and blocks count-dependent navigation when no fresh server result is available.

## Canonical Counting Contract

The countable fields are:

```text
title
keywords (item count, not word count)
background
objective
methods
results
conclusion
```

The 300-word total is the sum of the five independently counted content sections. It excludes title, keywords, authors, affiliations, section labels, and uploaded PDF content.

The engine configuration for the behavior-preserving release is:

```text
locales: ["th", "en"]
granularity: "word"
counted segment: isWordLike === true
normalization: trim only
fallback: none
```

The locale list and normalization policy may change only after the Microsoft Word benchmark demonstrates that another configuration is measurably better near the 300-word boundary.

## Backend Components

### Canonical utility

`conference-api/src/utils/abstractWordCount.ts` owns:

- policy and limit constants;
- section names and TypeScript types;
- one module-scoped `Intl.Segmenter` instance;
- `countWords`;
- comma-separated keyword parsing;
- per-field and total counting;
- structured validation issues;
- runtime metadata for diagnostics.

The utility contains no Fastify, database, upload, email, or UI concerns.

### Count endpoint

`POST /api/abstracts/word-count` accepts JSON and requires the same JWT authentication used by submit/resubmit. It accepts incomplete strings so it can be used while typing. It returns counts, limits, validation issues, and a stable policy identifier. It never logs the abstract text.

### Submit and resubmit

Both routes remove their local segmenter/counting functions and call the canonical validator once. Existing HTTP status behavior remains additive-compatible: the existing `success` and `error` fields remain, while structured `code` and `details` are added.

## Frontend Components

### API client

`Pris2026/src/lib/abstractWordCount.ts` contains the request/response contract and the authenticated fetch function. It does not implement a tokenizer.

### Debounced hook

`Pris2026/src/app/[locale]/abstract-submission/useAuthoritativeWordCount.ts`:

- waits 500 ms after the latest text change;
- aborts superseded requests;
- ignores stale responses using a stable input signature;
- exposes `idle`, `loading`, `ready`, and `error` states;
- exposes `refresh()` for immediate validation before leaving Steps 3 and 4;
- keeps the last successful result visible while a replacement request is in flight.

### Submission page

The page removes local word segmentation and local word-based truncation. Step 3 displays the server title count. Step 4 displays the server per-section and total counts. Navigation from Steps 3 and 4 performs an immediate refresh and uses the returned issues. If authoritative counting is unavailable, navigation is blocked with a localized retry message; final submission remains revalidated by the backend.

## API Contract

Request:

```json
{
  "title": "",
  "keywords": "",
  "background": "",
  "objective": "",
  "methods": "",
  "results": "",
  "conclusion": ""
}
```

Successful response:

```json
{
  "success": true,
  "policy": "intl-segmenter-th-en-v1",
  "limits": {
    "titleMax": 30,
    "keywordMax": 6,
    "sectionMin": 10,
    "totalMax": 300
  },
  "counts": {
    "title": 0,
    "keywords": 0,
    "sections": {
      "background": 0,
      "objective": 0,
      "methods": 0,
      "results": 0,
      "conclusion": 0
    },
    "total": 0
  },
  "issues": []
}
```

Validation issue:

```json
{
  "code": "TOTAL_TOO_LONG",
  "field": "abstract",
  "current": 301,
  "limit": 300
}
```

Supported issue codes are `TITLE_TOO_LONG`, `TOO_MANY_KEYWORDS`, `SECTION_TOO_SHORT`, and `TOTAL_TOO_LONG`.

## Error Handling

- Invalid JSON shape: HTTP 400 with `code: "INVALID_WORD_COUNT_INPUT"`.
- Missing JWT or invalid JWT: existing authentication response.
- Unsupported `Intl.Segmenter`: application startup/test failure; no Thai whitespace fallback.
- Count endpoint network failure: frontend retains the last successful count, marks it stale, and blocks count-dependent navigation until `refresh()` succeeds.
- Submit/resubmit count violation: HTTP 400 with the first issue in existing validation order and all counts/issues in `details`.
- Rate limit: existing API `RATE_LIMIT_EXCEEDED` contract.

## Microsoft Word Compatibility Method

Compatibility fixtures must use exactly the same strings sent to the API. The Word baseline must count only the selected five content sections and must record:

- Microsoft Word product and full build;
- desktop operating system;
- proofing language;
- whether only the body selection was counted;
- Node version, ICU version, and resolved segmenter locale;
- exact Unicode text or an approved anonymized fixture.

The benchmark reports exact-match rate, mean absolute error, maximum absolute error, and false-accept/false-reject cases around 295–305 words. It compares the current locale list against Thai-only locale and optional NFC normalization. Algorithm changes are made in a separate commit after benchmark review.

## Security and Privacy

- The count endpoint is authenticated.
- Request strings have explicit character limits.
- The endpoint has a route-specific rate limit.
- Logs contain policy/runtime metadata and numeric counts only.
- Real abstracts are not committed unless anonymized and approved.

## Rollout

1. Add and test the canonical backend utility without changing locale behavior.
2. Refactor submit/resubmit to use it.
3. Add the authenticated count endpoint.
4. Add the frontend API client and debounced hook.
5. Switch displayed counts and step validation to server results.
6. Verify browser-to-API consistency and production Docker ICU support.
7. Build the Word compatibility corpus and benchmark variants.
8. Update the policy only if benchmark evidence supports a change.

## Success Criteria

- For the same request payload, the count shown in `Pris2026`, the count endpoint, submit, and resubmit are identical.
- No abstract route contains a duplicate `countWords` implementation.
- No backend path silently falls back to whitespace splitting.
- Tests cover Thai, English, mixed text, punctuation, Unicode edge cases, and 299/300/301 boundaries.
- The UI clearly states that the system count is authoritative and that Microsoft Word may differ slightly.
- Microsoft Word compatibility is measured before any claim that a locale or normalization change is better.
