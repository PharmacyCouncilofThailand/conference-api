# Admin session invitations — design for written-spec review

Date: 2026-10-01 (Asia/Bangkok)

Status: The user approved approach A on 2026-10-01: invite first and create the session entitlement only after acceptance. The user explicitly selected responses until the session starts. This written specification is ready for review; implementation has not started.

## 1. Scope and accepted behavior

- Initially enable this behavior only for PRIS-2026 / POLICY-INNOVATION (Policy Innovation Workshop). Resolve the configured session by event/session codes, never assume production numeric IDs exist in every environment.
- Admin creates invitations from the existing Registration List or Registration Details flow. No purchase, add-on ticket, order, payment, invoice, new registration, or new registration code is created.
- Invite only confirmed registrations belonging to the session's event.
- Reserve a seat when Admin creates an invitation. Convert that reservation into a real entitlement on acceptance. Decline, expiry, or invalidated registration releases the reservation.
- Responses are permitted strictly before the session start. At server time equal to startTime, an unanswered invitation is expired. There is no seven-day TTL.
- The initial session has maxCapacity 50. Enforce its stored capacity, without changing other sessions' existing unrestricted Admin grant behavior.
- Email contains a recipient-specific link to a public response page in Pris2026. No login or OTP is required; possession of the invitation token authorizes only reading and responding to that invitation.
- The recipient chooses acceptance or decline explicitly. Opening the link never records a response. A recorded response is final for that invitation.
- Existing session entitlements remain valid. Do not silently convert old grants into pending invitations or send retrospective invitations.
- Existing registration, grant selection, pagination, email attempt audit, and unknown-send acknowledgement behavior are reused.

Out of scope: waitlists, reminders, recipient-initiated cancellation after acceptance, bulk retrospective invitations, an Admin entitlement withdrawal interface, general ticket/payment changes, new authentication, and new dependencies.

## 2. Current code and changes in meaning

The baseline is docs/superpowers/specs/2026-09-30-admin-session-grants-design.md plus the implemented module, not that document's historical descriptions of pre-migration schema.

| Current component | Relevant behavior | Required change |
| --- | --- | --- |
| src/modules/session-grants/service.ts | Immediately inserts registration_sessions, records added/skipped, snapshots a generic participant URL | For configured sessions, create invitation plus email job instead of an entitlement |
| src/database/schema.ts | registration_sessions has nullable ticketTypeId and unique registration/session pair | Preserve it as the source of actual access |
| src/modules/session-grants/email-jobs.ts | Initial sending and retry require an existing entitlement | Validate a pending invitation for invitation messages; preserve old entitlement checks for grant messages |
| src/modules/session-grants/email-template.ts | Says access has already been granted | Add an invitation template with deadline and response link |
| src/routes/backoffice/registrations.ts | Legacy add-session and manual-registration paths can insert entitlements directly | Reject attempts to bypass invitation acceptance for configured sessions |
| src/routes/backoffice/checkins.ts | Reads actual entitlements | Pending invitations remain absent; preserve access and time checks |
| src/utils/sessionEnrollment.ts and backoffice readers | Count actual entitlements | Keep enrollment counts; add reserved count and capacity availability separately |
| Pris2026/src/app/[locale]/abstracts/confirm/page.tsx | Public token lookup and explicit submission | Reuse page interaction patterns for a separate session page |
| Pris2026/src/components/layout/GlobalRefreshRedirect.tsx | Redirects reloads to the home page | Exempt the session response route |

Do not use requiresOptIn as an invitation flag: it currently describes checkout selection. The previous capacity exemption remains for other sessions, but is superseded for sessions using invitations.

## 3. Data model

Add sessions.adminGrantRequiresConfirmation (boolean, not null, default false). Turn it on for the target session only after backend, worker, and frontend are ready. There is no new Session settings UI in this scope.

Add one table, session_invitations:

| Field | Type / purpose |
| --- | --- |
| id | UUID primary key |
| registrationId | Required registration FK; deletion must not silently erase invitation audit |
| sessionId | Required session FK |
| grantItemId | Required, unique FK to registration_session_grant_items |
| status | pending / accepted / declined / expired / revoked, checked constraint |
| tokenHash | SHA-256 digest, unique; never the raw token |
| tokenCiphertext | Nullable authenticated-encryption envelope for durable email sending/retry |
| expiresAt | timestamptz, snapshot of session start at invitation creation |
| respondedAt | Nullable timestamptz; set only for accepted/declined |
| closedAt | Nullable timestamptz; terminal transition time |
| closeReason | Nullable fixed code for invalidation/closure |
| createdBy | Required Admin identity, consistent with existing audit retention |
| createdAt | timestamptz |

Partial unique index on (registrationId, sessionId) where status = 'pending'. Before creating a replacement invitation, close stale pending invitations for that participant under the session lock. Retain historical invitations. Add indexes needed for pending capacity counts and unique token lookup only.

Extend grant items' allowed outcome values to added / invited / skipped. An invitation's original item remains invited even after acceptance: creation outcome is audit, invitation status is current participation. Populate its existing registrationSessionId after acceptance. Preserve the existing unique entitlement linkage.

Add invitedCount to grant batches (default zero). Update completion constraint to requestedCount = addedCount + invitedCount + skippedCount. addedCount continues to mean immediate entitlements created in the original request; it does not increase later when recipients accept.

Update outcome/email constraint so invited items have no skip reason and use the existing applicable email states. Skipped items retain not_applicable. Do not merge email state into invitation state.

## 4. Lifecycle and deadline

| Effective status | Holds seat? | Has access? | Can respond? |
| --- | --- | --- | --- |
| pending, valid, before deadline | Yes | No | Yes |
| accepted | Through its actual entitlement | Yes, subject to normal registration/session checks | No |
| declined | No | No | No |
| expired | No | No | No |
| revoked | No | No new access from invitation | No |

Effective pending requires: stored pending, confirmed registration, matching event, active session, serverNow < expiresAt, and serverNow < current session.startTime. The earlier of snapshotted expiresAt and current startTime is the effective deadline. Moving a session earlier closes responses earlier; moving it later never silently extends issued links. Configuration/availability is checked again on every operation.

GET computes effective status without writes. Capacity excludes effectively expired/revoked invitations even if their stored status has not been normalized yet. Existing email runner and invitation mutations may normalize such rows and clear ciphertext; no separate scheduler is required for correct seat release.

An accepted/declined link may display its recorded result after the deadline, but never authorize another mutation. If its underlying registration/session no longer exists or is inaccessible, return an unavailable result rather than misleading active access.

Allow Admin to invite again after decline/expiry using the existing create flow with a new idempotency key, fresh token, and available capacity before session start. No special resend-sent or change-answer endpoint is added.

## 5. Capacity, participant identity, and locking

For a configured session:

occupied = confirmed actual entitlements + valid pending reservations that do not already have an actual entitlement for the same participant.

remaining = max(0, maxCapacity - occupied).

maxCapacity must be a positive integer for the configured session. Invalid capacity blocks new invitations with a configuration error; it does not mean unlimited.

Actual entitlement readers keep their existing enrollment meaning. Invitation displays expose confirmed/entitled count, reservedCount, occupiedCount, and seatsRemaining. Include existing legacy entitlements in capacity; if there are already more than 50, reject new invitations and report the overage without deleting existing access.

Reuse current registration identity. When userId is present, check other confirmed registrations for the same user in the event to prevent a second pending reservation or entitlement for this session. For registrations without userId, use registrationId; do not invent email-based identity merging. Duplicate participant selection within a batch is reported as DUPLICATE_PARTICIPANT; canonical ascending registration IDs make the result deterministic.

All invitation mutations acquire locks in one order: session row FOR UPDATE, relevant registration rows in ascending ID order, relevant invitation rows in deterministic order. Obtain current database time after waiting for locks. Existing actor/idempotency advisory lock may precede these locks in create requests.

After eligibility and duplicate checks, compare the number of new reservations against remaining capacity. If insufficient, reject the whole create request with 409 SESSION_CAPACITY_EXCEEDED and counts; persist no batch, reservations, or emails. Other invalid registrations retain item-level skip results when the request fits available capacity.

Acceptance swaps one reservation for one entitlement atomically. Decline/invalidation/expiry releases it. If another authorized writer has already created the exact entitlement, reconcile the existing row without replacing ticket/source/check-in metadata and avoid double counting. Audit any different-registration ownership conflict and return a structured conflict rather than silently granting another seat.

Session row locking is sufficient only when every reachable writer follows the configured-session rules. Audit legacy/manual/checkout/settlement paths; do not claim capacity safety while a bypass remains.

## 6. Token and durable mail payload

- Reuse the 32-byte random token and SHA-256 primitive already demonstrated by src/services/abstractConfirmation.ts, without coupling session state to abstract tables or adopting its multi-update mutation flow.
- Encrypt the raw token with AES-256-GCM using node:crypto. Use a dedicated deployment secret SESSION_INVITATION_ENCRYPTION_KEY (base64 encoding of exactly 32 bytes), a fresh random nonce, and authenticated associated data bound to invitation ID. Store only a versioned ciphertext/nonce/tag envelope outside notificationSnapshot.
- Missing/invalid encryption key or configured PRIS_FRONTEND_URL blocks invitation creation atomically; other immediate-grant flows continue to work.
- Keep the deployment key stable while outstanding invitations exist. Do not rotate it by replacing it without a payload migration plan.
- Build https://<configured-Pris2026-origin>/th/sessions/confirm?token=<encoded-token>. Require a trusted HTTPS origin in production; allow explicitly configured localhost only in local development. Do not derive it from Host or the generic CONFER_URL fallback.
- Snapshot recipient email and display metadata as the current grant system does. Never put plaintext token/URL in persisted notification snapshots, email attempt fields, logs, public batch DTOs, or errors.
- Retain ciphertext while the invitation is effectively pending, including sent mail, so failed/unknown retries can reproduce the same link. Clear it when the invitation closes. Token hash may remain for read-only result lookup.
- Disable email-provider click tracking/link rewriting for this message where the transport supports it; inspect the existing provider behavior during integration verification. Token-bearing links must not be sent to third-party analytics.
- Apply no-store to public lookup/response; set Referrer-Policy: no-referrer on the response page and redact token query strings and authorization headers in application/proxy logs. Validate token length/format and rate-limit public endpoints.

The token is a bearer credential for one invitation. Forwarding the email allows its recipient to respond. Do not log the user in, set AuthContext, or grant broader API access with it.

## 7. API contracts

### Admin create and read

Keep POST /api/backoffice/session-grants with its existing strict body {sessionId, registrationIds}, Admin authentication, Idempotency-Key, 1..500 limit, canonical request hash, 201 initial / 200 replay, and 409 payload mismatch. The server selects invitation versus immediate grant from the session flag; caller cannot bypass it.

Add invitedCount, reservedCount, occupiedCount, seatsRemaining, and item invitation metadata (invitationId, effective invitationStatus, expiresAt/effectiveDeadline, respondedAt) to applicable batch/history/registration responses. Keep currentEnrollmentCount as actual confirmed entitlements. Return no token or ciphertext. Invitation response counts are derived from linked invitation states; immutable batch outcomes/counts remain unchanged.

Eligibility includes ALREADY_INVITED, DUPLICATE_PARTICIPANT, existing already-registered/registration/event skip reasons, and inactive/response-closed session errors. Unconfigured sessions retain their current contract and behavior; frontend consumers must understand invited before enabling the flag.

### Public lookup

GET /api/session-invitations/current, with Authorization: Bearer <invitation-token>.

Return 200 with invitation status and minimal session summary (name, type, startTime, endTime, room, effectiveDeadline, display first name). Do not expose contact email, Admin identity, full registration code, batch audit, or other invitations.

Unknown/malformed credential returns 401 INVALID_INVITATION_TOKEN; unanswered expired invitation returns 410 INVITATION_EXPIRED with sufficient safe summary for the expired screen; unavailable registration/session returns 409 with its fixed reason code. Terminal accepted/declined results return 200 read-only.

### Public response

PUT /api/session-invitations/current/response, same scoped bearer credential, strict JSON body {decision: "accepted" | "declined"}. Body never accepts registrationId, sessionId, userId, role, or return URL.

- 200 for successful response or retry of the same previously recorded response.
- 409 RESPONSE_ALREADY_RECORDED for the opposite recorded response.
- 401 INVALID_INVITATION_TOKEN for invalid credentials.
- 410 INVITATION_EXPIRED for a pending invitation at/after effective deadline.
- 409 REGISTRATION_NOT_CONFIRMED / SESSION_RESPONSE_CLOSED / INVITATION_REVOKED / PARTICIPANT_ALREADY_REGISTERED as applicable.
- 400 for invalid body; 429 for rate limit; structured 500 without sensitive internals for unexpected failures.

Acceptance, entitlement insert, invitation transition, timestamp, and grant item linkage commit in one transaction. A new entitlement uses source = admin_grant, ticketTypeId = null, and addedBy = the original invitation Admin; createdAt is the actual acceptance/insert time, while invitation.createdAt preserves the invitation time. A failed insert/update rolls back all changes. Retried requests cannot create duplicate access. Concurrent opposite responses produce one terminal decision. Use database constraints as the final duplicate defense.

Public routes are registered outside protected Backoffice authentication and use invitation-specific validation, never the normal login JWT validator. Server binds credential to invitation/registration/session.

## 8. Email and recovery

Reuse existing grant email queue, attempt audit, NipaMail transport, claim leases, failed/unknown/suppressed states, and worker deployment. Add a distinct session-invitation-v1 template; preserve session-grant-v1 rendering for historical/immediate grant messages.

Invitation email is Thai, preserving actual person/event/session names. Include greeting, session, Bangkok date/time, actual room, deadline, response-page link, and notice that access becomes active after acceptance. The link opens a decision page; it never embeds an accept/decline action.

For invited items, worker checks effectively pending invitation and valid registration/session before rendering/sending. For old added items, retain entitlementStillActive behavior. Recheck before transport and suppress closed invitations. A decision concurrent with transport can still cause an already-dispatched email to arrive; opening it displays the current terminal state safely.

Retry failed/unknown mail uses the same invitation, token, recipient snapshot, and deadline. Keep unknown acknowledgement/audit. Do not reset a response, create another reservation, extend deadline, or auto-issue a token. Reject retry of responded/expired/unavailable invitations with a fixed reason. Email failure does not immediately release the reservation; it remains visible and expires at the session start.

No additional acceptance/decline notification email is required: response page and Backoffice provide confirmation.

## 9. Backoffice experience

- Reuse both existing entry points and their shared selection/dialog/result components.
- Configured session says invitations reserve seats, require recipient acceptance, and close at session start.
- Show actual entitled, pending reserved, capacity, and remaining seats using server counts. UI estimates never replace transaction validation.
- Disable ineligible/already-invited/already-owned registrations with a visible reason. Include cross-registration ownership checks when userId exists.
- Before submitting, show selected recipients, effective deadline, and seat reservation count. Capacity failure preserves selection and refreshes availability.
- Result panel distinguishes added / invited / skipped. Show participation state and timestamp separately from email state and attempts.
- Registration Details displays pending/declined/expired invitations separately from actual accessible sessions. Existing access list contains entitlements only.
- Existing polling continues for pending/sending mail; response statuses refresh on opening the view and manual refresh. Do not add endless polling for invitations awaiting a human response.
- Preserve keyboard/focus handling, disabled explanations, selection across pages, and unknown retry acknowledgement.

## 10. Pris2026 response page

Create src/app/[locale]/sessions/confirm/page.tsx, using next-intl locales th/en and existing loading/submission patterns. The email initially targets th. Add translations for response/error states; names remain from API.

Read the token from the URL and send it only as the scoped API Authorization header. Preserve token through supported locale changes and refresh, but never store it as an application login token or in localStorage. Use a page-level referrer policy and prevent indexing/third-party token analytics. Do not put response-specific credentials into global auth helpers.

Display minimal recipient greeting, session name, Bangkok time range, room, deadline, and current state. Render two labeled buttons for accept/decline with a visible note that the submitted answer is final. Disable both during submission. Announce success/errors accessibly. A lost response triggers a safe re-read/retry rather than assuming the choice failed.

Support loading, pending, submitting, accepted, declined, expired, revoked/unavailable, missing/invalid token, network/server error, and rate-limit states. Recorded decisions show the result and no action buttons. Links to other pages do not propagate the token.

Exempt /sessions/confirm from GlobalRefreshRedirect after locale normalization. Verify direct email navigation, browser refresh, locale change, and mobile behavior. Existing registration-closed/REGISTRATION_OPEN gates must not prevent an invited recipient from responding.

Current supplied values are eventId 2/sessionId 5, room Impact Challenger Jupiter Room 11, start 2026-10-29 06:00:00 and end 10:00:00, intended as UTC (13:00–17:00 Bangkok per setup comments). Validate database driver serialization of timezone-less legacy session timestamps before using the deadline. New invitation timestamps use timestamptz; API returns unambiguous ISO instants.

## 11. Admin-only enforcement and compatibility

- Legacy POST /api/backoffice/registrations/:id/sessions rejects configured sessions with 409 SESSION_INVITATION_REQUIRED, directing callers to the existing grant endpoint; do not silently discard its ticketTypeId contract or convert purchases into grants.
- Manual-registration input or automatic session linking must not create direct access for configured sessions. Explicit bypass requests fail before any registration/payment-related mutation; require the separate invitation flow after registration exists.
- Verify target-session ticket_sessions/add-on configuration and public optional selections. Exclude configured sessions from public options and reject direct selections if reachable. Audit all registration_sessions writers, including settlement snapshots.
- The user says there is no purchase path for this session. Verify this using configuration and existing code/tests; do not modify unrelated payment logic. If legacy outstanding payment snapshots target it, report the conflict and preserve paid reconciliation; do not drop paid access or reclassify it silently.
- Standard check-in naturally denies pending invitations because no entitlement exists. Verify every scan mode (assigned, specific, all, picker) and preserve existing checks/metadata. Registration/session reports continue to list actual entitlements, with reservation statistics separately labeled.
- conference-web continues consuming actual entitlements after acceptance through existing readers. Do not add a new purchase interface or invitation UI there.
- Do not overwrite existing ticketTypeId/source/check-in metadata or change the registration's main ticket/status. Foreign-key/audit behavior must preserve invitation history and clear credentials when resources become unavailable.

## 12. Rollout and rollback

1. Run read-only preflight: target session configuration and UTC interpretation, actual count/duplicates, direct writers/callers, public ticket links, legacy queued grant emails, and any outstanding purchase references.
2. Deploy additive migration with flag default false, new table, invitedCount default zero, updated checks/indexes. No backfill turning existing entitlements into invitations.
3. Deploy backend and invitation-aware worker together while the target flag remains false; configure HTTPS frontend origin and encryption key without printing secrets.
4. Deploy Pris2026 page and updated Backoffice consumers; verify API CORS permits the existing frontend origin and Authorization header.
5. Complete tests and staging flow with fake email transport/test DB before enabling the target flag through the existing controlled deployment procedure. Enabling/configuration uses event/session codes and leaves maxCapacity intact.
6. Monitor reservation counts, expired rows, failed/unknown messages, and response errors using existing health/log facilities, with credentials redacted.

Rollback of new invitation creation must fail closed for configured sessions, not fall back to immediate grant or clear the flag while invitations are outstanding. ADMIN_SESSION_GRANTS_ENABLED may stop new grant/retry work under its current behavior; valid recipients' public response endpoints must remain available. Keep the compatible backend/worker, data, keys, and response page until outstanding invitations settle. Never downgrade to code that rejects invited rows or removes their checks while such data exists.

## 13. Acceptance verification

Use existing Node/tsx tests and guarded session-grants integration DB setup. Add focused invitation unit/route/integration tests and extend existing compatibility checks rather than introduce a new harness. Inspect applicable local verification instructions before running integration environments; no production mail or data writes for testing.

Required checks:

1. Admin-only creation; confirmed/same-event eligibility; numeric ID portability.
2. Target session creates invitation plus durable email job atomically and no entitlement, order, payment, or new regCode.
3. Opening/GET/prefetch never consumes a token; response API has no global-login side effect.
4. Accept gives exactly one entitlement with original regCode; decline gives none and releases the seat.
5. Same-decision replay is 200; opposite decision/concurrent tabs result in one recorded answer.
6. Capacity 50: concurrent Admin creates cannot exceed it; oversized batch rejects atomically; duplicates/invalid rows are not counted as new seats.
7. Re-invite declined/expired, duplicate registrations for a known user, and legacy exact-pair ownership do not create duplicate reservations/access.
8. Boundary serverNow = effective deadline is expired; new earlier start closes responses; later start does not extend links; inactive/cancelled registration invalidates response and releases reservations.
9. Pending rows past expiry do not count even with worker stopped; ciphertext cleanup/normalization is recoverable.
10. Fake mail transport verifies stable tokens across failed/unknown retry, acknowledgement, process restart, suppression, template separation, and no sensitive plaintext snapshots/logs.
11. Invalid/missing configuration fails atomically; encrypted payload tampering/decryption failure cannot produce a valid invitation email.
12. Legacy/manual/direct public writers cannot bypass the configured flow; unconfigured sessions retain existing behavior and readers.
13. All check-in modes deny pending and allow accepted subject to normal timing; invitation/entitlement/email counts and exports stay distinct.
14. Pris2026 direct navigation, refresh, locale change, missing/expired token, failed submission recovery, mobile layout, keyboard actions, and registration-closed state.
15. Existing entitlements and old queued grant emails still work; feature disable stops creation without invalidating outstanding response links.

## 14. File boundaries for the implementation plan

- conference-api: schema/new migration; session-grants service/types/schemas/routes/readers; focused invitation service/public routes; index route registration; existing email worker/template/runner; eligibility/capacity readers and reachable legacy/manual/public bypass guards; focused tests.
- conference-backoffice: src/types/session-grants.ts, API types, AddSessionDialog, SessionGrantResults, registrations list/details, relevant server response readers.
- Pris2026: new localized sessions/confirm page and messages; GlobalRefreshRedirect exemption; page security metadata/headers using current Next conventions; focused tests where non-trivial behavior is extracted.

Do not refactor unrelated components, build a general notification framework, add dependencies, or expand into payment redesign.

## 15. Review workflow

- [x] Explore repository context, existing design, recent commits, and relevant callers.
- [x] Discuss alternatives; user approved approach A.
- [x] Clarify response deadline; user selected session start.
- [x] Present architecture/flow and write this specification.
- [x] Self-review specification for incomplete requirements, contradictions, scope, and ambiguity.
- [x] Commit the reviewed specification to conference-api.
- [ ] User review of this written specification.
- [ ] Invoke writing-plans after written-spec approval, then produce the implementation plan.

No visual comparison question required a companion. Written-spec review precedes implementation under the explicitly requested brainstorming skill.
