# Presentation Replaced File Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Delete obsolete Poster/Oral storage files after successful replacement while retaining submission history and protecting the current version.

**Architecture:** Insert durable deletion intents in the acceptance transaction. The existing worker claims and retries one deletion at a time; a database view supplies identical availability fields to every reader. Clients hide unavailable links and retain metadata.

**Tech Stack:** TypeScript, PostgreSQL/Drizzle raw SQL, existing R2/Drive adapters, React/Next.js, node:test.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-10-22-presentation-replaced-file-deletion-design.md`, user approval received 2026-10-22.
- Existing upload/receipt/request/attempt rows remain; failed-attempt cleanup keeps its accepted-file guards.
- Initial/replayed submissions and migration/startup do not queue deletions. A newly accepted revision queues all earlier versions of its own target.
- One deletion per worker iteration; 15-second provider timeout; three-minute lease; retry delay starts at one minute and caps at one hour.
- DTO `fileStatus`: `available | deletion_pending | deleted`; `deletedAt`: string/null; `fileUrl`: string/null. Client fields may be absent for compatibility with the old API.
- Do not deploy, migrate runtime databases, or call live storage/mail providers. Reuse only the guarded local test database at `127.0.0.1:55073/confer_posters_integration_test`.
- Execute inline in this session as already authorized; no additional execution-choice approval is needed.

## File responsibilities

API root: `D:/confer/confer/conference/conference-api`.
Owner root: `D:/confer/confer/conference/Pris2026`.
Staff root: `D:/confer/confer/conference/conference-backoffice`.

- API `drizzle/0047_presentation_file_deletions.sql`: additive queue, constraints/indexes, read-only availability view.
- API `src/modules/presentations/file-deletions.ts`: enqueue, claim, safety checks, provider operation, retry and completion audit.
- API `src/modules/presentations/uploads.ts`, `jobs-runner.ts`: acceptance/worker integration.
- API `storage.ts`, `readers.ts`, `email-jobs.ts`, `types.ts`: shared availability contract; bounded deletion adapters.
- API `startup.ts`: additive migration readiness.
- API `src/modules/lucky-wheel/images.ts`, `src/services/googleDrive.ts`: optional deletion AbortSignal/request timeout through existing adapters.
- API `test-support.ts`, deployment/migration fixtures and new deletion tests: guarded schema and behavior proof.
- Owner `src/types/presentations.ts`, workspace/success dialog, `messages/th.json`, `messages/en.json`: metadata-only history and replacement notice.
- Staff `src/types/presentations.ts`, `src/app/presentations/[abstractId]/page.tsx`, `PresentationTable.tsx`: nullable URLs and status labels.

### Task 1: Durable queue and consistent read projection

**Interfaces:** Produce table `presentation_file_deletions` and view `presentation_upload_files`, preserving all upload columns and adding `file_status`, `deleted_at`, and nullable projected `file_url`.

- [x] Add a failing migration check: accept two historical versions, apply 0047, assert queue count 0, versions unchanged and all view statuses `available`; reject cross-target replacement references and self-replacement.
- [x] Create queue with old/replacement composite foreign keys, `pending/deleting/deleted` states, valid lease/completion checks, retry timestamps and due indexes.
- [x] Create the view with this exact projection over existing uploads plus a left join to the deletion queue:

```sql
CASE WHEN d.upload_id IS NULL THEN u.file_url ELSE NULL END AS file_url,
CASE WHEN d.upload_id IS NULL THEN 'available'
     WHEN d.state='deleted' THEN 'deleted'
     ELSE 'deletion_pending' END AS file_status,
d.deleted_at
```

- [x] Apply 0047 in guarded shared test setup after migrations 0039/0041/0045. Test initial projection and constraints on the isolated DB. Add no data backfill.

### Task 2: Atomic acceptance and availability DTO

**Interfaces:** Add `enqueueReplacedFileDeletions(tx: PresentationTx, targetId: string, replacementUploadId: string): Promise<void>`; extend API `UploadDto` with required `fileStatus`, `deletedAt` and nullable `fileUrl`.

- [x] Add acceptance regression checks for no pre-commit delete, queue rollback, replay, and all lower versions.
- [x] Insert the following query only after a revision advances the pointer, inside the existing transaction:

```sql
INSERT INTO presentation_file_deletions(upload_id,target_id,replacement_upload_id)
SELECT old.id,old.target_id,new.id
FROM presentation_uploads old JOIN presentation_uploads new ON new.target_id=old.target_id
WHERE new.id=$1::uuid AND old.target_id=$2::uuid AND old.version<new.version
ON CONFLICT(upload_id) DO NOTHING;
```

- [x] Read `presentation_upload_files` in `readUploadDto`, staff roster uploads, and fresh receipt payloads; select `file_status AS "fileStatus"` and `deleted_at AS "deletedAt"`. Normalize nullable deletion timestamps to ISO together with `receivedAt`.
- [x] Keep snapshot receipt payloads immutable; old accepted retries return metadata with projected availability.
- [x] Require the queue/view migration during initialized API/worker startup; readiness returns unavailable when the migration is missing. Preserve paused behavior when no Presentation schema exists.

### Task 3: Claimed worker deletion and provider timeouts

**Interfaces:** Add `runReplacedFileDeletionOnce(database: PresentationDatabase, storage: PresentationStorage): Promise<boolean>`. Export claim/completion operations only when needed for crash/concurrency verification. Extend adapter deletion calls with optional signal while preserving existing callers.

- [x] Add failing fake-provider checks: delete only the lower version; reject current/resource references; permission failure stays pending; absent object completes; stale token cannot acknowledge.
- [x] Claim a due row using settings/target/job lock order, `FOR UPDATE SKIP LOCKED`, a random token and `clock_timestamp()+interval '3 minutes'`. Recheck due state after locks and increment attempts.
- [x] Require accepted old and replacement attempts, increasing version, same target and noncurrent old ID; query all current uploads for matching provider/key/Drive ID before provider access. Invalid jobs record `PRESENTATION_DELETE_UNSAFE` and back off without provider calls.
- [x] Use `AbortSignal.timeout(15_000)` for R2 deletes and a 15,000 ms request timeout plus signal for Drive deletes. Drive 404 is already absent; R2 absent-key deletion is idempotent. Permission errors propagate.
- [x] Complete only with matching state/token. In the same transaction insert `file_deleted` system audit with old/replacement IDs. On error schedule retry using:

```ts
const retrySeconds = Math.min(3600, 60 * 2 ** Math.min(attemptCount - 1, 6));
```

- [x] Retry updates clear token/lease, retain a stable error code and are fenced by token. Expired claims can be recovered; deleted bytes with unknown SQL outcome are safely retried by identity.
- [x] Invoke once per existing worker iteration, preserve subsequent mail and heartbeat execution after recorded provider failure. Do not change failed-attempt cleanup guards.

### Task 4: Owner and staff history

**Interfaces:** Copied client DTOs accept optional `fileStatus`/`deletedAt` and `fileUrl: string | null`; missing status means available.

- [x] Add rendering cases for legacy available, pending and deleted history, plus success dialog with no URL.
- [x] Gate links/previews with `file.fileUrl && (!file.fileStatus || file.fileStatus === 'available')`. Render names as text when unavailable and show localized pending/deleted messages. Keep version and receive time visible.
- [x] Update both owner locales with `fileDeletionPending`, `fileDeleted`, and a replacement-deletion sentence in confirmation copy. Hide historical URLs even if a stale response pairs a nonavailable status with a string URL.
- [x] Apply identical guards to staff current preview/list link and history. Preserve existing layout and permissions.
- [x] Run owner `npx tsx --test src/lib/presentationWorkspace.test.ts src/lib/presentationApi.test.ts src/lib/presentationPage.test.ts` and staff `npx tsx --test src/lib/presentationUi.test.ts`, then type checks in both repos.

### Task 5: End-to-end verification and release notes

- [x] Expand PostgreSQL tests for R2 PDF/PNG, same-name Oral revisions, queue rollback/replay, lease recovery, competing claims, stale tokens, audit failure, multiple prior versions and current-file protection.
- [x] Update unit fixtures for the API DTO; fix the full workflow's obsolete PNG-rejection expectations. Verify metadata survives worker deletion.
- [x] Run `npm run test:presentations`, `npm run build`, then `npm run test:presentations:integration` serially against the guarded DB using injected fake providers. Expected: all pass; record unrelated baseline failures separately if encountered.
- [x] Run focused frontend lint/type checks; inspect rendered component assertions for both statuses and locales. Run `git diff --check` in each repo.
- [x] Update `docs/superpowers/runbooks/pris2026-presentations.md` with client-first rollout, additive migration 0047, matching API/worker, origin/cache limitation and irreversible deletion rollback boundary. Verify no runtime migration or external deletion occurred.
- [x] Review full diff and commit only task files per repo with `feat(presentations): delete replaced files after acceptance`. Record check results and any infrastructure limitation here.

## Plan self-review

Spec coverage: Tasks 1/2 cover additive persistence and atomicity; Task 3 covers safety, retries, recovery and audit; Task 4 covers all clients and compatibility; Task 5 covers failure proof and release behavior. Signatures and DTO names match across tasks. No missing implementation decisions remain.

## Execution record

User approved the written spec on 2026-10-22. Implemented inline across API, Pris2026 and Backoffice with no new dependency or service.

Verification completed:

- API `npm run test:presentations`: 59/59 passed, including exact-key R2 deletion signal forwarding.
- API `npm run test:presentations:integration`: 87/87 passed against the guarded local database with injected providers. Two additional recovery/timeout cases were then added; the final focused deletion suite passed 9/9. Full regression log: local untracked `.test-artifacts/presentations/replaced-file-integration.log`; final deletion log: `.test-artifacts/presentations/replaced-file-focused.log` under the parent workspace.
- API `npm run build`: passed. Shared R2 configuration/image decoding checks: 2/2 passed. An attempted unconfigured run of the separate wheel integration case stopped at its `TEST_DATABASE_URL_REQUIRED` guard; it did not access a database and was excluded from the focused pure helper run.
- Owner API/page/workspace checks: 5/5 passed, including both locales, legacy status omission, pending/deleted histories with stale URLs, and receipt links with null URLs. The workspace check passed again after adding receipt assertions.
- Backoffice checks: 26/26 passed. Backoffice type check and focused ESLint passed; focused owner ESLint passed.
- Full owner type check is blocked by the existing unchanged `src/lib/agendaPrintRendering.test.ts:29` error: `NextIntlClientProvider` props lack required `children`. No error was reported in the changed files. This unrelated test was not edited.
- All repository whitespace checks passed. Schema creation/reset was confined to the existing dedicated PostgreSQL test container/database; no runtime migration, provider deletion, mail delivery, deployment or global deletion backfill was performed.

Release remains: compatible clients first, migration 0047, then matching API/worker. Deletion removes origin bytes and cannot revoke cached/downloaded copies.

Client commits: Pris2026 `754751b`; Backoffice `c2289dc`.
