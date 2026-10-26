# Resend execution ledger

Workspaces: sibling `conference-api` and `conference-backoffice` under `D:/confer/confer/conference/.worktrees/session-invitation-resend`, branch `codex/session-invitation-resend` in each. Original checkouts clean and preserved. No production credentials copied.

Model for every delegated worker/reviewer: gpt-6.1-sol, medium (user instruction).

Contract: `resend-types.ts` is owned and frozen by the controller. Schema field names and API paths follow the approved plan. Shared reader functions: `readResendCandidates(tx,input)`, `buildResendSnapshot(candidate)`, `getResendOperation(database,requestId,page,limit)`. Policy: `canonicalResendInput(input)`, `resendCooldownUntil(lastSuccessfulSentAt,lastResendQueuedAt)`, `resendDisabledReason(candidate,now): ResendSkip|null`. Queue service: `previewInvitationResends(database,input)` and `queueInvitationResends(database,input & {actorId,idempotencyKey}) -> {replayed,result}`. Route options use injection, same Admin/feature checks.

Ownership:
- Controller: contract file; email-jobs.ts and worker/template tests; final integration/build, test database setup, verification docs.
- Foundation worker: schema.ts, migration 0050, schemas.ts, resend-policy.ts, resend-readers.ts, existing tracking.ts/types.ts/service.ts read additions, their tests. Never edit email-jobs.ts or new resend-service.ts/routes.
- Service worker: new resend-service.ts/resend-routes.ts plus tests, existing routes.ts and package.json. Never edit shared schema/types/policy/readers or existing service.ts.
- Backoffice worker: all Backoffice source/tests only. Never edit API. Copy HTTP contracts exactly from controller-owned resend-types.ts.

Dependencies: frozen contract before dispatch; foundation schema/readers before executable backend/worker integration. Backoffice may code to frozen HTTP interfaces independently. No two writers own the same file. Workers do not run schema-reset integration suites concurrently; controller runs them serially.

Preflight: spec and nine plan tasks reviewed. Same renderer and credential/capacity immutability are mandatory. Test environment uses an isolated Docker PostgreSQL on a new localhost port and fake transport. No production DB, deployment, or actual email sends.

Progress:
- [x] Contract and ownership frozen.
- [x] Foundation tasks 1–3: deb994d,147c597,348eb77; case normalization d454af5.
- [x] Transactional service and route tasks 4/6:983d126,c4d7059; case-safe key locking35fb2fc.
- [x] Worker task 5:740dc66; completion-clock regression fix fcef4bc.
- [x] Backoffice tasks 7–8:fd43a0f,8d42a30; transient polling fix eb4f8df; browser acceptance f5e1d98.
- [x] Combined verification task 9: isolated schema/worker/bulk/regression tests, builds, browser acceptance; see verification report.

Decisions: work performed in fresh isolated worktrees so existing user checkouts and unrelated work are preserved. No behavior deviations from approved spec currently required.

Integration correction: request-scoped queued retries must show waiting before a new attempt is claimed. Reader now uses queue state only when nextResendRequestId matches the requested operation; unrelated later operations cannot overwrite its history. Regression tests passed. Commit9f1b681.

Final reader boundary correction: f3a1498 normalizes operation UUIDs before SQL and request-bound queue matching. Lower/uppercase retry-status assertions and real-worker/reader integration tests passed. Independent scoped review passed with no remaining P1/P2 findings.

Review gates: service agent reviewed foundation (spec/quality pass); foundation agent reviewed service/worker and found completion-clock issue (fixed/tested); independent api_review found UUID casing issues (fixed/tested and scoped re-review pass); independent backoffice_review found polling failure recovery (fixed/browser-tested and scoped re-review pass). All reviewers used user-requested gpt-6.1-sol medium.

Environment corrections, not product changes: legacy test prerequisite SQL allowlists confer_session_grants_*_test names; dedicated container databases use those names. Legacy check-in requires attendance0033 and booth0042 on its separate runtime fixture, applied only to the newly created local test DB. Default Turbopack rejects external node_modules junction; Webpack production build passed. No operational credentials were copied or used.
