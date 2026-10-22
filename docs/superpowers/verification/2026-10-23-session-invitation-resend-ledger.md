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
- [ ] Foundation tasks 1–3.
- [ ] Transactional service and route tasks 4/6.
- [ ] Worker task 5.
- [ ] Backoffice tasks 7–8.
- [ ] Combined verification task 9 and final review.

Decisions: work performed in fresh isolated worktrees so existing user checkouts and unrelated work are preserved. No behavior deviations from approved spec currently required.
