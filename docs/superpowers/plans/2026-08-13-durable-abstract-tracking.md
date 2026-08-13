# Durable Abstract Tracking ID Implementation Plan

> **Execution note:** Implement this plan task by task. Every task starts with a failing test or a read-only assertion, makes the smallest production change that satisfies it, reruns focused checks, and ends at a reviewable checkpoint. Do not skip the production-clone rehearsal or cutover gates.

**Goal:** Replace `COUNT(*)` tracking-ID generation with a transactional, monotonic, non-reusing allocator; preserve prior IDs as permanent aliases when resubmission changes presentation type; replace destructive abstract deletion with archival; and migrate production without a planned submit-endpoint shutdown.

**Design:** [`docs/superpowers/specs/2026-08-13-durable-abstract-tracking-design.md`](../specs/2026-08-13-durable-abstract-tracking-design.md)

**Repositories:**

- `/Users/ptic/Desktop/Conference/conference-api`
- `/Users/ptic/Desktop/Conference/Pris2026`

**Tech stack:** Node.js 20, TypeScript 5, Fastify 5, Drizzle ORM, postgres-js, PostgreSQL, Zod, Node test runner through `tsx`, Next.js 16, React 19, next-intl.

---

## 1. Delivery Scope

This plan delivers:

- an immutable per-event tracking namespace;
- an atomic high-water counter per event and presentation type;
- a permanent allocation registry of all tracking IDs ever committed or recovery-reserved;
- a separate append-only assignment/alias chain for type-changing resubmissions;
- a durable administrative audit stream for allocation, rotation, namespace, archive, and unlink actions;
- current-ID compatibility through `abstracts.tracking_id`;
- abstract/member/event archive rules that preserve issued IDs;
- exact canonical/alias lookup and backoffice search support;
- additive v1 API response fields and stable error codes;
- public UI warning/history behavior in `Pris2026`;
- production audit, anomaly-manifest, verification, cutover, monitoring, and rollback runbooks;
- expand and delayed-hardening migrations;
- unit, schema, integration, route-contract, concurrency, rollback, and frontend tests.

It intentionally does not deliver:

- a new GraphQL or API v2 surface;
- a new backoffice frontend, because that repository is absent;
- submit idempotency keys;
- automatic replay of failed requests;
- automatic renumbering of unexplained legacy anomalies;
- Drive upload/outbox redesign.

---

## 2. Non-negotiable Engineering Rules

1. The target allocator never uses `COUNT(*)`, `MAX(abstracts rows) + 1`, application memory, or `abstracts.id`; Release A uses the durable allocator immediately. The temporary database bridge exists only to protect writes from pre-A binaries during rolling deployment, then is disabled and removed in Release B.
2. Never decrement a counter.
3. Never recycle a committed ID.
4. Never update or delete an allocation, identifier-assignment, or durable-audit row.
5. Never expose an allocated ID before the enclosing transaction commits.
6. Never silently truncate a prefix or tracking ID.
7. Never repair a counter downward.
8. Never auto-fix a legacy anomaly not represented in a reviewed manifest.
9. Never run `npm run db:push` for this rollout.
10. Do not edit `drizzle/meta/_journal.json`; migrations after `0007` are maintained manually in this repository.
11. Do not roll production back to a build containing the old `COUNT(*)` allocator after cutover.
12. Preserve unrelated user changes and the existing Team Registration work.
13. Keep every v1 `error` value a string; add stable `code` and `requestId` without replacing existing required fields.
14. Do not log abstract text, author/co-author email, phone, multipart body, or Drive URL.
15. If correctness is at risk, fail closed with 503 and pause only submit/resubmit as an emergency measure; never issue a possibly duplicate ID.
16. During mixed-version bridge operation, keep initial and same-type submission open through the durable allocator/bridge; temporarily reject type-changing and history-dependent shape mutations until `history_ready=true`; never let a frozen manifest race an uncoordinated writer.

---

## 3. Target File Inventory

### 3.1 `conference-api`: create

- `src/app.ts`
- `src/app.test.ts`
- `src/modules/abstracts/tracking.types.ts`
- `src/modules/abstracts/tracking-format.ts`
- `src/modules/abstracts/tracking-format.test.ts`
- `src/modules/abstracts/errors.ts`
- `src/modules/abstracts/errors.test.ts`
- `src/modules/abstracts/tracking.repository.ts`
- `src/modules/abstracts/tracking.repository.test.ts`
- `src/modules/abstracts/submission.service.ts`
- `src/modules/abstracts/submission.service.test.ts`
- `src/modules/abstracts/archive.service.ts`
- `src/modules/abstracts/archive.service.test.ts`
- `src/modules/abstracts/backoffice-access.ts`
- `src/modules/abstracts/backoffice-access.test.ts`
- `src/modules/abstracts/test-database.ts`
- `src/modules/abstracts/tracking.integration.test.ts`
- `src/modules/abstracts/tracking.health.ts`
- `src/modules/abstracts/tracking.health.test.ts`
- `src/modules/abstracts/tracking.metrics.ts`
- `src/modules/abstracts/tracking.metrics.test.ts`
- `src/routes/public/abstracts/submit.test.ts`
- `src/routes/backoffice/abstract-identifiers.ts`
- `src/routes/backoffice/abstract-identifiers.test.ts`
- `src/routes/backoffice/abstract-archival.test.ts`
- `src/routes/backoffice/members.abstract-archive.test.ts`
- `src/routes/backoffice/events.tracking.test.ts`
- `drizzle/0028_abstract_tracking_allocator.sql`
- `drizzle/0029_abstract_tracking_hardening.sql`
- `sql/abstract-tracking-setup/07_prepare_hardening.sql`
- `sql/abstract-tracking-setup/08_verify_hardening.sql`
- `sql/abstract-tracking-setup/00_preflight.sql`
- `sql/abstract-tracking-setup/01_prepare_manifest.sql`
- `sql/abstract-tracking-setup/01_stage_manifest_tables.sql`
- `sql/abstract-tracking-setup/01_disable_legacy_bridge.sql`
- `sql/abstract-tracking-setup/manifest/anomaly-decisions.csv.example`
- `sql/abstract-tracking-setup/manifest/series-floors.csv.example`
- `sql/abstract-tracking-setup/manifest/event-namespaces.csv.example`
- `sql/abstract-tracking-setup/02_expand_verify.sql`
- `sql/abstract-tracking-setup/02_constraint_probes.sql`
- `sql/abstract-tracking-setup/02_online_backfill.sql`
- `sql/abstract-tracking-setup/02_backfill_verify.sql`
- `sql/abstract-tracking-setup/03_cutover.sql`
- `sql/abstract-tracking-setup/04_post_cutover_verify.sql`
- `sql/abstract-tracking-setup/05_runtime_health.sql`
- `sql/abstract-tracking-setup/06_set_abstract_write_pause.sql`
- `sql/abstract-tracking-setup/README.md`
- `docs/api/abstract-tracking-v1.md`

### 3.2 `conference-api`: modify

- `package.json`
- `package-lock.json`
- `Dockerfile`
- `.env.example`
- `src/database/index.ts`
- `README.md`
- `src/database/schema.ts`
- `src/index.ts`
- `src/errors/ApiError.ts`
- `src/schemas/abstracts.schema.ts`
- `src/schemas/events.schema.ts`
- `src/routes/public/abstracts/submit.ts`
- `src/routes/public/abstracts/user.ts`
- `src/routes/public/abstracts/confirm.ts`
- `src/routes/public/events.ts`
- `src/routes/public/tickets.ts`
- `src/routes/public/workshops.ts`
- `src/routes/public/sponsors.ts`
- `src/routes/public/studentEligibility.ts`
- `src/routes/registrations/free.ts`
- `src/routes/registrations/quick.ts`
- `src/routes/payments/index.ts`
- `src/modules/team-registrations/database.repository.ts`
- `src/modules/team-registrations/public.routes.ts`
- `src/routes/backoffice/abstracts.ts`
- `src/routes/backoffice/members.ts`
- `src/routes/backoffice/events.ts`
- `src/routes/backoffice/abstractCategories.ts`
- `src/routes/backoffice/email-manual.ts`
- `src/routes/backoffice/email-retrosend.ts`
- `src/services/abstractConfirmation.ts`

### 3.3 `Pris2026`: create

- `src/lib/abstractTracking.ts`
- `src/lib/abstractTracking.test.ts`
- `src/components/profile/TrackingIdHistory.tsx`
- `src/components/profile/TrackingIdHistory.test.ts` (use `React.createElement`/test renderer so it matches the existing `src/**/*.test.ts` script without JSX syntax)

### 3.4 `Pris2026`: modify

- `src/app/[locale]/abstract-submission/page.tsx`
- `src/components/profile/AbstractTracker.tsx`
- `messages/en.json`
- `messages/th.json`

### 3.5 Explicitly out of scope

- `PSATHealthHack`
- external `accp-backoffice` UI repository, which is not present
- generated Drizzle snapshot/journal files

---

## 4. Dependency Graph and Release Checkpoints

```text
Baseline + preflight contract
        |
        v
Format/errors -> additive schema -> repository allocator
                                  |
                                  v
                  submit service + compatibility Release A
                                  |
                         +--------+---------+
                         |                  |
                         v                  v
                type-change aliases   archive/event rules
                         |                  |
                         +--------+---------+
                                  v
                       API lookup + UI changes
                                  |
                                  v
                   production-clone rehearsal
                                  |
                                  v
 reviewed floors -> guarded 0028 bridge -> Release A -> history backfill/cutover
                                  |
                                  v
                         Release B + soak
                                  |
                                  v
                       hardening migration 0029
```

Required rollback artifacts:

- **Allocator-core checkpoint:** development/staging fallback before type-rotation/archive behavior is released; never the universal production rollback after later phases.
- **Release A production checkpoint:** allocator plus assignments/aliases, archive/member/event gates, lookup, safe errors/audit/health, and matching API contract. This is the minimum production rollback floor after the first cutover.
- **Release B checkpoint:** Release A behavior with the legacy allocator removed; it must retain the shared cutover advisory lock.
- **0029-compatible checkpoint:** application schema/types compatible with non-null/deferred-FK hardening. After 0029, no older artifact is a valid rollback target.
- Select the rollback floor that matches the latest behavior/schema milestone; never treat an early tag as universally safe.

“Release A” is the final compatibility build assembled across Phases 5–13, not the partial Phase-5 checkpoint by itself. Do not deploy Release A to production until alias, archive/event gates, API/error/audit/health behavior, cutover SQL, frontend compatibility, and clone rehearsal have all passed.

---

## 5. Phase 0 — Baseline, Branching, and Test Safety

### Task 0.1: Record repository state

**Repository:** `conference-api`

- [ ] Record current branch, HEAD SHA, origin refs, and dirty state.
- [ ] Confirm no unrelated file is modified by this work.
- [ ] Create a feature branch according to the team's normal workflow; suggested name:

  ```bash
  git switch -c fix/durable-abstract-tracking
  ```

- [ ] Save baseline commands and results in the implementation PR description, not in committed generated output.

Run:

```bash
cd /Users/ptic/Desktop/Conference/conference-api
git status --short
git rev-parse HEAD
npm test
npm run build
```

Expected:

- baseline failures, if any, are recorded before implementation;
- TypeScript build passes or pre-existing failures are explicitly separated.

### Task 0.2: Validate test database isolation

Do not run concurrency or migration tests against development or production.

- [ ] Provision a disposable PostgreSQL database whose name or schema contains `test`.
- [ ] Restore/apply the repository baseline schema through manual migration `0027` before testing `0028`.
- [ ] In that disposable database create non-owner test counterparts for migrator, runtime, read-only, and one-shot manifest-loader roles; expose guarded `TEST_MIGRATION_DATABASE_URL`, `TEST_RUNTIME_DATABASE_URL` (also used as `TEST_DATABASE_URL` by app integration tests), `TEST_READONLY_DATABASE_URL`, and `TEST_MANIFEST_LOADER_DATABASE_URL`.
- [ ] Add a guarded URL loader patterned after Team Registration integration tests and a teardown script that drops only these explicit test roles/objects after connections close.
- [ ] Refuse to start if `TEST_DATABASE_URL === DATABASE_URL` unless a deliberately named local-only override is set.
- [ ] Print only database host/name in test diagnostics; never print credentials.

Acceptance:

- under the generic `npm test` lifecycle, guarded integration tests skip with a clear message when `TEST_DATABASE_URL` is absent;
- under the explicit `npm run test:abstract-tracking:integration` lifecycle, absence of `TEST_DATABASE_URL` is a hard failure so the production gate cannot false-pass;
- they hard-fail when pointed at the application database;
- role assertions prove runtime cannot DML protected tables, read-only cannot mutate/execute protected functions, loader can touch only an unfrozen batch, and migrator owns the test migration objects;
- cleanup targets only objects with the test suite's explicit prefix/schema.

### Task 0.3: Record current incident fixture

Create a reusable fixture description in test code:

```text
event prefix: PRIS-2026
presentation type: poster
existing IDs include P022
current matching row count is lower than suffix 22
expected next ID: P023
```

The fixture fixes `approvedFloor = 22`; separate tests cover a higher approved floor and expect `approvedFloor + 1`.

Do not copy production PII into fixtures.

Checkpoint:

```bash
git commit -m "test(abstracts): record tracking allocator incident fixture"
```

---

## 6. Phase 1 — Pure Tracking Format and Error Contracts

### Task 1.1: Define public module types

**Create:** `src/modules/abstracts/tracking.types.ts`

Define:

```ts
export type AbstractPresentationType = "oral" | "poster";
export type TrackingAssignmentReasonDb =
  | "initial_submission"
  | "presentation_type_change"
  | "legacy_import"
  | "migration_assignment"
  | "migration_normalization"
  | "admin_correction";

export type TrackingIdentifierOrigin =
  | "native"
  | "legacy_structured"
  | "legacy_opaque"
  | "recovery_tombstone";

export type TrackingAssignmentReasonApi =
  | "INITIAL_SUBMISSION"
  | "PRESENTATION_TYPE_CHANGED"
  | "LEGACY_IMPORT"
  | "MIGRATION_ASSIGNMENT"
  | "MIGRATION_NORMALIZATION"
  | "ADMIN_CORRECTION";

export type TrackingReservation = {
  trackingId: string;
  eventId: number;
  presentationType: AbstractPresentationType;
  sequenceNumber: bigint;
  prefix: string;
  paddingWidth: number;
};

export type TrackingIdentifierView = {
  trackingId: string;
  identifierOrigin: TrackingIdentifierOrigin;
  presentationType: AbstractPresentationType | null;
  sequenceNumber: string | null;
  assignmentReason: TrackingAssignmentReasonApi;
  previousTrackingId: string | null;
  isCurrent: boolean;
  issuedAt: string;
};
```

Use decimal strings at JSON boundaries for bigint sequence values.

Keep lowercase database/domain values internal. One tested mapper converts them to `TrackingAssignmentReasonApi`; public user history, backoffice lookup/history, and `identifierChange.reason` all use the uppercase REST enum consistently.

### Task 1.2: Write format tests first

**Create:** `src/modules/abstracts/tracking-format.test.ts`

Test:

- [ ] `poster -> P`, `oral -> O`;
- [ ] prefix with multiple hyphens parses from the final marker/suffix;
- [ ] `PRIS-2026-P022` parses as prefix `PRIS-2026`, poster, 22;
- [ ] width 3 renders 1 as `001`, 22 as `022`, 999 as `999`, and 1000 as `1000`;
- [ ] no use of truncating `lpad` semantics;
- [ ] empty, whitespace-padded, control-character, too-long, and ambiguous prefixes are rejected;
- [ ] zero, negative, non-numeric, overflow, lower-case marker, and trailing text are rejected;
- [ ] IDs longer than 80 are rejected before persistence;
- [ ] opaque legacy strings can be classified without being rendered as native IDs.

Run and expect failure:

```bash
npx tsx --test src/modules/abstracts/tracking-format.test.ts
```

### Task 1.3: Implement format utility

**Create:** `src/modules/abstracts/tracking-format.ts`

Export small pure functions:

```ts
validateTrackingPrefix(prefix: string): string
validatePaddingWidth(width: number): number
markerForPresentationType(type: AbstractPresentationType): "O" | "P"
presentationTypeForMarker(marker: string): AbstractPresentationType | null
formatTrackingId(input: {...}): string
parseStructuredTrackingId(value: string): ParsedTrackingId | null
```

Rules:

- trim only at explicit namespace-configuration boundaries;
- do not silently normalize already-issued IDs;
- use `String(number).padStart(width, "0")` after bigint validation;
- preserve digits beyond padding width;
- make parsing deterministic and side-effect free.

### Task 1.4: Define domain errors

**Create:**

- `src/modules/abstracts/errors.ts`
- `src/modules/abstracts/errors.test.ts`

Extend the existing `ApiError` contract with stable classes or factories:

| Code | Status | Use |
|---|---:|---|
| `TRACKING_ALLOCATOR_UNAVAILABLE` | 503 | missing runtime/schema/counter dependency |
| `TRACKING_NAMESPACE_NOT_CONFIGURED` | 503 | event exists but cannot allocate until namespace is configured |
| `TRACKING_INVARIANT_VIOLATION` | 503 | bounded collision or state mismatch |
| `ABSTRACT_WRITES_PAUSED` | 503 | operator-enabled emergency submit/resubmit pause |
| `TRACKING_HISTORY_INITIALIZING` | 503 | allocator is safe but legacy aliases/history are not ready for type rotation |
| `TRACKING_PREFIX_LOCKED` | 409 | mutation after first issuance |
| `TRACKING_PREFIX_IN_USE` | 409 | global prefix reservation conflict |
| `INVALID_TRACKING_PREFIX` | 400 in current v1 | invalid format/length |
| `ABSTRACT_ARCHIVED` | 409 | operation on archived abstract |
| `ARCHIVE_REASON_CONFLICT` | 409 | already archived under a different immutable reason |
| `ABSTRACT_NOT_OPEN_FOR_REVISION` | 400 on existing v1 route | locked status is not revision |
| `ABSTRACT_IDENTIFIER_NOT_FOUND` | 404 | absent or unauthorized lookup |
| `EVENT_HAS_TRACKING_HISTORY` | 409 | hard-delete attempt |
| `ABSTRACT_RESTORE_AUTHOR_REQUIRED` | 409 | member-deleted archive lacks author |
| `EVENT_ARCHIVED` | 409 | new submission/registration against an archived event |
| `RESTORE_NOT_ALLOWED` | 409 | event/resource does not satisfy restore policy |

Tests assert:

- string `error` remains present;
- `code`, status, and safe details are deterministic;
- errors never serialize database constraint names, SQL, title, email, or file URL;
- allocator errors carry a request/support reference and never expose raw database text or instruct blind non-idempotent retry.
- `EVENT_ARCHIVED`, `RESTORE_NOT_ALLOWED`, `ARCHIVE_REASON_CONFLICT`, `TRACKING_HISTORY_INITIALIZING`, and `ABSTRACT_WRITES_PAUSED` serialize with their exact 409/503 status rather than falling through to 500.

### Task 1.5: Pass focused checks

```bash
npx tsx --test \
  src/modules/abstracts/tracking-format.test.ts \
  src/modules/abstracts/errors.test.ts
npm run build
```

Checkpoint:

```bash
git commit -m "feat(abstracts): define tracking id domain contracts"
```

---

## 7. Phase 2 — Read-only Production Audit and Reviewed Manifest Contract

This phase creates only read-only/reporting SQL until operators approve the output.

### Task 2.1: Write `00_preflight.sql`

**Create:** `sql/abstract-tracking-setup/00_preflight.sql`

Requirements:

- [ ] begin a read-only transaction;
- [ ] set a bounded `statement_timeout`;
- [ ] verify `abstracts_tracking_id_unique` exists and is validated;
- [ ] report duplicate current strings;
- [ ] parse using `^(.+)-([OP])([0-9]+)$`;
- [ ] report NULL and blank current IDs;
- [ ] report malformed IDs;
- [ ] report type-marker/current-type mismatches;
- [ ] report prefix/current-event-code mismatches;
- [ ] report multiple prefixes per event;
- [ ] report case-insensitive prefix reuse across events;
- [ ] report duplicate `(event, marker, numeric suffix)` caused by padding variants;
- [ ] show `count`, `max suffix`, and gap ranges per event/type;
- [ ] show the exact legacy next candidate and whether it already exists;
- [ ] show `abstracts_id_seq` and `max(abstracts.id)` as conservative evidence only;
- [ ] report related hard-delete/foreign-key risk;
- [ ] finish with separate machine-readable `expand_blocker_count` and `cutover_blocker_count` summaries.

The script must not contain INSERT, UPDATE, DELETE, ALTER, CREATE, DROP, TRUNCATE, or sequence mutation.

Classify only structural conditions that make additive DDL/backfill unsafe as expand blockers. NULL, malformed, prefix-mismatched, and type-mismatched legacy rows are cutover blockers: preserve them for reviewed reconciliation rather than preventing the backward-compatible schema expansion.

### Task 2.2: Write manifest preparation SQL

**Create:** `sql/abstract-tracking-setup/01_prepare_manifest.sql`

Output columns:

```text
snapshot_fingerprint
abstract_id
event_id
event_code
current_presentation_type
current_tracking_id
parsed_prefix
parsed_marker
parsed_sequence
anomaly_codes[]
proposed_action
proposed_active_prefix
observed_floor
historical_floor
approved_by
approved_at
approval_reason
```

Rules:

- proposed actions are suggestions only;
- approval columns are empty in generated output;
- no apply script acts on an unapproved row;
- hash/fingerprint current row values so stale approvals are rejected;
- exclude PII.

**Create:**

- `sql/abstract-tracking-setup/manifest/anomaly-decisions.csv.example`
- `sql/abstract-tracking-setup/manifest/series-floors.csv.example`
- `sql/abstract-tracking-setup/manifest/event-namespaces.csv.example`

`anomaly-decisions.csv` columns:

```text
snapshot_fingerprint,abstract_id,action,approved_active_prefix,approved_by,approved_at,approval_reason
```

`series-floors.csv` has exactly two rows (oral and poster) for every approved namespace, including zero-current and archived/restorable events. A permanently non-restorable event is not a concept in this delivery, so it is never omitted. Columns:

```text
event_id,presentation_type,approved_floor,evidence_source,approved_by,approved_at,approval_reason
```

`event-namespaces.csv` has exactly one row for every event with existing abstracts, every event with an active abstract category, and the configured default abstract event, including events with zero current abstracts:

```text
event_id,approved_prefix,padding_width,approved_by,approved_at,approval_reason
```

It must resolve unsafe event codes, case-insensitive prefix conflicts, and historic-prefix decisions explicitly. No migration derives an unsafe/truncated prefix or guesses a namespace from an anomalous abstract row.

The runbook copies the examples to an operator-only directory outside git, fills them, hashes a documented canonical serialization of each reviewed rowset, and records the expected digests in a separately controlled deployment record. It creates persistent, access-controlled staging tables keyed by a UUID `migration_batch_id`. A distinct non-owner one-shot `conference_manifest_loader` connection runs literal-path `psql -c "\copy ... FROM '/restricted/literal-file.csv' CSV HEADER"` commands because `\copy` does not interpolate psql `-v` variables. A migrator-owned freeze function validates coverage/approvals/uniqueness, recomputes deterministic rowset digests and compares them with the expected recorded values, then sets `frozen_at`. Frozen-row triggers reject INSERT/UPDATE/DELETE and batch-metadata hash rewrites even from normal operator paths. `02_online_backfill.sql` and `03_cutover.sql` accept only `-v migration_batch_id=...`, recompute/validate the frozen digests and consume that immutable batch. Never commit production manifests because approver identities and operational evidence belong in the restricted deployment record. After verified cutover, revoke loader login/DML and retain the rows/digests as deployment evidence according to policy.

### Task 2.3: Create and load immutable staging batches

**Create:** `sql/abstract-tracking-setup/01_stage_manifest_tables.sql`

The migrator-owned script creates batch metadata plus three staging tables keyed by `migration_batch_id`, with primary/check constraints, frozen-row mutation triggers, and a `frozen_at` timestamp. It also installs a dormant pre-`0028` guard trigger on legacy abstract writes. Exact runbook order immediately before guarded `0028`; the same namespace/floor batch is reused by history backfill/cutover while anomaly decisions may be refreshed through a separately versioned, frozen superseding batch:

1. run `01_stage_manifest_tables.sql` with `$...MIGRATION_DATABASE_URL`;
2. provision a short-lived non-owner `conference_manifest_loader` login with INSERT on only the unfrozen staging rows; the table-owning migrator is not used as the CSV loader;
3. insert one UUID batch metadata row through a guarded migrator function;
4. run three separate literal-path `psql -c "\copy ... FROM '/absolute/restricted/file.csv' CSV HEADER"` commands using the loader URL;
5. acquire the exclusive cutover advisory lock in the guarded freeze call; recompute canonical rowset digests, check coverage/approvals/duplicates, set `frozen_at`, and activate the pre-`0028` guard. After this point, old NULL->tracking updates at or below an approved floor, incompatible type-marker changes, and hard deletes fail closed; namespace/event-code/category activation and destructive admin mutations for covered events are also blocked until `0028` commits. No human review or batch reload occurs before `0028`;
6. revoke/expire the loader credential and prove INSERT/UPDATE/DELETE/hash rewrite fails for loader, runtime, read-only, and ordinary operator credentials; the freeze trigger is the owner-bypass defense used by consumer scripts in addition to digest recomputation;
7. use the same immutable UUID for `02_online_backfill.sql` and later `03_cutover.sql`; never reload or mutate it between backfill and cutover.

The script and runbook provide exact table/column names and literal commands. Both consumer scripts abort if the batch is absent, unfrozen, digest recomputation differs, already consumed by a different environment, or its snapshot fingerprint is stale.

### Task 2.4: Document operator evidence

**Create:** `sql/abstract-tracking-setup/README.md`

Document how to inspect:

- point-in-time backups;
- historical database exports;
- email-provider records containing tracking IDs;
- old application logs;
- serial sequence state;
- current identifier distribution.

Document the rule:

```text
approved floor = max(observed committed suffix, trustworthy historical evidence)
```

If evidence is uncertain, choose a conservative higher floor. Extra gaps are harmless; reuse is not.

### Task 2.5: Review SQL safety

Run against a disposable database and use PostgreSQL transaction read-only enforcement to prove the preflight cannot write.

Expected incident result:

```text
event PRIS-2026 / poster
P022 exists
legacy candidate P022 exists = true
approved seed >= 22
next allocator candidate = P023
```

This P023 expectation is conditional on the reviewed PRIS poster floor being 22; a higher evidence-backed floor must produce that floor plus one.

Checkpoint:

```bash
git commit -m "docs(abstracts): add tracking migration preflight contract"
```

---

## 8. Phase 3 — Additive Database Schema and Expand Migration 0028

### Task 3.1: Write schema contract tests first

**Create:** `src/modules/abstracts/tracking.repository.test.ts`

Use Drizzle `getTableConfig` where suitable and assert exact names:

- `abstract_tracking_namespaces`;
- `abstract_tracking_counters`;
- `abstract_tracking_allocations`;
- `abstract_tracking_identifiers`;
- `abstract_tracking_runtime`;
- `abstract_tracking_audit_events`;
- archive columns on `abstracts` and `events`;
- global prefix case-insensitive unique index;
- event/type counter primary key;
- allocation primary key, structured tuple uniqueness, and origin/type/sequence check;
- allocation native-render validation and append-only enforcement;
- deferred committed-allocation assignment enforcement, with the only unassigned exception being `recovery_tombstone`;
- assignment primary key and exact composite unique target `(abstract_id,event_id,presentation_type_at_assignment,tracking_id)` for the delayed current-ID FK;
- assignment one-root, one-successor, no-self-reference, and reason/predecessor constraints;
- previous-ID single-successor index;
- restrictive allocation/assignment/event/abstract FKs;
- counter non-decrease/delete trigger;
- durable audit-event table and append-only trigger;
- exact durable audit event-name CHECK/allowlist from the design, with no arbitrary runtime strings;
- widened tracking column;
- composite `(abstract.id,event_id)` uniqueness;
- runtime singleton plus `allocator_enabled`, `history_ready`, `legacy_bridge_enabled`, `abstract_writes_paused`, and pause-reason consistency checks.
- archive-state consistency checks: active rows have null reason/note/actor and archived rows have an allowed non-null reason; actor may become null through `ON DELETE SET NULL`, with provenance retained in durable audit.

Run and expect failure before schema implementation.

### Task 3.2: Modify Drizzle schema

**Modify:** `src/database/schema.ts`

Add definitions matching the design exactly.

Recommended TypeScript table names:

```ts
abstractTrackingNamespaces
abstractTrackingCounters
abstractTrackingAllocations
abstractTrackingIdentifiers
abstractTrackingRuntime
abstractTrackingAuditEvents
```

Extend `abstracts`:

```ts
trackingId: varchar("tracking_id", { length: 80 }).unique()
archivedAt: timestamp("archived_at", { withTimezone: true })
archivedBy: integer("archived_by").references(() => backofficeUsers.id, { onDelete: "set null" })
archiveReason: varchar("archive_reason", { length: 40 })
archiveNote: text("archive_note")
updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
```

All new audit/runtime/namespace/allocation/assignment timestamps use `timestamptz` (`withTimezone: true`). Do not make `trackingId` non-null in the expand schema migration. That is delayed until Phase 18.

Add event archival metadata without inserting `archived` into the existing enum, preventing exhaustive-client breakage.

### Task 3.3: Write `0028_abstract_tracking_allocator.sql`

**Create:** `drizzle/0028_abstract_tracking_allocator.sql`

Structure:

1. `BEGIN` and bounded lock/statement timeouts.
2. Fail-fast checks for structural expand blockers; record but do not normalize cutover anomalies.
3. Widen `abstracts.tracking_id` to varchar(80).
4. Add `abstracts` and `events` archive/update columns.
5. Add `(id,event_id)` uniqueness to abstracts.
6. Create namespace, counter, allocation, identifier-assignment, runtime, and durable audit tables.
7. Add checks, exact unique targets, one-root/one-successor indexes, and restrictive FKs.
8. Add append-only triggers for allocations, assignments, and audit events.
9. Add a deferred constraint trigger requiring every committed non-tombstone allocation to have exactly one assignment.
10. Add counter monotonic trigger rejecting decrement, key mutation, and ordinary DELETE; add a guarded `delete_unused_tracking_namespace` function whose only allowed delete proves unlocked namespace, two zero counters, and no allocation/assignment/abstract history.
11. Add namespace trigger rejecting unlock and prefix/padding/event mutation after `locked_at`.
12. Add an `abstracts` `BEFORE UPDATE` trigger that sets `updated_at = clock_timestamp()`; guarded namespace/counter functions set their own `updated_at` explicitly.
13. Add native-allocation render validation against the immutable namespace.
14. Add migration-owner `SECURITY DEFINER` functions with typed/validated arguments and `PUBLIC EXECUTE` revoked: allocate; append assignment; append allowlisted audit event; configure/lock namespace and create both counters; delete unused namespace; disable the legacy bridge; toggle the independent emergency abstract-write pause; atomic reviewed legacy import; and post-enable recovery-tombstone import. Tombstone import requires `history_ready=true` and the exclusive advisory lock. Fully schema-qualify every object and use a locked search path with `pg_catalog` first and `pg_temp` last; runtime/PUBLIC has no CREATE on referenced schemas.
15. The assignment function requires the locked abstract's current tail, validates allocation event/type plus reason/predecessor rules, and inserts its durable audit event; archive/member/event services use the allowlisted audit function inside their transaction.
16. Add archive-state consistency checks so active rows cannot retain reason/note/actor metadata and archived rows require an allowed reason; permit actor null after explicit `ON DELETE SET NULL`, with durable audit retaining provenance.
17. Validate the frozen namespace/floor batch, create every approved namespace plus both counters, and seed each counter to `GREATEST(observed current structured maximum, approved historical floor)`; insert one `floor_applied` audit per series and lock any namespace with a positive floor/current maximum.
18. Adopt the active pre-`0028` guard for pre-A binaries, then extend it into the bridge. On a NULL->non-null tracking assignment the bridge locks event/counter, validates approved prefix/marker, rejects `sequence <= last_issued_number`, or atomically advances the counter and inserts allocation/root assignment/audit for a larger candidate. It rejects a presentation-type change that keeps an incompatible old marker and blocks hard DELETE of abstracts/events once tracking state exists. It never silently rewrites the ID returned by old code.
19. Initialize allocator enabled/version 1, `history_ready=false`, `legacy_bridge_enabled=true`, and `abstract_writes_paused=false`.
20. Revoke direct allocation/counter/assignment/audit mutation and PUBLIC function EXECUTE; grant `conference_api_runtime` EXECUTE only on runtime functions, while recovery/import functions remain migrator-only. If the current API login owns application tables, create/use a non-owner runtime role before cutover and make that a deployment blocker.
21. Run internal verification queries and raise on invariant failure.
22. `COMMIT`.

`0028` is a **guarded compatibility migration**, not historical backfill. It consumes a frozen namespace/floor batch, protects the no-reuse boundary immediately, and leaves only pre-existing allocation/assignment history for later online import. Temporary database guards make pre-A hard-delete/member-delete/event-delete paths fail closed after expand; they cannot erase tracking state while Release A rolls out. Release A is deployed immediately off-hours to replace those legacy routes.

The batch must be staged, digest-verified, and frozen before `0028` starts. The migration receives `-v migration_batch_id=...`; absent, unfrozen, stale, or reused batches abort before DDL/DML. This ordering closes the only window in which a deleted historical ID could be reissued by the old count-based binary.

Important SQL rules:

- use `lower(prefix)` unique index rather than requiring `citext`;
- format native IDs using `repeat('0', greatest(width - length(number::text), 0)) || number::text`;
- do not use `lpad` in a way that truncates values longer than width;
- use idempotent guards only where rerunning is explicitly safe;
- do not silently skip structural blockers or unreported cutover anomalies;
- do not update any valid existing `abstracts.tracking_id`;
- validate digit length before any `::bigint` cast so an oversized legacy suffix is reported, not allowed to abort unpredictably;
- preserve every existing `abstracts.tracking_id` byte-for-byte; import/normalization belongs to later online history backfill/cutover;
- revalidate the batch snapshot and current maxima immediately before commit; stale namespace/floor evidence aborts the whole migration.

### Task 3.4: Add expand verification SQL

**Create:** `sql/abstract-tracking-setup/02_expand_verify.sql`

Verify:

- allocator enabled, history not ready, legacy bridge enabled, and abstract-write pause false;
- every approved namespace has O/P counters at or above observed/approved floors and positive-floor namespaces are locked;
- pre-existing history remains unimported, while any post-migration bridge write has an atomic allocation/root assignment/audit;
- no existing `(id,tracking_id,presentation_type)` value changed;
- allocator/bridge functions, triggers, roles, and archive checks exist;
- valid before/after `(id,tracking_id)` hashes match;
- namespace prefix uniqueness holds;
- no forbidden cascade path exists.

`02_expand_verify.sql` is strictly read-only and safe for the production read-only role.

**Create:** `sql/abstract-tracking-setup/02_constraint_probes.sql`

On disposable test/clone only, run mutation probes inside a transaction that always rolls back. Using both migrator and runtime-role sessions where relevant, prove counter decrement/delete, allocation/assignment/audit mutation, invalid native render, orphan allocation, second root/self-loop/branch/cycle, cross-event/type assignment, tombstone assignment, unauthorized DML/function calls, and issued-namespace deletion all fail; prove guarded zero-history cleanup and `updated_at` advancement succeed. The script refuses production-like database identity and is never run against production.

### Task 3.5: Run focused validation

```bash
npx tsx --test src/modules/abstracts/tracking.repository.test.ts
npm run build
# First run the test-only staging helper from Task 0.2: load/freeze the
# fixture namespace/floor/anomaly CSVs as batch 00000000-0000-0000-0000-000000000001
# through TEST_MANIFEST_LOADER_DATABASE_URL and verify its canonical digests.
psql "$TEST_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="00000000-0000-0000-0000-000000000001" \
  -f drizzle/0028_abstract_tracking_allocator.sql
psql "$TEST_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/02_expand_verify.sql
TEST_RUNTIME_DATABASE_URL="$TEST_RUNTIME_DATABASE_URL" \
TEST_MIGRATION_DATABASE_URL="$TEST_MIGRATION_DATABASE_URL" \
psql "$TEST_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/02_constraint_probes.sql
```

Expected:

- clean schema migrates;
- baseline-through-0027 bootstrap and separated test-role/batch assertions pass before 0028;
- an unreported structural blocker aborts before changes;
- a known malformed/current mismatch is untouched and remains a reported cutover blocker;
- rerunning verification is read-only;
- migration transaction rolls back completely on failure.

Checkpoint:

```bash
git commit -m "feat(abstracts): add durable tracking allocator schema"
```

---

## 9. Phase 4 — Transactional Allocator Repository

### Task 4.1: Create guarded integration harness

**Create:** `src/modules/abstracts/test-database.ts`

Follow existing Team Registration integration safety patterns:

- validate `TEST_DATABASE_URL` before importing application DB modules;
- use an explicit test schema/database;
- expose setup/teardown helpers;
- seed only minimum event/user/category/abstract fixtures;
- clean only test-owned rows in FK-safe order;
- close pools in `after` hooks.

### Task 4.2: Define repository interface

**Create:** `src/modules/abstracts/tracking.repository.ts`

Export:

```ts
export type AbstractTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function acquireTrackingCutoverLock(
  tx: AbstractTransaction,
): Promise<void>;

export async function getTrackingRuntimeMode(
  tx: AbstractTransaction,
): Promise<{
  enabled: boolean;
  version: number;
  historyReady: boolean;
  legacyBridgeEnabled: boolean;
  abstractWritesPaused: boolean;
}>;

export async function allocateTrackingId(
  tx: AbstractTransaction,
  input: { eventId: number; presentationType: AbstractPresentationType },
): Promise<TrackingReservation>;

export async function appendTrackingAssignment(...): Promise<void>;
export async function appendTrackingAuditEvent(...): Promise<void>;
export async function listTrackingHistory(...): Promise<TrackingIdentifierView[]>;
export async function resolveTrackingIdentifier(...): Promise<...>;
```

`allocateTrackingId` invokes the database allocator function and verifies exactly one returned allocation. `appendTrackingAssignment` invokes the guarded assignment function and verifies exactly one inserted row. Repository code never updates counters or inserts native allocation rows directly. It contains no Fastify, email, Drive, or UI dependencies.

### Task 4.3: Write integration tests before implementation

**Create:** `src/modules/abstracts/tracking.integration.test.ts`

Tests:

1. first poster allocation returns P001;
2. first oral allocation returns O001 independently;
3. event B has independent counters;
4. PRIS P022 fixture returns P023 even if row count implies P022;
5. counter 20 plus structured allocation P022 self-heals to P023;
6. archived/deleted gaps do not affect next number;
7. number 1000 is not truncated;
8. first committed issuance locks prefix;
9. event-code edit does not alter prefix;
10. failed enclosing transaction leaves counter, allocation, assignment, and audit unchanged;
11. 100 concurrent same-key transactions commit 100 distinct values;
12. different events proceed independently; oral/poster have separate number series but briefly share the event namespace lock;
13. a candidate already reserved only as an old alias or opaque allocation skips to the next value and emits retry result;
14. three collisions fail closed;
15. counter overflow fails closed;
16. missing namespace, either missing pre-created counter, or runtime mismatch returns typed availability error;
17. direct counter decrement/key mutation/delete is rejected;
18. invalid native rendered string is rejected;
19. allocation/assignment/audit UPDATE or DELETE is rejected;
20. a second root, self-reference, branch, disconnected predecessor, and cycle are rejected;
21. a recovery tombstone reserves an exact string without requiring an abstract;
22. recovery-tombstone import is rejected until `history_ready=true`, bridge disabled, and exclusive cutover lock held; a two-connection legacy-submit race cannot reserve the same string;
23. append assignment must reference an existing allocation and locked abstract.
24. structured allocation event/type mismatch, known-event opaque mismatch, and any recovery-tombstone assignment are rejected.
25. with a frozen pre-`0028` batch, an old binary candidate at/below the approved floor is rejected, a candidate above the floor is allowed and later imported idempotently, and hard delete/type-marker drift is rejected before `0028` commits.

Every test that commits a native/legacy allocation must also create its abstract and assignment in that transaction; allocator-only tests roll back intentionally. This keeps tests aligned with the deferred no-orphan constraint instead of normalizing an invalid committed allocation.

Add concurrent submit-vs-event-archive/delete and resubmit-vs-event-archive tests for both possible lock winners. A submit/resubmit that wins may commit before archival; archival that wins causes the later submission transaction to re-read archived state and fail without allocation.

For concurrency assertions:

- compare set size to committed row count;
- sort numeric suffixes and confirm they are unique and above the seed;
- do not assert wall-clock ordering between client promises.

### Task 4.4: Implement fixed locking and allocation

Lock order for allocation and persistence:

```text
shared cutover advisory xact lock
-> event FOR UPDATE
-> existing abstract FOR UPDATE (resubmit only)
-> active category FOR UPDATE (when category is used)
-> namespace FOR UPDATE
-> counter FOR UPDATE
-> allocation INSERT
-> abstract INSERT/UPDATE
-> assignment/files/co-authors/revision rows
```

Algorithm:

```text
lock event and recheck active/submission policy
lock/recheck active category after event and existing abstract, if applicable
read namespace
ensure namespace plus both counters exist
lock counter
allocationMax = max(structured allocation sequence)
candidate = max(counter.lastIssued, allocationMax) + 1
format and validate
INSERT allocation ON CONFLICT (tracking_id) DO NOTHING RETURNING
if no row returned, advance and repeat (max 3)
update counter
set namespace locked_at on first successful allocation
return reservation
```

Implement this mutation inside the migration-owned `SECURITY DEFINER` function. The allocation row intentionally exists before the service knows the abstract ID; the service inserts the abstract and assignment before the same outer transaction commits. If any later step fails, allocation and counter update roll back with it.

The function uses `ON CONFLICT DO NOTHING RETURNING`, so an opaque/tombstone/old-alias collision does not abort the transaction. The final abstract and assignment inserts keep their unique/FK constraints as defense in depth. A late `23505` aborts the complete transaction; permit at most one fresh whole-transaction retry, then return the typed 503. Never catch `23505` and continue in an already-aborted PostgreSQL transaction.

### Task 4.5: Add package scripts

**Modify:** `package.json`

```json
{
  "scripts": {
    "test:abstract-tracking": "tsx --test src/modules/abstracts/**/*.test.ts",
    "test:abstract-tracking:integration": "tsx --test src/modules/abstracts/tracking.integration.test.ts"
  }
}
```

### Task 4.6: Pass tests

```bash
npm run test:abstract-tracking
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:abstract-tracking:integration
npm run build
```

Checkpoint:

```bash
git commit -m "feat(abstracts): add transactional tracking allocator"
```

---

## 10. Phase 5 — Submission Service and Compatibility Release A

### Task 5.1: Extract submission persistence boundary

**Create:** `src/modules/abstracts/submission.service.ts`

The service receives already validated domain data and uploaded-file metadata. It owns the database transaction but not multipart parsing or Drive upload.

Route-side validation before upload is only an early user-experience check. Inside `persistNewAbstract`, acquire advisory -> event lock, recheck event archive/submission window, then lock/recheck `abstract_categories` by `(category_id,event_id,is_active)` with a mode that conflicts with category deactivation/update before allocating. No abstract may commit against a category/event that changed while Drive upload was in progress.

Suggested interface:

```ts
export async function persistNewAbstract(input: PersistNewAbstractInput):
  Promise<PersistedAbstractSubmission>;

export async function persistAbstractResubmission(
  input: PersistAbstractResubmissionInput,
): Promise<PersistedAbstractResubmission>;
```

Inject repository functions in tests to make transaction behavior observable.

### Task 5.2: Write service tests first

**Create:** `src/modules/abstracts/submission.service.test.ts`

Test:

- [ ] allocator called inside transaction;
- [ ] event and active category are re-read/locked inside the transaction before allocation;
- [ ] concurrent event archive or category deactivation wins => submission fails and no allocation/abstract commits;
- [ ] abstract initial INSERT includes final tracking ID;
- [ ] no insert-null/count/update sequence exists;
- [ ] allocation, abstract, root assignment, and audit rows are inserted in the same transaction;
- [ ] files/co-authors failure rolls everything back;
- [ ] success returns only committed ID;
- [ ] controlled allocator errors retain their status/code;
- [ ] an authoritative in-transaction write-pause check blocks both initial submit and same-/different-type resubmit before mutation;
- [ ] retry is bounded to one whole transaction for `40001` or `40P01`;
- [ ] unique collision cap maps to 503, not generic 500;
- [ ] no email runs inside the transaction;
- [ ] no Drive cleanup runs until the transaction rejects.

### Task 5.3: Add compatibility runtime switch

Release A behavior:

1. every submit/resubmit and touched archive/member/event/backoffice tracking mutation acquires the shared advisory lock as its first database lock;
2. every participating write transaction explicitly uses `READ COMMITTED`; after the advisory lock it reads `abstract_tracking_runtime FOR SHARE` before domain locks, while startup/readiness rejects a non-READ-COMMITTED default;
3. submit/resubmit performs an early best-effort read before Drive upload and then authoritatively reads runtime inside its transaction; a race rejection compensate-cleans uploaded files and alerts if cleanup fails;
4. if `abstract_writes_paused` is true, both same-type and type-changing writes return `503 ABSTRACT_WRITES_PAUSED` without database mutation; reads and repair/admin operations remain available;
5. allocator is enabled by guarded `0028`, so Release A initial submit uses it immediately and never runs COUNT;
6. same-type resubmit retains ID; while `history_ready=false`, different-type resubmit and history-dependent tracking-shape corrections return `503 TRACKING_HISTORY_INITIALIZING` at the authoritative check;
7. after history cutover, different-type resubmit allocates/aliases normally.

Hard guard:

- Release A source contains no callable COUNT allocator; compatibility for pre-A binaries exists only in the database bridge trigger;
- log allocator version/path without PII;
- add a test proving every initial submit calls the durable allocator and history-initializing blocks only type-changing resubmit/history-dependent mutations;
- add mixed-version DB tests: old binary candidate `<= floor` is rejected; old candidate above floor atomically advances counter/registers history; incompatible legacy type change is rejected; Release A then allocates above that bridge advance.
- repeat boundary tests with an attempted REPEATABLE READ transaction and assert it is rejected/retried rather than observing stale runtime state.

### Task 5.4: Replace submit route persistence

**Modify:** `src/routes/public/abstracts/submit.ts`

Remove from the enabled path:

- `sql<number>count(*)` query;
- `runningNumber` derived from row count;
- insert with null then update tracking ID.

Retain:

- multipart validation;
- word-count validation;
- event/category resolution;
- Drive upload;
- cleanup of uploaded files after persistence failure;
- post-commit background email behavior.

Change:

- call service with validated input;
- use `request.log` rather than bare `fastify.log` where request context matters;
- return additive `identifierChange`, `trackingAliases`, and `requestId` fields;
- add `X-Request-Id` response header;
- do not advertise automatic POST/PATCH retry or send `Retry-After` until HTTP idempotency exists; return a stable support message and `requestId`;
- rethrow `ApiError` rather than replacing it with anonymous 500.

### Task 5.5: Route-level contract test

**Create:** `src/routes/public/abstracts/submit.test.ts`

Add a route/service injection seam and test:

- old required 201 keys remain;
- ID is `approvedFloor + 1` (`P023` when the approved floor is 22) in the incident fixture;
- raw constraint details never appear;
- 503 response contains stable code/requestId and does not instruct blind retry;
- emergency write pause returns `503 ABSTRACT_WRITES_PAUSED` and never uploads/inserts;
- external upload cleanup runs once after transaction failure;
- email is scheduled only after committed service success.

### Task 5.6: Full checks and staging diagnostic checkpoint

```bash
npm test
npm run test:abstract-tracking
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:abstract-tracking:integration
npm run build
```

Checkpoint — this allocator-core tag is useful for staging bisect/rehearsal only. It is **not** a valid production rollback floor after alias/archive behavior ships:

```bash
git commit -m "fix(abstracts): replace count based tracking allocation"
git tag abstract-tracking-allocator-core
```

Do not force-push or move the tag. The complete Release A artifact created after the dependent alias/archive/error/health work is the minimum post-cutover rollback floor.

---

## 11. Phase 6 — Type-changing Resubmission and Permanent Aliases

### Task 6.1: Expand resubmit service tests

Add cases:

- poster -> poster keeps ID and counter;
- poster -> oral allocates next oral ID;
- old poster ID remains registered to same abstract;
- new row points to previous ID;
- only `abstracts.tracking_id` determines current ID;
- oral -> poster later creates a fresh poster ID;
- alias chain has no branch;
- any mid-transaction failure leaves type, current ID, counter, files, co-authors, and revision state unchanged;
- concurrent resubmits serialize on `abstract FOR UPDATE`;
- second request sees `pending` and returns `ABSTRACT_NOT_OPEN_FOR_REVISION` without allocation.

### Task 6.2: Move authoritative checks under lock

**Modify:** `src/routes/public/abstracts/user.ts` and service.

Resolve owned abstract/event identity without a row lock and perform an early runtime check before external upload so known history/write-pause state does not upload needlessly. Because state may change, repeat authoritative checks inside the transaction:

1. acquire shared cutover advisory lock;
2. lock the event `FOR UPDATE` and recheck archive/submission policy;
3. lock and re-read the owned abstract by `(id,event_id,user_id)` `FOR UPDATE`;
4. verify abstract not archived and `status = revision`;
5. lock/recheck the active category/event association in the canonical event -> abstract -> category order;
6. compare locked current type with target type;
7. branch explicitly: same-type uses no allocation/assignment; different type with `history_ready=false` throws `TRACKING_HISTORY_INITIALIZING` and compensate-cleans any race upload; different type with history ready invokes the allocator;
8. only in the history-ready different-type branch, insert the permanent allocation and append assignment with `previous_tracking_id` equal to the locked current tail;
9. update current type/ID/content/status;
10. replace files/co-authors;
11. mark open revision request resubmitted;
12. commit.

Never rely solely on the pre-upload read because another request can change state while files upload.

For the existing v1 route, preserve its current 400 status when the abstract is not open for revision and add the stable code. The tracking-ID rotation is an intentional semantic behavior change already approved for this product; before rollout, inventory every known consumer and provide old/new contract fixtures. If an uncoordinated consumer is discovered, gate rotation behind an explicit opt-in/versioned route instead of silently changing that consumer.

### Task 6.3: Extend user API views

User list/edit endpoints add:

```ts
trackingAliases: string[];
trackingIdHistory: TrackingIdentifierView[];
```

Resubmit success adds:

```ts
identifierChange: {
  changed: boolean;
  reason: "PRESENTATION_TYPE_CHANGED" | null;
  previousTrackingId: string | null;
  trackingId: string;
};
```

Preserve all existing required fields and HTTP 200 status.

### Task 6.4: Pass tests

```bash
npm run test:abstract-tracking
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:abstract-tracking:integration
npm test
npm run build
```

Checkpoint:

```bash
git commit -m "feat(abstracts): preserve aliases across type changes"
```

---

## 12. Phase 7 — Identifier Resolution and Backoffice Search

### Task 7.1: Add schemas

**Modify:** `src/schemas/abstracts.schema.ts`

Add:

```ts
trackingId: z.string().min(1).max(80).optional()
trackingMatch: z.enum(["any", "canonical", "alias"]).default("any")
archiveStatus: z.enum(["active", "archived", "all"]).default("active")
```

The tracking schema deliberately has **no** `.trim()`: issued and opaque legacy identifiers are exact, case-sensitive decoded query values, and lookup/filter must not normalize leading/trailing whitespace. Trimming remains valid only for new namespace configuration.

Define separate schemas: the public/backoffice abstract archive route accepts only `manual|withdrawn|duplicate_submission`; the internal domain schema additionally permits guarded `member_deleted|legacy_anomaly`. Event route accepts `completed|cancelled|superseded|manual`. Optional note is normalized to null when blank or otherwise trimmed to 1–1000 characters. Tests prove route input cannot forge internal reasons and idempotency compares the normalized `(reason,note)` pair: exact repeat is 200/no new audit; changing either returns `ARCHIVE_REASON_CONFLICT`.

### Task 7.2: Create identifier resource route tests

**Create:** `src/routes/backoffice/abstract-identifiers.test.ts`

Test:

- canonical lookup;
- alias lookup;
- absent ID 404;
- out-of-scope reviewer also 404;
- admin sees authorized archived result;
- response reports requested/match/canonical ID, `issuedAt`, API-enum `assignmentReason`, and a derived `replacement` object for an alias;
- canonical/tail identifier has `replacement: null`;
- assignment `assigned_at` maps to `issuedAt`; direct successor `assigned_at` maps to `replacement.replacedAt`;
- lowercase database reason maps explicitly to the documented uppercase API enum and never leaks raw internal values accidentally;
- no redirect and no PII over-fetching;
- request ID header/body match.

**Create:** `src/modules/abstracts/backoffice-access.ts`, `src/modules/abstracts/backoffice-access.test.ts`

Extract one shared visibility predicate used by list, detail-by-ID, identifier resolution, broad search, and email/operator lookup. Admin/organizer can see all authorized archive states; a reviewer must match both `assignedCategories` and, when configured, `assignedPresentationTypes`. A reviewer with no valid assigned category sees none. Add event scope only if the authenticated role model supplies an explicit event assignment—do not invent a different rule for alias lookup. Missing and out-of-scope exact lookups both return 404.

### Task 7.3: Implement resource-oriented lookup

**Create:** `src/routes/backoffice/abstract-identifiers.ts`

Route:

```http
GET /api/backoffice/abstract-identifiers/resolve?trackingId=<exact URL-encoded value>
```

Use an exact, case-sensitive query parameter with decoded length 1–80 and the shared visibility predicate above. The query form supports grandfathered opaque IDs that cannot safely inhabit a path segment. Do not log lookup strings as metrics labels.

Implement one explicit response mapper from allocation/assignment rows to the API contract. It derives replacement information from the direct successor, does not confuse the original assignment reason with the replacement reason, and returns `replacement: null` for the current tail.

### Task 7.4: Extend abstract list/search

**Modify:** `src/routes/backoffice/abstracts.ts`

- add exact ID filter through allocation/assignment `EXISTS`/join;
- broad search matches current and aliases;
- ensure count query uses the same predicates without multiplying rows;
- preserve pagination totals;
- default archive status to active;
- only admin/organizer may request archived/all;
- include optional `matchedTrackingId`, `trackingIdMatch`, and history in detail response;
- batch-fetch histories for list results; avoid N+1.

### Task 7.5: Register route

**Modify:** `src/index.ts`

Register under protected backoffice prefix. Preserve existing route order and authentication hook.

### Task 7.6: Verify

```bash
npx tsx --test src/routes/backoffice/abstract-identifiers.test.ts
npm test
npm run build
```

Checkpoint:

```bash
git commit -m "feat(abstracts): resolve canonical and alias tracking ids"
```

---

## 13. Phase 8 — Abstract Archive Service and Member Deletion

### Task 8.1: Write archive tests first

**Create:**

- `src/modules/abstracts/archive.service.ts`
- `src/modules/abstracts/archive.service.test.ts`

Test before implementation:

- manual archive sets metadata and is idempotent;
- archive preserves current ID/history/counter/files/co-authors/reviews/revisions;
- manual restore clears metadata when author still exists;
- `member_deleted` archive with null author cannot restore;
- archive never changes review status;
- archived rows are excluded from active user/public queries;
- archive operations require authorized actor;
- member deletion archives all authored abstracts and returns count;
- member deletion invalidates/supersedes active confirmation tokens;
- transaction rollback preserves user and abstracts if any archival step fails.
- concurrent member deletion/resubmit follows deterministic event->abstract ordering without deadlock; bounded whole-transaction `40P01` retry remains defense in depth.
- active/archive metadata consistency checks reject partial archive state; endpoint callers cannot forge `member_deleted` or `legacy_anomaly` reasons.

### Task 8.2: Implement archive service

Service methods:

```ts
archiveAbstract(tx, { abstractId, actorId, reason, note, now })
restoreAbstract(tx, { abstractId, actorId, now })
archiveAbstractsForDeletedMember(tx, { userId, actorId, now })
```

Rules:

- acquire the shared cutover lock; for one abstract resolve event ID, lock event, then abstract; for member bulk archival resolve IDs first, lock distinct events in ascending ID order, then abstracts in ascending ID order;
- repeated same archive is idempotent;
- conflicting new archive reason returns `ARCHIVE_REASON_CONFLICT`; correction requires permitted restore then a new archive so audit history remains explicit;
- restore checks author link and reason policy;
- insert durable audit event in the same transaction and emit the operational application log after commit.

### Task 8.3: Replace hard delete in member route

**Modify:** `src/routes/backoffice/members.ts`
**Create:** `src/routes/backoffice/members.abstract-archive.test.ts`

Remove:

```ts
delete reviews on the user's authored abstracts
delete the user's abstracts
```

Replace with:

1. archive owned abstracts as `member_deleted`;
2. set their `user_id = NULL`;
3. preserve reviews from other reviewers;
4. delete reviews where the deleted user is the reviewer only, as required by reviewer FK/privacy policy;
5. invalidate active confirmation tokens;
6. continue allowable member/order/registration cleanup;
7. return additive `archivedAbstractCount` and `identifiersPreserved: true`.

Ensure existing user deletion succeeds with the now-null abstract FK.
The catch path must return the standard safe envelope; never expose caught `error.message` in `details`.

Refactor `supersedeActiveTokens` in `src/services/abstractConfirmation.ts` to accept an optional transaction client (or add a transaction-only variant). The current helper uses global `db`; member deletion must invalidate tokens through its existing transaction so archive/unlink/token state commits or rolls back atomically and follows the same lock order.

### Task 8.4: Add archival resource endpoints

**Modify:** `src/routes/backoffice/abstracts.ts`
**Create:** `src/routes/backoffice/abstract-archival.test.ts`

Add:

```http
PUT    /api/backoffice/abstracts/{id}/archival
DELETE /api/backoffice/abstracts/{id}/archival
```

- PUT body requires reason and optional bounded note;
- reject unknown fields; ordinary admin/organizer accepts only `manual|withdrawn|duplicate_submission`, while `member_deleted` and `legacy_anomaly` are available only through their guarded service/migrator paths;
- both acquire the shared cutover lock and abstract row lock, then are idempotent according to current state;
- only admin/organizer;
- return current resource representation and archive metadata;
- return exact `archived:true` PUT and `archived:false` DELETE envelopes/effects from the design;
- restore failures use stable 409 codes.

### Task 8.5: Gate every abstract operation

Add `archived_at IS NULL` or explicit archived rejection in:

- `src/routes/public/abstracts/user.ts` list/edit/resubmit;
- `src/routes/public/abstracts/confirm.ts`;
- `src/services/abstractConfirmation.ts`;
- backoffice revision/status/resend/manual-confirm routes;
- `src/routes/backoffice/email-manual.ts`;
- `src/routes/backoffice/email-retrosend.ts`.

For archived rows:

- public owner lists/edit reads omit archived rows (404/absent); an authenticated owner resubmitting their known archived ID gets 409 `ABSTRACT_ARCHIVED`; a non-owner gets indistinguishable 404;
- email batch flows skip and report aggregate skip reason;
- confirmation tokens cannot be consumed;
- no background email is sent.

Any manual-email, retrosend, or operator flow that accepts/searches a tracking ID must resolve through allocations/assignments so old aliases remain usable; canonical-only behavior must be explicitly named if a field is not intended as identifier lookup.

### Task 8.6: Verify

```bash
npx tsx --test src/modules/abstracts/archive.service.test.ts
npm run test:abstract-tracking
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:abstract-tracking:integration
npm test
npm run build
```

Checkpoint:

```bash
git commit -m "feat(abstracts): archive submissions instead of deleting history"
```

---

## 14. Phase 9 — Event Namespace and Event Archival API

### Task 9.1: Extend event schemas

**Modify:** `src/schemas/events.schema.ts`

Add optional event-create inputs:

```ts
abstractTrackingPrefix: z.string().trim().min(1).max(50).optional()
trackingPaddingWidth: z.coerce.number().int().min(1).max(12).default(3)
```

The prefix must also satisfy `^[A-Z0-9]+(?:-[A-Z0-9]+)*$`; unsafe legacy IDs remain query-resolvable opaque records but cannot become native namespaces.

Do not include namespace fields in the general event PATCH spread. Namespace mutation uses a dedicated resource so it cannot accidentally track `eventCode`.

Add dedicated PUT schema and event archival schema.

Event archive PUT rejects unknown fields, accepts only `completed|cancelled|superseded|manual`, and shares the optional trimmed/null 1–1000-character note contract from the design.

Because the current `updateEventSchema` is derived from `createEventSchema.partial()` and the route spreads parsed data into the event update, explicitly `.omit({ abstractTrackingPrefix: true, trackingPaddingWidth: true })` from the general PATCH schema. When an explicit or valid derived namespace is present, event creation inserts the event, namespace, and both counters in one transaction; a partial configured namespace cannot commit. The compatibility case with no valid derived prefix intentionally commits the event alone with `trackingNamespaceConfigured: false`.

### Task 9.2: Add event namespace endpoints

**Modify:** `src/routes/backoffice/events.ts`

Add:

```http
GET /api/backoffice/events/{id}/abstract-tracking-namespace
PUT /api/backoffice/events/{id}/abstract-tracking-namespace
```

Behavior:

- event create initializes prefix from explicit input or current eventCode;
- invalid explicit prefix returns `INVALID_TRACKING_PREFIX` and no event is created;
- if prefix is omitted and a legacy-compatible eventCode fails native grammar, event creation still succeeds with additive `trackingNamespaceConfigured: false`; no namespace is guessed/sanitized and abstract submission remains unavailable until valid namespace PUT;
- namespace creation atomically creates oral and poster counters at zero;
- same PUT is idempotent;
- different PUT while unlocked updates prefix/padding;
- different PUT after first issuance returns 409;
- prefix conflict is 409;
- invalid/overlength is controlled validation error;
- eventCode PATCH never changes namespace.

GET/PUT success and error bodies follow the exact design contract. The guarded PUT function takes the shared cutover lock, event row, then namespace/counters; concurrent PUT, archive/delete, and first allocation serialize. Before issuance, the last completed authorized PUT wins; after issuance, mutation is rejected.

Implement PUT through the guarded namespace function, which locks event first and then existing namespace/counters. Add concurrent PUT-vs-event-archive/delete/allocation tests for both lock winners. Do not lock namespace before event.

**Modify:** `src/routes/backoffice/abstractCategories.ts`

Creating or reactivating an abstract category after cutover requires a configured namespace and both counters. In one advisory -> event -> category -> namespace transaction, either confirm that state or reject with `TRACKING_NAMESPACE_NOT_CONFIGURED`; do not let a newly active category make readiness fail later. Category deactivation uses the same event -> category order and conflicts with submit's category lock.

### Task 9.3: Harden event deletion and add archival

Existing `DELETE /api/backoffice/events/{id}`:

- may delete only a truly unused event with unlocked/no-history namespace;
- otherwise returns `EVENT_HAS_TRACKING_HISTORY` or existing dependency conflict;
- must never cascade namespace/counter/identifier history.
- acquires the shared cutover advisory lock before event/dependency locks.
- calls `delete_unused_tracking_namespace` inside the event-delete transaction rather than directly deleting counters/namespaces.

Add:

```http
PUT    /api/backoffice/events/{id}/archival
DELETE /api/backoffice/events/{id}/archival
```

Archived event effects:

- disable new abstract submission;
- preserve event, categories, abstracts, namespace, counters, and history;
- exclude archived events from public event/ticket/workshop/sponsor discovery, student-eligibility creation, free/quick registration, payment preview/create-intent, and new/update team-registration flows in `src/routes/public/events.ts`, `tickets.ts`, `workshops.ts`, `sponsors.ts`, `studentEligibility.ts`, `src/routes/registrations/free.ts`, `quick.ts`, `src/routes/payments/index.ts`, and the team-registration event-context/public routes;
- existing team-registration payment/status/read operations needed for reconciliation remain readable, but no new OTP draft/create/update/submit action may advance an archived event;
- existing payment webhook/status/refund/reconciliation paths continue processing already-created financial state; archive blocks only new preview/create-intent/registration acquisition paths;
- every new-registration, payment preview/create-intent that persists intent/order state, student-eligibility create, and team draft/create/update/submit transaction locks/rechecks the event row before its write using the archive-compatible order; a route-side precheck alone is insufficient because archive may commit between check and insert;
- sponsor application creation also locks/rechecks the event inside its write transaction; archived events remain visible only where documented for read/reconciliation and cannot accept new sponsor applications;
- allow restore only when status is `draft` or `published` and `endDate >= now`; otherwise return `RESTORE_NOT_ALLOWED`. Admin may correct status/dates while archived, but public discovery/submission/registration remains disabled until restore commits.

Archive/restore is row-locked and idempotent, inserts a durable audit event in the same transaction, and returns the response/effect representation defined in the design.

### Task 9.4: Tests

**Create:** `src/routes/backoffice/events.tracking.test.ts`

Test:

- explicit/default prefix creation;
- legacy lowercase/underscore/space eventCode with omitted prefix still creates the event as `trackingNamespaceConfigured: false`;
- explicit invalid prefix rejects the whole create transaction;
- edit before first issuance;
- lock on first committed issuance;
- rollback does not lock namespace;
- eventCode edit after issuance leaves prefix unchanged;
- hard delete blocked after history;
- archive is idempotent and preserves counters;
- submission rejects archived event.
- archived event is absent from public event/ticket/workshop/sponsor discovery;
- sponsor application POST rejects an archived event and its archive-vs-application race obeys the event lock;
- free/quick registration rejects archived event;
- student eligibility and new/update team registration reject archived event, while existing payment/status reads remain available;
- restore re-enables discovery/registration only when dates/status/dependencies satisfy the documented policy.

Checkpoint:

```bash
git commit -m "feat(events): add immutable abstract tracking namespaces"
```

---

## 15. Phase 10 — Error Envelope, Request IDs, Health, and Telemetry

### Task 10.0: Extract an injectable application factory

**Create:** `src/app.ts`, `src/app.test.ts`

**Modify:** `src/index.ts`

Move Fastify construction, hooks, error mapping, plugin/route registration, and health routes into `buildApp(options)` without listening. Keep process startup, warm-up, signal handling, and `listen` in `index.ts`. Inject allocator/health/metrics dependencies in tests. This is required because the current `index.ts` constructs and starts the server on import, making exact request/error/readiness contract tests unreliable.

Contract-test the factory with `fastify.inject()` before moving on; startup behavior must remain unchanged in the compiled entrypoint.

### Task 10.1: Standardize request ID behavior

**Modify:** `src/index.ts`, `src/errors/ApiError.ts`, and touched routes.

- set `X-Request-Id` on all responses through an `onSend` hook;
- ensure every error body contains the same `requestId`;
- preserve current v1 string `error` field;
- preserve rate-limit compatibility;
- add the same request ID to authentication and rate-limit error bodies that currently reply directly;
- map allocator errors without DB details;
- use `request.log`, not global logger, for request-bound operations.

### Task 10.2: Add exact liveness/readiness contracts

**Create:** `src/modules/abstracts/tracking.health.ts`, `src/modules/abstracts/tracking.health.test.ts`

**Modify:** `Dockerfile`

Keep `/health` byte-shape compatible for existing Railway/worker monitoring. Add:

```http
GET /health/live
GET /health/ready
```

`/health/live` performs no dependency query and returns HTTP 200 while the process can serve:

```json
{"status":"live","requestId":"req-..."}
```

`/health/ready` checks:

- DB connectivity;
- expected allocator tables/runtime row;
- if enabled, every active abstract event has namespace plus both counters and required functions;
- allocator version is supported.
- write-pause state is readable; a deliberate pause is reported but does not make the API unready.

Return HTTP 200 with `{"status":"ready","components":{"database":"ok","trackingAllocator":"ok","abstractWrites":"enabled"},"requestId":"..."}` or HTTP 503 with the same low-cardinality dependency keys and values `ok|unavailable|uninitialized|unsupported`; `abstractWrites` is only `enabled|paused`. Do not expose prefixes, IDs, counts, pause reasons, exception text, or PII publicly.

Switch the API branch of the Docker `HEALTHCHECK` from `/health` to `/health/ready`; keep the worker healthcheck branch unchanged. Contract-test that Release A with allocator enabled, bridge enabled, and valid expand state is ready, allocator-enabled broken bootstrap is unready, and an intentional write pause remains ready so Railway does not restart a healthy paused service.

### Task 10.3: Add durable audit plus structured events

Emit after commit:

```text
abstract_tracking.issued
abstract_tracking.rotated
abstract_tracking.prefix_locked
abstract.archived
abstract.restored
```

Emit on exceptional path:

```text
abstract_tracking.allocation_retry
abstract_tracking.invariant_failed
```

Safe fields only:

```text
requestId, eventId, abstractId, presentationType,
sequenceNumber, allocatorVersion, attempt, outcome, code
```

Insert `abstract_tracking_audit_events` inside the same DB transaction for issue/rotate/prefix/archive/restore/member-unlink/admin-correction. Audit stores archive state/reason and a boolean `notePresent`, never raw `archive_note`; application logs emitted after commit are telemetry, not the audit source of truth. If a valid `traceparent` header is supplied, carry it into structured logs but never a metric label.

The database audit CHECK/function allowlist is exactly the full list in Design §9.7, including migration import/normalization/floor, recovery tombstone, legacy-bridge change, cutover completion, write-pause change, and hardening. Tests parse the migration allowlist and assert every event emitted by `0028`, online backfill, `03_cutover`, operator controls, and `0029` is accepted with the exact `abstract_tracking.*` spelling; abbreviated `tracking.*` names are forbidden.

### Task 10.4: Add protected metrics

**Create:** `src/modules/abstracts/tracking.metrics.ts`, `src/modules/abstracts/tracking.metrics.test.ts`

Run `npm install prom-client` in `conference-api` so both `package.json` and `package-lock.json` change together. Expose `/metrics` only behind internal network policy plus `Authorization: Bearer $METRICS_AUTH_TOKEN`; missing/invalid credentials return 404 to avoid advertising the endpoint.

Metrics:

```text
conference_abstract_tracking_allocations_total{presentation_type,outcome}
conference_abstract_tracking_allocation_duration_seconds{presentation_type}
conference_abstract_tracking_counter_lock_wait_seconds{presentation_type}
conference_abstract_tracking_invariant_failures_total{code}
conference_abstract_tracking_alias_resolutions_total{match}
conference_abstract_archive_operations_total{resource_type,operation,outcome}
```

Never label by event/tracking/abstract/user/request ID, title, email, prefix, exception message, or URL. Use restricted structured logs/audit queries for per-event diagnosis. Tests inspect rendered metrics and reject high-cardinality/PII labels.

### Task 10.5: Add runtime health SQL

**Create:** `sql/abstract-tracking-setup/05_runtime_health.sql`

Read-only checks:

- counter below structured allocation maximum;
- null current ID;
- no matching current identifier assignment/allocation;
- multiple successors;
- multiple roots, disconnected nodes, self-reference, or recursive cycle;
- namespace unlocked despite history;
- archived/deleted ownership anomalies;
- identifier mutation trigger/constraint validity.

### Task 10.6: Add the emergency abstract-write pause

**Create:** `sql/abstract-tracking-setup/06_set_abstract_write_pause.sql`

The runtime table contains independent `abstract_writes_paused boolean NOT NULL DEFAULT false` and nullable `write_pause_reason`. A migration-owned `SECURITY DEFINER` operator function is the sole mutation path; it first acquires the exclusive transaction advisory lock `(20260813, 1)`, then locks the singleton row, requires a stable reason when enabling, clears it when disabling, updates `updated_at`, and appends `abstract_tracking.write_pause_changed` atomically. Runtime can read the state but cannot toggle it; only `conference_migrator` may execute the operator function. The exclusive lock drains existing shared-lock writers and establishes an exact pause/resume boundary.

The SQL wrapper accepts explicit `pause=true|false`, reason, actor reference, and request/change-ticket reference, asserts the migrator role, and prints only the resulting boolean/timestamp. The runbook provides exact enable/status/disable commands. Both submit and resubmit (including same-type resubmit) check pause state inside their transaction; an optional early check avoids beginning Drive upload when already paused.

### Task 10.7: Tests

- request header/body IDs match;
- raw `23505` text absent;
- readiness false when runtime enabled but state missing;
- paused submit/resubmit returns `503 ABSTRACT_WRITES_PAUSED`, creates no DB/external-file mutation, and remains readiness 200 with `abstractWrites: paused`;
- a two-connection test proves pause waits for an in-flight shared-lock submit, the earlier submit may commit before the boundary, every later submit sees paused, and the toggle cannot alter `allocator_enabled`;
- `/health` shape is unchanged and live/ready status/body contracts are exact;
- telemetry contains allowed fields only;
- durable audit rolls back with the domain transaction and cannot be mutated;
- metrics reject PII/high-cardinality labels and require internal authorization;
- telemetry does not contain title/email/file URL.

Checkpoint:

```bash
git commit -m "refactor(abstracts): standardize tracking errors and telemetry"
```

---

## 16. Phase 11 — Public Frontend (`Pris2026`)

Work in its own repository and branch.

### Task 11.1: Baseline frontend

```bash
cd /Users/ptic/Desktop/Conference/Pris2026
git status --short
git switch -c feat/abstract-tracking-history
npm test
npm run lint
npm run build
```

Record pre-existing failures separately.

### Task 11.2: Create response normalizer tests

**Create:**

- `src/lib/abstractTracking.ts`
- `src/lib/abstractTracking.test.ts`

Test:

- old v1 response without new fields remains valid;
- changed response yields current/previous IDs;
- unchanged response does not invent previous ID;
- aliases are deduplicated;
- current ID is excluded from alias list;
- history sorts current first then issued time;
- 503 extracts requestId and stable code;
- unknown response safely falls back to current UX.

### Task 11.3: Add history component tests

**Create:**

- `src/components/profile/TrackingIdHistory.tsx`
- `src/components/profile/TrackingIdHistory.test.ts`

Test:

- current ID prominent;
- previous IDs collapsible;
- no empty history control;
- correct oral/poster badges;
- accessible labels/keyboard behavior;
- archived badge only when supplied.

### Task 11.4: Update resubmit page

**Modify:** `src/app/[locale]/abstract-submission/page.tsx`

- remember original presentation type/current ID when loading edit data;
- on Step 5, show a clear warning when target type differs;
- after `history_ready=true`, explain that a new ID will be issued and old ID remains searchable;
- while `history_ready=false`, explain that type change is temporarily unavailable; handle `503 TRACKING_HISTORY_INITIALIZING` without retry loop or client-side ID prediction;
- do not predict the new number client-side;
- consume `identifierChange` after success;
- display new current ID prominently and previous ID secondarily;
- show support-safe `requestId` for 503 errors only when the server response/header was actually received; a connection failure may not provide one;
- immediately before initial submit, snapshot the user's existing abstract IDs; on an ambiguous network outcome, refresh `GET /api/abstracts/user` and show any unseen same-event/type records only as possible results for manual review—not proof that this request created them;
- immediately before resubmit, snapshot the exact target abstract's status, type, and current tracking ID; after ambiguity, show its observed transition only as evidence, not proof of which request caused it;
- never infer success from title, timestamp, or exactly one unseen ID; every ambiguous transport outcome remains unconfirmed and shows list-review/support guidance;
- never automatically replay submit/resubmit or offer an automatic/manual retry from inference alone; the user may act again only after independent confirmation/support because idempotency is out of scope;
- retain disabled submit button behavior;
- do not add automatic unbounded retries.

### Task 11.5: Update profile tracker

**Modify:** `src/components/profile/AbstractTracker.tsx`

- show current ID as before;
- render optional history component;
- tolerate API without history during rolling frontend deployment;
- keep archived items excluded by default.

### Task 11.6: Localize

**Modify:** `messages/en.json`, `messages/th.json`

Add copy for:

- presentation-type change warning;
- new/current/previous Tracking ID;
- old ID remains valid;
- tracking service temporarily unavailable;
- support reference/request ID;
- identifier history.

### Task 11.7: Verify and checkpoint

```bash
npm test
npm run lint
npm run build
```

Checkpoint:

```bash
git commit -m "feat(abstracts): display tracking id changes and aliases"
```

---

## 17. Phase 12 — API and Operations Documentation

### Task 12.1: Write API contract doc

**Create:** `docs/api/abstract-tracking-v1.md`

Document:

- submit and resubmit multipart fields;
- additive response examples;
- current vs alias semantics;
- type-change behavior;
- exact identifier lookup;
- archive/restore resources;
- namespace resource lifecycle;
- status/error code matrix;
- `X-Request-Id`, stable allocator errors, and the rule against blind non-idempotent retry;
- authorization/404 anti-enumeration behavior;
- deprecation of inferring prefix from eventCode;
- compatibility guarantee for existing required keys.

There is no OpenAPI/Swagger artifact in the repository. Do not introduce a generator as part of this incident. The Markdown contract is authoritative until a separate OpenAPI effort.

### Task 12.2: Update environment docs

**Modify:** `.env.example`, `README.md`

- mark `TRACKING_ID_PREFIX` and `TRACKING_ID_PAD_LENGTH` as legacy during Release A;
- state the DB namespace owns them after cutover;
- document integration-test guards;
- add `METRICS_AUTH_TOKEN` to `.env.example` as optional/blank; when unset, `/metrics` is disabled and returns 404;
- document `MIGRATION_DATABASE_URL` as operator-only in `.env.example`/runbook and explicitly state application code must not load it;
- link design, plan, API doc, and runbook;
- document migrations are manual;
- warn not to use `db:push`.

Document and implement three long-lived database roles/connections plus one short-lived manifest loader:

- `conference_migrator` owns migration-created functions/tables and is used only by restricted operator `MIGRATION_DATABASE_URL`/psql sessions;
- `conference_api_runtime` is the non-owner login used by application `DATABASE_URL`, with ordinary app-table rights plus allocator function EXECUTE and no direct counter/allocation/assignment/audit mutation.
- `conference_readonly` is a non-owner operator login used by `PRODUCTION_READONLY_DATABASE_URL` and clone equivalent; it has CONNECT, schema USAGE, catalog access, and SELECT on required application/tracking objects only, with no DML, CREATE, ownership, or protected-function EXECUTE.
- `conference_manifest_loader` is a non-owner, time-bounded credential used only to load an unfrozen UUID batch; it has no table ownership/function execute and is revoked/expired immediately after the guarded freeze.

`src/database/index.ts` continues reading only runtime `DATABASE_URL`; application code must never read migrator/read-only operator URLs. The runbook includes Railway credential creation/rotation, `ALTER ... OWNER TO conference_migrator`, default privilege hardening, explicit GRANT/REVOKE statements, pre-cutover `current_user`/ownership/privilege assertions for all three roles, and credential rollback. It explicitly executes and verifies `REVOKE CREATE ON SCHEMA public FROM PUBLIC, conference_api_runtime` while granting runtime only required `USAGE`; alternatively every definer object is fully qualified in a dedicated non-writable schema. Runtime/PUBLIC schema-object shadowing is a hard blocker for `SECURITY DEFINER`. Never print any URL. If role separation cannot be established, cutover is blocked because table-owner privilege would bypass ordinary revokes/triggers.

The runbook also covers generating/storing/rotating `METRICS_AUTH_TOKEN`, keeping `/metrics` outside public CORS/browser use, and verifying public requests receive 404. Production readiness does not depend on metrics being enabled, but monitoring sign-off does.

### Task 12.3: Complete operational runbook

Expand `sql/abstract-tracking-setup/README.md` with:

- anonymized clone process;
- outbound email/Drive disable requirements;
- preflight and manifest approval;
- backup requirements;
- expand migration;
- Release A deployment/drain proof;
- cutover command and lock behavior;
- smoke tests;
- rollback boundaries;
- monitoring queries;
- delayed hardening.
- exact migrator-only pause/status/resume commands using `06_set_abstract_write_pause.sql`, audit verification, and the rule that resuming requires zero runtime-health blockers.

Checkpoint:

```bash
git commit -m "docs(abstracts): document tracking allocator operations"
```

---

## 18. Phase 13 — Cutover and Verification SQL

### Task 13.1: Disable the mixed-version bridge and run online history backfill

**Create:**

- `sql/abstract-tracking-setup/01_disable_legacy_bridge.sql`
- `sql/abstract-tracking-setup/02_online_backfill.sql`
- `sql/abstract-tracking-setup/02_backfill_verify.sql`

After guarded `0028` and universal Release A, the migrator-only bridge script acquires exclusive advisory lock `(20260813,1)`, waits for prior shared-lock writes, proves all pre-A writers/credentials drained, disables the compatibility trigger/flag, and appends `abstract_tracking.legacy_bridge_changed`. Release A initial submit remains open on the durable allocator and same-type resubmit remains open; type-changing resubmit returns `TRACKING_HISTORY_INITIALIZING` until history cutover.

Generate/freeze refreshed anomaly decisions after that boundary (reusing the immutable namespace/floor approvals from `0028`), then run restartable `02_online_backfill.sql -v migration_batch_id=...`. It:

1. asserts migrator role, universal Release A external gate record, allocator enabled, history not ready, bridge disabled, and frozen/hash-valid approvals;
2. verifies approved namespaces/counters/floors created by `0028` and never lowers them;
3. imports each current non-null identifier through a migrator-only atomic import function that locks event then abstract, rechecks the frozen fingerprint/current values, and inserts allocation plus root assignment without changing `abstracts.tracking_id`;
4. inserts per-row `abstract_tracking.migration_imported` audit with batch/fingerprint/action/approver references;
5. raises a counter only if an imported structured suffix is higher, never downward;
6. locks namespaces with imported history or any positive floor/counter;
7. each bounded chunk acquires the shared cutover advisory lock, then commits each row's allocation, assignment, audit, and progress atomically; exact already-imported matches are idempotent and partial/mismatched state aborts the chunk;
8. leaves allocator enabled and history not ready.

`02_backfill_verify.sql` is read-only and checks batch coverage, current-row import coverage, namespace/counter state, unchanged current-ID hashes, audit coverage, privileges, bridge disabled, and zero malformed unapproved writes. New Release A submissions already create their own allocation/assignment and therefore do not need delta import.

### Task 13.2: Write `03_cutover.sql`

The script runs as one transaction and accepts one UUID referencing the same frozen, persistent, access-controlled staging batch consumed by `02_online_backfill.sql`; temp-table/direct-file alternatives are forbidden because they bypass hash/retention/staleness guarantees:

1. exactly one approved namespace/padding row per abstract-capable event;
2. one anomaly decision per affected abstract, bound to its snapshot fingerprint;
3. exactly one approved floor for both oral and poster of every namespace—including zero-current and archived/restorable events—with evidence source, approver, and approval timestamp.

Required steps:

1. set bounded lock and statement timeouts;
2. acquire exclusive transaction advisory lock `(20260813, 1)`;
3. verify the operator-supplied manifests are complete, approved, range-safe, and unique for their keys;
4. assert the selected backfill batch is complete and no shared-lock chunk remains active;
5. verify anomaly snapshot fingerprints including normalized archive state/reason prerequisites;
6. reject any unapproved/stale anomaly or unassigned pre-existing current ID;
7. apply approved `preserve_current` only for prefix/opaque-format anomalies whose current type still matches; type-marker/current-type mismatch is not preservable and must rotate;
8. raise each counter with `GREATEST(current, structuredAllocationMax, approvedFloor)` and insert one per-series `abstract_tracking.floor_applied` audit containing old/new floor, batch/snapshot fingerprint, evidence reference, and approver reference;
9. allocate new current IDs for approved missing/rotation/`archive_and_assign` actions only after step 8; preserve old allocation/assignment as an alias when rotating, and for `archive_and_assign` archive the row plus append current assignment/audit in this transaction;
10. insert per-row normalization/assignment audit;
11. assert every current ID has both an allocation and assignment;
12. assert no counter is below its structured allocation maximum or approved floor;
13. set `locked_at` for every namespace with an allocation, positive counter, or positive approved floor; validate chains, current pointers, floor state, and runtime privileges;
14. set `history_ready=true`, keep allocator enabled, and assert bridge disabled;
15. insert one aggregate durable cutover event (per-row events were inserted with their corresponding mutations);
16. commit and release the advisory lock.

The script cannot prove Railway deployment state. Before invoking it, the runbook must record the Release A deployment ID and independent evidence that every pre-A replica has drained to zero. This external gate is mandatory; SQL must not claim to verify it.

New Release A submit/resubmit requests wait on the shared advisory lock rather than intentionally receiving a failure. If lock timeout occurs, cutover aborts without killing sessions.

Application lock acquisition also has a rehearsed bounded wait budget. Map `55P03`/the configured query-cancellation timeout to controlled allocator 503 with request ID and never run legacy behavior after a timed-out lock attempt. Record the selected wait budget from clone rehearsal; do not hard-code an untested value in this design document.

### Task 13.3: Write post-cutover verification

**Create:** `sql/abstract-tracking-setup/04_post_cutover_verify.sql`

Return a non-zero/blocker result for:

- enabled flag false;
- history-ready flag false or legacy bridge still enabled;
- current ID missing from allocation or assignment;
- event/type/current-ID mismatch;
- counter drift below maximum;
- duplicate structured tuple;
- multiple roots, branch, disconnected node, self-reference, or cycle in alias chain;
- mutable/invalid locked namespace;
- null current ID;
- identifier update/delete privilege leakage.

### Task 13.4: Prove bridge-disable/cutover waiting behavior

Integration test with two connections:

- connection A holds shared lock in a simulated submit;
- cutover exclusive lock waits;
- after A commits, exclusive lock succeeds;
- a new Release A submit waits behind exclusive lock;
- after flag flip/commit, waiting submit reads enabled and uses allocator;
- no request executes legacy path after enabled flag is visible.
- bridge-disable exclusive lock waits for an earlier shared-lock transaction; afterward pre-A bridge writes fail closed, while Release A initial/same-type writes remain open and history backfill proceeds in bounded chunks.

Checkpoint:

```bash
git commit -m "feat(abstracts): add online allocator cutover protocol"
```

---

## 19. Phase 14 — Complete Development Verification

### Task 14.1: Backend full suite

```bash
cd /Users/ptic/Desktop/Conference/conference-api
npm ci
npm test
npm run test:abstract-tracking
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:abstract-tracking:integration
npm run build
```

Gate:

- all commands pass;
- no `.only`, `.skip` hiding required tests, or flaky timing assertions;
- test database guard proves isolation;
- no generated migration journal change.

### Task 14.2: Static searches for forbidden behavior

```bash
rg -n "count\(\*\).*abstract|runningNumber|TRACKING_ID_PREFIX|TRACKING_ID_PAD_LENGTH" \
  src/routes/public/abstracts src/modules/abstracts
rg -n "delete\(abstracts\)|DELETE FROM abstracts" src sql drizzle
rg -n "tracking_id.*UPDATE|SET tracking_id" src sql drizzle
```

Expected:

- no enabled allocator path derives a number from row count;
- no ordinary member/event route hard-deletes abstract history;
- tracking current-pointer changes occur only in reviewed service/migration paths;
- remaining legacy fallback is isolated and scheduled for Release B removal.

### Task 14.3: Frontend full suite

```bash
cd /Users/ptic/Desktop/Conference/Pris2026
npm ci
npm test
npm run lint
npm run build
```

### Task 14.4: Contract compatibility test

Snapshot or explicit assertions prove the old frontend can still read:

- initial submit 201;
- resubmit 200;
- `success` boolean;
- `abstract.id`, `trackingId`, `title`, `status`, files/timestamps where previously present;
- string `error` on failures.

New frontend must tolerate both old and new optional metadata during deployment ordering.

---

## 20. Phase 15 — Anonymized Production-clone Rehearsal

This is a mandatory production gate.

### Task 15.1: Prepare clone safely

- [ ] Restore a recent production snapshot into an isolated dev/staging database.
- [ ] Anonymize user/co-author PII while preserving IDs, event relations, types, statuses, dates, and tracking strings.
- [ ] Disable outbound email.
- [ ] Disable or redirect Drive writes to a disposable location.
- [ ] Block the clone from serving real public traffic.
- [ ] Record snapshot time and fingerprint.

### Task 15.2: Review/freeze floor batch, apply guarded expand, and deploy compatible writers

Run baseline preflight. Review/freeze the event-namespace and O/P-floor batch before `0028`; this batch is the no-reuse boundary. Apply `0028 -v migration_batch_id=...`, verify allocator enabled/bridge enabled, deploy complete Release A plus backward-compatible frontend, and prove every pre-A writer is drained. Exercise old-build compatibility against the guarded expand: old initial submit may use the bridge only for a candidate above the approved floor; old type-marker changes and all hard-delete paths fail closed.

Exact order: run `01_stage_manifest_tables.sql` with the clone migrator URL; insert the UUID batch; load namespace/floor/anomaly files through the non-owner loader's literal-path `\copy` commands; recompute canonical digests; freeze/revoke the loader; export `ABSTRACT_TRACKING_MIGRATION_BATCH_ID` only after freeze. Freeze activates the temporary pre-`0028` no-reuse guard. Run `0028` immediately; no human review, reload, or destructive operation may occur between freeze and migration. `0028`, backfill, and cutover consume this same immutable UUID.

```bash
psql "$PROD_CLONE_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/00_preflight.sql
psql "$PROD_CLONE_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f drizzle/0028_abstract_tracking_allocator.sql
psql "$PROD_CLONE_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/02_expand_verify.sql
```

### Task 15.3: Disable bridge and generate anomaly manifest

After Release A is universal and all pre-A writers/credentials are drained, run `01_disable_legacy_bridge.sql`. Its exclusive advisory lock waits for shared-lock writes, disables the bridge, and keeps allocator enabled. Type-changing resubmit remains blocked with `TRACKING_HISTORY_INITIALIZING` until history is ready; initial and same-type resubmit stay open. Only now run fresh anomaly preflight/manifest preparation:

```bash
psql "$PROD_CLONE_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/00_preflight.sql

psql "$PROD_CLONE_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/01_prepare_manifest.sql
```

Review every blocker. Do not proceed with blank approval fields.

### Task 15.4: Verify frozen batch and backfill

The namespace/floor batch was staged, digest-verified, and frozen before `0028`; never create or mutate a replacement batch after allocator activation. Copy/fill the refreshed anomaly-decision manifest in the restricted rehearsal directory after bridge disable. If namespace/floor preflight proves it stale, stop and create a new guarded expand batch rather than silently changing floors. Record SHA-256 hashes.

For PRIS poster:

- confirm P022 exists;
- confirm trustworthy high-water is at least 22;
- if no evidence of higher deleted IDs exists, approve floor 22;
- otherwise approve the higher evidence-backed floor;
- document sources and approver.

For every event/type, approve one floor.

Verify the same UUID batch remains frozen, complete, and digest-valid. Then run:

```bash
psql "$PROD_CLONE_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f sql/abstract-tracking-setup/02_online_backfill.sql
psql "$PROD_CLONE_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f sql/abstract-tracking-setup/02_backfill_verify.sql
```

Record duration, locks, hashes, progress watermark, and verification blockers.

### Task 15.5: Final history cutover

- prove all replicas still report compatible Release A and warning frontend;
- reuse the same loaded/frozen UUID batch; do not reload or mutate it between backfill and cutover;
- run `03_cutover.sql -v migration_batch_id=...`;
- run `04_post_cutover_verify.sql`;
- prove `history_ready=true`, allocator enabled, bridge disabled, and both normal/type-changing paths use the durable allocator.

### Task 15.6: Rehearsal scenarios

Must pass:

1. PRIS poster next allocation is P023 or the approved higher floor + 1;
2. 100 concurrent same-type submissions are unique;
3. failure after reservation rolls back counter/allocation/assignment/abstract/audit;
4. archive the highest current row, then allocate; number still increases;
5. poster -> oral allocates new O ID and keeps old alias;
6. oral -> poster later allocates fresh P ID;
7. lookup by every alias resolves same abstract;
8. member deletion archives/unlinks but preserves IDs;
9. event-code edit leaves prefix unchanged;
10. event hard delete is blocked after issuance;
11. migration re-run/failure behavior is safe as documented;
12. no valid historical current ID changed unexpectedly;
13. no real email or Drive operation occurs;
14. UI renders changed and unchanged resubmit responses;
15. verification blocker count is zero.

### Task 15.7: Rehearse rollback

- rollback frontend independently: API remains compatible;
- rollback API only to the complete Release A production artifact (or a later milestone-compatible artifact), then re-verify alias lookup, archive/event/member gates, and current-ID behavior;
- leave `0028` schema/data in place;
- confirm no counter is lowered and runtime stays enabled;
- confirm submit still allocates safely;
- prove rollback to pre-allocator build is rejected operationally.

Sign-off required from:

- backend owner;
- database/operator owner;
- product owner for anomaly manifest;
- frontend owner;
- production deploy owner.

---

## 21. Phase 16 — Production Rollout (Off-hours, Endpoint Nominally Open)

### Pre-deploy gate

- [ ] clone rehearsal signed off;
- [ ] all builds/tests pass from clean install;
- [ ] namespace/floor manifest templates and evidence owners ready; the reviewed namespace/floor batch is frozen before `0028`, while anomaly decisions are refreshed only after the bridge is disabled;
- [ ] recoverable DB backup completed and restore procedure verified;
- [ ] complete API Release A artifact retained; allocator-core retained for staging diagnostics only;
- [ ] matching frontend artifact retained;
- [ ] signed inventory of every known v1 resubmit consumer/integration and contract fixtures completed; if any consumer cannot accept ID rotation, explicit opt-in/versioned gating is enabled;
- [ ] source/proxy/access-log audit proves no known client automatically replays submit/resubmit POST/PATCH;
- [ ] warning/history-capable `Pris2026` is predeployed and verified before allocator cutover makes type rotation reachable;
- [ ] all operators in communication channel;
- [ ] dashboards/log queries open;
- [ ] no planned member/event destructive operation during cutover;
- [ ] from batch freeze through `0028` commit, covered-event namespace/event-code/category activation and destructive admin mutations are blocked; abstract submission remains nominally open under the temporary guard;
- [ ] every database writer is inventoried (API replicas, worker/cron jobs, one-off scripts, integrations, and operator sessions); old writer credentials are revoked/rotated, `pg_stat_activity` and grants show no pre-A writer, and the signed gate proves only Release A runtime plus migrator/read-only roles can touch the affected tables;
- [ ] traffic is low enough for the exclusive advisory-lock window.

### Step 16.1: Baseline read-only preflight

Run `00_preflight.sql` through a restricted `$PRODUCTION_READONLY_DATABASE_URL`. Compare output with clone. If new anomalies appear, stop and review; do not improvise production changes.

### Step 16.2: Apply expand migration 0028

Stage/freeze `ABSTRACT_TRACKING_MIGRATION_BATCH_ID` first using `01_stage_manifest_tables.sql`, the non-owner loader, literal-path `\copy`, canonical digest verification, and freeze/revoke checks. Freeze activates the temporary pre-`0028` guard. Run `0028` immediately; no human review or batch reload occurs after freeze. Then run:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f drizzle/0028_abstract_tracking_allocator.sql
```

Use short `lock_timeout`. If a lock cannot be obtained, abort/retry later. Do not terminate user sessions.

Every mutating migration/cutover/hardening script begins by asserting `current_user = 'conference_migrator'` and expected object/function ownership; it aborts before DDL/DML otherwise. Clone scripts assert their clone migrator role equivalently. Read-only verify scripts use the separate read-only URL.

Immediately run and require zero blockers before deploying Release A:

```bash
psql "$PRODUCTION_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/02_expand_verify.sql
```

### Step 16.3: Deploy API Release A

- deploy 100% of API replicas;
- wait for Railway to drain the previous deployment;
- verify every live replica/version is Release A;
- verify readiness reports allocator enabled, history not ready, bridge enabled, and writes unpaused;
- do not cut over while any pre-A writer exists.

### Step 16.3a: Predeploy warning-capable `Pris2026`

Deploy and verify the backward-compatible warning/history-capable frontend before bridge disable. It tolerates old responses, optional history, and `TRACKING_HISTORY_INITIALIZING`. Do not exercise type rotation until history is ready; no separate rotation flag is introduced.

### Step 16.4: Disable mixed-version bridge

After proving every pre-A writer/credential is gone, run `01_disable_legacy_bridge.sql` with the migrator role. Its exclusive advisory lock drains earlier shared-lock operations, disables the temporary trigger/flag, and appends `abstract_tracking.legacy_bridge_changed`. Initial submit and same-type resubmit remain open on the durable allocator; type-changing resubmit remains blocked with `TRACKING_HISTORY_INITIALIZING` until history cutover. Hard-delete/member-delete/event-delete paths remain blocked.

### Step 16.5: Generate anomaly decisions and backfill history

Run fresh `00_preflight.sql` and `01_prepare_manifest.sql` through the read-only role **after** bridge disable. Review/freeze anomaly decisions against the immutable namespace/floor batch. Never reload or mutate namespace/floor rows after `0028`; if they are stale, stop and run a new guarded expand batch.

Run online backfill and require zero blockers:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f sql/abstract-tracking-setup/02_online_backfill.sql
psql "$PRODUCTION_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f sql/abstract-tracking-setup/02_backfill_verify.sql
```

Initial submits and same-type resubmits continue through the durable allocator and already have allocation/assignment history. If anomaly data becomes stale or an unexpected tracking-shape mutation appears, keep `history_ready=false`, retain the bridge-disabled safety state, and fix forward with a superseding anomaly batch; never reopen legacy COUNT and never lower a floor.

### Step 16.6: Execute final cutover

Record the active Railway Release A deployment ID and proof that all pre-A replicas are drained. Confirm the UUID-keyed staged batch hashes match the three reviewed production files, then run:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v migration_batch_id="$ABSTRACT_TRACKING_MIGRATION_BATCH_ID" \
  -f sql/abstract-tracking-setup/03_cutover.sql
```

Immediately verify through the read-only role:

```bash
psql "$PRODUCTION_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/04_post_cutover_verify.sql
```

Do not smoke-test or reopen type-changing resubmit unless blocker count is zero. If verification fails after commit, allocator remains enabled and `history_ready` remains false; invoke the independent write-pause switch for submit/resubmit, retain all allocation data/counters, and fix forward—never re-enable legacy COUNT behavior.

Expected user behavior:

- in-flight Release A submit transactions finish;
- new submit/resubmit transactions may wait briefly on advisory lock;
- after commit they observe enabled allocator and continue;
- no planned 500 or duplicate ID occurs.

Abort conditions:

- advisory lock timeout;
- stale manifest fingerprint;
- unexpected anomaly;
- verification invariant failure;
- unconfirmed old replica.

Before `03_cutover` commits, any failure rolls back that transaction; allocator remains enabled, bridge remains disabled, and `history_ready` remains false. After `history_ready=true` commits, `04_post_cutover_verify.sql` failure cannot be rolled back: pause submit/resubmit, page the owner, and fix forward. Do not cancel a batch after any backfill import commits, do not reopen legacy COUNT, and do not partially apply fixes.

### Step 16.7: Reverify warning-capable `Pris2026`

Confirm the predeployed warning/history frontend is still healthy immediately after cutover and before exercising a type-change smoke fixture.

### Step 16.8: Smoke test API

Use an authorized retained test submission under the agreed production policy.

Verify:

- expected new poster/oral ID above approved floor;
- allocation/assignment/current pointer/counter agree;
- exact canonical lookup works;
- alias lookup fixture works if safe to exercise;
- same-type resubmit retains ID;
- type-change resubmit rotates ID if a designated test fixture exists;
- no raw 23505;
- response request ID present;
- email references committed current ID.

Do not delete the smoke abstract. Archive it if policy requires; its ID remains reserved.

### Step 16.9: Final frontend verification

- verify the predeployed/matching `Pris2026` artifact after API smoke;
- verify ordinary submit success;
- verify type-change warning and result display;
- verify profile current/history display;
- verify old optional-field fallback is not needed but remains functional.

### Step 16.10: Monitor

For at least 60 minutes actively, then at 24 and 72 hours:

- submit/resubmit 2xx/4xx/5xx;
- PostgreSQL 23505, 40001, 40P01;
- invariant failure/retry structured events;
- allocator lock-wait p50/p95/max;
- Drive cleanup failures;
- counters below structured allocation maximum;
- current ID missing/mismatched allocation or assignment;
- null IDs;
- namespace/runtime readiness;
- email delivery failures;
- archive/member-delete effects.

### Step 16.11: Rollback rules

- frontend can roll back independently;
- API may roll back only to the complete Release A production checkpoint or later; allocator-core alone predates alias/archive guarantees and is not safe here;
- never disable allocator runtime and reopen legacy count writers;
- never drop 0028 tables;
- never lower counters;
- if allocator correctness is uncertain, temporarily block only submit/resubmit and fix forward.

---

## 22. Phase 17 — Remove Legacy Branch (Release B)

After production cutover is stable:

### Task 17.1: Delete legacy allocator

**Modify:** `src/routes/public/abstracts/submit.ts`, service/repository.

Remove:

- legacy `COUNT(*)` allocator function;
- legacy env fallback from active allocation;
- temporary legacy-bridge compatibility code/trigger after the agreed soak and all pre-A writers are gone.

Keep runtime version/readiness and the shared transaction advisory lock as the first DB lock on every relevant write. Removing the legacy branch does **not** authorize removing the cutover lock before 0029 finishes.

### Task 17.2: Add negative source test

Add a test/static assertion that source under abstract submission contains no count-based ID allocation and no direct current-ID string construction outside the format module.

### Task 17.3: Verify

```bash
rg -n "count\(\*\).*abstract|runningNumber" src/routes/public/abstracts src/modules/abstracts
npm test
npm run test:abstract-tracking
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:abstract-tracking:integration
npm run build
```

Checkpoint:

```bash
git commit -m "refactor(abstracts): remove legacy tracking allocator"
```

---

## 23. Phase 18 — Delayed Hardening Migration 0029

Apply only after all old replicas are gone and the agreed soak is clean.

### Task 18.1: Build and universally deploy the dual-compatible Release B

**Modify:** `src/database/schema.ts`

Represent the final `.notNull()` tracking ID and named relations/constraints where Drizzle supports them; document raw-SQL-only deferred constraints in schema comments/tests. Build Release B so runtime code accepts both pre- and post-0029 schema/runtime versions and continues taking the shared advisory lock. Deploy it to 100% of replicas, drain all older replicas/writers, and retain this artifact as the only rollback floor after hardening. Do not run `07_prepare_hardening.sql` or `0029` until this universal-deployment gate passes.

### Task 18.2: Prebuild and validate online constraints

**Create:** `sql/abstract-tracking-setup/07_prepare_hardening.sql`

Before the short hardening cutover:

1. create any not-yet-existing exact assignment unique index with `CREATE UNIQUE INDEX CONCURRENTLY` (normally it already exists from 0028);
2. add `CHECK (tracking_id IS NOT NULL) NOT VALID` with a short lock timeout;
3. validate that check online;
4. add the deferred current-ID FK `NOT VALID` so new writes are enforced immediately, then validate it online; retry later on timeout, but validation is mandatory before hardening is declared complete;
5. abort on any violation and return to data reconciliation—never auto-rewrite rows here.

The script is a resumable catalog state machine and cannot wrap `CREATE INDEX CONCURRENTLY` in a transaction block. For each named index/check/FK it distinguishes: absent (create), present with exact expected definition but unvalidated (continue validation), present and validated (no-op), invalid concurrent index (drop/retry only that verified name), and wrong definition/name collision (hard blocker). An interruption after ADD/VALIDATE can therefore be rerun safely without duplicate-constraint failure. Clone tests terminate it after each boundary and prove every rerun converges or rejects a mismatched object.

Release B continues taking the shared advisory lock throughout this preparation.

### Task 18.2a: Create hardening verification contract

**Create:** `sql/abstract-tracking-setup/08_verify_hardening.sql`

The read-only verifier accepts required `-v phase=prepared|complete`. `prepared` requires exact index/check/FK definitions present and validated, runtime enabled, bridge disabled, no null/mismatched current IDs, and zero invariant blockers. `complete` additionally requires `tracking_id NOT NULL`, runtime schema version for `0029`, mutation-privilege hardening, and the same zero-blocker result. Unknown/missing phase, wrong definition, unvalidated FK, or non-zero blocker exits non-zero. Clone tests run both phases and retry after interrupted `07_prepare_hardening.sql`.

### Task 18.3: Write short hardening migration

**Create:** `drizzle/0029_abstract_tracking_hardening.sql`

Steps:

1. begin with bounded timeouts;
2. acquire exclusive cutover advisory lock;
3. assert runtime enabled/version supported;
4. delta-import/reconcile any boundary rows;
5. reject NULL/missing/mismatched current IDs;
6. raise counters to structured allocation maximum;
7. verify the exact assignment unique key and **validated** current-ID FK are present as rehearsed; an unvalidated FK is a blocker;
8. perform the short `SET NOT NULL` using the already validated check;
9. verify mutation privileges/triggers and all invariants;
10. bump runtime schema version and insert durable hardening audit event;
11. commit promptly.

If a request's shared advisory-lock wait budget expires during this short window, map the lock/query timeout to controlled 503 with `requestId`; never fall through to legacy behavior.

### Task 18.4: Rehearse 0029 on clone

Exact rehearsal order:

1. restore/anonymize or refresh clone and reproduce the fully cut-over 0028/Release A state;
2. deploy the dual-compatible Release B to 100% and drain older writers;
3. run `07_prepare_hardening.sql` with the clone migrator URL;
4. run its read-only catalog/invariant verification and require the NOT NULL check plus current-ID FK to be validated;
5. run `drizzle/0029_abstract_tracking_hardening.sql` with the clone migrator URL;
6. run `08_verify_hardening.sql` with the clone read-only URL;
7. run the full integration/concurrency suite, prove an inconsistent current pointer cannot commit, prove abstract deletion cannot erase history, and record lock duration.

### Task 18.5: Apply production hardening

Use the same off-hours lock/verification/monitoring discipline. First deploy dual-compatible Release B universally and drain older replicas. Then run exactly:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f sql/abstract-tracking-setup/07_prepare_hardening.sql
psql "$PRODUCTION_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v phase=prepared \
  -f sql/abstract-tracking-setup/08_verify_hardening.sql
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f drizzle/0029_abstract_tracking_hardening.sql
psql "$PRODUCTION_READONLY_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v phase=complete \
  -f sql/abstract-tracking-setup/08_verify_hardening.sql
```

The preparation verify requires the FK/check validated before `0029`; the complete verify additionally requires `tracking_id NOT NULL`, the new runtime version, and zero blockers. Keep endpoint nominally open via Release B shared cutover lock until commit. Afterward, rollbacks may target only the retained 0029-compatible artifact or a newer fix-forward build.

Checkpoint:

```bash
git commit -m "chore(abstracts): enforce tracking id invariants"
```

---

## 24. Required Test Matrix

| Area | Case | Expected |
|---|---|---|
| incident | P022 exists, row count lower | next is P023 or approved higher floor + 1 |
| concurrency | 100 same event/type writes | 100 unique committed IDs |
| concurrency | different events | independent locks/counters; same-event types keep independent series but share a short namespace lock |
| rollback | failure after allocation | no committed counter advance/ID |
| deletion | archived early/highest abstract | next number still advances |
| type change | poster -> oral | fresh O ID, old P alias |
| type change | oral -> poster | fresh P ID, no alias reuse |
| resubmit | same type | same current ID, no counter change |
| resubmit race | two concurrent requests | one commit; other state conflict |
| lookup | old alias | same abstract/current ID |
| authorization | reviewer out of scope | 404 indistinguishable from absent |
| prefix | edit before issue | succeeds |
| prefix | edit after issue | 409 locked |
| event code | edit after issue | prefix/IDs unchanged |
| event delete | history exists | 409; no cascade |
| member delete | owns abstracts | archive + unlink, identifiers remain |
| restore | member-deleted/no author | 409 author required |
| migration | malformed unapproved row | abort before changes |
| migration | reviewed mismatch | old alias + fresh correct current ID |
| cutover | waiting writes | wait, then new allocator; no legacy write |
| restore | counter below structured allocations | repair upward only |
| capacity | sequence 1000, width 3 | renders 1000 |
| errors | allocator unavailable | 503, safe code/requestId, no blind retry instruction |
| privacy | logs/errors | no title/email/file URL/DB detail |
| compatibility | old v1 client | existing required fields deserialize |

---

## 25. Definition of Done

Implementation is complete only when all items are true:

- [ ] Design and API contract are approved and committed.
- [ ] Pure format/error tests pass.
- [ ] Schema contract tests pass.
- [ ] 0028 and 0029 migrations are rehearsed on an anonymized production clone.
- [ ] Reviewed anomaly manifest has no unresolved row.
- [ ] PRIS incident fixture allocates P023 or approved higher next ID.
- [ ] 100-way concurrency test passes repeatedly.
- [ ] Rollback and archive tests pass.
- [ ] Type changes create permanent aliases.
- [ ] Every old/current ID lookup enforces authorization.
- [ ] Member/event hard deletion cannot destroy issued history.
- [ ] Backend clean install tests/build pass.
- [ ] Frontend clean install tests/lint/build pass.
- [ ] Existing v1 response compatibility tests pass.
- [ ] Production Release A fully drains old replicas before cutover.
- [ ] Cutover verification blocker count is zero.
- [ ] API/frontend smoke tests pass.
- [ ] Active monitoring shows no tracking unique collisions or invariant failures.
- [ ] Legacy count allocator is removed in Release B.
- [ ] 0029 final constraints validate after soak.
- [ ] Runbook contains exact rollback artifact and operator ownership.

---

## 26. Suggested Review and Commit Sequence

1. `test(abstracts): record tracking allocator incident fixture`
2. `feat(abstracts): define tracking id domain contracts`
3. `docs(abstracts): add tracking migration preflight contract`
4. `feat(abstracts): add durable tracking allocator schema`
5. `feat(abstracts): add transactional tracking allocator`
6. `fix(abstracts): replace count based tracking allocation`
7. `feat(abstracts): preserve aliases across type changes`
8. `feat(abstracts): resolve canonical and alias tracking ids`
9. `feat(abstracts): archive submissions instead of deleting history`
10. `feat(events): add immutable abstract tracking namespaces`
11. `refactor(abstracts): standardize tracking errors and telemetry`
12. `docs(abstracts): document tracking allocator operations`
13. `feat(abstracts): add online allocator cutover protocol`
14. Frontend: `feat(abstracts): display tracking id changes and aliases`
15. `refactor(abstracts): remove legacy tracking allocator`
16. `chore(abstracts): enforce tracking id invariants`

Each checkpoint must remain independently reviewable. Schema, allocator, route behavior, archival, frontend, and production cutover must not be collapsed into one unreviewable commit.

---

## 27. Immediate Incident Unblock Embedded in the Rollout

The long-term allocator also resolves the current P022 incident. Do not apply a separate manual P023 edit unless an emergency business decision explicitly requires it.

During the approved cutover:

1. verify the existing P022 row and global unique constraint;
2. approve the PRIS poster high-water floor at 22 or higher based on evidence;
3. seed the counter to that floor;
4. use the allocator already enabled by guarded `0028`; wait for Release A to be universal before disabling the bridge;
5. the first successful poster submission receives P023 or the next value above the approved higher floor;
6. do not delete, rename, or reassign P022;
7. notify affected users to resubmit because the 44 failed request bodies cannot be safely replayed from logs.
