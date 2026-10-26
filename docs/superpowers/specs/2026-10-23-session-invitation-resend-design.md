# Session invitation resend

Date: 2026-10-23 (Asia/Bangkok)
Status: Written specification approved by the user on 2026-10-23; ready for implementation planning.

## 1. Approved scope

Add an explicit Admin action to resend an existing session invitation, supporting one recipient or a selected set of up to 500 recipients for one session, including invitations created in different original grant batches. Reuse the existing durable email queue, transport, claim recovery, and email-attempt history.

The user approved approach B and clarified: initial invitations and resends MUST use the same email template. Both call `renderInvitationEmail`, with the same subject construction, body, plain presentation, full visible response URL, and template-version constant. Do not add a reminder heading, resend prefix, alternate wording, new sender, or separate resend template. Classify initial/retry/resend in internal audit only. Equal rendering inputs must produce equal subject and HTML regardless of send purpose.

The approved PRIS copy remains unchanged, including the removal of the automatic-email footer. Preserve its simple paragraph/line-break presentation. This feature does not introduce rich email styling or change provider MIME capabilities.

Resend uses the original invitation, token, recipient address, origin, and expiry. It must not create a new invitation, entitlement, capacity reservation, grant batch, or grant item. It does not change the user's answer or extend the response deadline.

Out of scope: automatic reminders, scheduled campaigns, resending accepted/declined/expired/revoked invitations, recipient email changes, token rotation, response reopening, entitlement withdrawal, general email infrastructure replacement, new dependencies, or changes to payments/check-in/public response UX.

## 2. Existing implementation and constraints

- `src/modules/session-grants/service.ts`: create rejects duplicate active invitations with item-level `ALREADY_INVITED`; retain that behavior.
- `email-preview.ts`: create preview excludes existing invitees; do not weaken it for resend.
- `email-jobs.ts`: grant items are queue entries; one item can have many attempts. `retryGrantEmails` accepts only failed/unknown items within one batch. Keep retry's eligibility contract.
- `invitation-policy.ts`: effective pending requires a confirmed matching registration, active session, and database time strictly before both stored expiry and current session start.
- `session_invitations.grant_item_id` is unique. Do not duplicate invitations or grant items to represent another email.
- `notificationSnapshot` and `recipientEmailSnapshot` preserve original invitation metadata. Do not overwrite them when resending.
- Current attempts record trigger (`system/admin`), actor, subject, template version, and delivery result, but not initial/retry/resend purpose or an idempotent resend operation.
- Current item `sentAt` can be cleared by a later failed attempt. Last successful delivery must be derived from successful attempts, not assumed from this nullable field.
- Backoffice retry controls and selection are tied to failure recovery; registration creation eligibility intentionally excludes existing pending invitations.

## 3. Eligibility and cooldown

For a new resend operation, require all of:

1. The selected invitation belongs to the requested session and an original `invited` grant item.
2. `effectiveInvitationStatus` is pending, using database time after lock acquisition.
3. The original registration is confirmed, matches the session event, and the session is active.
4. The item email status is `sent`.
5. The original recipient address is usable and the original response origin is valid.
6. Token ciphertext is present, decryptable with the configured key, and matches the stored hash.
7. At least five minutes have elapsed since the later of the latest successful email attempt and latest committed eligible resend request for this invitation. Include an existing item `sentAt` as a fallback for legacy rows without a successful attempt record. No prior timestamp means no cooldown.

The operation returns `retryAfter` for a cooldown skip. Pending/sending items return `EMAIL_BUSY`. Failed/unknown items return `EMAIL_NOT_RESENDABLE`, with the UI pointing to existing retry. Accepted/declined/expired/revoked items return `INVITATION_NOT_PENDING`. Missing/mismatched records return explicit per-item reasons. Invalid/decryption-failed token payloads return a bounded configuration/payload code without logging credentials.

Cooldown applies to new resend commands; replays of the same idempotency key return their original result. A failed or unknown delivery is recovered through retry and its existing acknowledgement rules, not by bypassing resend cooldown.

Capacity may already be full: an eligible resend must still work because it adds no reservation. Current create-invitation capacity enforcement remains unchanged.

## 4. API contracts

All paths are under `/api/backoffice/session-grants`, require Admin authentication and the existing `ADMIN_SESSION_GRANTS_ENABLED` flag, validate a strict body, and expose no raw token or ciphertext.

### POST /resend-preview

Body: `{ sessionId: positiveInteger, invitationIds: UUID[1..500] }`.

Read only: no queue update, token issuance, request ledger, or capacity mutation. Deduplicate IDs and report one result per unique ID. Return eligible recipient/name/subject/HTML/invitationId plus skipped IDs with reason codes and optional retryAfter. Build response URL with `https://preview.invalid/`; the real token must not be returned to the browser. Use the shared invitation template and resend metadata policy below.

### POST /resend

Same body, plus UUID `Idempotency-Key` header. The server creates the operation and updates eligible original queue items in one transaction. Return `202` for a newly recorded operation and `200` for an idempotent replay, including an operation whose selected entries were all skipped.

Response: `{ requestId, sessionId, requestedCount, queued: [{ invitationId, itemId }], skipped: [{ invitationId, reasonCode, retryAfter? }] }`.

Canonicalize distinct invitation IDs in sorted order. Idempotency is scoped to actor and operation, with a hash of canonical input. Identical key/input returns the immutable original response. A reused key with different input returns `409 IDEMPOTENCY_KEY_MISMATCH`. Authentication/feature/validation failures reject the whole request. An eligible/ineligible mixture returns per-item results. Missing or differently scoped IDs are skipped without disclosing unrelated records.

### GET /resends/:requestId

Return original operation actor/time and queue/skip results, together with delivery states resolved from linked original items and attempts for that request. A queued entry without an attempt is waiting; one with an attempt is classified by that attempt's result. Never infer an old operation's result solely from a queue item's latest status, because another operation may have run later. Include failed/unknown/suppressed outcomes and pagination for selected entries, at most 100 per response.

Register static resend routes without accidentally treating them as the existing `/:batchId` route. Preserve all current create, preview, retry, batch/history, and email-attempt contracts.

## 5. Data changes

Add `session_invitation_resend_requests`:

- UUID id; actorId; sessionId; UUID idempotencyKey; canonical requestHash; timestamptz createdAt.
- Bounded JSONB original result containing selected invitation IDs, eligible original item IDs, and skip reasons/retryAfter. At most 500 unique entries; no bearer URLs, tokens, ciphertext, email body, or arbitrary client payload.
- Unique `(actorId, idempotencyKey)`; session/time index for operation history/cooldown lookups as needed by the implemented query.

Extend original queue items with:

- `nextEmailPurpose`: initial/retry/resend, default initial for backward compatibility.
- Nullable `nextResendRequestId`, referencing the request ledger; associated with the queued operation, never used to recreate an invitation.
- Nullable `lastResendQueuedAt` for efficient cooldown checks, set only when a new eligible resend is atomically queued; left untouched for skipped/replayed operations.

Extend email attempts with:

- `purpose`: initial/retry/resend, default initial for pre-existing records. Do not guess historical attempts' purpose during migration.
- Nullable `resendRequestId`, referencing the request ledger. Retain this link through explicit retry of a failed/unknown resend. Retry resolves the prior attempt/request association under the item lock.

Constraints: a queued resend must have a request reference; linked request/session/item must be checked by the service. Preserve existing outcome/count constraints and attempt uniqueness `(itemId, attemptNo)`.

Existing attempt rows are append-only except their own in-flight lifecycle updates. Preserve original snapshots, successful attempts, and original batch counts. Expose `lastSuccessfulSentAt` from successful finished attempts, with the existing sentAt fallback for legacy data. Successful resend count means distinct resend request IDs having a successful linked attempt; retries do not inflate that count.

Use an additive migration with defaults/nullability compatible with existing data. Confirm actual migration numbering when implementing; do not reuse a historical migration number.

## 6. Metadata and rendering

One renderer serves initial and resend messages. The resend path supplies:

- Original recipient email and original invitation identity.
- Current session name, type, start/end, room, and current event display context, read when the worker prepares the message. Preview uses the same metadata builder.
- Original snapshotted response origin and decrypted original token to reproduce the issued URL. Do not switch origin merely because event website configuration changed.
- Effective deadline: `min(original expiresAt, current session start)`.

The renderer version is the deployed version at actual rendering time. Preview is advisory; UI states that eligibility is rechecked and does not claim a frozen preview across concurrent session edits or deployment. API and worker must run the same release for content parity.

Advance the shared invitation template version to identify the currently approved copy. Do not fork a resend version. Preserve grant-email template behavior for unrelated sessions.

The PRIS template currently contains event-specific prose (event dates, selected 60 participants, display alias) and matches an exact stored event/session name. Preserve the user-approved prose in this feature. A later change to those facts or identifiers requires explicit template review; this feature does not invent a configurable copy system or silently rewrite approved language.

Only reconstruct token-bearing HTML in worker memory. Do not persist full HTML/response URL in request ledger, normal logs, DTOs, or attempts. Existing attempt subject/version/recipient auditing remains sufficient for this scope; do not claim that it stores the complete historical email body.

## 7. Transactions, races, and failure handling

Acquire the actor/idempotency advisory lock first, then follow the existing mutation lock ordering: session, registrations in deterministic order, invitations in deterministic order, original grant items in deterministic order. Obtain database time after waiting for relevant locks. Check compatibility with create, acceptance, cleanup, retry, and worker locking; do not introduce an inverse wait chain.

Persist the request result and queue transitions atomically. Set eligible original item emailStatus to pending, nextTrigger to admin, nextTriggeredBy to actor, purpose to resend, request reference, and lastResendQueuedAt. Never reset attemptCount or delete old attempts. Claim/lease/error cleanup follows existing queue semantics. Do not alter original invitation expiry or participant/capacity tables.

Two overlapping new operations may each be recorded, but at most one queues a given invitation; the other skips it as busy or cooling down. An idempotent replay does not create another ledger row or update cooldown.

Worker claims capture purpose/requestId, create an attributed attempt, validate original token integrity and effective eligibility, and render with the shared template. Recheck relation availability before provider handoff. Responses received while queued suppress delivery. Missing keys/payloads fail safely. Do not hold a database transaction open for a provider network call.

Retain existing claim-token fencing and interrupted-worker recovery. A provider request whose outcome is unknown is not automatically retried. Admin retry requires the existing explicit acknowledgement. Preserve request/purpose association through pre-send recovery and retry. On finalization clear pending queue metadata only under the matching claim; durable attempts retain the association.

There is an unavoidable gap between the last status check and external provider handoff. A recipient answering in that gap may still receive an email, but it cannot change their recorded response or grant access again. `sent` means provider handoff succeeded, not Inbox delivery or read confirmation.

## 8. Backoffice

Primary entry point: existing `/session-grants` tracking page. Provide single-row resend and bulk selection across pagination for one chosen session, capped at 500. Support original invitations from multiple batches. Use eligible original invited rows, not skipped duplicate-create history rows.

Provide pending-response/sent-email filters, select-visible controls, selected count, disabled reasons, cooldown availability time, and clear selection on event/session scope changes. Preserve selection across page navigation within the same scope. Do not imply select-all-filtered when only the current page is selected.

Reuse the email-preview dialog with an explicit operation mode. Resend copy in the Backoffice must say it resends an existing invitation; it must not claim to create invitations or add rights. Preview recipient, shared subject/body, current session details, deadline, and skipped counts. Keep the inert sample-link explanation and iframe restrictions.

Persist the same client idempotency key while retrying an uncertain HTTP submission. Disable submit while pending, recover operation results after an uncertain response, and show queued rather than sent until worker completion. Poll active operations using bounded pagination and the existing tracking patterns. Show per-recipient skipped/failure/unknown/suppressed details.

Existing retry remains the action for failed/unknown deliveries, with a distinct label from intentional resend. Attempt history shows initial/retry/resend, actor, time, result, template version, and last successful send. Link operations to original invitation history without inflating invited/added/reserved totals.

Update API client, DTOs, tracking helper predicates, preview dialog, tracking page, and reusable results/history views. Registration list's create eligibility must remain unchanged. On registration detail, expose an entry to the same resend flow or scoped tracking action for pending invitations rather than repurposing add-session controls. No new general-purpose mailing page is required.

## 9. Verification

Add focused tests for:

1. Admin/auth/feature gate and strict schema, 1..500 cap, cross-session/missing IDs, stable deduplication.
2. Each invitation/email eligibility state, effective expiry vs stored pending, missing ciphertext/key, cancelled registration, full session with valid existing reservation.
3. Five-minute boundary using database time, latest successful send vs queued resend, and unchanged cooldown on replay/skip.
4. Idempotent replay, hash mismatch, reordered IDs, repeated ID, mixed eligible/ineligible recipients across original batches.
5. Two Admins concurrently targeting the same invitation; no duplicate queued send or reservation.
6. Preview performs no writes and returns no real token; initial/resend rendering is identical for identical inputs, including version and visible URL.
7. Original URL/token/expiry preserved; metadata uses current session values without overwriting original snapshot; original recipient/origin retained.
8. Respond/decline/expiry/cancellation between preview, queue, and provider handoff; suppression and no entitlement mutation.
9. Success, provider failure/timeout/unknown, worker interruption before/after handoff, lease recovery, stale claim fencing, linked retry attribution.
10. Immutable historical attempts, accurate operation status after a later resend, last-success timestamp survives a later failure, attempts vs successful resend counts.
11. UI single/bulk selection across pages, session-scope reset, stale preview, repeated submit/network loss, cooldown, skipped/partial results, and polling.
12. Regression: create still skips existing pending invitees; retry retains failed/unknown rules; capacity/enrollment unchanged; initial emails, public acceptance, legacy grants, and check-in unaffected.

Use an isolated TEST_DATABASE_URL verified different from the operational DATABASE_URL and the existing fake transport. Do not send operational emails during automated tests. This design phase performs no production mutations or email sends.

## 10. Rollout and acceptance

Apply the additive migration, deploy API and worker from the same release, deploy Backoffice, then verify with fake transport and an explicitly authorized sample send before enabling real operator use. Retain the existing feature kill switch. During rolling deployment, keep resend controls unavailable until the new worker is active; an old worker cannot safely process attributed resends with the intended metadata rules.

Operational checks: pending/sending backlog, expired claims, failed/unknown/suppressed counts, worker health, matching release/template versions, operation replay behavior, and token-free logs. Provider throughput stays on the existing bounded worker loop.

Acceptance: Admin can select one or multiple eligible pending invitations, inspect the same invitation template used for initial sends, submit an idempotent resend, and inspect attributable delivery outcomes. Old links remain valid until their original effective deadline; no additional invitation, seat, or entitlement exists. Existing create and retry contracts remain compatible.

## 11. Review checkpoint

The user approved this written specification on 2026-10-23. The next step is writing-plans, producing a bounded implementation plan. Specification approval does not authorize sending operational emails or changing production data during planning.
