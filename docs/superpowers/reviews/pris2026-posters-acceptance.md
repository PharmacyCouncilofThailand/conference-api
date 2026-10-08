# PRIS 2026 posters acceptance — T21/T22 and final PASS

Verified 2026-10-07 against implementation bases API `93376e80aad6c7dd8e7329ff314171bd6b0198a3` (poster core `2f0c42d`), Pris `5b4fe798594aa2be0fc8849933cc4fea12d1d61b`, BO `6dc082f93132a746d7036d469615acf71933c7ce`, plus the reviewed T21/T22 changes included with this matrix. All T01–T22 task gates, the final259-test rerun, root final browser gate and independent overall review passed. No deployment or live-provider acceptance is claimed. Resolve the exact final API release commit from `git log -1 --format=%H -- docs/superpowers/reviews/pris2026-posters-acceptance.md` and record it with the deployed artifact before a future deployment.

## Runnable gates and evidence

Evidence directory: `.superpowers/sdd/2026-10-07-pris2026-poster-submission/` in the API checkout. Commands below were actually run and exited 0. API tests supplied explicit `NODE_ENV=test`, the dedicated runtime and integration URLs from execution-policy.md, and both poster flags `true`.

| Checkout | Command | Actual result | Log |
| --- | --- | --- | --- |
| API | `npm run test:posters` | 36/36 | task-21-api-unit.log |
| API | `npm run test:posters:integration` | 63/63, strict file concurrency 1 | task-21-api-integration-resumed.log |
| API | `node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 src/services/emailService.test.ts src/modules/lucky-wheel/images.test.ts` | 4/4; started only after poster suite exited | task-21-email-wheel-resumed.log |
| API | `npm run test:abstract-tracking` | 15/15 | task-21-tracking.log |
| API | `npm run test:session-grants` | 22/22 | task-21-session-grants.log |
| API | `npm run test:session-invitations` | 22/22 | task-21-session-invitations.log |
| API | `npm run build` | TypeScript compilation passed | task-21-api-build.log |
| Pris | `npm test` | 74/74 | task-21-pris-tests.log |
| Pris | `npm run build` | Production build passed | task-21-pris-build.log |
| BO | `node ../conference-api/node_modules/tsx/dist/cli.mjs --test src/lib/posterUi.test.ts src/lib/session-grant-selection.test.ts` | 22/22 | task-21-bo-tests.log |
| BO | `npm run build` | Production build passed | task-21-bo-build.log |
| Pris / BO | Existing ESLint CLI on changed, existing frontend paths | Passed | task-21-pris-lint-final.log / task-21-bo-lint.log |

Actual package inventory is retained in task-21-script-inventory.log. Tracking's unit script contains an integration-harness configuration check; it is not represented as a full tracking DB integration run. No unrelated payment/load suites were required. Frontend build includes TypeScript checks; API has no configured lint script.

## Acceptance matrix

All rows below have passing executable or recorded browser evidence. API filenames refer to `src/modules/posters/`. `U` means the unit command above; `I` means the full serialized integration command above; `P` means Pris npm test; `B` means the BO test command. Browser evidence is task-17-browser-root.md, task-19-browser-root.md and task-20-browser-root.md; public-page browser evidence is the T14 report. Browser fixtures exercise UI composition only; parser, DB concurrency, outbox and object integrity are proven by actual API tests with isolated PostgreSQL and injected providers.

| Case | Expected and observed result | Runnable evidence / browser evidence |
| --- | --- | --- |
| A01 | Exact 119 source rows, 31 Oral/39 Highlighted/49 Poster, 2 null tracking IDs; API is the source; synthetic Round 2 appears | U data.test.ts fixed JSON digest and counts; P approvedRound1Abstracts.test.ts, approvedAnnouncementsPage.test.ts; T14 report. Final local fixture also reads built API projection. |
| A02 | Exact canonical/name/title/type matching; alias approval records reason/actor/time; no fuzzy matching | U policy.test.ts; I reconcile.integration.test.ts alias fingerprint, operations.integration.test.ts audited approval/replay; T19 browser approval/difference UI. |
| A03 | Missing/ambiguous/remapped/duplicate/conflicting data blocks; no automatic account/abstract edits | U policy.test.ts; I reconcile.integration.test.ts invalid manifest, duplicate/remap, alias invalidation; I routes.integration.test.ts; T19 invalid rows/recheck. |
| A04 | Two works owned by one account yield two independent jobs/statuses to the actual owner | I email-jobs.integration.test.ts manual batch once per work; workflow.integration.test.ts actual-route pair and worker capture; T19 browser pair. |
| A05 | Login return preserves work/request/locale/reload; wrong-account message reveals no owner email; tampering denied | P localizedRedirect.test.ts, refreshRedirect.test.ts, posterPage.test.ts, posterApi.test.ts; I access.integration.test.ts and routes.integration.test.ts; T17 browser Login and locale composition. |
| A06 | Real PNG/PDF only, single unencrypted PDF page, no APNG, inclusive 30 MB, unrestricted dimensions | U file-validation.test.ts all real-byte negative/boundary fixtures; P posterSubmissionState.test.ts; T17 browser chooser/30 MB transport. |
| A07 | Validation/R2/SQL failures preserve rights and old file; accepted initial upload locks | I uploads.integration.test.ts reservation/failure/atomic acceptance; workflow.integration.test.ts PNG lock; T17 browser invalid/size/locked. |
| A08 | Exclusive close enforced after upload/storage and lock waits using DB clock; Bangkok date boundary | U policy.test.ts deadline; I uploads.integration.test.ts post-R2 expiry, target-lock waits and skewed application clock; P posterWorkspace.test.ts; B posterUi.test.ts date conversion. |
| A09 | Same-key replay one version/receipt, competing keys one winner, lost commit preserves accepted object | I uploads.integration.test.ts independent-client races/replay/lost COMMIT; workflow.integration.test.ts exact upload replay; T17 browser frozen file/key retry. |
| A10 | One concurrent active request; immutable terms; reasoned cancellation/audit; new request after terminal | I revisions.integration.test.ts independent-client create/immutable/cancel/new request; workflow.integration.test.ts submitted then cancelled request; T20 browser. |
| A11 | Revision uses its own close after main closes; cancellation/expiry during R2 preserves v1 | I uploads.integration.test.ts post-R2 cancellation/expiry and revision lock-wait; I revisions.integration.test.ts; T17/T20 browser expired/cancelled links. |
| A12 | Mail failure leaves rights; explicit resend creates no new request/deadline; pending/sending guarded | I revisions.integration.test.ts failed/unknown resends; I email-jobs.integration.test.ts revision preview/resend terminal state; B posterUi.test.ts; T20 browser failure/unknown/pending flows. |
| A13 | Initial/revision receipt and modal; receipt failure cannot roll back or reopen rights; manual resend | I uploads.integration.test.ts receipt config failure vs SQL rollback; I revisions.integration.test.ts historical receipt resend; workflow.integration.test.ts two receipts; T17 modal/T20 stored receipt and fresh resend preview. |
| A14 | Admin manages; assigned Organizer/Reviewer read only; wrong event/account family denied | I access.integration.test.ts, readers.integration.test.ts, routes.integration.test.ts; B posterUi.test.ts; T19/T20 browser roles/unassigned/event scope. |
| A15 | Original bytes and existing R2 helper/public prefix; all versions retained; no gallery | U storage.test.ts; I uploads.integration.test.ts cleanup and retained originals; workflow.integration.test.ts Map buffers exact PNG/PDF, two objects/no deletion/prefix; T17/T20 file previews/history. |
| A16 | Lease/recovery excludes duplicate provider calls; unknown never auto-resends; sent means provider acceptance | I email-jobs.integration.test.ts independent claimers, recovery race, provider accepted/DB finish failure, lease heartbeat; T19/T20 explicit unknown warnings/retry. |
| A17 | Reconciliation/restart idempotent; withdrawal/re-add preserves used rights/history; readiness failure blocks | I reconcile.integration.test.ts idempotence/withdraw-readd/serialized manifest; I email-jobs.integration.test.ts startup paused/schema readiness; deployment procedures are revisited in T22. |
| A18 | Initial/reminder manual only; source/startup queues nothing; stale preview rejects all jobs | I reconcile.integration.test.ts; I email-jobs.integration.test.ts stale preview/batch rollback; workflow.integration.test.ts zero jobs before explicit batch; T19 browser stale refresh and explicit second confirmation. |
| A19 | Public allowlist/no email, unchanged PDF button, common close, existing cards/stats/page size/copy, shrink clamps page | U data.test.ts allowlist; I routes.integration.test.ts public route; P approvedAnnouncementsPage.test.ts and acceptedAbstractsFilter.test.ts; T14 source/UI/browser report. |
| A20 | Both upload modes retain identical approved theme; TH/EN/mobile/keyboard/dialog/long-title usable | P posterPage.test.ts, posterWorkspace.test.ts; T17 browser desktop/mobile/keyboard receipt focus and long Thai title; T20 mobile native modal screenshot. |
| A21 | Versioned main settings/audit persist; no reset of used rights or revision deadlines | I operations.integration.test.ts settings version/race/audit; reconcile.integration.test.ts; email-jobs.integration.test.ts startup settings; B posterUi.test.ts; T19 browser native date preview and request payload. |
| A22 | Every file/request/mail/audit retained, sorted history, cancelled link exposes terminal state | I readers.integration.test.ts and revisions.integration.test.ts; workflow.integration.test.ts versions [2,1], submitted/cancelled requests, suppressed notice, receipts/audit; T17/T20 browser history. |

## Combined isolated workflow

workflow.integration.test.ts uses actual Fastify JWT/multipart routes and actual PostgreSQL module operations. It reconciles two synthetic works, approves an exact alias, previews and queues two jobs, drains fake worker transport, uploads generated PNG, asserts same-key replay and initial lock, creates a revision, uploads a generated one-page PDF, cancels another request, verifies its old link/upload is blocked, and reads retained versions/requests/email/audit. Actual result: 5 fake accepted messages, 2 exact original buffers, 2 versions, 2 requests and no object deletions. Synthetic JWTs represent seeded accounts; real Login UI composition is separately recorded in T17 browser evidence. No participant from the 119-row announcement roster received a message.

## Safety, incident and limits

Before resets, Docker exact ID `6ba1d0f3241b017abacdfde1b854cefc89e2c9a30cc8767e33d547f4d1ecaf97` was verified running with only `127.0.0.1:55073`, and SQL verified database `confer_posters_integration_test`, user `posters_test`, no other client backend. Only this integration schema was reset. Runtime DB was never reset. Test storage/mail are injected fakes; no live R2/mail/deployment was tested.

Earlier poster/wheel runs overlapped due my mistaken classification of wheel's DB regression and are INVALID (task-21-api-integration.log, task-21-email-wheel.log); the interrupted attempted rerun is also INVALID (task-21-api-integration-final.log). After the user's stop/resume, only this worker owned DB access, and clean 63/63 then 4/4 runs completed sequentially. The original incident record remains in task-21-report.md. An initial lint command included a deleted source path; corrected existing-path selection passed. No product change was needed for either orchestration issue.

T22 operational/runbook gates and final whole-plan browser smoke passed; their evidence is recorded below. Retained local synthetic services are documented in final-verification-report.md. Production-like staging, real provider delivery, and container removal require later explicit user instruction.

## T22 and final verification after the last task

T22 independent review passed before the final whole-system rerun. Operational SQL now fails closed on missing prerequisites/already applied schema, missing/not-ready settings, duplicates and incorrect current-file linkage. `npm run posters:reconcile` reuses startup reconciliation and closes on success/error. The isolated deployment rehearsal proves one additive migration, paused startup/source119, default close, preserved edited close/used right/file/request/audit and compiled CLI exit0/1. T22 clean integration was64/64 and TypeScript build passed; actual package reconciliation and `psql -v ON_ERROR_STOP=1` read-only verify also exited0. Evidence: task-22-report.md, task-22-integration-final.log, task-22-build-final.log, task-22-cli.log and task-22-psql-verify.log. [The operational runbook](../runbooks/pris2026-posters.md) distinguishes future deployment steps from this isolated rehearsal.

The following final checks were rerun after T22 review PASS, against frozen product code. All verification commands exited0; the separately labeled idle heartbeat diagnostic returned its expected1, because no real worker is running. These are259 passing test executions across the listed suites, not259 unique acceptance requirements.

| Final command | Result | Retained final evidence |
| --- | --- | --- |
| API npm run build | PASS | final-api-build.log |
| API npm run test:posters | 36/36 | final-api-unit.log |
| API npm run test:posters:integration | 64/64 | final-api-integration.log |
| API serialized emailService + wheel/images test files | 4/4, only after integration exited0 | final-email-wheel.log |
| API npm run test:abstract-tracking | 15/15 | final-abstract-tracking.log |
| API npm run test:session-grants | 22/22 | final-session-grants.log |
| API npm run test:session-invitations | 22/22 | final-session-invitations.log |
| Pris npm test / npm run build / scoped ESLint | 74/74, builds/lint PASS | final-pris-tests.log / final-pris-build.log / final-pris-lint.log |
| BO posterUi + session-grant-selection / build / scoped ESLint | 22/22, builds/lint PASS | final-bo-tests.log / final-bo-build.log / final-bo-lint.log |
| Compiled worker --healthcheck, invalid synthetic DB URL, no heartbeat | Expected idle1; DB import not reached. Positive/expired heartbeat and CLI-before-DB assertions pass inside the64-test suite | final-worker-health.log |
| Local public fixture vs compiled API announcement projection | Exact JSON projection,119 rows,31/39/49,2 null IDs | final-announcement-parity.log |
| Local fixture/frontend read-only HTTP health | Four200 responses; no restart required | final-fixture-health.log |
| Dedicated DB identity/no other client before wheel reset; diff check | PASS | final-db-preflight.log / final-diff-check.log |

Root final browser gate passed in final-browser-report.md and independent overall review passed in final-review.md. These gates are actual recorded checks, separate from unit/API evidence. Exact tested implementation bases remain API93376e80aad6c7dd8e7329ff314171bd6b0198a3 (poster core2f0c42d), Pris5b4fe798594aa2be0fc8849933cc4fea12d1d61b, BO6dc082f93132a746d7036d469615acf71933c7ce, with reviewed T21/T22 changes included in the commit containing this matrix/runbook. Resolve that final API release SHA from the file-history command above and record it before future deployment. No live providers, deployment, runtime reset or cleanup occurred.
