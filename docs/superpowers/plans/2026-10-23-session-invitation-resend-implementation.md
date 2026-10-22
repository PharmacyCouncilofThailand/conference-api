# Session Invitation Resend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let an Admin explicitly resend one or up to 500 pending invitations using their original links and the same email template used for initial invitations.

**Architecture:** Record an idempotent resend operation, atomically requeue eligible original grant items, and reuse the existing worker and attempt audit. Keep original invitation snapshots immutable; build current session display metadata only for resend-related delivery. Backoffice exposes single/bulk resend with preview, operation recovery, and per-recipient results.

**Tech Stack:** Existing TypeScript, Fastify, Zod, Drizzle/PostgreSQL, postgres.js, node:test/tsx, Next.js/React, existing NipaMail transport. No new dependencies.

## Global Constraints

- Approved specification: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-23-session-invitation-resend-design.md`.
- Initial invitations and resends MUST use the same email template: `renderInvitationEmail`, subject, body, full visible URL, and shared template version. No reminder copy or resend subject prefix.
- One selected session, 1..500 invitation IDs, including different original grant batches.
- Only effectively pending invitations whose original item email status is `sent` can enter a new resend command.
- Five-minute cooldown from the later of last successful delivery and last committed eligible resend request. Exact boundary is eligible.
- Original invitation, token, recipient, origin, and expiry remain unchanged; no new grant batches/items, invitations, entitlements, or reservations.
- Existing create `ALREADY_INVITED` behavior and failed/unknown retry rules remain compatible.
- Admin only, existing feature flag, strict schemas, durable idempotency, per-recipient partial results.
- Preview exposes only a dummy URL and performs no writes. No raw token, ciphertext, bearer URL, or HTML body in audit/logs/API responses except dummy preview HTML.
- Existing plain email copy stays unchanged. Current PRIS event-specific prose is not generalized in this feature.
- Integration tests use a guarded, dedicated TEST_DATABASE_URL and fake transport, never production data or real email delivery.
- Production deployment and operational email sending are separate from local implementation/test execution.

## Working directories and task order

API root: `D:/confer/confer/conference/conference-api`.
Backoffice root: `D:/confer/confer/conference/conference-backoffice`.

Paths below beginning `src/`, `drizzle/`, or `docs/` are relative to the explicitly named root for that task. These are separate Git repositories; commit only a task's own files in the appropriate root. Inspect `git status --short` before every commit. Preserve unrelated changes.

Execute tasks 1–6 in API order, then 7–8 in Backoffice, then task 9 across both. Do not implement different tasks concurrently where they share schema, worker, route, or DTO files.

## File ownership

| Root/file | Responsibility |
| --- | --- |
| API `src/modules/session-grants/resend-policy.ts` | Pure eligibility/cooldown and canonical input helpers |
| API `src/modules/session-grants/resend-types.ts` | New command, result, read-model and candidate interfaces |
| API `src/modules/session-grants/resend-readers.ts` | Candidate loading, current display snapshot, last-success and request-status reads |
| API `src/modules/session-grants/resend-service.ts` | Preview and transactional idempotent queueing |
| API `src/modules/session-grants/resend-routes.ts` | New routes using existing Admin/flag/error behavior |
| API `src/modules/session-grants/email-jobs.ts` | Queue purpose/request attribution, current resend metadata, retry/recovery |
| API `src/modules/session-grants/email-template.ts` | Shared invitation renderer/version only; no alternate template |
| API `src/modules/session-grants/tracking.ts`, `service.ts`, `types.ts`, `routes.ts` | Existing reads, registration of routes and attempt/summary additions |
| API `src/database/schema.ts`, `drizzle/0050_session_invitation_resends.sql` | Additive operation/queue/attempt schema |
| API `src/modules/session-grants/resend-*.test.ts` | Focused unit, route, migration, service/worker integration coverage |
| Backoffice `src/types/session-grants.ts`, `src/lib/api.ts` | Matching DTOs and client calls |
| Backoffice `src/lib/session-invitation-resend.ts` | Scope-safe selection, eligibility and durable submission helpers |
| Backoffice `src/components/registrations/SessionEmailPreviewDialog.tsx` | Explicit create/resend preview mode |
| Backoffice `src/components/registrations/SessionResendResults.tsx` | Paginated operation results and bounded polling |
| Backoffice `src/app/session-grants/page.tsx` | Single/bulk action, preview, submission and recovery |
| Backoffice `src/components/registrations/SessionGrantResults.tsx`, `src/app/registrations/[id]/page.tsx` | Consistent attempt labels and entry to scoped resend flow |

Migration 0050 is the next available number at planning time (latest is 0049). Recheck before creating it and update references together if another migration landed. Existing migrations are manually listed in test harnesses and the journal is historically incomplete: follow the local migration test pattern, do not regenerate/replay the entire journal against operational data.

### Task 1: Define command interfaces, validation and pure eligibility

**Root:** API.

**Files:** Create `resend-types.ts`, `resend-policy.ts`, `resend-policy.test.ts`, `resend-schemas.test.ts`; modify existing `schemas.ts`. All module files live in `src/modules/session-grants/`.

**Interfaces:** Existing `InvitationPolicyInput`, `effectiveInvitationStatus`, and `EmailStatus` are inputs. Produce `ResendInput`, `ResendResult`, `ResendSkip`, `ResendCandidate`, `ResendOperationDto`, `resendInvitationSchema`, `canonicalResendInput`, and `resendDisabledReason`.

- [x] Define the shared HTTP contracts exactly:

```ts
export interface ResendInput { sessionId: number; invitationIds: string[] }
export type ResendSkipCode =
  | 'INVITATION_NOT_FOUND' | 'INVITATION_NOT_PENDING'
  | 'EMAIL_BUSY' | 'EMAIL_NOT_RESENDABLE' | 'RESEND_COOLDOWN'
  | 'INVITATION_PAYLOAD_INVALID';
export interface ResendSkip {
  invitationId: string;
  reasonCode: ResendSkipCode;
  retryAfter?: string;
}
export interface ResendQueued { invitationId: string; itemId: string }
export interface ResendResult {
  requestId: string;
  sessionId: number;
  requestedCount: number;
  queued: ResendQueued[];
  skipped: ResendSkip[];
}
```

`ResendCandidate` includes invitation/item/registration IDs, recipient/name, original notification snapshot and ciphertext/hash, effective-policy inputs, emailStatus, lastSuccessfulSentAt, and lastResendQueuedAt. Keep it server-internal and never serialize it. Define `ResendPreviewDto` with eligible `{invitationId,registrationId,name,recipient,subject,html}` entries and `ResendSkip[]`.

`ResendOperationDto` includes original result, actorId, createdAt, paginated entries with `waiting|sending|sent|failed|unknown|suppressed`, latest associated attempt number/time, and totals grouped by those six states. Skips retain their original reason. Return both original queued/skip counts and delivery-state counts so they are not confused.

- [x] Add the strict schema and pure helpers:

```ts
export const resendInvitationSchema = z.object({
  sessionId: z.number().int().positive(),
  invitationIds: z.array(z.string().uuid()).min(1).max(500),
}).strict();

export const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
export function canonicalResendInput(input: ResendInput): ResendInput {
  return { sessionId: input.sessionId,
    invitationIds: [...new Set(input.invitationIds)].sort() };
}
export function resendCooldownUntil(
  lastSuccessfulSentAt: Date | null,
  lastResendQueuedAt: Date | null,
): Date | null {
  const values = [lastSuccessfulSentAt, lastResendQueuedAt]
    .filter((value): value is Date => value !== null)
    .map(value => value.getTime());
  return values.length ? new Date(Math.max(...values) + RESEND_COOLDOWN_MS) : null;
}
```

`resendDisabledReason(candidate, now)` checks effective pending first, then pending/sending busy, sent-only status, and cooldown. Candidate payload validation is performed by the server reader/service with the existing token helpers; a client helper does not decrypt tokens. Malformed times/payloads fail closed with bounded codes.

- [x] Add boundary tests with concrete fixtures:

```ts
test('five minute cooldown is exact', () => {
  assert.equal(resendCooldownUntil(new Date('2026-10-23T03:00:00Z'), null)
    ?.toISOString(), '2026-10-23T03:05:00.000Z');
  assert.equal(resendCooldownUntil(null, null), null);
  assert.equal(resendCooldownUntil(new Date('2026-10-23T03:00:00Z'),
    new Date('2026-10-23T03:02:00Z'))?.toISOString(),
    '2026-10-23T03:07:00.000Z');
});
```

Test each skip, exact effective expiry, sorted/deduplicated IDs, 0/501 entries, wrong IDs and unknown object fields. Run `node --import dotenv/config --import tsx --test src/modules/session-grants/resend-policy.test.ts src/modules/session-grants/resend-schemas.test.ts`; expect all green. Commit `feat(session-invitations): define resend policy and contracts` with only these files.

### Task 2: Add durable operation and delivery-attribution schema

**Root:** API.

**Files:** Modify `src/database/schema.ts`; create `drizzle/0050_session_invitation_resends.sql`, `src/modules/session-grants/resend-migration.integration.test.ts`; extend the existing integration migration harness to apply the new migration once after existing invitation tables.

**Interfaces:** Produce Drizzle `sessionInvitationResendRequests`, queue `nextEmailPurpose/nextResendRequestId/lastResendQueuedAt`, attempt `purpose/resendRequestId`.

- [x] Add a guarded migration integration test first: old data migrates without changes to counts, duplicate actor/key fails, invalid purpose fails, request foreign keys reject missing IDs, null/default values support old inserts, and a full invited queue lifecycle is valid after migration. Expect failure on missing objects before migration implementation.
- [x] Implement the SQL transaction with a short local lock timeout:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE session_invitation_resend_requests (
  id uuid PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES backoffice_users(id),
  session_id integer NOT NULL REFERENCES sessions(id),
  idempotency_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_invitation_resend_actor_key_unique UNIQUE(actor_id,idempotency_key),
  CONSTRAINT session_invitation_resend_result_object CHECK(jsonb_typeof(result)='object')
);
CREATE INDEX session_invitation_resend_session_time_idx
  ON session_invitation_resend_requests(session_id,created_at);
ALTER TABLE registration_session_grant_items
  ADD COLUMN next_email_purpose varchar(16) NOT NULL DEFAULT 'initial',
  ADD COLUMN next_resend_request_id uuid REFERENCES session_invitation_resend_requests(id),
  ADD COLUMN last_resend_queued_at timestamptz,
  ADD CONSTRAINT session_grant_next_purpose_check
    CHECK(next_email_purpose IN ('initial','retry','resend')),
  ADD CONSTRAINT session_grant_resend_request_check
    CHECK(next_email_purpose <> 'resend' OR next_resend_request_id IS NOT NULL);
ALTER TABLE registration_session_grant_email_attempts
  ADD COLUMN purpose varchar(16) NOT NULL DEFAULT 'initial',
  ADD COLUMN resend_request_id uuid REFERENCES session_invitation_resend_requests(id),
  ADD CONSTRAINT session_grant_attempt_purpose_check
    CHECK(purpose IN ('initial','retry','resend'));
CREATE INDEX session_grant_attempt_resend_request_idx
  ON registration_session_grant_email_attempts(resend_request_id,item_id,attempt_no);
COMMIT;
```

- [x] Mirror SQL exactly in Drizzle, retaining all existing outcome/email/count checks. Do not rewrite historical purpose or clear original snapshots. Test isolated migration rehearsal and `npm run build`; expect old fixture inserts and new constraints to pass. Commit `feat(session-invitations): persist resend operations and attribution`.

### Task 3: Read candidates, shared display data and operation history

**Root:** API.

**Files:** Create `resend-readers.ts`, `resend-readers.integration.test.ts` in the module; modify `types.ts` and `tracking.ts` for read-only UI additions.

**Interfaces:** Produce:

```ts
readResendCandidates(tx: GrantTransaction, input: ResendInput): Promise<ResendCandidate[]>;
buildResendSnapshot(candidate: ResendCandidate): InvitationNotificationSnapshot;
getResendOperation(database: GrantDatabase, requestId: string,
  page: number, limit: number): Promise<ResendOperationDto | null>;
```

`readResendCandidates` expects mutation locks already acquired for command calls; preview calls it in a read-only snapshot. Do not put locks or writes inside a reader used by preview. Build qualified joins from invitation to original grant item, registrations, session, and event. Match requested session and original `outcome='invited'` before returning candidate data.

- [x] Test last-success calculation, originals from different batches, preserved original email/origin, a session changed since initial invitation, and zero credential disclosure. Use existing guarded fixture conventions from `invitation-email.integration.test.ts`; create fixture rows using SQL `RETURNING` and tear down only rows belonging to that test's generated IDs.
- [x] Implement successful-send reads using `MAX(finished_at) FILTER (WHERE result='sent')` per original item; fall back to original item `sentAt` only without such an attempt. Use explicit UTC conversion for timestamp-without-time-zone session fields, as the existing worker does.
- [x] Build current display snapshot by copying the original notification snapshot and replacing event/session display fields from current rows; preserve original recipient/person identity and responseOrigin. Never update persisted original snapshots. The same builder feeds resend preview and worker; initial sends keep the existing renderer path.
- [x] Read operation results from immutable ledger JSON and only attempts with matching `resendRequestId`. For each queued original item select the greatest attemptNo associated with that operation, including linked retries; absence means waiting. Paginate entries, calculate summary across the entire operation, and never use the item's current emailStatus to describe an older operation.
- [x] Add optional/additive tracking fields `lastSuccessfulSentAt`, `lastResendQueuedAt`, `resendEligibleAt`, `successfulResendCount`, `resendEligible`, and `resendDisabledReason`. Count distinct request IDs with at least one successful linked attempt. No tokens in read DTOs.
- [x] Run reader integration tests and existing tracking integration tests serially against the isolated test database. Commit `feat(session-invitations): add resend readers and delivery history`.

### Task 4: Implement preview and idempotent transactional resend

**Root:** API.

**Files:** Create `resend-service.ts`, `resend-service.integration.test.ts`, `resend-preview.test.ts` in the module. Consume task 1–3 interfaces and existing token helpers.

**Interfaces:** Produce:

```ts
previewInvitationResends(database: GrantDatabase, input: ResendInput): Promise<ResendPreviewDto>;
queueInvitationResends(database: GrantDatabase,
  input: ResendInput & { actorId: number; idempotencyKey: string }):
  Promise<{ replayed: boolean; result: ResendResult }>;
```

- [x] Add integration tests that initially fail because the functions are absent: one eligible recipient; different original batches; mixed eligible/busy/terminal recipients; full capacity; stable key replay and key mismatch; 500 selected; two physical connections racing for the same invitation. Assert invitation/token/expiry/registration_session counts and original snapshots are byte-for-byte unchanged.
- [x] Implement preview as a repeatable-read read-only transaction. Read database time, use the same candidate policy, verify token payload integrity server-side without returning the token, render with `renderInvitationEmail(snapshot,'https://preview.invalid/',effectiveDeadlineISO)`, and report per-ID skips. Assert no ledger/queue/attempt/capacity writes.
- [x] Implement the mutation in this exact sequence:

```text
Canonicalize IDs; SHA-256 JSON of {operation:'invitation-resend',sessionId,invitationIds}.
Begin transaction; acquire actor+resend+idempotency advisory lock.
Read existing actor/key record: equal hash => original response; unequal => 409.
Verify actor exists. Lock selected session.
Resolve matching original registrations/invitations/items, then lock in existing
session -> ordered registrations -> ordered invitations -> ordered items order.
Read clock_timestamp() after waiting for locks.
Load candidates; check each effective status, payload, mail state, and cooldown.
Build final safe result with one entry per unique requested invitation ID.
Insert ledger row with final result and generated request ID.
For each eligible item set pending, admin trigger/actor, resend purpose/request ID,
lastResendQueuedAt=databaseNow; clear claim/lease/last error only.
Commit and return {replayed:false,result}.
```

Use `GrantError(404,'SESSION_NOT_FOUND',...)` for absent selected session; absent/different-session invitation IDs receive `INVITATION_NOT_FOUND` without revealing their actual owner/session. Missing global encryption configuration fails bounded and atomically; malformed individual stored payload returns per-item `INVITATION_PAYLOAD_INVALID`. Update only eligible original items. Generate no tokens and touch no capacity tables. Do not clear attemptCount or historical sentAt merely to enqueue.

- [x] Verify HTTP-timeout-style replay returns original result even after the worker has completed; a fresh key during cooldown returns a skip. Ledger/request creation is rolled back if queue transition fails. Run new service/preview tests serially; expect one queued recipient and one skip for concurrent overlapping requests. Commit `feat(session-invitations): queue explicit idempotent resends`.

### Task 5: Attribute resend delivery, retry and recovery in the worker

**Root:** API.

**Files:** Modify `email-jobs.ts`, `email-template.ts`, `email-template.test.ts`, `email-jobs.integration.test.ts`, `invitation-email.integration.test.ts`; create `resend-email.integration.test.ts`.

**Interfaces:** `ClaimedMail` carries `purpose` and nullable `resendRequestId`. Worker consumes `buildResendSnapshot`; every invitation delivery still calls the existing `renderInvitationEmail`. Existing queue method signatures remain compatible.

- [x] Write a fake-transport integration test comparing the real initial-send and resend HTML/subject after controlling snapshot/deadline inputs. Capture HTML only in test memory and compare exactly. Check real original URL is unchanged, no resend prefix/footer/style appears, and attempts have different purposes but the same template version.
- [x] Bump only the shared invitation version to `session-invitation-v3`; update existing assertions. Do not add a renderer, purpose argument to the renderer, or a second copy of the approved prose.
- [x] Extend claim reads and both valid/template-failed attempt inserts to persist purpose/request attribution. If a claim belongs to a resend request (including its retry), use current display snapshot; otherwise retain existing initial/grant semantics. Effective deadline and original token/origin are still required. Do not return token-bearing data to new read endpoints.
- [x] Preserve attribution through `recoverOneExpiredClaim`. Pre-provider interruption requeues the same purpose/request; post-provider interruption becomes unknown. Finalization clears active queue metadata with matching claim token and a consistent `nextEmailPurpose` value, while attempt rows retain attribution. Leave lastResendQueuedAt intact.
- [x] Extend retry internally: still accept only failed/unknown; for an attributed failed resend, recover its request association from the latest attempt under lock and set purpose retry with the same request reference. For non-resend retry set purpose retry and no request reference. Keep unknown acknowledgement, relation checks and batch scoping.
- [x] Test accepted/declined/expired/revoked before claim and before handoff; suppression attributed to the operation; key failure; provider rejection; timeout; interrupted recovery; stale claim fencing; failed resend retry; no automatic unknown retry; last-success still readable after a later failure. Verify two sequential resend operations show their own attempt results.
- [x] Run new worker tests, existing invitation-email/email-jobs integration tests, and template unit tests; expect all green and unchanged counts/token/expiry. Commit `feat(session-invitations): deliver resends through shared invitation template`.

### Task 6: Expose Admin routes and additive history fields

**Root:** API.

**Files:** Create `resend-routes.ts`, `resend-routes.test.ts`; modify `routes.ts`, `types.ts`, `tracking.ts`, `service.ts`, `package.json` and affected route/read tests.

**Interfaces:** `registerInvitationResendRoutes(fastify, options)` receives database and injectable preview/queue/get functions for route tests, reusing the Admin/feature/error helpers. Extract those three small existing helpers only if necessary to avoid duplicating auth; do not restructure the whole route module.

- [x] Write Fastify inject tests with stub services: 401/403; feature-disabled 503 for new routes; malformed body/header 400; new operation 202; replay 200; key mismatch 409; operation missing 404; existing create/retry endpoints unchanged. Assert every sensitive response uses `Cache-Control: no-store` and serializes no payload credentials.
- [x] Register `POST /resend-preview`, `POST /resend`, `GET /resends/:requestId` before the dynamic batch route. Validate request ID and page/limit with existing schemas. Get-operation limit is 1..100. A read response includes its operation actor and timestamps, not the full raw database row.
- [x] Add optional `resendSupported:true` to `/status` only in the new API. It is a client compatibility signal, not automatic worker readiness detection. The operational flag remains off during a mixed API/worker rollout.
- [x] Expose attempt `purpose/resendRequestId` and additive tracking fields. Preserve existing endpoint meanings and batch outcome totals. Update all reader DTO mappings, including batch/history where they display attempts.
- [x] Add scripts `test:session-resends` and `test:session-resends:integration` listing new tests explicitly. Integration scripts must serialize shared-schema tests. Run new routes plus old routes and tracking unit tests with dotenv preloaded, then `npm run build`. Commit `feat(session-invitations): expose resend API and audit read models`.

### Task 7: Add Backoffice contracts, selection and shared preview mode

**Root:** Backoffice.

**Files:** Modify `src/types/session-grants.ts`, `src/lib/api.ts`, `src/components/registrations/SessionEmailPreviewDialog.tsx`; create `src/lib/session-invitation-resend.ts`, `src/lib/session-invitation-resend.test.ts`.

**Interfaces:** API client `sessionGrants.resendPreview(token,input)`, `resend(token,key,input)`, `resendOperation(token,id,page,limit)`. Match server DTO names/fields; do not derive new server eligibility from client guesses. Dialog props become a discriminated create/resend operation while preserving existing create callers.

- [x] Test client paths/methods/body/header using the existing mocked-fetch style. Ensure resend body uses invitation IDs and no batchId/recipient/URL. Create preview behavior must still use registration IDs and existing endpoint.
- [x] Implement a pure scope-aware selection Map keyed by invitationId, capped at 500, retaining selected values across pages in the same event/session and clearing on scope change. Visible selection adds/removes only visible eligible rows. Each entry retains name/email for review but the server receives only IDs.
- [x] Define pending submission storage key `session-invitation-resend:${actorId}:${sessionId}` in sessionStorage. Persist `{key,input,requestId?}` before first POST; reuse after HTTP ambiguity. Clear only on known completion or explicit cancellation. Unknown HTTP result never creates a fresh key automatically. A failed key replay is surfaced without sending to a new recipient set.
- [x] The preview dialog selects API/copy from its mode. In resend mode use Thai UI copy `ส่งคำเชิญซ้ำ`, `ยืนยันส่งคำเชิญซ้ำ`, and counts of eligible/skipped recipients. Email subject/body remain untouched. Keep iframe sandbox/no-referrer and inert dummy links; do not expose real URLs for preview fidelity.
- [x] Run helper/client tests with the existing API dependency's tsx executable if Backoffice lacks its own: `node --import ../conference-api/node_modules/tsx/dist/loader.mjs --test src/lib/session-invitation-resend.test.ts src/lib/session-grant-tracking.test.ts` from Backoffice. Verify the loader path exists before the command; otherwise use the already installed API `node_modules/.bin/tsx.cmd` directly, without adding dependencies. Run `npx tsc --noEmit`. Commit `feat(session-invitations): add resend client and preview mode`.

### Task 8: Add single/bulk resend, results and history UI

**Root:** Backoffice.

**Files:** Modify `src/app/session-grants/page.tsx`, `src/components/registrations/SessionGrantResults.tsx`, `src/app/registrations/[id]/page.tsx`, `src/lib/session-grant-tracking.ts`, and existing helper tests; create `src/components/registrations/SessionResendResults.tsx`.

**Interfaces:** Tracking page consumes task 7 client/selection/dialog. Results component takes `{requestId:string,onSettled:()=>void}`; fetches operation pages <=100 and polls only while waiting/sending, at the existing three-second interval while visible. It ignores stale responses when requestId/page changes and cleans up timers.

- [x] Add eligibility-helper tests for capability missing/disabled, accepted/expired, sent eligible, busy, failed/unknown retry, cooldown boundary and skipped history rows. Disabled reason displays server state and the Bangkok eligible time. Preserve `sessionGrantRetryDisabledReason` contract.
- [x] Add row resend and bulk toolbar only for one selected session and `enabled && resendSupported`. Use original invited rows, not skipped duplicate-invitation history rows. Include select-visible count and explicit cross-page selected count. Changing event/session clears the selection and old preview; ordinary paging does not.
- [x] Submit preview first, freeze its selected input for confirmation, create/reuse one idempotency key, disable confirmation in flight, then show `เข้าคิวแล้ว` and operation results. After network loss offer recovery/replay of the exact stored request; never silently generate another key. Empty eligible preview disables submit.
- [x] Display original queued/skipped counts and per-entry current attempt result/reason; do not equate queued with delivered. Poll result pagination without losing the operation reference. Show provider success as `ส่งแล้ว`, not Inbox/read confirmation. Refresh tracking after terminal results, and keep retry available for failed/unknown entries using their original batch/item IDs.
- [x] Show attempt purpose labels `ส่งครั้งแรก`, `ลองส่งใหม่หลังล้มเหลว`, `ส่งคำเชิญซ้ำ`, actor, version and time. Preserve the existing unknown-send acknowledgement. Link registration detail to the scoped tracking flow; do not change add-session eligibility or add a duplicate mail screen. Show last successful send independent of last attempt result.
- [x] Validate single selection, two recipients from different original batches, selection across pages, event/session change, double click, failed preview, ambiguous submit, cooldown, mixed results, stale polling response, and role/capability hiding. Use existing browser harness/local fake mail; do not dispatch real email. Run focused helper tests, `npx tsc --noEmit`, targeted lint and `npm run build`. Commit `feat(session-invitations): expose single and bulk resend controls`.

### Task 9: Regression proof and rollout instructions

**Roots:** API and Backoffice; run commands from the corresponding root.

**Files:** Create API `docs/superpowers/verification/2026-10-23-session-invitation-resend.md`; update API scripts/runbook only where needed to run new tests. Record API/worker/Backoffice commit identities and actual pass/fail output, not assumed success.

- [x] Run API `npm run build`, unit suites for session grants/invitations/resends, then isolated resend integration tests and existing invitation/readers/tracking/email-jobs integration coverage. Preload dotenv only for required app configuration; test clients still require a separately guarded TEST_DATABASE_URL. The existing test-database validator must reject missing/shared/unsafe targets. Never use `db:push` or an operational URL to prepare tests.
- [x] Run Backoffice focused helper/client tests, `npx tsc --noEmit`, targeted ESLint on changed files, and `npm run build`. Fix change-caused failures; identify unrelated baseline failures with evidence instead of widening scope.
- [x] Browser acceptance with fake transport: create initial invitation, deliver it, advance guarded test timestamps for cooldown, preview and resend one and multiple recipients, compare actual initial/resend body for equal data, confirm exact original URL, and inspect attempts/operation results. Respond while another resend waits and verify suppression. Confirm no extra seat, entitlement, invitation, batch, or grant item.
- [x] Test a 500-recipient operation with bounded pages, duplicate IDs and partially invalid recipients; inspect queue throughput using existing worker pacing instead of creating a bulk provider call.
- [x] Write rollout checklist: disable existing flag; apply additive migration; deploy API and worker from matching release; deploy Backoffice; verify worker health and capability; enable flag; perform only explicitly authorized sample sending. An old worker can dequeue a resend without its new attribution, so never activate resend while old workers run.
- [x] Document rollback: disable flag before stopping workers; resolve/record in-flight sending/unknown states; drain or explicitly suspend pending resend items with a reviewed operational procedure before any worker downgrade. Do not drop new columns/tables or run an old worker while resend-attributed items remain pending. Keep audit and token keys intact; prefer a forward fix if queue state cannot safely be downgraded.
- [x] Record remaining handoff limitations: final-check/provider race, provider acceptance versus Inbox delivery, event-specific PRIS prose, manual worker-release readiness. Review `git diff --check` in both repositories and commit verification documents only after actual results exist.

## Self-review against the approved specification

| Spec section | Tasks covering it |
| --- | --- |
| 1: shared template, single/bulk, exclusions | 1, 4, 5, 7, 8 |
| 2: preserve create/retry/audit infrastructure | 2, 4, 5, 6, 9 |
| 3: status, payload and five-minute cooldown | 1, 3, 4, 5, 8 |
| 4: preview/queue/get API, idempotency, pagination | 1, 3, 4, 6, 7 |
| 5: ledger, queue/attempt association, historical success | 2, 3, 5, 6, 8 |
| 6: same renderer, current metadata, preserved address/origin/link | 3, 4, 5, 7 |
| 7: atomicity, locking, races, retry/unknown/recovery | 4, 5, 9 |
| 8: tracking, selection, preview, results, detail links | 7, 8 |
| 9: safety and regression tests | All tasks, consolidated in 9 |
| 10: additive rollout and acceptance | 2, 6, 9 |

Execution must load the chosen execution skill before modifying application code. Verified available paths are `D:/confer/confer/conference/vendor/superpowers/skills/executing-plans/SKILL.md` and `D:/confer/confer/conference/vendor/superpowers/skills/subagent-driven-development/SKILL.md`. Read applicable vendor AGENTS.md before using those sources. This document itself is planning, not an implementation or a production send instruction.
