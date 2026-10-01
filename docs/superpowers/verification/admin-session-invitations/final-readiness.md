# Admin Session Invitations — Final Readiness

Date: 2026-10-02 (Asia/Bangkok)

## 1. Result

**Implementation and independent review: PASS in the isolated Docker verification environment.**

**Production deployment readiness: BLOCKED pending explicit migration/provisioning closure and production runtime configuration.** The authoritative migration chain used by this repository does not currently prove creation of `registrations.attendee_type` or `events.website_url`. Those two columns were added only by the guarded, database-name-restricted Docker test-harness prerequisite. This evidence must not be interpreted as production migration coverage.

No production database, real email provider, real payment provider, deployment, push, or PR publication was performed.

## 2. Revisions and working-tree scope

- conference-api implementation group 2: `0d591663a02ed9d310388fdb58bee1a198870f0c`
- conference-backoffice implementation group 2: `334a96f83531dbdb0975333ca5d6346838cf31d7`
- Pris2026 implementation group 2: `f870a7db2e0279b441f7d1b25d00b3f2e6ba1e35`
- conference-web HEAD (no intentional diff for this group): `4ee1045f7bf670d86ad38eb53eef1a3f27371642`

The implementation/review working trees intentionally contain goal-owned changes that were verified in Docker. `conference-web` remained source-clean. User/unrelated changes were not reset, stashed, cleaned, or reverted.

## 3. Behavior proved

Docker evidence proves the intended flow:

1. Backoffice Admin creates a session invitation for a confirmation-gated Session.
2. The invitation reserves capacity without granting session access.
3. The durable worker renders/sends the Thai invitation through the fake test transport using the original encrypted credential and stable deadline.
4. The recipient can accept or decline through the public PRIS response page without account login.
5. Acceptance atomically swaps one reservation into one `admin_grant` entitlement; decline/expiry/revocation frees the reservation and creates no entitlement.
6. Existing ticket, registration, order/payment, check-in, and source metadata remain unchanged.
7. Existing immediate-grant Sessions and historical grant behavior remain compatible.

The final clean-fixture browser rerun passed the strengthened Backoffice and PRIS gate groups, including cross-page selection, capacity conflict recovery, invitation history, direct unauthenticated link use, locale preservation, accept/decline, reload, conflict/uncertain-response recovery, and token-navigation protections.

## 4. Gate summary

Required implementation tasks I-T00 through I-T12 and the implementation comprehensive final verification are complete.

Fresh final verification evidence:

- API invitation unit/routes/template: 18/18 PASS.
- Legacy/current session-grant unit set: 19/19 PASS.
- Legacy migration suite: 4 PASS.
- Invitation migration suite: 2 PASS.
- Serialized invitation/session-grant integration suite: 10/10 PASS.
- 500-registration load: requested 500, added 500, no truncation.
- API TypeScript build: PASS.
- Backoffice production build: PASS.
- Backoffice task-owned focused lint: PASS.
- PRIS full test suite: 39/39 PASS.
- PRIS production build and focused invitation lint: PASS.
- conference-web focused entitlement/payment compatibility tests: 8/8 PASS.
- conference-web production build: PASS.
- Four-repository `git diff --check`: PASS.
- Strengthened Docker browser review: BOUI and PRIS gate groups PASS.

Backoffice broad focused lint also surfaced five `no-explicit-any` errors in legacy registration-page lines. `git show HEAD` proves the offending usages already existed before this invitation work; the production build passes and invitation task-owned focused files lint clean. These baseline findings are not counted as invitation regressions.

No required invitation gate is being converted from UNKNOWN/interrupted to PASS. The stale recovery task was explicitly classified interrupted and replaced by fresh runtime evidence.

## 5. Final Docker commands/evidence

The final API chain executed in one serialized Docker tools container:

`npm run test:session-invitations && npm run test:session-grants && npm run test:session-invitations:integration && npm run test:session-grants:load500 && npm run build`

Terminal task: `9b2f4b01-5de7-47c2-9892-4922572b9e01`, exit 0.

PRIS final chain:

`npm test && npm run build && <focused invitation eslint>`

Terminal task: `00a824f1-7a4e-4d9c-972f-dab1f310c2b8`, exit 0.

Backoffice task-owned lint: terminal task `738f5fb0-959d-457a-8f31-ac8d2836d4fb`, exit 0. The associated Backoffice production build completed successfully before the documented legacy lint baseline was reported.

conference-web final compatibility chain: terminal task `a6d6e1f4-c749-4f7d-8302-b06f6715ffa1`, exit 0.

Strengthened clean-fixture Backoffice/PRIS browser rerun: terminal task `43d9ca6b-5b5b-461c-9bfe-07f12a131488`, exit 0.

Raw invitation credentials, encryption keys, captured full email HTML, and private token environment contents are intentionally omitted.

### Independent Review FINAL on committed product snapshots

After implementation group 2 was committed, the full Docker matrix was rerun against the committed product revisions rather than relying only on the pre-commit implementation-final run:

- API `0d591663a02ed9d310388fdb58bee1a198870f0c`: task `bf1da54c-2ca8-43a9-b272-68838f794694`, exit 0 — invitations 18/18, grants 19/19, migration 4, invitation migration 2, serialized integration 10/10, load500 500/500, TypeScript build PASS.
- Backoffice `334a96f83531dbdb0975333ca5d6346838cf31d7`: task `4add7e51-b545-4641-a9a2-ca7905d84e50`, exit 0 — production build and task-owned focused lint PASS.
- Pris2026 `f870a7db2e0279b441f7d1b25d00b3f2e6ba1e35`: task `f29d33ca-345d-41ac-89e2-3cacb2ac4155`, exit 0 — 39/39 tests, production build and focused invitation lint PASS.
- conference-web `4ee1045f7bf670d86ad38eb53eef1a3f27371642`: task `f94e37c4-7803-4f16-a9e8-39e73e88282a`, exit 0 — focused entitlement/payment tests 8/8 and production build PASS.
- Fresh clean-fixture browser review: task `00acba4a-9afe-4ef0-a3cd-001a3dc82a11`, exit 0 — BOUI-01-05, BOUI-06, BOUI-08-12, PRIS-01-03-06-07-14, PRIS-04, PRIS-05 and PRIS-08-12-13 all PASS.

The review fixture was cleaned and re-created before this browser run. The private response credentials were refreshed only in the ignored review env file and were not copied into the evidence.

## 6. Migration

The invitation migration itself is additive and verified from the supported pre-invitation baseline, including lock-timeout rollback with no partial DDL.

However, deployment migration completeness is **not** proven because two historical application-schema prerequisites are absent from the authoritative migration chain:

- `registrations.attendee_type varchar(20)`
- `events.website_url varchar(500)`

The isolated Docker harness applies only these prerequisites through `review/session-invitations-test-harness-prerequisites.sql`, guarded to the two goal-owned test database names.

Before deployment, choose and review an authoritative migration/provisioning path for these columns, rehearse it against the intended deployment baseline, and rerun the migration/integration gates without relying on the harness-only prerequisite.

## 7. Security

Verified properties include:

- Invitation credential is random 32 bytes rendered as 64 lowercase hex characters.
- SHA-256 token hash is persisted for lookup; the raw credential is not persisted as the lookup value.
- Pending-mail recoverability uses AES-256-GCM with a strict 32-byte key and invitation-ID binding.
- Public API accepts the invitation credential only as strict Bearer authorization.
- Response body is strict decision-only and capped.
- Success/error responses use `Cache-Control: no-store`.
- PRIS response route uses `no-referrer` and `noindex/nofollow`.
- Invitation credential is not copied into account auth storage, localStorage, or sessionStorage.
- API unexpected-error logging uses fixed codes and does not serialize the credential.
- Private Docker review token env is explicitly ignored by Git to prevent accidental staging.

Provider-level click tracking remains an external provider configuration concern; the application transport schema exposes no supported switch and no undocumented field was invented.

## 8. Worker / retry / recovery

Fake-transport and integration evidence covers definitive failure, unknown-after-capture, explicit unknown acknowledgement, stale claim recovery, closed-state suppression, missing/wrong encryption key, restart with the original key, and retry using the same invitation credential/hash/deadline without creating a second seat or entitlement.

Creation disable is fail-closed for new Admin grants while already-issued recipient response links continue to work.

## 9. UI

Backoffice evidence covers:

- gated Session capacity/deadline display;
- eligible/ineligible reasons;
- selection persistence across pagination/search/filter;
- current-page select-all without clearing prior pages;
- Event/Session-change confirmation;
- capacity failure preserving the selected rows;
- added/invited/skipped result separation;
- invitation history and mail retry rules;
- manual refresh with no indefinite recipient-response polling.

PRIS evidence covers:

- direct unauthenticated email-link navigation;
- no automatic accept/decline on GET;
- Bangkok time/deadline display;
- accept and decline;
- terminal reload;
- locale switch while preserving the invitation context;
- invalid/expired/conflicting/uncertain response handling;
- mobile/accessibility behavior;
- no-referrer/no-store/noindex and no invitation-token storage.

## 10. Remaining deployment actions

Before any separately authorized production deployment:

1. Add/review the authoritative migration or provisioning for `registrations.attendee_type` and `events.website_url`.
2. Rehearse the real migration chain from the intended production baseline and rerun migration/integration gates without the harness prerequisite.
3. Configure a stable server-only invitation encryption key and preserve it across restarts/rollbacks.
4. Set the canonical HTTPS root in production Event `PRIS-2026`'s `events.website_url`, include that origin in API `CORS_ORIGIN`, and point Pris2026 `NEXT_PUBLIC_API_URL` to the deployed API. After the Event-origin delta passes, `PRIS_FRONTEND_URL` is no longer required.
5. Deploy compatible API/worker, Backoffice, PRIS, and conference-web versions in an order that preserves outstanding invitation rows.
6. Run target Session preflight before enabling `admin_grant_requires_confirmation`.
7. Enable only the intended target Session after verification and monitor invitation/mail/error/backlog state.
8. Confirm provider-level email tracking/privacy settings through provider administration if required.

None of these deployment actions is claimed completed by this goal.

## 11. Rollback

Safe rollback is to stop **new creation** using the feature control while preserving:

- public recipient response routes;
- invitation rows and audit history;
- the existing encryption key;
- compatibility with invited grant-item outcomes.

Do not roll back by deleting invitations, rotating/removing the key, clearing the Session confirmation flag while pending invitations exist, or deploying an older binary that cannot read invited outcomes.

## 12. Limitations

- Authoritative migration-chain completeness is blocked by the two historical prerequisite columns described above.
- Provider-level email click-tracking behavior is external to the application transport contract.
- Null-user participant identity remains registration-scoped by design; known users are deduplicated across sibling registrations.
- Existing unrelated repository lint debt remains outside this feature scope and was not rewritten.
- All runtime evidence is from goal-owned isolated Docker test data and fake transport; no production operation was performed.

## 13. Event website origin delta — checkpoint ledger (2026-10-02)

This section records only the focused four-task delta. Historical evidence above remains evidence for its original revisions.

Baseline revisions: API `eecbdeb8db7fd85a0a010d8bf44f73408eb44e97`, Backoffice `334a96f83531dbdb0975333ca5d6346838cf31d7`, Pris2026 `f870a7db2e0279b441f7d1b25d00b3f2e6ba1e35`, conference-web `4ee1045f7bf670d86ad38eb53eef1a3f27371642`. All tracked diffs were empty. The pre-existing untracked continuation prompt is excluded and remains untouched.

Environment: newly created `session-invitations-test` project; project label and `current_database()/current_user` checked before provisioning. Runtime and integration databases are respectively `confer_session_grants_runtime_test` and `confer_session_grants_integration_test`, owned by `session_grants_test`. Existing API lockfile dependencies installed with Docker `api-tools sh -lc 'npm ci --no-audit --no-fund'`, exit 0; no dependency or lockfile changed.

Initial baseline chain: invitation units 18/18 and grant units 19/19 passed; migration rehearsal 4/4 and invitation migration 2/2 passed. Serialized integration encountered `42P01: relation "backoffice_users" does not exist` in the runtime DB, which was still empty. This is provisioning evidence before RED, not a delta regression. The run-owned tools container was stopped after checking its project label. The existing guarded SQL prerequisite was applied to integration and its schema cloned into the verified empty runtime DB using Docker PostgreSQL `pg_dump --schema-only | psql -v ON_ERROR_STOP=1`.

| Task | State | Files/diff identity | RED command/result | GREEN command/result | Dependency | Re-test trigger | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PASSED | Token source/tests diff `4c61bed4ee3f4c7f7858c8194e208b5464a3535f` over baseline HEAD | Token command below, exit 1: missing helper export | Token 5/5; compile closed by Task 3 chain, exit 0 | Compile dependency closed | Helper/caller change | Task 1 record below |
| 2 | PASSED | Creation/type/tests diff `f553579b4c74f4e1028a8b3267552496645a957c` over baseline HEAD | Creation command below, exit 1: missing persisted origin | Creation/service 5/5, exit 0 | Task 1 helpers satisfied | Creation/snapshot change | Task 2 record below |
| 3 | PASSED | Worker/email-tests diff `c88d25fc8986cba7d01297ddee351da7d5cb1fdb` over baseline HEAD | Email command below, exit 1: seven unexpected sends and wrong new origin | Email 8/8, units 19/19, compile exit 0; repeated after accepted/expired/missing-key assertions | Tasks 1–2 satisfied | Worker/snapshot change | Task 3 record below |
| 4 | PASSED | Final runtime/test diff `39bf1edecb0441c1cc99be7a9cd3d2e205f19c78` over baseline HEAD; generated frontend config drift below | Docker `test -z "${PRIS_FRONTEND_URL+x}"`, exit 1 | API matrix, fresh browser, fake worker, captured-mail acceptance and worker health exit 0; final scope inspection passed after authorized generated-config restoration | Tasks 1–3 satisfied; scope permission granted and closure verified | Runtime/fixture change | Task 4 record below |

Dependency audit after Task 3: Task 1 compile is closed. No due deferred check remained. Comprehensive final results are recorded at the end of this section.

Baseline rerun after provisioning: Docker chain `npm run test:session-invitations && npm run test:session-grants && npm run test:session-invitations:integration && npm run build`, exit 0. Observed 18/18 invitation units, 19/19 grant units, 4 migration checks, 2 invitation migration checks, 10/10 serialized integration checks, and TypeScript build. Baseline source remained API HEAD with no runtime diff.

Task 1: token-test RED exit 1, missing `parseInvitationFrontendOrigin` export (expected by plan); test diff identity `9a5ec785bb5fac30da323474584e166c031cdd86`. GREEN token suite 5/5, followed by compile exit 1 only for TS2305 missing `readInvitationConfig` in `service.ts:21` and `email-jobs.ts:27`. Commands use `docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc` with respectively `./node_modules/.bin/tsx --test src/modules/session-grants/invitation-token.test.ts` and `./node_modules/.bin/tsx --test src/modules/session-grants/invitation-token.test.ts && npm run build`.

| Blocked task/check | Exact failure | Later prerequisite | Pending command | Re-test trigger | Final result |
| --- | --- | --- | --- | --- | --- |
| Task 1 compile | TS2305: removed combined config still imported by service/email-jobs | Task 2 creation caller and Task 3 worker caller | Docker `npm run build`, token tests and invitation units | Immediately after Task 3 GREEN, before Task 4 | PASSED: Task 3 chain exit 0, invitation units 19/19 and build |
Task 2: initial test invocation failed at the removed combined-reader import; that failure was not counted as behavior RED. Creation caller was first changed to consume Task 1 encryption-key helper without adding Event validation/snapshot behavior. Repeated exact focused command then exited 1 at persisted origin assertion: actual null, expected `http://localhost:3004`; existing three invitation integration tests remained green. GREEN exact plan command `./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitations.integration.test.ts src/modules/session-grants/service.integration.test.ts` in Docker exited 0, 5/5. Assertions cover distinct synthetic Events, normalized snapshot, null/non-root atomic rejection (batch/item/invitation/reservation/entitlement counts unchanged), replay after valid and null Event changes, new-origin invitation, ungated null-website grant, existing capacity/lifecycle/concurrency. Test initialization reuses the existing database-guarded prerequisite SQL after migration rehearsal; no migration/schema source changed. Task 1 compile remains deferred only until the worker caller changes in Task 3.
Task 3: initial import failure was not counted as behavior RED. Worker key caller was separated first while preserving its old destination selection for RED only; no compatibility wrapper was retained. Repeated exact focused email integration command exited 1: seven invalid snapshot cases each called transport once (expected zero), and later invitation used localhost rather than the changed IPv6 Event origin. GREEN plan command `./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitation-email.integration.test.ts && npm run test:session-invitations && npm run build` exited 0: email integration 8/8, invitation units 19/19, TypeScript compile passed. No obsolete worker ENV access remains. Tests prove first-send origin after Event change, failed-send retry URL/token/full content/deadline equality in memory, newly created invitation origin, safe failures and unchanged credentials/deadlines for missing/null/non-string/path/credentials/query snapshots, wrong key, unknown acknowledgement, restart, declined/expired suppression and no entitlement before acceptance. Task 1 compile dependency is closed; no due deferred check remains.

### Task 4 runtime results and scope checkpoint

All commands below used project `session-invitations-test` with `-f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml` from conference-api.

- ENV RED: `run --rm api-tools sh -lc 'test -z "${PRIS_FRONTEND_URL+x}"'`, exit 1 because obsolete ENV was present. After removal, the same assertion passed in the complete API chain.
- API GREEN: `run --rm api-tools sh -lc 'test -z "${PRIS_FRONTEND_URL+x}" && npm run test:session-invitations && npm run test:session-invitations:integration && npm run test:session-grants && npm run build'`, exit 0: invitation units 19/19, legacy migration 4/4, invitation migration 2/2, serialized integration 18/18 (including seven invalid-origin subcases), grant units 19/19 and TypeScript build. The later E2E cleanup-only change does not affect API source/tests; its owner checks were repeated below.
- Docker Backoffice `npm ci --no-audit --no-fund`, exit 0. Pris initial strict `npm ci` exited 1 with `EUSAGE: Missing: @swc/helpers@0.5.23 from lock file`; `npm ci --legacy-peer-deps --no-audit --no-fund` then exited 0 using the existing lockfile. No package or lockfile was edited and no dependency was added.
- `build api-server`, exit 0; isolated runtime image manifest list `sha256:2fed8dd2b3ee9f478da4e128c0ddeb85a1689c9daeb24bf5185d40f25183fb4e`. Compose config inspection confirmed no obsolete ENV in api-tools/api-server/worker, while key/API/CORS/browser settings remain present without displaying their secret values.
- Before runtime reset/clone, checked Docker project label and both exact database names/users. Runtime public schema was reset in the owned test DB and cloned from the integration schema using Docker PostgreSQL `pg_dump --schema-only | psql -v ON_ERROR_STOP=1`. Existing guarded schema prerequisites remained harness-only; no migration/schema source changed.
- `run --rm api-tools ./node_modules/.bin/tsx review/session-invitations-review-fixture.ts setup` was captured into private PowerShell memory. Only its three invitation credentials were written to the ignored review-token env exactly as the plan specifies, never displayed. `git check-ignore --quiet -- review/session-invitations-review-tokens.env` exited 0; `git ls-files` showed the file is untracked.
- `up -d postgres fake-mail api-server worker backoffice-server pris-server browser`, exit 0. Initial `exec -T browser node /workspace/conference-api/review/session-invitations-review-e2e.mjs` exited 1 at `Expected checkbox INV-CAND-1`; its existing wait checks presence rather than eligibility readiness. Warm rerun without any frontend/harness edit passed all seven BOUI/PRIS gate groups, exit 0. This is observed retry evidence, not a claim that the unmodified harness cannot race.
- Initial fake worker and captured-mail acceptance both reached success, but the acceptance script exited 1 during Chromium profile cleanup (`ENOTEMPTY`). Added native recursive-removal retries in the mapped acceptance script. After reseeding fresh fixtures/token env, resetting only the private fake recorder and recreating only browser, the entire browser sequence passed again: BOUI-01-05, BOUI-06, BOUI-08-12, PRIS-01-03-06-07-14, PRIS-04, PRIS-05, PRIS-08-12-13, exit 0.
- Final Task 4 worker/acceptance sequence: `run --rm worker sh -lc 'ADMIN_SESSION_GRANTS_ENABLED=true ./node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --once'`, exit 0, claimed=1/sent=1/failed=0/unknown=0; `exec -T browser node /workspace/conference-api/review/session-invitations-e2e-accept-latest.mjs`, exit 0, public Event origin/path assertions and PRIS/API accepted result passed; `run --rm worker sh -lc './node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --healthcheck'`, exit 0, no pending/sending/expiredSending/unknown backlog. PostgreSQL assertion in the owned runtime DB proved exactly one INV-CAND-2/INVITE-UI entitlement and stored origin `http://localhost:3004`.

**Historical scope checkpoint (subsequently closed with explicit user authorization): Tasks 1–3 PASSED; Task 4 BLOCKED_WAITING_USER at final scope inspection.** At that checkpoint, no due deferred check remained, comprehensive final verification had not started, and nothing was staged, committed or pushed.

Historical scope blocker: both conference-backoffice and Pris2026 were tracked-clean at baseline, but running the prescribed Docker Next dev services changed their tracked `tsconfig.json` files. Both diffs have original blob `cf9c65d` and generated blob `295acdb`: Next added `.next/dev/dev/types/**/*.ts` and expanded existing arrays/formatting. No frontend application component was edited. These two files are outside the focused File map. At that checkpoint, they had not been restored, staged or committed and permission was requested before touching them. conference-web remained clean. The pre-existing continuation prompt remained untouched.

Impact at that checkpoint: Task 4 could not become PASSED with out-of-map diffs present. Pending work was permission to restore only these identified Next-generated config changes, then Task 4 scope closure, a new comprehensive final run at the final source state, explicit staging and the single cohesive commit. Production remained unmodified and blocked on authoritative provisioning plus canonical HTTPS Event URL, stable server-only key, explicit CORS and deployed API configuration.
### Scope closure and comprehensive final run start (2026-10-02)

The user explicitly approved restoring only the identified Next-generated tsconfig changes and continuing final verification/commit. On resume, focused plan, checkpoint/dependency records, evidence and four-repository revisions/status/diffs were reread. Runtime/test diff identity remained `39bf1edecb0441c1cc99be7a9cd3d2e205f19c78`; no API source drift occurred. With Next services stopped, the exact generated array-formatting and extra include changes were reversed using a narrow patch, without reset/checkout/clean/stash. Backoffice, Pris2026 and conference-web now have no tracked diff. The historical blocker above is closed.

Tasks 1–4 runtime/verification work is PASSED and no due deferred dependency or scope blocker remains. Task 4's final commit checkbox remains the authorized post-verification checkpoint, not a fifth implementation task. Comprehensive final run starts now at baseline API HEAD plus runtime/test diff identity `39bf1edecb0441c1cc99be7a9cd3d2e205f19c78`. No runtime-relevant edit is planned during this run. Fresh guarded integration schema rehearsal, focused checks, complete API matrix and fresh runtime browser/fake-mail verification will be recorded below. No commit/push has occurred yet.

### Comprehensive final verification (2026-10-02)

Final source identity: API parent `eecbdeb8db7fd85a0a010d8bf44f73408eb44e97` plus runtime/test/fixture/Compose diff `39bf1edecb0441c1cc99be7a9cd3d2e205f19c78`, computed with `git diff -- src/modules/session-grants review/session-invitations-review-fixture.ts review/session-invitations-e2e-accept-latest.mjs docker-compose.session-invitations-test.yml | git hash-object --stdin`. No runtime-relevant edit occurred during this final run. Evidence and plan checkbox edits afterward do not alter tested source. Tasks 1–4 PASSED; no due dependency, implementation failure or scope blocker remains.

Every Docker command below used this exact prefix from conference-api:

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml
```

Fresh integration verification checked PostgreSQL project ownership and `SELECT current_database(), current_user` before migration rehearsal. The API command was `run --rm api-tools sh -lc` with this exact command string, exit 0:

```sh
./node_modules/.bin/tsx --test src/modules/session-grants/migration.integration.test.ts && ./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitation-migration.integration.test.ts && ./node_modules/.bin/tsx --test src/modules/session-grants/invitation-token.test.ts && ./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitations.integration.test.ts src/modules/session-grants/service.integration.test.ts && ./node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitation-email.integration.test.ts && npm run test:session-invitations && npm run test:session-invitations:integration && npm run test:session-grants && npm run build
```

Observed in order: migration rehearsal 4/4, invitation migration 2/2, token unit 5/5, creation/service integration 5/5, email integration 8/8, invitation unit suite 19/19, full integration's migration 4/4 and invitation migration 2/2, serialized integration 18/18, grant units 19/19 and TypeScript build. Every TAP group reported zero failures. These are new results after Task 4 PASSED, not reused baseline results. Assertions prove key-only configuration, production/local URL matrix and safe errors; atomic gated rejection and ungated compatibility; normalized immutable snapshots and idempotent replay; unchanged first-send/retry credentials/content/deadlines after Event changes; new invitations using the new origin; seven invalid-snapshot no-send cases and key/recovery/terminal suppression regressions.

Fresh runtime preparation, all exit 0 after verifying project ownership and both database names/users:

```text
stop api-server
exec -T postgres psql -v ON_ERROR_STOP=1 -U session_grants_test -d confer_session_grants_runtime_test -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
exec -T postgres sh -lc 'pg_dump -U session_grants_test --schema-only confer_session_grants_integration_test | psql -v ON_ERROR_STOP=1 -U session_grants_test -d confer_session_grants_runtime_test'
run --rm api-tools ./node_modules/.bin/tsx review/session-invitations-review-fixture.ts setup
exec -T worker node --input-type=module -e 'const r=await fetch("http://fake-mail:8025/reset",{method:"POST"});if(!r.ok)process.exit(1)'
up -d postgres fake-mail api-server worker backoffice-server pris-server browser
up -d --force-recreate browser
```

Fixture credentials were captured only in private memory and the ignored token env using the exact plan procedure. `git check-ignore --quiet -- review/session-invitations-review-tokens.env` exited 0; `git ls-files -- review/session-invitations-review-tokens.env` returned no tracked path. No credential, captured HTML or token-bearing link is recorded here.

Final browser/mail commands, each exit 0:

```text
exec -T browser node /workspace/conference-api/review/session-invitations-review-e2e.mjs
run --rm worker sh -lc 'ADMIN_SESSION_GRANTS_ENABLED=true ./node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --once'
exec -T browser node /workspace/conference-api/review/session-invitations-e2e-accept-latest.mjs
run --rm worker sh -lc './node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --healthcheck'
```

Browser observed all seven gate groups PASS: BOUI-01-05, BOUI-06, BOUI-08-12, PRIS-01-03-06-07-14, PRIS-04, PRIS-05 and PRIS-08-12-13. Worker claimed=1/sent=1/failed=0/unknown=0/suppressed=0 through private fake transport. The captured-mail script asserted public origin `http://localhost:3004` and path `/th/sessions/confirm` before private navigation, then reported mailCaptured=true/prisAccepted=true/apiStatus=accepted. Worker health reported pending=0/sending=0/expiredSending=0/unknown=0. No API `/health/ready` or real-provider readiness is claimed: the schema-only runtime lacks the unrelated abstract-tracking allocator baseline data.

Additional database proof used `exec -T postgres psql -U session_grants_test -d confer_session_grants_runtime_test -Atc` with this SQL, exit 0:

```sql
SELECT current_database(),
  (SELECT count(*) FROM registration_sessions rs
   JOIN registrations r ON r.id=rs.registration_id
   JOIN sessions s ON s.id=rs.session_id
   WHERE r.reg_code='INV-CAND-2' AND s.session_code='INVITE-UI'),
  (SELECT gi.notification_snapshot->>'responseOrigin'
   FROM registration_session_grant_items gi
   JOIN registrations r ON r.id=gi.requested_registration_id
   JOIN registration_session_grant_batches b ON b.id=gi.batch_id
   JOIN sessions s ON s.id=b.session_id
   WHERE r.reg_code='INV-CAND-2' AND s.session_code='INVITE-UI'
   ORDER BY gi.created_at DESC LIMIT 1);
```

Observed `confer_session_grants_runtime_test|1|http://localhost:3004`: exactly one entitlement for the accepted candidate and the Event snapshot origin. The first auxiliary query incorrectly used nonexistent `gi.registration_id` and exited 1; source schema inspection identified the existing `requested_registration_id`, and the corrected query above passed without application edits. This query error did not invalidate completed browser/API behavior checks.

Final inspection: resolved Compose JSON contained no `PRIS_FRONTEND_URL` for api-tools/api-server/worker; encryption key, API `CORS_ORIGIN`, Pris `NEXT_PUBLIC_API_URL` and browser `BASE_URL_PRIS` remained configured (values withheld). `rg -n "PRIS_FRONTEND_URL|readInvitationConfig" src review docker-compose.session-invitations-test.yml` returned no matches (expected exit 1); `git diff --check` exited 0. After stopping both Next test services, the recurring identical generated tsconfig changes were narrowly reversed under the user's explicit authorization; all three other repositories were clean and their baseline revisions unchanged. The continuation prompt hash remained `d7fef6c98dd2f4a809eb8cbc60a14ec61756f0b2` and it remains excluded. Only the twelve focused File-map files and the explicitly requested plan checkbox document are changed. No schema/migration/frontend/payment/registration/check-in/dependency/lockfile change is included.

Production boundary remains unchanged: no push, deployment, production flag, production migration/Event mutation or real email occurred. Before deployment, close the authoritative `events.website_url` provisioning/migration gap (and the historical prerequisites documented above), set canonical HTTPS root for Event `PRIS-2026`, provision stable server-only `SESSION_INVITATION_ENCRYPTION_KEY` for API/worker, include the Event origin in API `CORS_ORIGIN`, and point Pris2026 `NEXT_PUBLIC_API_URL` to the deployed API. `PRIS_FRONTEND_URL` is no longer required. Legacy production invitations are not supported by this delta because the feature has never been enabled in production.
Pre-commit review: explicitly staged only the twelve mapped files plus the user-required focused-plan checkbox document. `git diff --cached --check` exited 0; staged runtime/test diff identity equals the tested `39bf1edecb0441c1cc99be7a9cd3d2e205f19c78`. Staged source/tests/fixture/Compose behavior changes and evidence were inspected; no raw credential, token env, HTML capture, generated build output, continuation prompt or user change is staged. No tracked unstaged edit remained. The final Git hash and post-commit status are reported in the final chat; the commit completion checkboxes are recorded only after successful commit, then folded into that same cohesive commit without changing runtime source.