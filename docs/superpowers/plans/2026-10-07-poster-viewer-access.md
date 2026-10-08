# Poster Viewer Access Implementation Plan

**Goal:** Restrict organizer/reviewer to received Posters and revision actions.
**Architecture:** Reuse staff authorization and reader projections; enforce access in API and render role-specific UI.
**Tech Stack:** TypeScript, Fastify, Drizzle, React, Next.js, node:test.

- [x] Update `src/modules/posters/readers.ts` to filter received uploads before pagination/counts, redact verification/mail fields, deny unsubmitted details, allow only revision audits, and require admin for settings/batches. Add optional received query in `schemas.ts`; allow null matchState in API and backoffice DTOs.
- [x] Update backoffice Posters list/detail, PosterTable and posterUi to expose received-only viewer navigation, omit admin sections and filter displayed audit actions. Preserve admin mutation controls and role-scoped loading.
- [x] Update existing reader integration and actual component tests; add isolated reader checks for received-only totals/pagination, redaction, direct access denial, audit allowlist and admin preservation. Run `npx tsx --test src/modules/posters/readers.test.ts` in API, and `../conference-api/node_modules/.bin/tsx --test src/lib/posterUi.test.ts` in backoffice; run `npx tsc --noEmit` in both, then ESLint on changed backoffice files.

Validation: 21 backoffice component/helper checks and 12 API reader/policy checks passed. TypeScript passed in both projects; focused backoffice ESLint and diff whitespace checks passed. Full Poster unit suite: 36/40 passed; four announcement-data assertions expect 119 Round 1 rows, but existing uncommitted local Round 2 fixtures add two rows (121 total). Those fixtures were preserved. PostgreSQL integration tests were not run because the guarded 127.0.0.1:55073 Poster integration database is unavailable.
