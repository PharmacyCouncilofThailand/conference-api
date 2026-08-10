# Team Registration Payment Retry Safety Implementation Plan

> **For agentic workers:** Implement task-by-task with tests first. Do not collapse the state-policy, migration, concurrency, and rollout tasks into one unreviewable change.

**Goal:** Let a Team Registration leader replace an abandoned payment immediately while preserving idempotency, electing exactly one verified payment winner, surfacing duplicate/stale settlements, and closing the audited payment integrity and worker-reliability gaps.

**Architecture:** A pure payment-state policy classifies Pay Solutions results and decides monotonic settlement outcomes. Command flows and reconciliation use short PostgreSQL transactions with the common lock order `registration -> attempts`. Retry locally cancels and replaces an attempt without provider I/O. Reconciliation performs authenticated inquiry outside locks, then elects a winner or records an action-required settlement. A leased worker performs active, final-expiry, and bounded terminal reconciliation.

**Tech Stack:** Node.js 20, TypeScript 5, Fastify 5, Drizzle ORM 0.38, PostgreSQL, `postgres`, Zod 3, Axios, and the Node test runner through `tsx`.

**Design source:** `docs/superpowers/specs/2026-08-10-team-registration-payment-retry-design.md`

## Global Constraints

- Changes are limited to `conference-api` Team Registration, shared database schema, health output, environment documentation, and production worker scripts.
- Do not modify historical migrations `0024_team_registration_foundation.sql`, `0024a_team_registration_payment_snapshots.sql`, or `0025_team_registration_viewer_role.sql`.
- Quiesce Team Registration writes/provider handling and stop the old worker around the schema backfill/deploy boundary; old fulfillment code must never run after winner/action state is introduced.
- `cancelled` means locally superseded; it does not claim that Pay Solutions invalidated the hosted form.
- A fresh `Idempotency-Key` creates a new logical attempt; the same key never creates a successor.
- Retry must not call Pay Solutions and must not hold a database lock across network I/O.
- Every flow that locks both entities uses `team_registrations` before `team_registration_payment_attempts`.
- Provider postback is untrusted. Only authenticated inquiry may establish payment, refund, merchant, amount, reference, or currency facts.
- At most one attempt per registration has `isWinner=true`, including after a winner is refunded.
- Payment facts are monotonic. Stale pending/failed responses never overwrite cancelled, expired, paid, duplicate, refunded, or action-required verified states.
- Only a winner queues initial confirmation emails.
- Test-complete statuses are impossible to accept in `NODE_ENV=production`.
- A payment session has one absolute `paymentReservationExpiresAt`; retries retain it and never extend the reservation.
- `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED` defaults to `false`; supersession is enabled only after migrations, worker health, and staging checks pass.
- Integration tests use only `TEST_DATABASE_URL` and must refuse a database that is not explicitly marked for tests.
- Preserve unrelated worktree changes and keep each implementation checkpoint reviewable.

## Target File Structure

### Create

- `drizzle/0026_team_registration_payment_statuses.sql`
- `drizzle/0027_team_registration_payment_retry_safety.sql`
- `sql/team-registration-setup/01_preflight_payment_retry_safety.sql`
- `src/modules/team-registrations/payment-state.ts`
- `src/modules/team-registrations/payment-state.test.ts`
- `src/modules/team-registrations/payment.repository.ts`
- `src/modules/team-registrations/payment.service.test.ts`
- `src/modules/team-registrations/payment-verification.service.test.ts`
- `src/modules/team-registrations/provider.routes.test.ts`
- `src/modules/team-registrations/public.routes.test.ts`
- `src/modules/team-registrations/registration.service.test.ts`
- `src/modules/team-registrations/backoffice.routes.test.ts`
- `src/modules/team-registrations/payment.integration.test.ts`
- `src/modules/team-registrations/test-database.ts`
- `sql/team-registration-setup/README.md`

### Modify

- `.env.example`
- `README.md`
- `package.json`
- `src/database/index.ts`
- `src/database/schema.ts`
- `src/index.ts`
- `src/modules/team-registrations/backoffice.authorization.test.ts`
- `src/modules/team-registrations/backoffice.routes.ts`
- `src/modules/team-registrations/database.repository.ts`
- `src/modules/team-registrations/database.test.ts`
- `src/modules/team-registrations/jobs-policy.ts`
- `src/modules/team-registrations/jobs.test.ts`
- `src/modules/team-registrations/jobs.ts`
- `src/modules/team-registrations/jobs-runner.ts`
- `src/modules/team-registrations/payment-verification.test.ts`
- `src/modules/team-registrations/payment-verification.ts`
- `src/modules/team-registrations/payment-verification.service.ts`
- `src/modules/team-registrations/payment.service.ts`
- `src/modules/team-registrations/paysolutions.client.test.ts`
- `src/modules/team-registrations/paysolutions.client.ts`
- `src/modules/team-registrations/provider.routes.ts`
- `src/modules/team-registrations/public.routes.ts`
- `src/modules/team-registrations/registration.service.ts`
- `src/modules/team-registrations/types.ts`

## Task 1: Establish the Baseline and Test Database Guard

**Files:**

- Create: `src/modules/team-registrations/test-database.ts`
- Create: `src/modules/team-registrations/payment.integration.test.ts`
- Modify: `src/database/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Install the locked dependencies and record the baseline**

Run:

```bash
npm ci
npm run test:team-registrations
npm run build
git status --short
```

Expected: dependencies install from `package-lock.json`; existing Team Registration tests and TypeScript build pass before feature changes. If a baseline failure occurs, record it separately and do not weaken tests to proceed.

- [ ] **Step 2: Add a guarded integration-test helper**

`test-database.ts` must:

- read `TEST_DATABASE_URL` explicitly;
- reject a missing URL;
- reject equality with `DATABASE_URL` unless `TEAM_REGISTRATION_ALLOW_SHARED_TEST_DATABASE=true` is deliberately set;
- require the database name or schema to contain `test`;
- require a pre-migrated isolated database and verify the expected Team Registration schema before resetting fixtures; do not run a hand-picked subset of repository migrations that can drift from production order;
- expose reset/seed helpers and close all PostgreSQL clients after a test file.

Create the initial `payment.integration.test.ts` entrypoint in this task. It sets `DATABASE_URL` from the validated `TEST_DATABASE_URL` before dynamically importing the database, schema, repository, or service modules; it must not statically import a module that initializes the global database connection before the guard runs. Begin with guard/connect/reset/close smoke coverage so the command added below always points to a real, safe test file.

Export a database close function from `src/database/index.ts` so test processes and the worker can shut down cleanly without changing normal server startup.

- [ ] **Step 3: Add an opt-in integration test command**

Add:

```json
"test:team-registrations:integration": "tsx --test src/modules/team-registrations/payment.integration.test.ts"
```

The command fails safely when `TEST_DATABASE_URL` is absent; it never silently points at the regular database.

- [ ] **Step 4: Verify the guard**

Run once without `TEST_DATABASE_URL` and once with the isolated test database. Expected: the first run refuses to start; the second can connect, reset Team Registration fixtures, and close promptly.

- [ ] **Step 5: Commit the test foundation**

```bash
git add package.json src/database/index.ts src/modules/team-registrations/test-database.ts src/modules/team-registrations/payment.integration.test.ts
git commit -m "test(team-registration): add guarded payment database harness"
```

## Task 2: Define the Pure Payment State Policy

**Files:**

- Create: `src/modules/team-registrations/payment-state.ts`
- Create: `src/modules/team-registrations/payment-state.test.ts`
- Modify: `src/modules/team-registrations/payment-verification.ts`
- Modify: `src/modules/team-registrations/payment-verification.test.ts`

**Required public behavior:**

- classify provider output as `paid`, `failed`, `cancelled`, `pending`, `refunded`, or `unknown`;
- parse the test-status runtime switch fail-closed and refuse test-paid statuses in production;
- decide `winner`, `duplicate`, `review`, or `idempotent` for a fully verified settlement;
- decide whether provider metadata may change a local state without reviving/downgrading it;
- evaluate the shared `canStartPayment` inputs without database or framework dependencies;
- decide the shared unpaid-registration transition (`ready_for_payment` with retained/cleared deadline, held for action, or safely expired/releasable).

- [ ] **Step 1: Write failing classification tests**

Cover the paid codes currently supported, failed/cancelled codes already recognized by the generic Pay Solutions module, pending codes, refund/void codes, whitespace/case normalization, unknown values, and this invariant:

```ts
assert.equal(
  classifyTeamProviderStatus(
    { status: "TC", statusName: "TEST COMPLETE" },
    { nodeEnv: "production", allowTestStatuses: true },
  ),
  "unknown",
);
```

Explicitly test `VO`/`VOIDED` as `cancelled` before verified settlement and `refunded` after verified settlement.

Test the narrow environment adapter with the flag absent, malformed, mixed-case/whitespace `true`, and literal `true`: only normalized `true` outside production enables test-paid statuses, while production always supplies `allowTestStatuses=false`.

- [ ] **Step 2: Write failing settlement-decision tests**

Test:

- no winner + same revision + payable reservation => `winner`;
- existing different winner => `duplicate`;
- a different unresolved action => `review/other_payment_action_unresolved`, never winner;
- revision mismatch => `review/registration_revision_changed`;
- expired/released reservation => `review/registration_expired`;
- mismatched current reservation deadline or effective settlement after attempt expiry => `review`, while equality at the boundary is eligible;
- an absent provider `paidAt` uses inquiry start; the client/policy keeps absence distinct from a present malformed value;
- a present invalid value, a value before `attempt.createdAt - 5m`, or a value after `inquiryCompletedAt + 5m` => `review/provider_paid_at_invalid`; both exact skew boundaries remain valid;
- same winning attempt => `idempotent`;
- an administratively resolved action never re-enters winner election or reopens on another paid result;
- disabled configuration, invalid local payment environment, event/local profile or merchant mismatch, retained-session snapshot/profile/merchant mismatch, incomplete draft, missing claims, unresolved verified-money action, no valid session after close, existing winner, and active attempt with safe retry disabled => `canStartPayment=false`;
- a new session requires both `draftExpiresAt > now` and `registrationClosesAt > now`; equality at either boundary is false;
- a payable registration with an unexpired retained session remains true after draft/event close, while `paymentReservationExpiresAt == now` is false;
- an otherwise-payable active attempt becomes retryable only when safe retry is enabled;
- unpaid completion before session deadline retains it; after deadline but before registration close clears it for a new session;
- closed window after payment finalization expires/releases only without a winner or unresolved verified-money action;
- unresolved action always chooses held/no-release until an allowed resolution re-evaluates the same inputs;
- a pending/failed inquiry cannot revive cancelled/expired or downgrade paid/duplicate/refunded;
- a later fully matching inquiry may re-evaluate a non-settled `verification_required` attempt.

- [ ] **Step 3: Run and observe the expected failure**

```bash
npx tsx --test src/modules/team-registrations/payment-state.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 4: Implement the policy as a dependency-free module**

Do not import Fastify, Drizzle, Axios, environment variables, or the global database into `payment-state.ts`. Pass environment/test-mode, a non-secret `paymentEnvironmentReady` result, and current state as explicit inputs.

Keep snapshot comparison in `payment-verification.ts`, but have it consume the new paid classification rather than maintaining a second status list. Put the narrow runtime environment adapter there: it may read environment variables, but it must convert them into explicit fail-closed classifier inputs before calling the pure policy.

- [ ] **Step 5: Run focused and module tests**

```bash
npx tsx --test src/modules/team-registrations/payment-state.test.ts src/modules/team-registrations/payment-verification.test.ts
npm run test:team-registrations
```

Expected: PASS.

- [ ] **Step 6: Commit the state policy**

```bash
git add src/modules/team-registrations/payment-state.ts src/modules/team-registrations/payment-state.test.ts src/modules/team-registrations/payment-verification.ts src/modules/team-registrations/payment-verification.test.ts
git commit -m "feat(team-registration): define monotonic payment state policy"
```

## Task 3: Add the Two-Phase Database Migration

**Files:**

- Create: `sql/team-registration-setup/01_preflight_payment_retry_safety.sql`
- Create: `drizzle/0026_team_registration_payment_statuses.sql`
- Create: `drizzle/0027_team_registration_payment_retry_safety.sql`
- Modify: `src/database/schema.ts`
- Modify: `src/modules/team-registrations/types.ts`
- Modify: `src/modules/team-registrations/database.test.ts`

- [ ] **Step 1: Extend failing schema tests first**

Assert that the payment enum contains `cancelled`, `duplicate_paid`, and `refunded`, and that the Drizzle tables expose every approved column, the `isWinner`/active unique invariants, approved consistency checks, reconciliation/event indexes, and `teamRegistrationJobState`.

Run:

```bash
npx tsx --test src/modules/team-registrations/database.test.ts
```

Expected: FAIL on missing enum values/columns/table.

- [ ] **Step 2: Write the read-only preflight SQL**

The script returns and labels:

- registrations with more than one locally paid attempt;
- paid registrations with no paid attempt;
- paid attempts whose registration is not paid;
- existing `verification_required` attempts requiring conservative action backfill;
- more than one active attempt;
- more than one enabled event using the same `payment_profile_code`;
- duplicate attempt numbers, idempotency keys, or references;
- the current definition of `team_registration_payment_idempotency_unique`;
- installed Team Registration columns and enum values.

It performs no writes and ends with a clear zero-anomaly summary query.

- [ ] **Step 3: Write enum-only migration `0026`**

Use separate `ALTER TYPE ... ADD VALUE IF NOT EXISTS` statements for:

```text
cancelled
duplicate_paid
refunded
```

Do not add columns or write rows in this migration, because PostgreSQL enum-value visibility differs across migration transaction strategies.

- [ ] **Step 4: Write schema/backfill migration `0027`**

Wrap `0027` in an explicit transaction and raise all anomaly exceptions before electing or quarantining rows. Add the exact columns and checks from the design, including:

- registration `revision` and `payment_reservation_expires_at`;
- nullable migration-compatible customer email/name/product detail/form action URL snapshots, with application-level completeness required for every new attempt;
- attempt revision (database default `0`, explicitly current on every new state-aware row), winner, cancellation/refund timestamps, successor, review/action, schedule, lease, and reconciliation-count columns;
- self-FK for `superseded_by_attempt_id`;
- partial unique `registration_id WHERE is_winner=true`;
- partial unique `payment_profile_code WHERE is_enabled=true`;
- indexes for active/due/action queries and payment-event `(reference_no, event_type, created_at)` rolling-cap queries;
- `team_registration_job_state`.

Abort unless every paid registration has exactly one paid attempt, every paid attempt belongs to a paid registration, every registration has at most one active attempt, and every enabled payment profile belongs to at most one event. Elect the single paid attempt as winner with revision snapshot `1`. Backfill non-paid attempt revisions to `0`; locally cancel legacy `creating`/`pending` rows with immutable reason `migration_safety`, initialize their bounded terminal schedule, and backfill nullable form snapshots from current data where available. Mark every legacy `verification_required` row action-required with `legacy_verification_required`. Tolerate both full and partial idempotency-index shapes from `0024`/`0024a` without dropping uniqueness.

- [ ] **Step 5: Update Drizzle schema and TypeScript types**

Keep enum values, column nullability, check constraints, stable review/cancellation/action values, and index predicates identical to SQL. Add payment action/review response types without weakening existing unions. New-attempt construction must require all four form snapshots even though migrated legacy columns remain nullable.

- [ ] **Step 6: Apply both migrations to a disposable copy**

Run the preflight, `0026`, and `0027` individually with `ON_ERROR_STOP=1` on disposable databases representing both supported `0024`/`0024a` index shapes. Verify `0026`'s `IF NOT EXISTS` behavior separately; do not assume `0027` is safe to rerun, and document/verify the repository's one-time application mechanism. Confirm migration failures roll back schema/backfill work and never partially elect winners.

Seed and verify at least: one clean paid winner, a paid-registration/attempt mismatch abort in each direction, multiple-active abort, duplicate-enabled-profile abort, legacy active cancellation/scheduling/revision `0`, legacy verification action quarantine, and nullable form-snapshot backfill. Assert every failed fixture leaves the pre-migration state unchanged.

- [ ] **Step 7: Verify**

```bash
npx tsx --test src/modules/team-registrations/database.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit migrations and schema together**

```bash
git add drizzle/0026_team_registration_payment_statuses.sql drizzle/0027_team_registration_payment_retry_safety.sql sql/team-registration-setup/01_preflight_payment_retry_safety.sql src/database/schema.ts src/modules/team-registrations/types.ts src/modules/team-registrations/database.test.ts
git commit -m "feat(team-registration): add payment retry safety schema"
```

## Task 4: Build Transaction-Safe Payment Repository Helpers

**Files:**

- Create: `src/modules/team-registrations/payment.repository.ts`
- Modify: `src/modules/team-registrations/database.repository.ts`
- Modify: `src/modules/team-registrations/payment.integration.test.ts`

**Required helpers:**

- lock an owned registration by event and normalized leader email;
- lock the enabled event config `FOR SHARE` and load category, leader, pricing round, and price through the supplied transaction;
- lock active/all attempts only after the registration lock;
- cancel active attempts with one reason/timestamp without changing paid facts;
- link predecessors to a successor;
- find winner/latest attempt deterministically;
- count newly created attempts for one registration in a rolling window while its lock is held;
- apply a caller-supplied unpaid-registration transition inside the current transaction without re-deciding business policy;
- insert/deduplicate provider events and count postback-started inquiries per reference/window;
- claim a due inquiry by setting `inquiryLeaseUntil` in a short transaction.

- [ ] **Step 1: Write failing real-PostgreSQL tests**

Test that:

- the helper observes edits committed before its registration lock;
- a concurrent backoffice config update cannot produce a quote assembled from mixed config/pricing versions;
- concurrent lockers serialize on registration;
- cancelling active attempts does not touch paid/duplicate/refunded rows;
- a pre-existing local cancellation reason remains unchanged when later provider metadata says cancelled;
- winner/latest selection remains deterministic when a newer non-winning attempt exists;
- rolling counts are scoped to one registration/reference as designed;
- claim uses `SKIP LOCKED` and two callers cannot lease the same attempt;
- quote loading uses the transaction rather than the global `db` connection.

- [ ] **Step 2: Run the integration file**

```bash
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
```

Expected: FAIL until helpers exist.

- [ ] **Step 3: Implement narrow helpers**

Do not put provider calls, response formatting, or business-state decisions in this repository. Accept the Drizzle transaction explicitly and return typed rows/snapshots.

- [ ] **Step 4: Verify lock behavior and build**

Run the focused integration tests at least three times to expose ordering flakiness, then run `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/team-registrations/payment.repository.ts src/modules/team-registrations/database.repository.ts src/modules/team-registrations/payment.integration.test.ts
git commit -m "refactor(team-registration): centralize payment locking helpers"
```

## Task 5: Implement Atomic Cancel-and-Retry

**Files:**

- Create: `src/modules/team-registrations/payment.service.test.ts`
- Modify: `src/modules/team-registrations/payment.service.ts`
- Modify: `src/modules/team-registrations/paysolutions.client.ts`
- Modify: `src/modules/team-registrations/paysolutions.client.test.ts`
- Modify: `.env.example`
- Modify: `src/modules/team-registrations/payment.integration.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:

- same active key returns the same reference/form and does not cancel/create;
- same active key replay is resolved before loading current pricing and uses stored email/name/product/action URL snapshots even after that pricing round closes;
- same-key replay still requires an enabled config and matching local profile/merchant; disabling the event returns `TEAM_REGISTRATION_DISABLED` without reissuing the form;
- same key after redirect TTL returns `IDEMPOTENCY_KEY_REUSED`, makes final reconciliation due, and does not expire the attempt inline;
- same terminal key returns `IDEMPOTENCY_KEY_REUSED` with no form;
- with safe retry disabled, a fresh key preserves legacy `PAYMENT_ATTEMPT_ACTIVE`; with it enabled, a fresh key cancels A as `superseded_by_retry`, creates B, links A to B, and returns B;
- absent/invalid safe-retry environment values fail closed; only the normalized literal `true` enables supersession;
- A's cancellation atomically initializes terminal count `0`, deadline `cancelledAt + 24h`, and immediate reconciliation;
- B snapshots the locked registration revision and the authoritative resolved quote (retained session quote or current new-session price);
- B uses one enabled, share-locked configuration version for category, round, price, profile, and result/form data;
- B stores complete customer email/name/product/action URL snapshots and its redirect form is built only from those stored values after commit;
- invalid redirect snapshot/action data fails before insert and rolls back; a lost HTTP response after commit is recoverable by same-key replay;
- B retains the existing unexpired absolute reservation deadline; it never adds a fresh TTL on retry;
- within that retained session, B reuses A's merchant/category/pricing/amount/currency/customer/product quote snapshots even if the pricing round has ended, requires the current client merchant/profile to match, and refreshes only the form action URL;
- after an elapsed session, B can start `min(now + TTL, registrationClosesAt + TTL)` only while both the draft and registration are still open; race the request at/after draft expiry before the expiry job and assert no row is created;
- an unexpired retained session remains usable after draft/event close, but equality at its absolute deadline is rejected;
- a new session after edit/expiry loads the then-current quote rather than inheriting the old session;
- successor insert failure rolls back cancellation of A;
- paid, expired, incomplete, missing-claim, unresolved verified-money action, wrong-event, and wrong-leader registrations are rejected consistently with the status predicate;
- eleven created attempts inside ten minutes return `PAYMENT_RETRY_RATE_LIMITED` while replays do not consume the limit;
- the attempt limit is per registration, is checked after the registration lock, and independent attempts for another registration do not consume it;
- provider profile mismatch returns `PAYMENT_PROFILE_MISMATCH` before creating a payment row;
- an existing-session merchant snapshot mismatch returns `PAYMENT_MERCHANT_MISMATCH` without cancelling the prior attempt or creating a successor;
- retry never calls `inquiry`.

In `paysolutions.client.test.ts`, inject a transport error whose request headers/body contain marker secrets. Assert the client exposes only `PAYMENT_PROVIDER_UNAVAILABLE`/safe metadata and no marker reaches serialized errors or logs. Also assert inquiry uses documented-default product detail `QWERTY` (or the validated explicit override), keeps the 20-second timeout, follows zero redirects, rejects a response above 64 KiB, and validates only the expected first order row. Parser-level cases must preserve `paidAtState=absent` for a missing field, `valid` for a valid timestamp, and `invalid` for any present malformed value. Test that provider URLs reject userinfo and non-HTTPS production endpoints while allowing loopback HTTP only outside production.

- [ ] **Step 2: Add concurrent integration cases**

Run two fresh keys concurrently with safe retry enabled. Both requests may serialize and return their own committed attempt, but the final database state must contain one active latest attempt, a complete supersession chain, unique attempt numbers, one retained absolute deadline, and no partial cancellation.

- [ ] **Step 3: Run and observe failures**

```bash
npx tsx --test src/modules/team-registrations/payment.service.test.ts
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
```

- [ ] **Step 4: Refactor creation around the registration lock**

Remove the pre-transaction `requireReadyRegistration`/global pricing reads from creation. Inside one transaction:

1. lock and validate registration;
2. classify same-key semantics before current pricing reads, retaining an unexpired row as a replay candidate;
3. for an active same-key row past redirect TTL, make final reconciliation due and return the terminal-key response without inline expiry;
4. lock the event configuration `FOR SHARE`, validate enabled/profile/merchant state, return a safe active replay if present, and otherwise evaluate the shared payment-start predicate;
5. enforce the created-attempt limit;
6. retain or establish the capped, absolute session deadline and identify whether this is an existing or new session;
7. reuse the matching session quote or load a new authoritative quote from that configuration version;
8. cancel active attempts according to the safe-retry flag;
9. prevalidate the deterministic redirect form, then create and link the successor with complete snapshots;
10. update payment reservation/status.

Construct the redirect form only after commit from stored fields. Return `attemptNumber` and `supersededPaymentAttemptId` while preserving current response fields.

- [ ] **Step 5: Validate the merchant profile**

Add `TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE`, `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=false`, `TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES=false`, and documented-default `TEAM_REGISTRATION_PAY_SOLUTIONS_INQUIRY_PRODUCT_DETAIL=QWERTY` to `.env.example`. Parse both booleans fail-closed: only normalized literal `true` enables them, and production always forces test-paid statuses off. Require the local profile code to equal the event's `paymentProfileCode`. Keep credentials in environment variables; never persist secrets.

- [ ] **Step 6: Verify**

```bash
npx tsx --test src/modules/team-registrations/payment.service.test.ts src/modules/team-registrations/paysolutions.client.test.ts
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add .env.example src/modules/team-registrations/payment.service.ts src/modules/team-registrations/payment.service.test.ts src/modules/team-registrations/paysolutions.client.ts src/modules/team-registrations/paysolutions.client.test.ts src/modules/team-registrations/payment.integration.test.ts
git commit -m "feat(team-registration): retry abandoned payments atomically"
```

## Task 6: Cancel Attempts When Payable Team Data Changes

**Files:**

- Create: `src/modules/team-registrations/registration.service.test.ts`
- Modify: `src/modules/team-registrations/registration.service.ts`
- Modify: `src/modules/team-registrations/backoffice.routes.ts`
- Modify: `src/modules/team-registrations/payment.integration.test.ts`

- [ ] **Step 1: Write failing edit tests**

Cover:

- editing a `payment_pending` draft cancels its active attempt with `registration_edited`;
- edit cancellation initializes the same bounded terminal schedule in the edit transaction;
- one logical edit increments revision exactly once;
- a member/email-claim validation or uniqueness failure rolls back the edit, revision, reservation clearing, and attempt cancellation together;
- the edit clears `paymentReservationExpiresAt` and returns `ready_for_payment`/`draft` correctly;
- a new attempt snapshots the new revision;
- a new post-edit session can start only before registration close and is capped at `registrationClosesAt + TTL`;
- paid and expired registrations remain protected;
- leader and pre-payment backoffice edits return `PAYMENT_REVIEW_REQUIRED` while verified money has an unresolved action;
- a pre-payment backoffice correction follows the same revision/cancellation rule;
- a paid backoffice correction remains audited but does not mutate payment snapshots or unlock payment.

- [ ] **Step 2: Add edit-versus-payment concurrency test**

Race an edit against a paid reconciliation. The only acceptable outcomes are:

- reconciliation wins lock: registration becomes paid and edit is rejected; or
- edit wins lock: revision increments and the old paid result becomes review-required.

It must never fulfill revision 1 against revision 2 data.

- [ ] **Step 3: Implement a shared cancellation helper**

Use the payment repository helper from Task 4 inside the existing registration transaction. Do not call `payment.service.ts` from `registration.service.ts`; avoid a service cycle.

- [ ] **Step 4: Verify**

```bash
npx tsx --test src/modules/team-registrations/registration.service.test.ts
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/team-registrations/registration.service.ts src/modules/team-registrations/registration.service.test.ts src/modules/team-registrations/backoffice.routes.ts src/modules/team-registrations/payment.integration.test.ts
git commit -m "fix(team-registration): invalidate payment quotes on team edits"
```

## Task 7: Make Reconciliation Monotonic and Elect One Winner

**Files:**

- Create: `src/modules/team-registrations/payment-verification.service.test.ts`
- Modify: `src/modules/team-registrations/payment-verification.service.ts`
- Modify: `src/modules/team-registrations/jobs-policy.ts`
- Modify: `src/modules/team-registrations/jobs.test.ts`
- Modify: `src/modules/team-registrations/payment.integration.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Use a fake `TeamPaySolutionsClient` and cover:

- matching paid inquiry elects a winner and queues one email set;
- winner election cancels each active sibling as `sibling_paid` and initializes its bounded terminal schedule;
- a cancelled retry predecessor can win when revision/reservation still match;
- another paid reference becomes `duplicate_paid/actionRequired`;
- paid old revision becomes `verification_required/registration_revision_changed`;
- any verified-money review cancels active siblings as `payment_review_required` with terminal schedules; a later sibling settlement is also review until the first action is resolved;
- paid old payment session or post-deadline settlement becomes action-required review, even if a newer session is currently open;
- final inquiry started exactly at the deadline can elect a winner after the network call returns;
- provider `paidAt` absent uses inquiry start, while malformed, earlier than `attempt.createdAt - 5m`, or later than `inquiryCompletedAt + 5m` requires review; exact skew boundaries are accepted;
- released/expired registration becomes review rather than revived;
- same callback is idempotent and does not duplicate email outbox rows;
- a paid/refund-classified amount, reference, merchant, or currency mismatch never fulfills, records an unresolved action/primary stable reason, and does not downgrade an already settled status;
- a non-money mismatched inquiry only records redacted comparison metadata and cannot fail/cancel/terminalize the attempt;
- attempt/local payment-profile or merchant mismatch performs no provider call and advances the normal provider-error retry/heartbeat path with the corresponding sanitized code;
- failed provider result atomically sets `failedAt`, initializes terminal count `0`, deadline `failedAt + 24h`, and `nextReconcileAt=now`, then releases retry through the shared unpaid-registration transition;
- provider cancellation atomically sets `cancelledAt`/`provider_cancelled` when no earlier local reason exists, initializes the identical bounded schedule from `cancelledAt`, and releases retry;
- provider cancellation does not overwrite an existing `superseded_by_retry`, `registration_edited`, or `sibling_paid` reason;
- pending/unknown result only updates metadata;
- stale non-paid result after cancellation/paid is a no-op for local state;
- `VO`/`VOIDED` before settlement cancels, while the same authenticated result after verified settlement refunds;
- refund of duplicate records `refunded`/`refundedAt` without changing original `paidAt`, closes its action with resolution `refunded`, and re-evaluates the unpaid-registration transition;
- provider refund after an administrative resolution updates only refund facts and never overwrites the stored resolution/note/audit;
- refund of winner records `refunded`, keeps `isWinner`, locks registration, and requires action;
- runtime test-status wiring is fail-closed end to end: non-production literal `true` permits the provider test-paid code, absent/malformed flags do not, and production remains unpaid even when the flag is set.

- [ ] **Step 2: Add simultaneous-paid integration test**

Run reconciliation for two references concurrently. Assert one `isWinner=true`, one `duplicate_paid`, one paid registration snapshot, and one initial email set.

- [ ] **Step 3: Refactor inquiry and transaction boundaries**

1. Read immutable reference/snapshot identity and capture `inquiryStartedAt`.
2. Perform provider inquiry with no DB transaction open and capture completion time.
3. Open transaction and lock registration first.
4. Lock/re-read target attempt and siblings.
5. Derive/validate `effectiveSettledAt`, then re-run classification/settlement decision against current rows and the current reservation identity.
6. Apply one monotonic transition and event/outbox writes.

Never write `status: attempt.status` from the stale pre-inquiry object. Conditional updates must include current-state guards or operate on the locked row.

Use one pure `initializeTerminalSchedule(status, baseTime, now)` helper in `jobs-policy.ts` from the same reconciliation transaction that changes an active attempt to `failed` or `cancelled`. It returns count `0`, deadline `baseTime + 24h`, and `nextReconcileAt=now`; Task 10 reuses it for local `expired` transitions and owns subsequent advancement.

When an active attempt ends unpaid with no successor, call one shared transition: retain the current deadline before it elapses; clear it for a new session only when registration remains open; otherwise expire/release only after payment finalization and only when no unresolved verified-money action holds the claims.

- [ ] **Step 4: Preserve immutable registration payment snapshots**

Only the winner writes category, pricing round, amount, currency, paid time, and lock time to the registration. Duplicate/review attempts preserve their own provider facts without changing the team or email queue.

- [ ] **Step 5: Verify**

```bash
npx tsx --test src/modules/team-registrations/payment-state.test.ts src/modules/team-registrations/payment-verification.test.ts src/modules/team-registrations/payment-verification.service.test.ts src/modules/team-registrations/jobs.test.ts
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/team-registrations/payment-verification.service.ts src/modules/team-registrations/payment-verification.service.test.ts src/modules/team-registrations/jobs-policy.ts src/modules/team-registrations/jobs.test.ts src/modules/team-registrations/payment.integration.test.ts
git commit -m "fix(team-registration): reconcile payments monotonically"
```

## Task 8: Update Public Status and Idempotency Contracts

**Files:**

- Create: `src/modules/team-registrations/public.routes.test.ts`
- Modify: `src/modules/team-registrations/types.ts`
- Modify: `src/modules/team-registrations/payment.service.ts`
- Modify: `src/modules/team-registrations/public.routes.ts`
- Modify: `src/modules/team-registrations/payment.service.test.ts`

- [ ] **Step 1: Write failing response tests**

Cover:

- paid registration reports winner fields even when a newer attempt number exists;
- a refunded winner remains the winner and reports top-level `paymentStatus=refunded`, original `paidAt`, and authoritative `refundedAt`;
- unpaid registration reports active/latest attempt;
- `canRetry=true` exactly when the shared predicate allows a new logical attempt, including an active pending attempt only while safe retry is enabled;
- `canRetry=false` for disabled configuration, invalid local URL/credential readiness, event/local or retained-session profile/merchant mismatch, paid, expired, incomplete, missing-claim, unresolved-action, draft/new-session window expiry, and default-off active-attempt cases;
- an unexpired retained session keeps `canRetry=true` after draft/event close, but equality at the reservation deadline is false;
- `requiresAction`, `unresolvedActionCount`, and newest unresolved `reviewReason` aggregate across attempts without exposing secrets or raw provider payload;
- `winnerPaymentAttemptId` and `latestPaymentAttemptId` are independently correct;
- terminal same-key error has the approved structured fields and request ID;
- wrong event/email access remains a non-enumerating 404/401 as currently designed.

- [ ] **Step 2: Implement deterministic winner/latest queries**

Do not use a single latest-attempt join for the paid case. Query/derive winner, active/latest, unresolved-action aggregation, current configuration state, and a non-secret local payment-environment readiness result separately; call the same pure `canStartPayment` policy used by creation and preserve existing top-level response fields. Creation obtains the same inputs under its configuration lock; the read-only status path uses a consistent snapshot. Never expose which credential/URL check failed.

- [ ] **Step 3: Add route schemas/limits**

The payment-attempt route accepts no body and keeps `Idempotency-Key` capped at 100 characters. Map the service's ten-created-attempt rule to `429 PAYMENT_RETRY_RATE_LIMITED`.

- [ ] **Step 4: Verify**

```bash
npx tsx --test src/modules/team-registrations/payment.service.test.ts src/modules/team-registrations/public.routes.test.ts
npm run test:team-registrations
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/team-registrations/types.ts src/modules/team-registrations/payment.service.ts src/modules/team-registrations/public.routes.ts src/modules/team-registrations/public.routes.test.ts src/modules/team-registrations/payment.service.test.ts
git commit -m "feat(team-registration): expose safe retry payment status"
```

## Task 9: Debounce and Bound Pay Solutions Postbacks

**Files:**

- Create: `src/modules/team-registrations/provider.routes.test.ts`
- Modify: `src/modules/team-registrations/provider.routes.ts`
- Modify: `src/modules/team-registrations/payment.repository.ts`

- [ ] **Step 1: Write failing Fastify route tests**

Register only the provider plugin against the isolated test database/fake inquiry client. Test:

- missing/malformed/non-12-digit reference is rejected without a row;
- unknown reference is acknowledged/ignored without an event or inquiry;
- a body over 16 KiB is rejected;
- oversized individual provider strings within the body limit are length-bounded before persistence/logging;
- a forged `paid` payload cannot fulfill when authenticated inquiry is unpaid;
- identical provider event creates one event row;
- the same event delivered again after cooldown can trigger a new authoritative inquiry without inserting another row, including after the 24-hour schedule ended;
- exact normalization/hash vectors cover whitespace, casing, invalid totals, missing event ID/order, and the `U+001F` separator;
- concurrent replays acquire one 30-second inquiry lease/cooldown and call provider once;
- 61 unique payload variations for one reference inside an hour persist at most 60 `postback_received` rows plus one deterministic UTC-hour `postback_throttled` row;
- thirteen unique payload variations for one reference inside an hour start at most 12 postback inquiries; the capped request is acknowledged without accelerating the regular worker schedule;
- provider unavailable returns `202 processing` and leaves a due retry;
- route logs transport failures using only allowlisted error code/reference/request ID and never Axios config, headers, raw response, API key, or secret markers;
- a simulated crash after lease commit leaves the attempt due and the worker can claim it after 30 seconds;
- a later callback after the lease can trigger a fresh authoritative inquiry.

- [ ] **Step 2: Derive a stable event key**

Always hash the composite event identity. `trim()` every field; uppercase merchant/status/status name/currency; normalize total to two decimals or `invalid`; use an empty string for missing provider event ID/order; join provider event ID, reference, order, merchant, status, status name, total, and currency in that exact order with `U+001F`; store `paysolutions:sha256:<hex>`. Store only the key and existing redacted payload. Event deduplication must not permanently suppress a required retry; the cooldown/hourly cap and worker schedule own that decision.

- [ ] **Step 3: Implement bounded route behavior**

Set Fastify `bodyLimit` to 16 KiB and look up the attempt before event insertion. In a short attempt-lock transaction, persist at most 60 new `postback_received` rows per reference/rolling hour; above it, insert at most one `postback_throttled` row per reference/UTC-hour using `paysolutions:throttled:<reference>:<YYYYMMDDHH>` and omit the varied payload. Otherwise insert the normalized event with `ON CONFLICT DO NOTHING`. Both duplicate and storage-throttled deliveries continue to the per-reference 30-second cooldown and at most 12 `postback_inquiry_started` events in the preceding hour. A call-throttled request must not pull the regular worker schedule earlier. When an inquiry is allowed, make `nextReconcileAt` due, then acquire a lease and record the start in that transaction; leave the due timestamp until reconciliation advances it so a post-commit process crash is recovered after the lease expires. Provider-unavailable handling advances the normal reconciliation schedule. Inquire outside the lease-acquisition transaction.

- [ ] **Step 4: Verify**

```bash
npx tsx --test src/modules/team-registrations/provider.routes.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/team-registrations/provider.routes.ts src/modules/team-registrations/provider.routes.test.ts src/modules/team-registrations/payment.repository.ts
git commit -m "fix(team-registration): debounce payment provider postbacks"
```

## Task 10: Reconcile at Expiry and Make the Worker Production-Safe

**Files:**

- Modify: `src/modules/team-registrations/jobs-policy.ts`
- Modify: `src/modules/team-registrations/jobs.test.ts`
- Modify: `src/modules/team-registrations/jobs.ts`
- Modify: `src/modules/team-registrations/jobs-runner.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `src/modules/team-registrations/payment.integration.test.ts`

- [ ] **Step 1: Write failing scheduling tests**

Cover active five-minute eligibility, the TTL final inquiry, terminal checks at immediate/15m/2h/24h, reconciliation counts `0..4`, lease exclusion/recovery after 30 seconds, deadline stop, and clock-boundary equality. Assert the selectors are disjoint: regular active uses `pending && nextReconcileAt <= now && expiresAt > now`; final expiry uses `creating|pending && expiresAt <= now`; terminal schedule uses `cancelled|failed|expired && nextReconcileAt <= now`. At `now == expiresAt`, an active attempt is final-only. Provider success, non-success, and error must all release the lease and advance the applicable schedule.

- [ ] **Step 2: Write failing job/integration tests**

Cover:

- payment completed exactly at TTL is found before local expiry;
- a regular inquiry begun before TTL but completed at/after TTL performs finalization and never writes a due time into the past or causes a second final provider call;
- provider timeout at final inquiry locally expires the attempt and schedules bounded follow-up;
- completed provider-failed, provider-cancelled, and local-expired transitions each start count `0`/immediate/24-hour terminal scheduling exactly once;
- cancellation does not block immediate successor creation;
- late settlement inside grace is reconciled;
- expired registration/released claims cause review, not revival;
- draft expiry skips both an unexpired retained retry reservation (even with no active attempt) and a reservation not yet finalized;
- job order never releases claims before final payment handling;
- unresolved verified-money actions keep registrations and claims held until an allowed resolution re-evaluates the shared transition;
- two workers do not inquire the same attempt concurrently;
- heartbeat records start, success, and sanitized error code;
- privacy purge clears customer email/name/product form snapshots 90 days after event end only for terminal attempts without unresolved actions, while retaining financial/winner/audit facts;
- `/health` always returns HTTP 200 with nested worker `disabled`, `healthy`, or `stale`; disabled requires both no enabled config and no remaining registration/payment/email/retention work, so a disabled event with due attempts still requires a fresh heartbeat.

- [ ] **Step 3: Reorder and split job phases**

Implement:

```text
reconcile due leased attempts
final-inquire TTL attempts
finalize unpaid attempts
expire registrations/release claims
email outbox
privacy purge
heartbeat success/failure
```

Provider calls occur after a due row is leased and outside any row-lock transaction. Every result still goes through the reconciliation service. Implement the three selectors as disjoint repository/job-policy queries and apply the lease predicate to each. A regular result that completes at/after its TTL follows the final-expiry result path; a completed final inquiry must leave `creating`/`pending`, so only lease-expiry recovery after a crash can reclaim it.

Initialize active attempts at `min(now + 5m, expiresAt)`. Reuse Task 7's terminal initializer: `failedAt`, `cancelledAt`, or `expiresAt` is the base for count `0`, deadline `base + 24h`, and next due `now`; completed terminal inquiries advance to count/next pairs `1/base+15m`, `2/base+2h`, `3/base+24h`, then `4/null`. A worker crash leaves only the 30-second lease to expire.

- [ ] **Step 4: Add production Node scripts**

Add scripts equivalent to:

```json
"jobs:team-registrations:prod": "node dist/modules/team-registrations/jobs-runner.js",
"jobs:team-registrations:prod:once": "node dist/modules/team-registrations/jobs-runner.js --once"
```

Keep development `tsx` scripts if useful. Ensure `SIGTERM`/`SIGINT` stop the loop and close the database cleanly.

- [ ] **Step 5: Extend health output**

Report `disabled` only when no Team Registration config is enabled and no registration/payment/email/retention work remains. Otherwise report `healthy` for a successful heartbeat within three minutes and `stale` for missing/older heartbeat. Keep `/health` at HTTP 200 and the base API health response available so a separate worker outage does not trigger an API restart loop.

- [ ] **Step 6: Verify**

```bash
npx tsx --test src/modules/team-registrations/jobs.test.ts
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
npm run build
node dist/modules/team-registrations/jobs-runner.js --once
```

The last command is run only with an isolated/staging database and configured fake/test provider credentials.

- [ ] **Step 7: Commit**

```bash
git add package.json src/index.ts src/modules/team-registrations/jobs-policy.ts src/modules/team-registrations/jobs.test.ts src/modules/team-registrations/jobs.ts src/modules/team-registrations/jobs-runner.ts src/modules/team-registrations/payment.integration.test.ts
git commit -m "fix(team-registration): reconcile payments before expiry"
```

## Task 11: Surface and Resolve Payment Actions in Backoffice

**Files:**

- Modify: `src/modules/team-registrations/backoffice.routes.ts`
- Modify: `src/modules/team-registrations/backoffice.authorization.test.ts`
- Create: `src/modules/team-registrations/backoffice.routes.test.ts`

- [ ] **Step 1: Write failing authorization/contract tests**

Test:

- list accepts `cancelled`, `duplicate_paid`, and `refunded` filters;
- `paymentActionRequired=true` returns duplicate/review/winner-refund rows;
- list/detail identify winner and latest separately;
- detail shows revision, cancellation chain, safe comparison flags, action status, and no secret/raw payload;
- detail returns at most the newest 200 safe event summaries with total/has-more metadata, never an unbounded history;
- viewer can inspect actions but cannot resolve;
- admin resolution accepts only `refunded` or `closed_no_fulfillment` plus a trimmed 1–2,000-character reason;
- a replay with the same resolution/normalized reason is idempotent, while a different second resolution or reason returns `409 PAYMENT_ACTION_ALREADY_RESOLVED`;
- resolution writes one audit entry and cannot change `isWinner`, status facts, amount, reference, or paid time;
- resolution re-evaluates the shared unpaid-registration transition: retry becomes available only when the window/claims predicate permits, otherwise the registration expires and safely releases claims;
- provider-confirmed duplicate refund automatically closes only that duplicate's action;
- enabling a config whose profile differs from the local deployment returns `PAYMENT_PROFILE_MISMATCH`; enabling a second event with an already-enabled matching `paymentProfileCode` returns `409 PAYMENT_PROFILE_ALREADY_ENABLED`, while disabling the first permits the second.
- changing `paymentProfileCode` after the event has any payment attempt returns `PAYMENT_PROFILE_IMMUTABLE`; rotating API/secret credentials without changing merchant ID/profile remains allowed operationally.
- racing the first payment creation against a profile-code edit produces either the old-profile attempt plus an immutable-profile rejection, or the new config plus a payment-profile mismatch; it never creates an attempt under mixed profile data.

- [ ] **Step 2: Implement deterministic list filters**

When registration is paid, payment status/filtering uses the winner where applicable and exposes action-required attempts separately. Avoid the current latest-attempt-only scalar subquery. Map the enabled-profile partial-unique constraint to `PAYMENT_PROFILE_ALREADY_ENABLED` without leaking database details.

- [ ] **Step 3: Implement admin resolution endpoint**

Add:

```text
POST /team-registrations/:registrationId/payment-attempts/:attemptId/resolve-action
```

Lock registration then attempt, validate the action/resolution or return the stored identical result, update only action-resolution fields, invoke the shared unpaid-registration transition, and insert one redacted audit log containing actor, resolution, reason, request ID, and attempt ID. Administrative resolution never elects a winner or rewrites provider/payment facts; only authenticated inquiry may set attempt status to `refunded`.

- [ ] **Step 4: Verify**

```bash
npx tsx --test src/modules/team-registrations/backoffice.authorization.test.ts src/modules/team-registrations/backoffice.routes.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/team-registrations/backoffice.routes.ts src/modules/team-registrations/backoffice.authorization.test.ts src/modules/team-registrations/backoffice.routes.test.ts
git commit -m "feat(team-registration): surface duplicate payment actions"
```

## Task 12: Run the Full Safety Matrix and Document Deployment

**Files:**

- Modify: `src/modules/team-registrations/payment.integration.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `sql/team-registration-setup/README.md`

- [ ] **Step 1: Complete the end-to-end integration scenarios**

At minimum automate:

1. create A -> retry B -> A cancelled -> B wins;
2. with safe retry off, A remains active and B receives the legacy conflict; enabling it makes the same fresh-key flow succeed;
3. create A -> retry B -> A wins first -> B cancelled;
4. B wins -> A settles -> A duplicate/action required;
5. retries retain one absolute session deadline and cannot extend the close grace window;
6. create A -> edit revision -> A settles -> review/no confirmation;
7. provider failed/cancelled -> immediate retry;
8. lost postback -> worker finds payment;
9. settlement at TTL -> winner before claim release;
10. stale inquiry after paid -> no downgrade;
11. identical/varied replay storm -> deduplicated event plus 60 stored-postbacks/hour and 30-second/12-inquiries-per-hour reference bounds;
12. winner refund -> registration locked/action required;
13. duplicate refund -> duplicate action resolved;
14. action resolution idempotently transitions the unpaid registration or safely releases claims after the window;
15. legacy active attempt migrated to `migration_safety` settles -> review, never automatic fulfillment;
16. legacy `verification_required` attempt is surfaced as an unresolved backoffice action;
17. cross-event/email access -> denied.

- [ ] **Step 2: Add invariant SQL assertions**

After the suite and in staging pre/post-deploy checks, assert zero rows for:

- more than one winner per registration;
- more than one active attempt per registration;
- paid registration without a winner;
- a winner whose owning registration is not `paid`;
- a paid registration whose category/pricing/amount/currency snapshots differ from its winner;
- winner with no `paidAt`;
- duplicate paid with `isWinner=true`;
- paid/duplicate/refunded attempt downgraded to pending/failed;
- expired registration whose claims remain active after all reconciliation windows close;
- more than one enabled event for the same payment profile.

- [ ] **Step 3: Document environment and deployment**

Document:

- team Pay Solutions merchant/profile variables;
- safe-retry flag default-off, enablement, and rollback behavior;
- production prohibition on test-paid statuses;
- API and separate compiled-worker commands;
- heartbeat meaning and three-minute stale threshold;
- migration/preflight order;
- Team Registration write-maintenance/drain procedure around backfill and deployment;
- provider-dashboard postback and result URL checks;
- a known-reference sandbox inquiry using the configured product-detail search value;
- exact five-minute/final/15-minute/two-hour/24-hour reconciliation schedule and postback storage/cooldown/hourly inquiry caps;
- duplicate/review/refund action runbook;
- enabled-profile uniqueness and conflict recovery;
- external alerts required for stale heartbeat, provider error rate, action-required count, and reconciliation lag;
- rollback rule: disable safe retry first, retain the state-aware compatibility/reconciliation layer and additive schema/payment facts, and keep payment/provider routes in maintenance if a pre-change binary must be restored.

- [ ] **Step 4: Run the complete verification suite**

```bash
npm run test:team-registrations
TEST_DATABASE_URL="postgresql://.../conference_test" npm run test:team-registrations:integration
npm test
npm run build
git diff --check
git status --short
```

Expected: all tests/build pass, no whitespace errors, and only intended files are changed.

- [ ] **Step 5: Run staging migration and smoke checks**

In order:

1. backup and run the initial read-only preflight;
2. enter the Team Registration write-maintenance window, stop the old worker, drain in-flight Team Registration requests, and re-run preflight;
3. apply `0026`, then `0027` with stop-on-error;
4. deploy the state-aware API with test statuses and safe retry disabled;
5. deploy the compiled worker, verify fresh heartbeat, then reopen Team Registration routes;
6. verify provider dashboard URLs/profile;
7. exercise retry, failure, late payment, duplicate, refund, and replay cases;
8. review action queue and invariant SQL;
9. enable `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=true`, restart/deploy the API, and repeat the retry smoke case;
10. verify external alerts and monitor action queue, reconciliation lag, and provider errors.

- [ ] **Step 6: Commit documentation and final integration coverage**

```bash
git add .env.example README.md sql/team-registration-setup/README.md src/modules/team-registrations/payment.integration.test.ts
git commit -m "docs(team-registration): document safe payment retry rollout"
```

## Final Acceptance Checklist

- [ ] Fresh-key retry performs no provider inquiry and returns a successor immediately.
- [ ] With safe retry disabled, active-attempt behavior and `canRetry` remain consistently legacy/off; rollout explicitly enables it.
- [ ] Previous active attempt is cancelled in the same transaction as successor creation.
- [ ] Same key is idempotent and cannot unexpectedly create/cancel another attempt.
- [ ] Database and service layers enforce one winner.
- [ ] Late second settlement is visible and actionable.
- [ ] Registration edits invalidate old quotes through revisioning.
- [ ] Retry and edit cycles never extend the absolute payment-session deadline beyond the approved window.
- [ ] Paid/review/refund facts cannot be downgraded by stale work.
- [ ] Failed/cancelled provider results release retry immediately.
- [ ] Final inquiry happens before payment expiry/claim release.
- [ ] Public postback replay and unknown references are bounded.
- [ ] Backoffice actions are visible, admin-only to resolve, and audited.
- [ ] Production runs compiled worker code and reports heartbeat health.
- [ ] Migration preflight, backfill, deployment order, and rollback are documented and tested.
