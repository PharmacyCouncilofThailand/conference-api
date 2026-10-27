# Presentation Category Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Apply assigned category scope in addition to Event/type scope for presentation viewers, and add an authorized category filter plus Organizer category assignment UI.

**Architecture:** Reuse current database category-name grants and intersect them with authoritative Abstract category/Event relationships. Existing list API returns authorized category options and accepts a narrowing category ID. Backoffice reuses its current filter, access-scope and assignment patterns.

**Tech Stack:** Existing Fastify/Drizzle/Zod API, Next.js/React Backoffice, node:test/tsx. No new dependencies, migrations or endpoints.

**Spec:** `../specs/2026-10-27-presentation-category-scope-design.md`

## Global Constraints

- Both Organizer and Reviewer require the intersection of current database Event, type and category grants; empty/malformed category grants fail closed.
- Category grants are existing `assigned_categories` names; authorize using `abstract_categories.name` joined through the authoritative Abstract/Event, not announcement metadata.
- Category filter parameter is optional positive integer `categoryId`; list `categories` contains `{id:number;name:string}` options scoped to Event/category grants, independent of page/search/other filters.
- Admin retains unrestricted reads and all existing management features. Preserve latest-file viewer redaction and prevent status/filter inference.
- Use existing feature worktrees/branch. All subagents, including reviewers, must use `gpt-6.1-sol` effort `medium`; never spawn helpers from workers.
- Parallel file ownership: API agent owns all API files; list agent owns list/detail scope, DTO copy and first shared UI-test lease; assignment agent owns users/helper/comments and takes the shared UI-test lease only after list agent releases it.
- Guarded serial integration only at `127.0.0.1:55073/confer_posters_integration_test`; parent owns its disposable test container. No live account edits or automatic grant/backfill.

## Task 1: Database-authoritative category scope, filter and options

**Files (API):** `src/modules/presentations/access.ts`, `readers.ts`, `schemas.ts`, `types.ts`, `test-support.ts`, `readers.test.ts`, `readers.integration.test.ts`, `access.integration.test.ts` if necessary. Update other existing mocks only if the changed grant query requires it. Production schema comment may be corrected; no SQL migration.

**Interfaces:** Keep reader endpoint/signatures. Extend staff grants with `categories: string[]`; list DTO with `categories: Array<{id:number;name:string}>`; query with `categoryId`. Frontend reads the same options contract. No new row-level category field is needed if SQL applies the category filter.

- [x] Add failing reader/access tests for both roles, malformed/empty categories, category+type intersection, direct detail denial, independent authorized options and counts/pagination. Use a real guarded integration fixture for SQL authority; mock tests alone cannot prove category joins.
- [x] Run focused tests and record expected authorization/filter failures before runtime changes.
- [x] Extend active-user grant read to include existing category names; filter nonempty strings without broadening grants. Add query schema entry:

```ts
categoryId: idSchema.optional(),
```

- [x] Scope roster SQL with authoritative category/Event join in addition to type scope; apply optional category ID before counts/pagination. Detail uses identical category authorization. Query authorized Event category options separately from filtered roster and return:

```ts
categories: Array<{ id: number; name: string }>;
```

- [x] Correct shared test `backoffice_users` DDL by adding existing production column `assigned_categories jsonb NOT NULL DEFAULT '[]'`; explicitly assign categories in existing viewer fixtures that should still see files. Add a stale/forged announcement category test and stale actor/JWT assignment test.
- [x] Run focused unit and guarded serial readers/routes/access integration; verify existing redaction/Admin cases, then commit exact owned files. Report RED/GREEN and concerns.

## Task 2: Backoffice category filter and scope invalidation

**Files (Backoffice):** `src/app/presentations/page.tsx`, `src/app/presentations/[abstractId]/page.tsx`, `src/types/presentations.ts`, `src/lib/presentationUi.test.ts` (exclusive first lease).

**Interfaces:** Consume list `categories` from Task 1, send query `categoryId`; existing row/detail contracts unchanged. Tolerate an absent options property on older responses. Produce category-aware list and detail access scopes.

- [x] Add failing real component-harness tests for label/options, query ID, category-triggered page/selection reset, Event-reset behavior and immediate hiding on same-object assignedCategories changes. Include options beyond current roster page.
- [x] Run focused tests to demonstrate the missing filter/scope behavior.
- [x] Add local category state, query inclusion and existing `filter()` reset handler. Add a select with accessible label `หมวดผลงาน`, first option `ทุกหมวดที่มีสิทธิ์`, and API-authorized options. The core option source is:

```ts
const categories = data?.categories ?? [];
```

- [x] Include selected category in list request scope/effect dependencies; reset category when Event changes without a stale-category read under the new Event. Add `user?.assignedCategories` to both list/detail `accessScope` serialization. Keep managementScope independent of ordinary category filtering so same-scope batch results persist.
- [x] Extend the frontend list DTO with backward-compatible options:

```ts
categories?: Array<{ id: number; name: string }>;
```

- [x] Run focused UI tests and targeted lint; commit exact owned files and explicitly release the shared UI-test lease. Do not touch user forms/helper.

## Task 3: Organizer category assignment create/edit

**Files (Backoffice):** `src/app/users/page.tsx`, `src/lib/presentationUi.ts`, comments in `src/contexts/AuthContext.tsx` and user interface if needed; `src/lib/presentationUi.test.ts` only after Task 2 lease release.

**Interfaces:** Existing `presentationUserAssignments(role, types, categories)` now sends both assignment arrays for Organizer and Reviewer. User create/update API already accepts and stores these arrays.

- [x] Read current user create/edit and Event category-loading paths. Draft shared-test edits while Task 2 owns the test file; do not write it concurrently.
- [x] Extend category fetching and both assignment sections to Organizer using the existing role predicate:

```ts
['organizer', 'reviewer'].includes(formData.role)
```

- [x] Extend `presentationUserAssignments` to include selected category names for both roles, while other roles retain their current payloads. Update help text to explain category+type intersection for Presentations without changing Abstracts permissions.
- [x] After exclusive test lease transfer, update the existing helper regression to expect Organizer category values, plus empty assignments and unchanged other-role payloads. Exercise actual form category loading/selection/save through a component harness or local browser smoke where practical. Run focused RED/GREEN, full shared UI suite and targeted lint, commit only owned files, release lease.

## Final validation and review

- [x] Parent/review agents inspect Task 1, Task 2 and Task 3 changes for spec compliance and quality; fix any blocking findings with scoped regressions.
- [x] API: `npm run test:presentations`, `npm run build`; guarded integration: `npx --no-install tsx --test --test-concurrency=1 src/modules/presentations/readers.integration.test.ts src/modules/presentations/routes.integration.test.ts src/modules/presentations/access.integration.test.ts`.
- [x] Backoffice: `../conference-api/node_modules/.bin/tsx --test src/lib/presentationUi.test.ts`, targeted ESLint/Prettier, and `npm run build`. Compare full lint to existing baseline when needed; pre-amendment main has 94 errors/53 warnings.
- [x] Verify category options/filter plus Organizer assignment UI with synthetic/local test data where possible; distinguish UI-fixture smoke from database-backed authorization tests. Record any untested browser cases honestly.
- [x] Final combined review, completion notes and cleanup of only this amendment's disposable test environment/scratch. Retain both feature branches/worktrees for the existing integration decision; do not merge/push/deploy without the user's choice.

## Execution status

Complete: API70 unit/12 guarded integration, Backoffice33 component tests, both builds, no new lint findings, independent task and combined reviews passed. Browser UI smoke uses synthetic localhost API; evidence and limits are in `../verification/2026-10-27-presentation-category-scope.md`. No merge/push/deploy.
