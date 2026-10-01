# Admin Session Grants Execution Evidence

Date: 2026-09-30
Goal key: admin-session-grants-implementation-review-2026-09-30
Compose project: admin-session-grants-test-20260930
Policy: Docker-only verification; no production DB, production deploy, real email, real payment provider, or push.

## Confirmed execution baseline

The user confirmed the implementation baseline on 2026-09-30:

- Hard limit 500 Registration IDs per request. More than 500 rejects the whole request; no truncation.
- Selection persists across pagination/search/filter while Event and Session stay unchanged; total selected is visible and selected rows can be reviewed/removed before confirmation.
- Select-all affects only eligible rows on the current page and preserves prior-page selections.
- Changing Event/Session with a non-empty selection requires confirmation; cancel preserves the prior context and selection.
- Grant notification email subject/body are Thai-only. Person/Event/Session names remain exactly as stored and are not translated. Copy must not imply purchase, receipt, invoice, or successful payment.
- Failed email may be retried by Admin with attempt/actor audit and concurrency protection.
- Unknown email may be retried only after explicit duplicate-delivery acknowledgement; never auto-retry unknown.
- Results: 50/page, maximum 100, with whole-batch counters.
- UI polling: 3 seconds only while pending/sending exists.
- Worker polling: 5 seconds only when queue is empty; keep processing while work exists.
- Claim one item at a time; lease 180 seconds; provider auth/send timeout 30 seconds; 700 ms gap between emails.
- Grant commits/responds before all emails finish.
- If Docker timing/lease/500-row/concurrency tests or provider constraints fail, stop for user confirmation before changing these values.

## T00 baseline identity

| Repository | HEAD | Initial working tree |
| --- | --- | --- |
| conference-api | d46af6f218edf5372e13b152a2e7764adc5b600d | Six Admin Session Grants design/plan/prompt documents untracked before implementation |
| conference-backoffice | 638845c6dd66fb9b22f823337e398dcea55ebb35 | clean |
| conference-web | a8020c0901c9393e57f00b1d5d1d81e3ba477e2f | clean |

No applicable project-root AGENTS.md was found for these three repositories. AGENTS.md files found elsewhere in the workspace are outside these repo roots or are skill/vendor instructions.

## T00 Docker test environment

- Docker Engine: 29.7.2.
- Test compose file: conference-api/docker-compose.session-grants-test.yml.
- Project/network/volumes are dedicated to admin-session-grants-test-20260930.
- PostgreSQL runtime DB: confer_session_grants_runtime_test.
- PostgreSQL integration DB: confer_session_grants_integration_test.
- Runtime and integration database identities are distinct.
- Fake mail service is local to the test network.
- API/Backoffice/Web tools use Linux container node_modules named volumes; Windows host node_modules are not reused.
- Browser runner is represented by the Playwright 1.51.1 Docker image and remains isolated in the same Compose project.
- No host ports are required for database or fake mail verification.

## T00 registration_sessions writer/read inventory

Writer locations discovered from the current API revision:

- src/database/migrate-sessions.ts:54,97
- src/routes/payments/index.ts:1047
- src/routes/registrations/quick.ts:287
- src/routes/registrations/free.ts:414
- src/modules/payments/registration-settlement.service.ts:277
- src/routes/backoffice/registrations.ts:376,510,809

Nullable-sensitive reader/reference locations found by the same audit include:

- src/routes/backoffice/registrations.ts:212,229,592,724
- src/routes/backoffice/events.ts:931,936
- src/routes/backoffice/checkins.ts:73
- src/routes/payments/index.ts:1523,1536,1940
- src/database/schema.ts relation metadata near 1639

Detailed reachability/compatibility treatment remains owned by T03/T05; T00 records the exact baseline inventory only.

## T00 migration delivery state

- drizzle/meta/_journal.json ends at 0007_serious_marvel_zombies.
- Manual SQL exists beyond the journal, including drizzle/0030_promo_checkout_hardening.sql.
- drizzle.config.ts points drizzle-kit at the journal/output directory but does not make later manual SQL journal-managed.
- Therefore execution must not assume drizzle-kit migrate will apply 0031. The session-grants migration must use the explicitly reviewed manual-SQL delivery/rehearsal path.

## T00 session timestamp convention probe

Schema uses timestamp without time zone for sessions.start_time/end_time. API create/update converts request values with new Date(...). The database client is postgres-js with default date handling.

Docker probe on the isolated PostgreSQL/Node runtime:

- Inserted SQL timestamp: 2026-10-01 10:00:00.
- Container runtime timezone: UTC.
- postgres-js Date ISO: 2026-10-01T10:00:00.000Z.
- Rendering that instant in Asia/Bangkok: 2026-10-01 17:00:00.

This confirms the existing runtime treats a timestamp-without-zone wall value as a UTC Date under the current container environment. The feature must preserve this existing convention and compare endTime using the resulting server Date instant; it must not silently reinterpret stored timestamps as Bangkok-local during this feature.

## Verification command ledger

| Command/Gate | Status | Exit | Result |
| --- | --- | ---: | --- |
| Docker engine check | PASS | 0 | Server 29.7.2 |
| Compose config validation | PASS | 0 | Dedicated services/network/volumes resolved correctly |
| CMD-01 API baseline build | PASS | 0 | npm ci in container then TypeScript build completed |
| CMD-02 Backoffice baseline build/lint | BASELINE_FAIL | 1 | Next build PASS; repository-wide eslint then failed on pre-existing lint debt: 104 errors and 56 warnings |
| CMD-03 Web baseline install/build/focused test | BASELINE_FAIL | 1 | npm ci refused because package.json and package-lock.json are already out of sync; no feature code had been changed |
| Timestamp convention probe | PASS | 0 | UTC parse behavior recorded above |
| T01 policy/schema focused tests + API build | PASS | 0 | Docker api-tools; DATABASE_URL/TEST_DATABASE_URL unset for pure tests; 10/10 tests PASS, then TypeScript build PASS; raw 501 IDs rejected before dedupe |
| T02 migration rehearsal MIG-01/02/03/05 | PASS | 0 | Final Docker task 337e5631-1a64-4b13-a902-10c597acf9b7: 4/4 PASS. Clean apply keeps registrations.ticket_type_id NOT NULL, makes registration_sessions.ticket_type_id nullable, creates unique pair + 3 audit/outbox tables; duplicate preflight aborts atomically; direct duplicate/FK violations fail; lock timeout rolls back then apply succeeds after release. |
| T02 API TypeScript build | PASS | 0 | Docker task d091e399-ff0d-4263-b3a7-4741971c778b; schema mirror and T02 harness compile. |

The conference-web lock mismatch is a pre-existing baseline failure. It is not silently repaired as part of Session Grants and is not counted as a feature regression.

## Dependency / deferred ledger

| Task | Gate/Test | Error/Evidence | Required Task(s) | Status | Retest trigger | Retest result |
| --- | --- | --- | --- | --- | --- | --- |
| T00 | CMD-02 lint baseline | Existing Backoffice repository-wide lint debt: 104 errors / 56 warnings; production build itself passes | none; baseline condition outside Session Grants source | BASELINE_FAIL_RECORDED | Before final changed-file/static gate, prove no new lint regression and disposition baseline debt under Prompt rules | pending |
| T00 | CMD-03 baseline | Existing conference-web package-lock mismatch prevents npm ci | none; baseline condition outside Session Grants source | BASELINE_FAIL_RECORDED | Before a Web verification gate becomes completion-critical, resolve/disposition under Prompt rules | pending |
| T02 | MIG-04 | Nullable-ticket compatibility readers are not implemented until T03; migration DDL itself is already proven | T03 | DEFERRED_DEPENDENCY | Immediately after T03 nullable-safe readers pass | pending |

## T02 failed-attempt history

- Migration harness attempt 1 failed before 0031 because the repository's generated 0006 and 0007 SQL both add user_role.general and overlap other objects. Historical migrations were not edited; the representative test sequence records 0007 as superseding the duplicated 0006 SQL for this repository snapshot.
- Attempt 2 reached 0027 but postgres-js rejected an explicit BEGIN/COMMIT migration on a pooled max=4 harness. The guarded migration client was narrowed to max=1; concurrency tests still use separate explicit clients.
- Attempt 3 reached 0028 and proved the manual abstract-tracking prerequisite manifest was missing from a naive drizzle-only sequence. The harness now follows repository-owned sql/abstract-tracking-setup with a synthetic reviewed manifest in the isolated test DB.
- Attempt 4 reached 0028 but the harness duplicated approved-floor insertion already performed by 0028. The duplicate harness insert was removed; production migration semantics were unchanged.
- Final task 337e5631-1a64-4b13-a902-10c597acf9b7 passed 4/4 MIG-01/02/03/05 checks.

## Safety confirmations

- No production migration applied.
- No production DB accessed.
- No real email sent.
- No payment provider called.
- No push performed.
