# Delete replaced Presentation files after successful revision

Date: 2026-10-22 (Asia/Bangkok)

## Approved direction

The user selected asynchronous deletion after a replacement has been accepted: commit the new file first, retry failed storage deletions in the existing worker, retain version metadata, and remove obsolete download links. This design covers Poster, Highlighted Poster, and Oral.

## Current behavior and change boundary

- `uploads.ts` inserts an accepted version and advances `presentation_targets.current_upload_id` inside one transaction, together with the revision status and receipt job.
- Poster uses a unique R2 object key per attempt; Oral allocates a unique Drive file ID per attempt, including when filenames match.
- `cleanupFailedAttempt()` deliberately protects all accepted versions. Keep that protection for failed-upload cleanup; use a separate operation for deleting replaced accepted files.
- Owner and staff readers return version history. Owner and Backoffice clients currently render historical URLs as links.
- Accepted upload rows, attempts, revision requests, email references, identifiers, digests, and timestamps remain durable. Only storage objects are deleted.

## Options considered

1. **Durable deletion queue in the existing worker (selected).** Acceptance and deletion intent commit together; storage failures do not invalidate the new submission; retries survive restarts.
2. **Delete directly in the upload request.** Fewer moving parts, but couples response latency to another provider operation and still needs durable recovery after timeouts or process failure.
3. **Storage lifecycle rules.** Simple retention by age, but cannot reliably identify the current accepted version across R2 and Drive. Does not implement the requested replacement rule.

## Scope and timing

Each newly accepted revision schedules every earlier accepted version of that same target for deletion. This includes history created before deployment when that target next receives a successful revision. The new current version is excluded.

The migration creates an empty queue. Startup, reconciliation, initial submissions, request creation, cancellation, expiration, mail retries, and idempotent upload replays do not initiate historical deletion. Targets without a new accepted revision retain their existing files. No global backfill or administrative bulk-delete endpoint is included.

Deletion is eventual: a replacement succeeds before the worker removes old storage objects. Metadata remains visible even after deletion.

## Persistence

Add an additive migration with the next available number; do not rerun migration 0039. Create `presentation_file_deletions` with:

- `upload_id` as primary key: exactly one deletion job per old accepted upload.
- `target_id` and `replacement_upload_id`, with composite foreign keys into `presentation_uploads(target_id,id)` for both old and replacement uploads; old and replacement IDs must differ.
- `state`: `pending`, `deleting`, or `deleted`.
- `attempt_count`, `next_attempt_at`, `claim_token`, and `lease_until` for durable retries and worker fencing.
- `created_at`, `deleted_at`, and `error_code`; constraints enforce valid claims and completion timestamps.
- An index for pending due jobs and expired deletion leases.

The job references the original upload's authoritative provider and resource identity. It does not derive a key from a filename or reconstruct an ID from a URL. Do not copy credentials or raw provider error responses into the table.

No upload rows or their existing non-null `file_url` values are removed. Preserve foreign keys from receipts and other historical records. Queue state supplies availability without duplicating deletion state on upload rows.

## Acceptance transaction

After advancing the current upload pointer, insert jobs for all lower versions of the same target using `INSERT ... SELECT ... ON CONFLICT (upload_id) DO NOTHING`. The accepted replacement ID becomes the causal reference on each new job.

Queue insertion shares the acceptance transaction with the upload, pointer, request status, and receipt. A queue SQL failure rolls everything back; no storage delete runs inside acceptance. The existing post-error path still cleans only the unaccepted new attempt after verifying its binding.

If COMMIT succeeds but its response is lost, the queue is already durable and scoped replay returns the accepted upload without duplicate jobs or receipts. If the transaction rolls back, no deletion intent becomes visible to the worker.

## Worker and storage operations

Add a small module dedicated to replaced-file deletion and call it from `runPresentationWorkerIteration()`. Reuse the existing storage adapters and worker process; add no dependency or additional service.

Process at most one replaced-file deletion per iteration. A failed deletion records its retry state and permits mail processing and heartbeat updates to continue.

1. Find a due pending job or expired `deleting` lease. Follow the existing lock order: settings, target, then deletion job. Claim under a transaction with a fresh token and three-minute lease; concurrent workers must not claim the same live job.
2. Under the target lock, verify the upload is accepted, belongs to the job target, has a higher accepted replacement on that target, and is not the target's current upload. Check that the resource identity is not referenced by any current upload before deleting. Invalid references fail closed, remain retryable, and record an error.
3. Commit the claim before provider access. Normal upload writes only advance versions and never restore an old current pointer; deletion must not add a restore path.
4. Delete the exact R2 object key or Drive file ID. Bound the provider operation to 15 seconds. Treat an already absent resource as success; do not turn permission failures into success.
5. On success, mark `deleted`, set `deleted_at`, clear the claim, and append a system audit event referencing the old and replacement IDs. Persist completion and audit together, conditional on the current claim token.
6. On failure or unknown provider outcome, return to `pending` with a stable error code and exponential retry delay starting at one minute and capped at one hour. Continue retrying; no retry limit silently abandons a file.

If a worker dies after deletion but before acknowledgement, the next worker retries the same identity and treats absence as success. A stale claim cannot acknowledge or overwrite a newer claim. An old identity is never reused for a new file.

The existing `cleanupFailedAttempt()` continues to protect accepted upload history. Its semantics and attempt states are not relaxed to implement this feature.

## API contract, mail, and clients

Extend `UploadDto` consistently in API, Pris2026, and Backoffice:

- `fileStatus`: `available`, `deletion_pending`, or `deleted`.
- `deletedAt`: ISO timestamp or null.
- `fileUrl`: string for available files; null as soon as deletion is queued, including retries and an in-flight deletion.

An upload without a deletion job is `available`. Pending and deleting jobs project to `deletion_pending`; completed jobs project to `deleted`. Current uploads must remain available by invariant. Preserve the provider, IDs, version, names, size, digest in persistence, and original received time.

Apply the projection to single-upload reads, owner history, staff list/detail queries, accepted upload replays, and freshly built receipt payloads. Use the same projection rules across paths; receipt rendering still describes the original accepted version and points to the submission page. Previously queued mail snapshots remain immutable.

Owner and staff histories show the version/name/time as text with a localized status when no URL is available. Pending copy means the old file is awaiting deletion; completed copy means the file was deleted after replacement. Do not render an empty link, reconstruct a Drive URL, or remove the historical row. New clients tolerate a missing status from the old API as `available`; guard nullable URLs regardless of status. Include Thai and English owner copy and Thai Backoffice copy.

Update the owner confirmation copy to state that successful replacement removes earlier files while preserving history. Read-only list/detail views and receipt dialogs must tolerate the extended contract.

Deletion confirms removal at the provider origin. Existing public URLs or downloaded bytes may remain in browser/CDN caches; this feature does not promise immediate revocation of previously distributed copies or add cache-purge integration.

## Verification

Use injected R2, Drive, and mail fakes. Prove behavior rather than implementation shape:

1. Successful Poster PDF/PNG and Oral replacements advance the current version and atomically enqueue older versions; no deletion occurs before acceptance commits.
2. Failed validation, provider writes, expired/cancelled revisions, and acceptance SQL failures leave the original file current and create no deletion jobs.
3. Idempotent replay and a lost COMMIT response produce one accepted upload, receipt, and deletion job per obsolete version.
4. The worker deletes only old objects, including identical Oral filenames with distinct IDs; the current object's bytes and link survive.
5. Provider failure, missing objects, timeout, expired lease, worker crash after deletion, stale acknowledgement, and competing claims recover safely.
6. Current-pointer/resource-reference guards prevent deletion even for an invalid queued candidate. Completion audit failure is retried safely.
7. History retains names, versions, timestamps, and receipt references; all API read paths hide queued/deleted URLs. Both clients render statuses without obsolete links and tolerate legacy API responses.
8. Migration preserves existing data and starts with zero deletion jobs. Multiple historical versions are queued only on that target's next accepted revision.

Update existing retention expectations to distinguish metadata retention from eventual storage removal. Correct the stale full-workflow expectation that valid Poster PNG is rejected, since the current file policy accepts PNG.

Run API unit checks, builds/type checks, focused frontend checks, and guarded serial PostgreSQL integrations when the existing dedicated test database is available. Report unavailable integration infrastructure as a limitation. Do not connect these tests to runtime data or real provider credentials.

## Release and operational boundaries

Release clients that handle the additive fields and nullable URLs first. Apply the additive migration, then release the matching API and worker. Coordinate the API and worker version so a writer cannot create deletion intents that an old worker ignores indefinitely. Verify the migration is present in the API/worker startup readiness checks before enabling the new code.

Update the existing Presentation runbook: the former rule to retain all accepted physical files is superseded only for explicitly queued noncurrent versions caused by a successful replacement. Preserve the prohibition on dropping historical rows or deleting current files.

Implementation scope is local source, migrations, documentation, and verification. Applying a runtime migration, starting a worker with live storage credentials, or deleting existing production files is a separate deployment operation. Rollback may stop new deletion work, but cannot restore bytes already deleted; keep the additive schema and metadata.

## Design review checklist

- Project context: explored the API upload/storage/worker/reader paths and both client contracts.
- Visual companion: not needed; this change concerns behavior and concise status text.
- Requirements: the user approved commit-first queued deletion, retries, retained metadata, and safe failures. No unresolved question blocks this design.
- Options and design: recorded above; recommended direction matches the user's selection.
- Design document: written for user review; commit before handoff.
- Self-review: checked scope, explicit timing, atomicity, retries, current-file protection, compatibility, and test criteria; no placeholders or contradictory retention requirements remain.
- Written-spec review: approved by the user on 2026-10-22 (Asia/Bangkok).
- Next step: implement the accompanying writing-plans plan and verify locally.
