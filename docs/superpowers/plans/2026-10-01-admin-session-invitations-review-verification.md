# Admin Session Invitations — Independent Review and Verification Plan

> Track verification with checkbox (`- [ ]`) steps and the execution policy below. Check the implemented result against the approved design independently of the author's summary. Preparing or revising this document does not start tests, containers, or application edits.

**Goal:** Prove the invitation flow reserves no more than 50 seats, grants access only after explicit acceptance before session start, keeps scoped tokens confidential, and preserves existing grants/registration/payment/check-in behavior.

**Architecture:** Review source/migration/contracts first, then exercise guarded PostgreSQL integration, fake mail recovery, public HTTP semantics, and Docker Chromium flows across Backoffice and Pris2026. Record results by gate and exact source revision; a document checklist is never evidence that runtime behavior passed.

**Tech Stack:** Existing Docker Compose/PostgreSQL16/Node20 tools, node:test/tsx, Fastify.inject, existing direct Chromium/CDP harness, installed Next/TypeScript/ESLint. No new runtime or test framework dependency.

**Implementation plan:** [2026-10-01-admin-session-invitations-implementation.md](2026-10-01-admin-session-invitations-implementation.md)

**Approved design:** [2026-10-01-admin-session-invitations-design.md](../specs/2026-10-01-admin-session-invitations-design.md)

**Execution prompt:** [2026-10-01-admin-session-invitations-review-verification-prompt.md](2026-10-01-admin-session-invitations-review-verification-prompt.md)

**Status:** Planned verification only. All runtime gates below are UNRUN at document creation. Commands requiring future files run only after those files are implemented in a separately authorized turn. The user explicitly requested two planning files and no application edits.

## Global Constraints

- Initially enable this behavior only for PRIS-2026 / POLICY-INNOVATION (Policy Innovation Workshop). Resolve the configured session by event/session codes, never assume production numeric IDs exist in every environment.
- Reserve a seat when Admin creates an invitation. Convert that reservation into a real entitlement on acceptance. Decline, expiry, or invalidated registration releases the reservation.
- Responses are permitted strictly before the session start. At server time equal to startTime, an unanswered invitation is expired. There is no seven-day TTL.
- The initial session has maxCapacity 50. Enforce its stored capacity, without changing other sessions' existing unrestricted Admin grant behavior.
- No new purchase/order/payment/registration code; original confirmed Registration and event boundaries remain.
- Production deployment, production migrations/flags, real email, real payment calls, pushes, and PR publication are not authorized by this document.
- Tests, builds, lint, worker/API/frontend servers, PostgreSQL, fake mail, and browser are confined to the isolated Docker test project. Host use is limited to source/Git inspection and invoking Docker.
- No production DB exports, real attendee PII, production credentials, shared volumes, or host node_modules. Fake transport must be proven, not inferred from an environment variable.
- Errors/logs/artifacts must not disclose raw invitation tokens, authorization headers, ciphertext keys, or email HTML. Synthetic in-memory captures are allowed only inside the private test harness.
- No pass from skipped/blocked tests. No claiming that provider accepted mail means inbox delivery or recipient acceptance.

## Mandatory execution policy — user update 2026-10-01

This policy replaces any earlier per-task Git commit instruction. Follow the approved design and plan exactly. If requirements, contracts, repository state, or a necessary change conflict with the plan or require confirmation, stop dependent work immediately, summarize the evidence and impact, and ask the user before proceeding. Do not silently redesign, add scope, or weaken gates.

- Use brainstorming to check the approved intent, task scope, dependencies, acceptance criteria, and evidence before and after every task. The existing approved design remains the baseline; ordinary implementation choices already covered by it do not require repeated approval. Use api-design-principles for the approved API contracts without changing them.
- Use caveman only for chat progress and the final chat summary. Code, plans, findings, evidence, test names, and commit bodies must remain complete and precise. Refer to skills by name without skill paths.
- Create dedicated isolated Docker test containers for every runtime check: RED/GREEN, unit, integration, migration rehearsal, lint, typecheck, build, smoke, workers, concurrency, recovery, regression, and E2E. The browser and the full application/database/fake-provider stack run inside that project. Host inspection/editing/Git and Docker orchestration are allowed; host test/server runners and shared/live containers are not. Docker unavailable is BLOCKED, never a dependency exception or permission to use host runners.
- Task states are NOT_STARTED, IN_PROGRESS, PASSED, FAILED, DEFERRED_DEPENDENCY, or BLOCKED. Keep task checkboxes unchecked until every required gate passes. Gate outcomes retain the evidence model in the verification file.
- Finish one task, run its required tests, fix in-scope errors, and re-test until green before starting the next. Only a proven prerequisite owned by a later planned task permits DEFERRED_DEPENDENCY. Record blocked task/gates, observed error, source evidence, exact prerequisite task, pending checks, and re-test trigger. Do not defer ordinary bugs, scope conflicts, or infrastructure failures.
- Perform only the planned prerequisite work needed to resolve a deferral. Immediately after that prerequisite passes, re-test all now-unblocked tasks, oldest first, until they pass before starting another task. Record chained dependencies explicitly. Never skip, delete, weaken, or mark expected-failure tests to manufacture a pass.
- Task 1–7 = T00–T06; Task 8–13 = T07–T12. The default commit checkpoints are these two groups. At a checkpoint, all included tasks and now-due deferred tests must pass. Create a title and detailed body per changed repository, explicitly stage only intended files/hunks, and verify the coherent snapshot in Docker. Continue after the first checkpoint; never push.
- A documented adjustment to coherent groups of six or seven PASSED tasks is allowed when real dependencies make the default boundary invalid. Do not claim a snapshot passes using an unstaged prerequisite. If no valid grouping can meet this rule, stop and ask the user. Do not create empty commits in unchanged repositories.
- After the final task passes, independently re-run the complete detailed verification sequence, all required gate groups, and regression coverage at the final source state. Earlier task results do not replace this final run. Any runtime-relevant fix invalidates affected evidence and requires affected re-tests plus another comprehensive final run.
- Record exact Docker commands, exit codes, source revisions/diff identity, task/gate results, sanitized evidence, dependency resolutions, and grouped commit title/body/hash. A documentation-only evidence update after testing must be identified as such; record final commit hashes without pretending tests ran on a different source state.
- During a review-only run, apply the same T00–T12 ownership map to review checkpoints. Verify source and live behavior directly; do not count document sections or gate rows as additional implementation tasks. Fix only in-scope defects under review authorization; if substantial planned implementation is missing, stop and report it rather than silently implementing the whole feature.
- No production operations, real attendee mail/payment calls, pushes, or publication. Writing these documents creates no runtime proof or authorization to start implementation.

## 1. Evidence model and completion rules

Create evidence only during authorized execution under:

`D:/confer/confer/conference/conference-api/docs/superpowers/verification/admin-session-invitations/`

Record baseline.json, gates.json, task-checkpoints.md, commands.log, migration-catalog.json, writer-inventory.md, concurrency-summary.json, mail-recovery-summary.json, screenshots/, browser-console-summary.json, and final-readiness.md. Keep raw token/mail recorder/browser-network dumps out of Git; export only sanitized summaries. Existing grant artifacts remain untouched.

Gate result shape:

```json
{
  "gateId": "RESP-05",
  "taskId": "T05",
  "status": "UNRUN",
  "repositories": {"api": null, "backoffice": null, "pris": null, "web": null},
  "command": null,
  "expected": "One terminal response under concurrent accept/decline",
  "observed": null,
  "evidenceFiles": [],
  "blocker": null
}
```

During execution replace null revision/command/observed fields with actual evidence. Allowed statuses: UNRUN, PASS, FAIL, BLOCKED, NOT_APPLICABLE. NOT_APPLICABLE requires written proof a path is absent in this deployment and reviewer acceptance; it is never used for Docker unavailable, failed tests, or incomplete code.

Readiness requires all required gates PASS, no new scoped regression, migration rehearsal evidence, no credentials leaked, and no unresolved deployment conflict. A provider-only setting that cannot be verified in the test stack is explicitly BLOCKED for production readiness, even if implementation tests pass.

Planning completion is different: these two Markdown files exist, references/contracts/coverage are consistent, Git diff whitespace is clean, and no application source/test/runtime changes occurred. Do not run runtime gates just to finish a document-writing request.

## 2. Fixtures and isolation

### 2.1 Stack topology

Use project session-invitations-test with existing docker-compose.session-grants-test.yml plus new docker-compose.session-invitations-test.yml. Existing project admin-session-grants-test and any production project are different. Services:

| Service | Role | Constraint |
| --- | --- | --- |
| postgres | runtime/integration databases | PostgreSQL16; private network; dedicated named volume |
| api-tools | compile/unit/integration/migration scripts | installed API lockfile dependencies in container volume |
| api-server | real Fastify process | fake transport selected; test JWT/config only |
| worker | separate job runner/process recovery | same invitation key as API; fake transport only |
| fake-mail | private memory recorder/fault injection | no raw payload stdout or public host port |
| backoffice-tools/server | Admin build/UI | BO port3001, internal API3002 |
| pris-tools/server | recipient build/UI | PRIS port3004, internal API3002 |
| web-tools/server | existing entitlement regression | WEB port3003, no new feature UI |
| browser | bundled headless Chromium/CDP | all E2E here, no host browser replacement |

Use synthetic base email origin http://localhost:3004, which the config allows only outside production. In browser tests, assert the email URL origin/path exactly, then replace only its origin with the internal service origin http://pris-server:3004 for Docker navigation. The harness does this network bridge in memory; it is not an application redirect or a relaxed production origin rule. Never write the token-bearing URL to artifacts.

### 2.2 Database identities

- Runtime: confer_session_grants_runtime_test; integration: confer_session_grants_integration_test, both inside this test project's postgres service.
- validateSessionGrantTestDatabaseUrl requires TEST_DATABASE_URL and rejects equality with DATABASE_URL. Preserve that invariant when tests import global modules.
- Check current_database/current_schema before schema reset and before cloning the runtime fixture. No reset against a DB missing the test marker.
- Existing migration tests deliberately reset the integration public schema. Run serially before fixtures and before service suites; no simultaneous E2E using that database.
- Browser fixtures use the distinct runtime database only after latest schema is cloned. Cleanup is restricted to generated fixture IDs/prefix after database identity validation.
- If test databases already contain another run's fixtures, use their explicit guarded cleanup or a fresh project. Do not broadly delete data on a guessed connection.

### 2.3 Fixture matrix

| Fixture | Set up | Why |
| --- | --- | --- |
| Event A/B | two synthetic multi-session events | event mismatch |
| Gated Future | active workshop, start DB now + 2 hours, end + 6 hours, capacity 50, flagtrue | normal create/respond |
| Gated Small | capacity 2 with one actual and zero/one pending | deterministic capacity race |
| Gated AtStart | start fixed to supplied DB-now through test seam | exact deadline |
| Gated Inactive | inactive before future start | rejection/revocation |
| Gated InvalidCapacity | null/0/negative capacity | fail closed |
| Ungated Legacy | flagfalse, active, end future, capacity1 | old Admin over-capacity remains allowed |
| Primary Session | existing Ticket-linked access | original entitlement unaffected |
| Existing50/Existing51 | 50/51 actual legacy rows | no new invitations; no deletion |
| Registration A-confirmed | known user, primary Ticket, original regCode | eligible |
| A-cancelled / B-confirmed / missingID | enum-valid invalid inputs | skip/error |
| Sibling Registration | same user/event, different Registration | no second seat |
| Null-user Registration | user_id=null, different registration IDs | no email-based identity invention |
| ActualExact / ActualSibling | same pair vs same known user on another reg | audit reconcile vs conflict |
| Pending / Accepted / Declined / Expired / Revoked | distinct invitation rows | status presentation/retention |
| Mail failed/unknown/sending lease | pre-send/after-capture/process kill | recoverability |
| Admin/organizer/staff/ordinaryuser | proper test auth roles | creation authorization/public isolation |

Use returned fixture IDs; no hardcoded production 2/5, actual recipient names, or real regCode. Pure deadline tests use 2026-10-29T06:00Z; runtime fixtures are relative to database time, so the suite remains runnable after the real event date.

## 3. Exact command ledger for future execution

All commands in this section are instructions for a later implementation turn. Do not run them during plan writing. Expected successful commands exit0 unless a deliberate RED test says otherwise. Capture exit code/output/source revisions; redact environment secrets.

### CMD-00 — Host read-only baseline

Run in PowerShell from `D:/confer/confer/conference`:

```powershell
git -C conference-api status --short
git -C conference-api rev-parse HEAD
git -C conference-backoffice status --short
git -C conference-backoffice rev-parse HEAD
git -C Pris2026 status --short
git -C Pris2026 rev-parse HEAD
git -C conference-web status --short
git -C conference-web rev-parse HEAD
rg -n 'registrationSessions|registration_sessions' conference-api/src --glob '!*.test.ts'
rg --files conference-api/drizzle conference-api/review Pris2026/src
docker version
docker compose version
```

Record unrelated user edits before implementation. Do not read/print .env or credentials.

### CMD-01 — Compose config, private services, locked dependencies

Run in PowerShell from API root after T00 creates the overlay:

```powershell
$invComposeArgs = @('compose','-p','session-invitations-test','-f','docker-compose.session-grants-test.yml','-f','docker-compose.session-invitations-test.yml')
docker @invComposeArgs config --services
docker @invComposeArgs up -d postgres fake-mail
docker @invComposeArgs ps
docker @invComposeArgs run --rm api-tools npm ci --legacy-peer-deps
docker @invComposeArgs run --rm backoffice-tools npm ci --legacy-peer-deps
docker @invComposeArgs run --rm pris-tools npm ci --legacy-peer-deps
docker @invComposeArgs run --rm web-tools npm ci --legacy-peer-deps
```

Inspect redacted config/volume identities: PRIS mounts, separate project volume prefixes, no host node_modules/no production secret files/no published fake-mail endpoint. If network install needs tool approval, use normal permission flow; never bypass sandbox or change dependency versions to evade it.

Create the integration test DB once in the fresh project:

```powershell
docker @invComposeArgs exec -T postgres createdb -U session_grants_test confer_session_grants_integration_test
```

If already exists, confirm identity/schema/run ownership rather than delete it. The Compose postgres environment already creates the runtime DB.

### CMD-02 — Baseline and final builds/lint

```powershell
docker @invComposeArgs run --rm api-tools npm run build
docker @invComposeArgs run --rm backoffice-tools npm run build
docker @invComposeArgs run --rm backoffice-tools npm run lint
docker @invComposeArgs run --rm pris-tools npm run build
docker @invComposeArgs run --rm pris-tools npm run lint
docker @invComposeArgs run --rm web-tools npm run build
```

Baseline failures are cataloged by file/rule/error before edits; final must contain no new errors from this feature. Changed-file ESLint may narrow a known unrelated repo-wide failure, but the report retains that full-suite limitation. Missing environment/fonts or Docker resources is BLOCKED, never PASS. Do not inject production keys to make a build pass.

### CMD-03 — Pure policy/token and public route tests

After T01/T02/T06 creates their listed files:

```powershell
docker @invComposeArgs run --rm api-tools ./node_modules/.bin/tsx --test src/modules/session-grants/invitation-policy.test.ts src/modules/session-grants/invitation-token.test.ts src/modules/session-grants/invitation-routes.test.ts
docker @invComposeArgs run --rm api-tools npm run test:session-grants
```

Expected: all tests PASS and no open DB connections keep the process alive. Route fakes use the existing injected database/service pattern; they do not prove DB concurrency.

### CMD-04 — Migration preparation and serialized PostgreSQL suites

```powershell
docker @invComposeArgs run --rm api-tools ./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/migration.integration.test.ts src/modules/session-grants/invitation-migration.integration.test.ts
docker @invComposeArgs run --rm api-tools ./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitations.integration.test.ts src/modules/session-grants/invitation-email.integration.test.ts src/modules/session-grants/invitation-writer-compatibility.integration.test.ts
docker @invComposeArgs run --rm api-tools ./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/readers.integration.test.ts src/modules/session-grants/service.integration.test.ts src/modules/session-grants/writer-compatibility.integration.test.ts src/modules/session-grants/email-jobs.integration.test.ts
```

First command must leave schema0032 ready after preserving original pre-0031 checks. File-order dependence must be explicit in the script or staged with separate invocations, not assumed from tsx glob order. If the implementation script stages these files individually, use that staged script for final evidence.

### CMD-05 — Frontend focused helpers

```powershell
docker @invComposeArgs run --rm backoffice-tools /workspace/conference-api/node_modules/.bin/tsx --test src/lib/session-grant-selection.test.ts
docker @invComposeArgs run --rm pris-tools ./node_modules/.bin/tsx --test src/lib/sessionInvitation.test.ts src/lib/refreshRedirect.test.ts
docker @invComposeArgs run --rm pris-tools npm test
docker @invComposeArgs run --rm web-tools ./node_modules/.bin/vitest run src/lib/api/payments.test.ts src/components/ticket/AdminGrantedSessions.test.tsx
```

Confirm WEB file availability from current source before invocation. If a listed legacy file was moved, update the exact command with verified replacement and record the source revision; do not silently skip entitlement regression.

### CMD-06 — Runtime schema clone and synthetic fixtures

Only in the dedicated test project after integration fixtures clean themselves and migration leaves current schema:

```powershell
docker @invComposeArgs exec -T postgres psql -U session_grants_test -d confer_session_grants_runtime_test -c 'SELECT current_database(), current_schema();'
docker @invComposeArgs exec -T postgres pg_dump -U session_grants_test -d confer_session_grants_integration_test -Fc -f /tmp/session-invitations-baseline.dump
docker @invComposeArgs exec -T postgres pg_restore -U session_grants_test -d confer_session_grants_runtime_test --exit-on-error /tmp/session-invitations-baseline.dump
docker @invComposeArgs run --rm api-tools ./node_modules/.bin/tsx review/session-invitations-review-fixture.ts setup
```

The runtime DB must be empty on first restore. On rerun use guarded fixture cleanup or a new isolated project; do not add --clean against a guessed database. No binary redirection through PowerShell is needed; dump stays in the postgres container.

Fixture script must validate runtime test identity before connecting and report generated IDs plus synthetic auth references without invitation tokens. It rejects non-test/runtime mismatches. It only cleans its own prefix/returned IDs.

### CMD-07 — Runtime app/worker and browser

```powershell
docker @invComposeArgs up -d --build api-server
docker @invComposeArgs up -d backoffice-server pris-server web-server worker browser
docker @invComposeArgs ps
docker @invComposeArgs exec -T browser node /workspace/conference-api/review/session-invitations-review-e2e.mjs
docker @invComposeArgs run --rm worker sh -lc 'ADMIN_SESSION_GRANTS_ENABLED=true ./node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --once'
docker @invComposeArgs run --rm worker ./node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --healthcheck
```

The worker's --once is safe only after its fake transport has been asserted active. E2E script waits on real service readiness with bounded timeouts, captures no tokens, and uses BASE_URL_PRIS=http://pris-server:3004 plus the origin bridge in section2.1. Confirm the browser Chromium path from installed image; do not silently install another browser dependency.

### CMD-08 — Final source/evidence inspection and stop

```powershell
git -C conference-api diff --check
git -C conference-api diff --stat
git -C conference-api status --short
git -C conference-backoffice diff --check
git -C conference-backoffice status --short
git -C Pris2026 diff --check
git -C Pris2026 status --short
```

Inspect untracked files separately, since diff does not include them. Commit only intended source/tests/sanitized evidence in their owning repository at the grouped T00–T06 and T07–T12 checkpoints, with title/body and the mandatory execution policy's snapshot proof. After T12 passes, run the complete detailed verification again before the final checkpoint commit. No push or rollout. Retain test volumes until evidence is reviewed; normal compose down stops the dedicated project without deleting its volumes.

## 4. Environment and baseline gates

| ID | Task | Exercise / inspection | Expected and evidence |
| --- | --- | --- | --- |
| ENV-01 | T00 | CMD00/01 Docker/config/services | supported Docker/Compose; expected services/isolated project recorded |
| ENV-02 | T00 | DB env guard wrong/missing/shared URL | rejects before connection/reset; no bypass flag |
| ENV-03 | T00 | mounts/volumes/origins/secrets review | private test resources, synthetic config, no host node_modules |
| ENV-04 | T00 | send one synthetic message through selected worker transport | recorder sees it, no NipaMail request, no raw stdout |
| ENV-05 | T00 | PRIS tools and browser assets | locked dependencies present; PRIS3004 ready and Chromium executable |
| BASE-01 | T00 | capture four repo revisions/status | original edits known; changes attributable |
| BASE-02 | T00 | CMD02 + legacy grant suites | baseline failures separately recorded, no false green |
| BASE-03 | T00/T08 | writer and caller inventory | every direct insert mapped, payment snapshots/ticket links inspected |

## 5. Migration, schema, and DTO gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| MIG-01 | T01 | apply0032 on representative0031 DB | flag default false/table/counts/checks/indexes exist; transaction commits |
| MIG-02 | T01 | old completed batch with added/skipped counts | unchanged values; invitedCount0; old rows satisfy new checks |
| MIG-03 | T01 | invalid outcome/count/lifecycle direct SQL inserts | DB rejects each and rolls back offending statement/transaction |
| MIG-04 | T01 | duplicate pending pair/hash/item FK | rejected; historical closed invitation can coexist with a new pending |
| MIG-05 | T01 | migration lock timeout with held table lock | whole migration rollback; prior schema/data intact; later retry succeeds |
| MIG-06 | T01 | FK deletion attempts/invalid relations | no audit cascade; parent remains or deletion fails clearly |
| MIG-07 | T01 | compare Drizzle definitions and pg_catalog | matching column nullability/timestamptz/check/index shape; no reliance on stale journal |
| DTO-01 | T01/T09 | compile old/new DTO factories and consumers | added/invited/skipped understood; outcome stays invited after accept |

Check named constraints manually; SQL0031 auto-generated compound names differ from named schema representations. No broad deletion of unrelated CHECK constraints. No structural migration enables target flag or modifies maxCapacity/date/room.

## 6. Policy, time, capacity, and concurrency gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| POL-01 | T02 | one millisecond before exact deadline | pending and respondable |
| POL-02 | T02/T05 | now equals/after deadline | expired; no entitlement insert or answer change |
| POL-03 | T02 | current start earlier/later than snapshot | earlier closes earlier; later never extends issued deadline |
| POL-04 | T02/T05 | inactive/cancelled/event mismatch | revoked/unavailable; no reservation/access mutation |
| POL-05 | T03/T05 | accepted/declined link after deadline | recorded result readable, opposite mutation impossible |
| POL-06 | T03/T10 | UTC driver/API/DB/Bangkok display | intended 06:00Z appears 13:00 Bangkok; invitation timestamptz unambiguous |
| CAP-01 | T03 |30 actual + 15 valid pending / capacity 50 | actual 30 / reserved 15 / occupied 45 / remaining 5 |
| CAP-02 | T03 | stale pending while worker stopped | does not consume a seat; GET does not normalize row |
| CAP-03 | T03 | existing entitlement for pending participant | no second count for its reservation; legacy actual rows retained |
| CAP-04 | T04 | request needing more reservations than remaining |409 entire create rollback; no batch/item/email/token row |
| CAP-05 | T04 | invalid/skipped rows in request | count only eligible new reservations; detailed skips, immutable totals |
| CAP-06 | T04 | two disjoint Admin requests race for final seat | one winner, occupied<=capacity; lock order/time evidence |
| CAP-07 | T04/T05 | invalid capacity or 50/51 preexisting actual | new invitations blocked; no automatic deletion or unlimited fallback |

For locking tests use separate postgres connections; openSessionGrantTestDatabase max1 means sharing one handle cannot prove concurrency. Synchronize on an explicit lock/barrier, not arbitrary sleeps. Bound tests with node:test timeout and always release locks in finally/t.after. After deliberate blocked lock release, read clock again to prove a request that waited past deadline cannot accept based on its earlier timestamp.

Required concurrency scenarios and invariants:

| Scenario | Assertions beyond HTTP status |
| --- | --- |
| same Admin/key/body concurrent | one batch, one invitation/item per newly invited registration, same returned batch |
| same key different body | second 409, first data intact |
| two Admin keys same registration | one pending pair/initial mail; loser skipped / already invited |
| same known user two registrations | one reservation across event, explicit duplicate/owned reason |
| capacity 49 + two one-person requests | exactly one reservation succeeds; no count 51 |
| accept vs decline two connections | one terminal response, 0 or 1 entitlement matching winner |
| accept twice | one relation; no second item/batch/reservation |
| respond waits on lock until start | expiry response; no relation; pending no longer counted |
| retry twice | one pending send claim/next attempt, no new invitation/seat |
| worker send blocked while decline happens | decision committed; any already-sent link shows declined; no access |

Record transaction outcomes, row counts, statuses and elapsed lock wait without token payloads. A table/index constraint alone does not prove maxCapacity; session-level serialization and bypass closure are mandatory.

## 7. Creation/read/response gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| CREATE-01 | T04 | Admin confirmed same-event invitation | pending + queued mail; zero new access/order/payment/registration |
| CREATE-02 | T04 | organizer/staff/ordinary user |403 no writes |
| CREATE-03 | T04 | unknown/foreign/cancelled registration | existing detailed skip reasons, no reservation for invalid row |
| CREATE-04 | T04 | existing pending invitation | ALREADY_INVITED, no duplicate token/mail |
| CREATE-05 | T04 | actual same user entitlement | ALREADY_REGISTERED/no additional seat |
| CREATE-06 | T04 | two eligible same user candidates in payload | ascending canonical winner, later DUPLICATE_PARTICIPANT |
| CREATE-07 | T04 | missing origin/key/invalid key before invite |503 configuration error, atomic no writes; ungated grant unaffected |
| CREATE-08 | T04 | idempotent replay/mismatch | same batch/ciphertext/hash/counts; mismatch 409 |
| CREATE-09 | T04 | batch of 1/500 vs 501 | old strict limits; configured capacity still enforced; no truncation |
| CREATE-10 | T04 | inactive / at start / after start | session unavailable/closed before writes |
| CREATE-11 | T04 | re-invite after decline or expired old deadline with future current start | new key / new token/new audit, one active reservation; old answer immutable |
| CREATE-12 | T04 | DB failure partway through batch | all inserts/counts/ciphertexts rolled back |
| READ-01 | T03 | repeated lookup / GET and browser prefetch | zero DB writes, no mail send or token consume |
| READ-02 | T03 | missing/malformed/unknown token | uniform invalid credential behavior; no PII |
| READ-03 | T03 | safe public DTO | no email/regCode/Admin/batch/ciphertext/other invitations |
| READ-04 | T03/T08 | batch/history pagination | global counters, metadata current, no token leakage |
| READ-05 | T03 | legacy and null-ticket actual reader | old entitlement visibility preserved |
| READ-06 | T03 | cancellation/inactive resources after issuance | unavailable/expired result correctly mapped; no claimed active access |
| RESP-01 | T05 | accept pending | exactly one admin_grant/null ticket / original Admin relation; original regCode |
| RESP-02 | T05 | decline pending | no relation; closed/responded timestamps set; one reservation released |
| RESP-03 | T05 | retry same answer |200 same outcome, no duplicate access |
| RESP-04 | T05 | submit opposite answer afterward |409 response already recorded; no change |
| RESP-05 | T05 | simultaneous accept/decline | one winner; row counts/state coherent |
| RESP-06 | T05 | entitlement insert succeeds then simulated update failure | transaction rollback removes new relation and preserves pending |
| RESP-07 | T05 | exact pair already exists with original metadata | preserve source/ticket/checkin; compatible audit link reconciliation |
| RESP-08 | T05 | sibling registration owns same user access | conflict/revoked normalization committed; reservation released |
| RESP-09 | T05 | ciphertext after terminal transition | null; token hash retained only for recorded result lookup |
| RESP-10 | T05 | pending expiry/cancel close operation | correctly closes with reason and no respondedAt |
| RESP-11 | T05 | occupied before / after acceptance | reserved - 1 / actual + 1 / occupied unchanged |
| RESP-12 | T05 | mutable client time/ID/body injection | ignored by schema or rejected; credentials bind actual IDs |

RESP-07 requires special attention: registrationSessionGrantItems.registrationSessionId is unique. If another historical item already references the exact entitlement, new invitation audit must not steal that reference or cause an otherwise valid reconcile to fail. Leaving the new item's linkage null while retaining accepted invitation/actual access is valid only for this evidenced existing-link case; normal new acceptance must link its entitlement.

## 8. HTTP and security gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| HTTP-01 | T06 | route registration/public access | outside protected Backoffice, no normal JWT/session requirement |
| HTTP-02 | T06 | malformed Bearer / array header / normal JWT |401 before service call; no credential echo |
| HTTP-03 | T06 | valid GET | read-only 200 with minimal DTO |
| HTTP-04 | T06 | valid PUT with strict decision |200 new response / same replay;409 opposite |
| HTTP-05 | T06 | extra IDs/role/returnUrl/unknown field |400 strict body; no mutation |
| HTTP-06 | T06 | expired/unavailable |410/409 defined code; safe expired summary only |
| HTTP-07 | T06 | GET/PUT beyond per-IP 30/min |429; no unbounded body/handler work |
| HTTP-08 | T06 | CORS preflight from allowed PRIS / disallowed origin | PUT/Authorization permitted only for configured origin |
| HTTP-09 | T06 | no-store errors/success | header present on all token result responses |
| HTTP-10 | T06/T11 | creation feature disabled | new grants return 503, existing recipient response still works |
| SEC-01 | T02 | token format/random/hash |32 random bytes / 64 hex, cryptographic entropy, SHA256 at rest |
| SEC-02 | T02 | envelope roundtrip/nonce | AES-256-GCM / new 12-byte nonce/16-byte tag; 32-byte key |
| SEC-03 | T02 | tamper/version/wrong key / other invitation ID | authenticated decryption fails; no usable token |
| SEC-04 | T02 | origin validation | HTTPS in production, localhost HTTP only non-production, no Host-derived URL |
| SEC-05 | T02 | invalid configuration and helper errors | no key/raw token/ciphertext disclosure |
| SEC-06 | T03/T06 | DTO/database snapshot inspection | only hash/envelope persisted; no raw token in snapshot/attempt fields |
| SEC-07 | T06 | normal AuthContext / user JWT check | invitation credential never becomes account login |
| SEC-08 | T06 | request/error/log serializers | authorization/query token redacted across alternate URL / error fields |
| SEC-09 | T06 | strict body/prototype/oversized request | reject shape/size before mutation; no arbitrary privilege/redirect |
| SEC-10 | T06 | invalid token enumeration/rate limiter | no recipient data leaked; limits counted consistently |
| SEC-11 | T07 | fake/provider tracking and attempts | no full HTML / token in logs; capture kept private; tracking state documented |
| SEC-12 | T10 | headers/page/referrer/telemetry/storage | no-referrer/no-store/noindex; no localStorage/AuthContext/token in outgoing links |

Inspect actual Fastify logs with a unique synthetic token canary kept in test memory; assert the raw token is absent in collected output. Do not grep committed source for real secrets or dump entire process environment. A sanitized route filename is not enough if req.raw.url or axios error config still contains credentials.

Security review questions (all must have source evidence):

- [ ] Does caller-controlled body ever choose the invitation's registration/session?
- [ ] Is GET entirely read-only, including status normalization and mail scheduling?
- [ ] Can one scoped credential reach normal account/profile APIs?
- [ ] Can a logger serializer, telemetry SDK, locale switch, referrer, or provider click tracker disclose the token?
- [ ] Is ciphertext bound to invitation ID, retained only while pending, and independently hash-checked after decryption?
- [ ] Does key loss produce explicit failure rather than a new token/deadline/reservation silently?
- [ ] Are final answer replays read-only and independent of automatic account login?

## 9. Email, worker, retry and recovery gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| MAIL-01 | T07 | invited item with null relation claimed from queue | sendable via invitation branch, no false ENTITLEMENT_NOT_ACTIVE |
| MAIL-02 | T07 | historical added message | identical session-grant-v1 semantics, valid old snapshot |
| MAIL-03 | T07 | invitation rendering | Thai subject/body, real names/session/room/Bangkok time/deadline, decision page link |
| MAIL-04 | T07 | malicious name/room/link characters | HTML escaped; safe origin/protocol only |
| MAIL-05 | T07 | send success | mail sent; invitation stays pending; capacity unchanged |
| MAIL-06 | T07 | failure before send | failed state/audited attempt; reservation retained; manual retry available |
| MAIL-07 | T07 | unknown after capture | unknown, no auto-retry; acknowledgement needed for manual retry |
| MAIL-08 | T07 | failed/unknown retry | same token/hash/deadline/recipient; no new invitation/access/seat |
| MAIL-09 | T07 | accepted/declined/expired before claim/retry | suppressed/skipped with reason; no mail resurrects invitation |
| MAIL-10 | T07 | claimed process killed before transport | lease recovery restores pending, safe retry with original payload |
| MAIL-11 | T07 | process killed after capture before finalize | unknown recovery, no promised exactly-once mail |
| MAIL-12 | T07 | wrong/missing key after queue creation / invalid ciphertext | safely classified failure and attempt audit; no raw payload log |
| MAIL-13 | T07 | concurrent decision during blocked transport | no wrong access; arriving mail link shows terminal result; no worker lock cycle |

Required crash test protocol:

1. Reset recorder and fixture state through guarded test harness.
2. Start worker in a separate container with explicit fake transport.
3. Observe persisted claim/attempt state through guarded DB, not console token dumps.
4. Kill only that test worker process before or after recorder capture as the test requires.
5. Force lease expiry with test fixture DB update; do not wait three real minutes unnecessarily.
6. Restart worker, assert persisted attempt recovery classification.
7. For unknown retry, submit without acknowledgement -> skipped; with acknowledgement -> one queued attempt, same invitation credential and no new seat.
8. Export call counts / template version/hash-equality/statuses only. Do not export the HTML/raw link.

Review lock graph: mail-claim transaction locks item/attempt only and reads invitation without acquiring business locks; response/normalization acquire session->registrations->invitations->item; finalization never holds item while requesting a session lock. Otherwise a worker/response deadlock can persist despite happy-path tests.

## 10. Writer closure, compatibility and Admin API gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| BYPASS-01 | T08 | legacy add-sessions request includes gated session |409 before any insert; no ticketTypeId contract silently dropped |
| BYPASS-02 | T08 | manual registration with explicit gated selection | fails before Registration/soldCount writes |
| BYPASS-03 | T08 | free/quick/manual automatic linking | excludes gated, keeps other primary sessions |
| BYPASS-04 | T08 | public optional / direct selection injection | rejection at shared boundary; no invitation bypass |
| BYPASS-05 | T08 | addon/ticket_sessions target configuration | absent/unreachable or safely excluded with evidence |
| BYPASS-06 | T08 | settlement snapshot/manual migration writer | inventoried and guarded; no silently lost paid reconciliation |
| BYPASS-07 | T08/T11 | clear flag while pending exists | immediate grant fallback fails closed |
| BYPASS-08 | T08 | new insert path discovered by final rg | reviewer maps it to gate or fixed guard; no unknown writer left |
| BOAPI-01 | T08 | forGrant selector | capacity/deadline/flag/eligibility correct; old session end rule preserved |
| BOAPI-02 | T08 | Registration list with sessionId | actual owned access and active invitation distinguishable across known-user siblings |
| BOAPI-03 | T08 | details/history | invitations separate from actual sessions; mail state independent |
| BOAPI-04 | T08 | pagination/global counts | counters don't change with result page; invited outcome immutable |
| BOAPI-05 | T08 | unconfigured request/history | invited 0 / null, old eligibility and capacity exemption retained |
| REG-01 | T08 | original primary ticket/regCode/Registration status | unchanged after invite/accept/decline |
| REG-02 | T08 | Order/Payment/Invoice/soldCount snapshot | unchanged from grant/invitation response |
| REG-03 | T08 | assigned / specific / all / picker scan before acceptance | no Session access; unrelated sessions still scan |
| REG-04 | T08 | all scan modes after acceptance | allowed subject to existing time / staff checks; metadata intact |
| REG-05 | T08 | reports/export/actual count | actual access only, source admin_grant / null ticket renders |
| REG-06 | T08/T11 | conference-web existing entitlement reader | sees newly accepted access; no fabricated purchase |
| REG-07 | T08 | old added email and legacy grant test suites | no new failure due to invited count / flag / reader changes |

Preflight paid-path proof includes ticket_types/ticket_sessions and pending order/payment details containing optionalSessionIds. If any old paid reference is found, final-readiness says BLOCKED pending resolution. A test that deletes that reference to become green is invalid evidence.

## 11. Backoffice browser gates

| ID | Task | Walkthrough | Expected |
| --- | --- | --- | --- |
| BOUI-01 | T09 | open Add Session from List and Details | same gated session flags/deadline/capacity |
| BOUI-02 | T09 | choose confirmed/unconfirmed/owned/invited/sibling | eligibility aligns with API; visible reasons |
| BOUI-03 | T09 | select across pages/search/filter | selection retained; total / review / remove accurate |
| BOUI-04 | T09 | select all current page then another page | only eligible visible rows added, prior selection retained |
| BOUI-05 | T09 | change Event / Session, cancel confirmation | original context / selection preserved |
| BOUI-06 | T09 | submit capacity failure after another Admin fills the seat | safe error + fresh counts, selected rows preserved |
| BOUI-07 | T09 | response ambiguous network then retry | same key for same payload; no duplicate invitation |
| BOUI-08 | T09 | result rows added/invited/skipped | three distinct labels/counters, no invited rendered as skipped |
| BOUI-09 | T09 | pending / accepted / declined / expired history with manual refresh | correct timestamps / state, actual access shown only after acceptance |
| BOUI-10 | T09 | failed / unknown / closed mail retry | retry only pending; unknown requires acknowledgement; no new seat |
| BOUI-11 | T09 | mail completes but answer pending | polling stops; manual refresh works, no indefinite human-response timer |
| BOUI-12 | T09 | keyboard focus/dialog/table/mobile | labels/reasons/focus trap / return focus/colSpan correct |

Browser evidence uses synthetic recipient first names and masks URL bar/token. Screenshots alone do not prove row counts; accompany them with sanitized DB/API state assertions. Do not duplicate selection reducer implementation in tests; exercise multi-page real DOM flow.

## 12. Pris2026 browser and navigation gates

| ID | Task | Walkthrough | Expected |
| --- | --- | --- | --- |
| PRIS-01 | T10 | direct email-link navigation with nobody logged in | pending page loads, no login/SSO redirect |
| PRIS-02 | T10 | GET while opening with prefetch | buttons await click, no automatic acceptance / decline |
| PRIS-03 | T10 | session/greeting/room/time/deadline | matches API; Bangkok explicitly set; names unchanged |
| PRIS-04 | T10 | click accept | only PUT with decision accepted; buttons disabled; success after API confirmation |
| PRIS-05 | T10 | click decline | only PUT with decision declined; no entitlement; final-answer notice |
| PRIS-06 | T10 | reload pending and terminal page | remains response route, token retained, no home animation redirect |
| PRIS-07 | T10 | header locale switch th <-> en | same invitation / query credential retained, translation complete |
| PRIS-08 | T10 | missing / invalid token | clear invalid state; no PII or token echo |
| PRIS-09 | T10 | expiry while page open then submit |410 expired screen; no stale acceptance |
| PRIS-10 | T10 | opposite answer recorded in other tab |409 then read final state, no incorrect success message |
| PRIS-11 | T10 | network lost after response commit | re-lookup reveals accepted / declined, retry never duplicates |
| PRIS-12 | T10 | registration closed / unauthenticated global state | invitation page still respondable before deadline |
| PRIS-13 | T10 | mobile width 390px / keyboard / screen reader state | two actions usable; no clipping; focus/status/errors clear |
| PRIS-14 | T10 | no-referrer/no-store/noindex/outgoing links/storage | token never propagated to navigation/analytics/account session |

The page should not rely on fixed event numeric IDs or REGISTRATION_OPEN. The API summary is authoritative. Test token changes/unmount with aborted initial GET so an old request cannot overwrite the page for a new token. Assert unsupported decision query parameters do nothing.

## 13. Combined E2E, rollout and rollback gates

| ID | Task | Exercise | Expected |
| --- | --- | --- | --- |
| E2E-01 | T11 | BO invite -> fake email -> PRIS accept -> BO refresh | invitation created, one entitlement, correct states and limit of 50 |
| E2E-02 | T11 | BO invite -> PRIS decline -> invite new person | freed seat usable, first person has no access |
| E2E-03 | T11 | invitation expires with worker stopped | capacity frees, expired link cannot accept |
| E2E-04 | T11 | fake failed send -> BO retry -> PRIS answer | same credential / seat, attempts updated, final state correct |
| E2E-05 | T11 | worker restart unknown retry with acknowledgement | durable audit / state, no silent duplicate invitation |
| E2E-06 | T11 | accepted -> existing WEB reader / check-in / export | access visible and original Ticket / financial state unchanged |
| OPS-01 | T11 | target code resolution and preflight | exactly one target, capacity 50, date convention proved, existing count reported |
| OPS-02 | T11 | flags default false/enable in Docker | other Session behavior unchanged; no production mutation |
| OPS-03 | T11 | disable creation while outstanding tokens exist | public responses still available; no immediate grant bypass |
| OPS-04 | T11 | missing key after restart | explicit safe queue failure / history preserved; no reset TTL / token |
| OPS-05 | T11 | preserve same key across restart | decrypt/resume pending messages; token hash unchanged |
| OPS-06 | T11 | rollback rehearsal/version compat | no old binary rejecting invited rows; no destructive migration |
| OPS-07 | T11 | full final rerun after last edit | all required gates at final revision, blocked list accurate |
| REVIEW-01 | T12 | independent diff/schema/contract review | design traceability complete, source evidence |
| REVIEW-02 | T12 | token/ciphertext/logs/provider tracking review | protection proved, external setting limits explicit |
| REVIEW-03 | T12 | source/untracked/evidence review | no secret/raw mail / token artifact or unrelated changes |
| REVIEW-04 | T12 | commands/revisions/coverage ledger | actual PASS/FAIL/BLOCKED, no stale result or skip as pass |
| REVIEW-05 | T12 | final handoff | exact remaining deployment actions, no unauthorized publishing / real mail |

Runtime feature disable is a creation stop, not a reason to invalidate outstanding recipient links. Never roll back by deleting invitations, replacing the key, clearing the session flag, or deploying code that cannot handle invited outcomes.

## 14. Independent code-review checklist

- [ ] **Schema:** additive/default false; FK audit retention; lifecycle/checks; invited count arithmetic; exact partial unique index; no mutation of existing capacity/data.
- [ ] **Create transaction:** replay first, deterministic lock order, DB clock after locks, all eligibility before capacity, whole oversized batch rollback, token / job / invitation commit together.
- [ ] **Response transaction:** discovery is not authorization, re-read under lock, final-answer idempotency, acceptance insert + state atomic, original Admin metadata preserved, committed normalization before conflict error.
- [ ] **Identity/count:** known user siblings prevent a second seat; null users not merged by email; pending not double counted; actual count remains actual; stale expiration does not depend on worker.
- [ ] **Mail:** message-kind branch checks invitation, no entitlement requirement for pending; safe encryption / hash check; lock graph has no item -> session cycle; retry uses original token / deadline; unknown not automatically retried.
- [ ] **Security:** strict body / Bearer, unique hash, confidentiality at rest / in logs, HTTPS origin validation, public CORS / rate limit / no-store, no normal account login.
- [ ] **Bypasses:** legacy/manual/free/quick/optional/settlement/historical writer inventoried; absence of target purchases proved, paid reconciliation preserved.
- [ ] **Frontend:** three outcomes, independent email / participation, selection recovery, no continuous polling, localized deadline, refresh / language switch works, no registration gate, accessible decisions.
- [ ] **Operations:** existing entitlements / old mail remain valid, flag defaults false, compatible deployment order, key continuity, enable in tests only, outstanding responses survive creation disable.
- [ ] **Evidence:** final revision, actual commands / exit codes, races with independent connections, migration rollback, real Docker UI, no raw tokens committed.

If a checklist item reveals a bug, record a finding with priority, exact file/line, trigger, user/data impact, and minimal correction. Re-run its owning task's gates after correction. Do not expand review into unrelated refactors or payment redesign.

## 15. Spec-to-task-to-gate traceability

| Approved spec section | Implementation tasks | Required verification |
| --- | --- | --- |
|1 scope / Admin-only / reservation / existing access |T00/T04/T08/T11 |CREATE/BYPASS/REG/OPS |
|2 existing code compatibility |T00/T07/T08/T09 |BASE/MAIL/BOUI/REG |
|3 schema/outcome/count |T01/T04/T09 |MIG/DTO/CREATE/BOAPI |
|4 lifecycle / start deadline |T02/T03/T05/T10 |POL/READ/RESP/PRIS |
|5 capacity/identity/locks |T03/T04/T05/T08 |CAP/CREATE/RESP/BYPASS |
|6 token / durable payload |T02/T06/T07/T10 |SEC/MAIL/HTTP/PRIS |
|7 API / Admin / public / error |T04/T06/T08 |HTTP/CREATE/READ/BOAPI |
|8 mail/recovery |T00/T07 |ENV-04 / MAIL / SEC-11 |
|9 Backoffice UX |T09 |BOUI/DTO |
|10 PRIS UX / navigation / time |T02/T10 |POL-06 / PRIS / SEC-12 |
|11 writer / payment / check-in compatibility |T08/T11 |BYPASS / REG / E2E-06 |
|12 rollout/rollback |T11/T12 |OPS/REVIEW |
|13 acceptance checks |T01..T12 |all runtime gates |
|14 file boundaries |T00..T12 |REVIEW-01 / REVIEW-03 |
|15 approved workflow |documents only, then future execution |no application edit during planning |

## 16. Final readiness report template

Write final-readiness.md after authorized execution using:

1. **Result:** ready for separately authorized deployment / blocked, with exact scope.
2. **Revisions:** API/BO/PRIS/WEB hash and working tree status.
3. **Behavior proved:** invite -> reserve -> answer -> access, deadline boundary, no purchase, preserved existing grants.
4. **Gate summary:** PASS/FAIL/BLOCKED counts and full gates.json link; no UNRUN required gate.
5. **Commands:** exact final Docker commands/exit codes and sanitized logs.
6. **Migration:** rehearsal/catalog/lock timeout/legacy data evidence, journal caveat, target preflight.
7. **Security:** encrypted payload/hash, logger/referrer/storage proof, provider tracking constraints.
8. **Worker:** fake selection, failures/unknown/restart/retry, stable key / deadline, backlog health.
9. **UI:** BO and PRIS scenarios/screenshots and actual API / DB assertions.
10. **Remaining deployment actions:** configure secrets / origin / CORS, deploy compatible versions, enable target only after preflight, monitor; no action claimed completed without authorization/evidence.
11. **Rollback:** stop new creation, keep public responses and compatibility / key / data, do not clear flag or downgrade destructively.
12. **Limitations:** unrelated baseline failures, external provider configuration, null-user identity ceiling, outstanding paid-reference conflict if found.

## 17. Planning self-review record

- Gate groups map every implementation task and all approved design acceptance checks.
- Exact Docker commands separate baseline/unit/migration/integration/UI/final runs; future files are labeled as future prerequisites.
- Existing grant-only Docker/CDP tools are reused; only PRIS mounts/services and a private recorder are added.
- Evidence model makes planning review distinct from runtime proof and production readiness.
- No check is marked runtime PASS by writing these documents. No application code, database operation, dependency install, or mail send belongs to this planning turn.
