# Admin Session Invitations task checkpoints

## Implementation T00 — completed

- Authoritative prompts, approved design, implementation plan, review/verification plan read before source mutation.
- Baseline Git/Docker state captured.
- Persistent isolated Docker project prepared without touching production/real provider.
- Private fake-mail recorder and test-only transport selection verified.
- Writer inventory captured.
- Existing builds/tests recorded; pre-existing BO/PRIS repo-wide lint debt isolated from invitation changes.
- T00 gates ENV-01..05 and BASE-01..03 closed with evidence.

Next: Implementation T01 — schema/migration/contracts and RED tests.

## Implementation T01 — completed

- RED observed for missing decision schema and missing 0032 migration.
- Added structural confirmation flag, invited batch count, invitation table/index/checks, stable invitation DTO/types and strict decision schema.
- Historical completed added/skipped batch preserved with invitedCount=0.
- Lock-timeout rollback verified without partial 0032 DDL.
- Full session-grants chain after 0032: unit 17/17; legacy migration 4/4; invitation migration 2/2; serialized service/readers/writer/mail integration 4/4; API build PASS.

Next: Implementation T02 — pure invitation deadline policy and token/config utilities.

## Implementation T02 — completed

- RED observed for missing invitation-policy and invitation-token modules.
- Added exact effectiveDeadline/effectiveInvitationStatus/participantKey policy.
- Added 64-hex credential hashing, AES-256-GCM envelope with invitation-ID AAD, strict canonical base64 32-byte key config and trusted frontend-origin validation.
- Focused GREEN: policy 5/5; token/config 4/4; API build PASS.
- Error paths verified not to reveal raw invitation token or encryption key.

Next: Implementation T03 — capacity reader and read-only public invitation lookup.

## Implementation T03 — completed

- RED observed for missing A07 invitations module.
- Added bound-SQL configured-session capacity reader with UTC conversion, safe integer validation and fail-closed invalid capacity.
- Added token-hash public lookup using DB clock/effective state and minimal PublicInvitationDto; lookup performs no UPDATE/consume.
- Capacity evidence: 30 actual + 15 reservations => occupied45/remaining5; expired pending no seat; same-user sibling pending no double count; legacy 3 actual / capacity2 => remaining0.
- At-rest proof: token hash differs from raw token and encrypted envelope snapshot contains no raw token.
- Focused integration 1/1, full migration/integration chain PASS, API build PASS.

Next: Implementation T04 — branch Admin grant creation into atomic invitation reservations.

## Implementation T04 — completed

- RED observed: configured Session still followed legacy immediate-grant path and returned added outcomes instead of invitations.
- createGrant now locks Session FOR UPDATE, selected/same-user registrations in ascending ID order, then pending invitations deterministically; DB time is read after lock acquisition.
- Configured Sessions create immutable invited grant items plus encrypted pending invitation reservations and no entitlement. Missing config and insufficient capacity roll back before batch persistence.
- Eligibility distinguishes ALREADY_REGISTERED, ALREADY_INVITED, DUPLICATE_PARTICIPANT and existing invalid-registration reasons; known-user identity spans sibling registrations while null-user identity stays registration-scoped.
- Same idempotency key replays the same batch and encrypted payload; different keys racing the same participant produce exactly one pending invitation/email. Two disjoint requests racing for the final seat produce exactly one winner and occupied never exceeds capacity.
- Invitation-aware batch reads expose current invitation metadata plus global actual/reserved/occupied/remaining counts.
- Focused invitation integration 2/2 PASS; legacy service/readers integration 2/2 PASS; API Docker build PASS.

Next: Implementation T05 — atomic response and invalidation lifecycle.

## Implementation T05 — completed

- RED observed: respondToInvitation and closeInactiveInvitations did not exist.
- Response transaction discovers token hash read-only, then re-authorizes under session → registrations → invitation → grant-item locks and reads DB time after locks.
- Accept atomically swaps one reservation into one admin_grant/null-ticket entitlement using original Admin identity; decline creates no entitlement. Same-decision replay succeeds and opposite decision conflicts.
- Expired/revoked normalization commits before surfacing error so reservations are released. Exact existing entitlement reconciliation preserves ticket/source/check-in metadata; same-user sibling ownership revokes the redundant invitation.
- Forced failure after entitlement insert proves the transaction rolls back the entitlement and leaves invitation pending.
- Focused invitation integration 3/3 PASS including accept-vs-decline race; legacy session-grant unit 17/17 PASS; API Docker build PASS.
- During GREEN, postgres.js rejected raw Date parameters in untyped SQL; captured DB time is now bound as ISO timestamptz and the original failing case reran GREEN.

Next: Implementation T06 — scoped public HTTP API and request-secret redaction.

## Implementation T06 — completed

- RED observed: invitation-routes module absent.
- Added public GET /api/session-invitations/current and PUT /api/session-invitations/current/response outside Backoffice auth. Bearer credential is exactly 64 lowercase hex; PUT body is strict decision-only and capped at 1024 bytes.
- All invitation responses/errors carry Cache-Control: no-store. GrantError serialization exposes only declared safe details; unexpected errors return a generic fixed code.
- GET/PUT share one 30 requests/minute per-IP limiter. Initial route-local group configuration was proven not to share state because the global limiter's request marker suppressed the custom handler; fixed by disabling the global hook only on these routes and attaching one shared limiter instance.
- Fastify request serialization omits Authorization and strips token query parameters only for invitation routes. Runtime canary logs contain neither query secret nor Authorization token.
- Docker CORS preflight from http://pris-server:3004 returns 204 and permits PUT plus Authorization/Content-Type without wildcard expansion.
- Focused public/admin route regression 3/3 PASS; pure policy/token/public-route suite 11/11 PASS; session-grants unit 17/17 PASS; full migration/integration chain PASS; API Docker build PASS.

T00–T06 coherent checkpoint: all current source-state Docker verification passed. Next: create grouped API commit for T00–T06 without staging the pre-existing untracked continuation prompt, then continue Implementation T07.
