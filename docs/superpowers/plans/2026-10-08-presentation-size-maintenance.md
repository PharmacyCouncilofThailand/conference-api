# Presentation Size Maintenance Implementation Plan

> **For agentic workers:** Use executing-plans inline in this chat, in the existing checkouts, as already authorized by the user. Steps use checkbox syntax for tracking.

**Goal:** Centralize Frontend limits, derive email size text from API policy, and display MB everywhere without changing existing byte ceilings.

**Architecture:** API retains `maxPresentationBytes(type)` as its authoritative check. Frontend gets one local `presentationLimits.ts`; validation, translated requirements, errors and selected-file size use it. Multipart lifecycle remains unchanged.

**Tech Stack:** TypeScript, Fastify, React/Next.js, next-intl, existing node:test/tsx tests.

## Global Constraints

- Oral remains 52,428,800 bytes and at least two PDF pages.
- Poster/Highlighted Poster remain 31,457,280 bytes and exactly one PDF page.
- MB is the requested display label; byte calculations retain the existing 1024-based conversion.
- No dependency, ENV, DB, API DTO, storage or permission changes.
- Preserve uncommitted `approvedRound2Abstracts.ts` test rows; never stage them.
- Change remaining human-readable unit labels in the three repositories, including Backoffice and Lucky Wheel labels, without changing their limits.

## Task 1: Frontend constants and translated requirements

**Files:** Create `Pris2026/src/lib/presentationLimits.ts`; modify `presentationSubmissionState.ts`, `PresentationWorkspace.tsx`, TH/EN messages and existing `presentationWorkspace.test.ts` / `presentationSubmissionState.test.ts` under `Pris2026`.

**Interface:** Export `PRESENTATION_SIZE_UNIT_BYTES: number` and `PRESENTATION_LIMITS` with `oral`/`poster` entries containing `mb` and `bytes`.

```ts
export const PRESENTATION_SIZE_UNIT_BYTES = 1024 * 1024;
const oralMB = 50, posterMB = 30;
export const PRESENTATION_LIMITS = {
  oral: { mb: oralMB, bytes: oralMB * PRESENTATION_SIZE_UNIT_BYTES },
  poster: { mb: posterMB, bytes: posterMB * PRESENTATION_SIZE_UNIT_BYTES },
} as const;
```

- [x] Run existing focused suites before changes: `tsx --test src/lib/presentationSubmissionState.test.ts src/lib/presentationWorkspace.test.ts src/lib/presentationPage.test.ts`. Expect PASS.
- [x] Add direct constant assertions to the existing state suite: Oral bytes `52_428_800`, Poster bytes `31_457_280`, labels 50/30. Import the new module; verify the suite fails because the module does not exist yet.
- [x] Create the module above. Replace validation's inline bytes with `PRESENTATION_LIMITS[type === 'oral' ? 'oral' : 'poster'].bytes`.
- [x] In Workspace use `const maxMB = PRESENTATION_LIMITS[oral ? 'oral' : 'poster'].mb`; convert selected size with `PRESENTATION_SIZE_UNIT_BYTES`; display `MB`.
- [x] Use `{maxMB}` in both locales' error and requirements strings; call `t(requirementsKey, { maxMB })`. Update existing workspace assertions to substitute this placeholder. Assert rendered JSON has no unfilled `{maxMB}` or old unit label.
- [x] Rerun focused suites, TypeScript and scoped ESLint. Expect PASS; both Poster types retain the original boundary assertions.

## Task 2: Email policy and remaining unit labels

**Files:** API `email-template.ts`, email template/job integration tests, validation/route test descriptions; Backoffice Presentation detail page; remaining unit labels in Lucky Wheel UI/API and Markdown docs.

**Interface:** Consume API's existing `maxPresentationBytes(type: 'oral' | 'poster'): number`.

```ts
const maxMB = maxPresentationBytes(oral ? 'oral' : 'poster') / (1024 * 1024);
```

Template fragment:

```html
<li>ไฟล์ PDF จำนวนหนึ่งไฟล์ ${oral ? 'อย่างน้อย 2 หน้า' : 'หนึ่งหน้า'} ขนาดไม่เกิน ${maxMB} MB</li>
```

- [x] Change existing email assertions to expect 50/30 MB; run `tsx --test src/modules/presentations/email-template.test.ts`. Expect failure while template still has the old label.
- [x] Import the helper, derive `maxMB`, replace the template fragment above; no new payload field or conversion helper.
- [x] Replace remaining human-readable old unit labels with MB in API/Frontend/Backoffice and Markdown. Leave asset payloads, dependencies, generated files, byte ceilings and SQL migrations untouched.
- [x] Rerun email unit tests, API build, Backoffice type/lint checks. Expect PASS.
- [x] Run email-jobs integration tests only with the already approved isolated Docker test DB, using `.test-artifacts/presentations/integration.env`, never the runtime `.env` test URL. Expect PASS, with fake mail transport only.

## Task 3: Documentation and completion

**Files:** `conference-api/docs/presentation-file-size-limits.md`, this plan, affected existing Presentation specs/plans and unit-label documentation.

- [x] Update the summary's code extracts, constants location and maintenance instructions to match the final code. Explicitly record MB as display-only with unchanged byte values.
- [x] Search the three repositories with `rg -n '\bM[i]B\b|maxM[i]B'` excluding assets/dependencies/generated files. Expect no old unit labels in maintained code/docs.
- [x] Review diffs for unchanged multipart logic and byte ceilings; complete focused boundary/copy tests and check whitespace.
- [x] Commit only task files per repo, excluding the user's Round 2 test data. Record checkpoints and validation results below.

## Checkpoints

1. Frontend baseline: 6 tests passed. New constants test failed before the module existed; after implementation all 7 focused tests passed, including unchanged byte ceilings and translated placeholders for TH/EN.
2. Email copy assertions failed against the old unit label, then all 27 API policy/validation/email unit tests passed after policy-derived MB text. API build passed; Frontend and Backoffice TypeScript/scoped ESLint passed.
3. Docker integration: all 15 email-jobs tests passed with fake transport against `127.0.0.1:55073/confer_posters_integration_test`. Both route integration tests passed, including oversized response codes and exact Oral byte ceiling; log: `.test-artifacts/presentations/size-maintenance-routes.log`.
4. Final audit: no old unit labels in maintained TS/TSX/JSON/Markdown across all three repos; `policy.ts` and `public.routes.ts` have no diff. Existing byte ceilings, multipart lifecycle, ENV, runtime DB and user Round 2 test rows were not changed by this task. Whitespace checks passed.
