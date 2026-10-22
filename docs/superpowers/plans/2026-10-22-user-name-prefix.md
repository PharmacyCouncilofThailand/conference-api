# Nullable User Name Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Store an optional user prefix and display it only in Backoffice Member and Registration list columns.

**Architecture:** Add one nullable users column. Member reads it directly; Registration uses a left join to the user. Existing table markup renders the optional text or a dash, without another component or input workflow.

**Tech Stack:** PostgreSQL, Drizzle, TypeScript, React/Next.js; existing libraries only.

## Global Constraints

- Approved specification: `docs/superpowers/specs/2026-10-22-user-name-prefix-design.md`; written-spec approval received in chat.
- DB `users.name_prefix VARCHAR(50) NULL`, API `namePrefix`, no default, backfill, enum or index.
- Backoffice list column label `คำนำหน้า`; null, absent and blank values render `—`.
- Signup, editing forms, details, public sites, emails and exports remain outside this change.
- Migration precedes API deployment. Local verification never modifies a runtime database.
- Execute inline under the user's existing authorization.

### Task 1: Nullable persistence and list reads

**Files:** API `drizzle/0048_user_name_prefix.sql`, `src/database/schema.ts`, `src/routes/backoffice/members.ts`, `src/routes/backoffice/registrations.ts`.

**Interface:** List rows gain `namePrefix: string | null`; the nullable Registration user relation is preserved.

- [x] Confirm baseline schema and both projections omit the field; inspect signup/login response projections for accidental exposure.
- [x] Add additive migration:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_prefix varchar(50);
COMMIT;
```

- [x] Add Drizzle property next to names:

```ts
namePrefix: varchar("name_prefix", { length: 50 }),
```

- [x] Add `namePrefix: users.namePrefix` to only the existing Member and Registration list projections. Add `.leftJoin(users, eq(registrations.userId, users.id))` to the Registration list query. Keep all filters, counts and access scopes.
- [x] Verify the actual migration and HTTP list handlers against temporary tables on the existing guarded local test DB: preserve existing values, null defaults, populated values, unlinked registrations, scope and pagination. Temporary tables disappear when their connection closes.
- [x] Run `npm run build`. Expected: pass.

### Task 2: Backoffice table columns and release notes

**Files:** `D:/confer/confer/conference/conference-backoffice/src/app/members/page.tsx`, `D:/confer/confer/conference/conference-backoffice/src/app/registrations/page.tsx`.

**Interface:** Each local list interface gains `namePrefix?: string | null` for compatibility with the old API.

- [x] Add a header immediately before the existing Member/Attendee header:

```tsx
<th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider">
  คำนำหน้า
</th>
```

- [x] Add the corresponding cell after ID/Reg Code, using the current row variable:

```tsx
<td className="px-4 py-4 text-sm text-zinc-500">{member.namePrefix?.trim() || '—'}</td>
<td className="px-4 py-4 text-sm text-zinc-500">{reg.namePrefix?.trim() || '—'}</td>
```

- [x] Change only Member's empty-state `colSpan` from 8 to 9. Keep names, exports and all form fields unchanged.
- [x] Render both real pages with populated, null, absent and blank fixtures; confirm a separate column and escaped text. Use an ephemeral assert-based check rather than introducing reusable production helpers or implementation-mirroring tests.
- [x] Run Backoffice `npx tsc --noEmit`, focused ESLint, and the existing `node --test tests/registrationRefresh.test.mjs`. Expected: pass, or document unrelated existing diagnostics.
- [x] Review both diffs and `git diff --check`, update the specification approval state, record verification below, and commit only task files in each repo. Do not push or deploy.

## Self-review

Both read paths, missing-user semantics, client compatibility, null display, unchanged signup/export behavior and migration ordering are covered. Property names match across layers. No unresolved choices remain.

## Execution record

Implemented inline as approved. Production changes are one nullable column, two list projections, one left join, and two table columns; no new package, input form, API endpoint or runtime helper was added.

Verification on 2026-10-22:

- API `npm run build`: passed.
- Backoffice `npx tsc --noEmit`: passed.
- Actual migration executed twice against a session-local temporary `users` table in the existing guarded `127.0.0.1:55073/confer_posters_integration_test` database. Verified existing rows remain NULL, omitted inserts default to NULL, populated Unicode text survives rerun, and 51-character input is rejected.
- Actual Fastify Member/Registration list handlers exercised against temporary tables through the real Drizzle queries. Populated/null values, a registration with no linked user, pagination/counts and organizer event scoping all passed. Persistent `public.users` row count and column presence were checked unchanged before/after; no schema reset occurred. Temporary fixture tables disappear on disconnect.
- Both real page components were transpiled and rendered with fixture state. Separate columns, populated/NULL/absent/whitespace values, escaped text and Member's 9-column empty state passed.
- Existing `node --test tests/registrationRefresh.test.mjs`: 1/1 passed.
- Focused ESLint has the exact unchanged HEAD baseline: Member 2 `no-explicit-any` errors; Registration 4 `no-explicit-any` errors and 1 `exhaustive-deps` warning. Baseline and changed-file rule/message/severity signatures were compared programmatically and match. These unrelated diagnostics were not suppressed or refactored.
- Both repository `git diff --check` checks passed. Signup/login/profile schemas and sources, public frontend, detail pages and export mappings were unchanged.

Ephemeral verification scripts live outside the repos in parent workspace `.codex-tmp/user-name-prefix-check.mts` and `.codex-tmp/user-name-prefix-ui-check.cjs`. No permanent implementation-mirroring test scaffold was added for the small display change.

Release requirement: apply `drizzle/0048_user_name_prefix.sql` before API deployment; clients tolerate the previous API. No runtime migration, data backfill, push or deployment was performed.
