# Team Registration Payment Retry Safety Design

**Date:** 2026-08-10

**Repository:** `conference-api`

**Status:** Approved through the preceding design discussion

## Problem

Team Registration creates a local Pay Solutions payment attempt before the browser posts the hosted-payment form. An attempt remains `pending` for the configured TTL, which is currently 30 minutes. If the team leader leaves the provider page and returns, a new `Idempotency-Key` is rejected with `409 PAYMENT_ATTEMPT_ACTIVE` until the old attempt expires.

Changing the old database row to `cancelled` is not sufficient on its own. The current Pay Solutions integration exposes redirect-form creation and authenticated inquiry, but no provider-side API that invalidates an unpaid hosted form or PromptPay QR. An old reference can therefore settle after a replacement reference is created. The current fulfillment flow does not elect an explicit winning attempt, cancel sibling attempts, detect a second settlement, or protect a paid state from stale reconciliation writes.

The payment audit also found related integrity risks:

- a `payment_pending` registration can be edited while an old price/category snapshot remains payable;
- payment inputs are read before the registration row is locked;
- failed or provider-cancelled inquiries remain locally `pending`;
- expiry does not perform a final inquiry and background reconciliation ignores expired attempts;
- draft expiry can release member email claims before payment reconciliation;
- postback replay can create unbounded events and provider inquiries;
- the production image starts only the API, while the worker command depends on the development-only `tsx` binary;
- payment status always reports the newest attempt, even when an older attempt paid;
- test-complete provider statuses are accepted without a production guard.

The official [Pay Solutions developer documentation](https://paysolutions.asia/developer/developer.html) documents the hosted redirect and Inquiry Order API. No public pre-settlement cancellation endpoint was found, so this design treats `cancelled` as a local supersession state and continues reconciling the reference.

## Goals

1. Let a team leader create a replacement payment immediately with a new `Idempotency-Key`.
2. Cancel the previous active attempt and create its replacement atomically.
3. Let the first eligible, provider-verified settlement win the registration.
4. Detect and surface every later settlement as a duplicate payment requiring backoffice action.
5. Prevent an attempt created for an old registration revision from paying a modified team automatically.
6. Make payment transitions monotonic under concurrent retries, edits, callbacks, jobs, and inquiries.
7. Reconcile payments at expiry and for a bounded period after local cancellation or expiry.
8. Keep member email claims until the associated payment reservation is safely finalized.
9. Bound postback replay, provider calls, and event growth without trusting postback payment status.
10. Make the reconciliation/email worker runnable and observable in the production image.
11. Preserve the existing public response fields where possible and keep changes isolated to Team Registration.

## Non-goals

- Invalidating an unpaid Pay Solutions form at the provider; the available integration has no confirmed API for this.
- Implementing automated Pay Solutions refunds or voids.
- Sending new Slack, email, or other external notifications to administrators.
- Changing the generic registration/payment flow in `src/routes/payments`.
- Changing Team Registration pricing rules or payment channel.
- Modifying the Team Registration frontend in another repository.
- Automatically unlocking or deleting a paid registration after a refund.

## Approved Business Rules

### Retry without editing the team

A fresh `Idempotency-Key` means a new logical payment attempt. The API locally cancels the active attempt with reason `superseded_by_retry` and creates the successor in the same transaction. It does not wait for a provider inquiry.

The cancelled reference remains reconcilable. If it becomes the first verified settlement while the registration revision and reservation remain valid, it wins the registration and all active siblings are cancelled. If another reference already won, the late settlement becomes `duplicate_paid` and requires backoffice action.

### Editing after a payment attempt

Every leader edit increments `team_registrations.revision`. Saving an edit atomically cancels active attempts with reason `registration_edited` before replacing the team data.

A later verified settlement whose revision snapshot differs from the current registration is recorded with `paid_at`, provider fields, `status=verification_required`, `review_reason=registration_revision_changed`, and `action_required=true`. It does not pay the edited registration automatically.

### Expired registration or released reservation

A verified payment can win automatically only while the registration is payable, its revision matches, and its member-email reservation is still held. A payment discovered after the registration expired or claims were released is recorded for manual review and never silently revives the team.

The first attempt in a payment session establishes an absolute `payment_reservation_expires_at`. A retry uses only the remaining time and never extends that deadline. A new session created before registration closes is capped at `registration_closes_at + payment_attempt_ttl_minutes`, so repeated retry/edit cycles cannot reserve a team indefinitely after closing.

The first attempt also establishes the session quote. A retry in that same session reuses its merchant, category, pricing-round, amount, currency, customer display, and product-detail snapshots even if the pricing round ends in the meantime; the current client merchant/profile must still match, and only the form action endpoint may refresh. It uses a new reference. Editing payable team data clears the session, so the next session uses the then-current authoritative price and display data.

### Refunds and voids

A fully snapshot-matching, authenticated provider refund sets the attempt to `refunded` and `refunded_at` to the authoritative inquiry completion time while preserving the original `paid_at`. `VO`/`VOIDED` before a verified settlement is treated as provider cancellation; after a verified settlement it is treated as a refund. Refunding a non-winning duplicate closes an open action with the `refunded` resolution. If an administrator already resolved it, the provider updates only the refund fact and never overwrites the stored resolution, note, actor audit, or resolution time. Refunding the winning payment keeps `is_winner=true`, keeps the registration locked, and surfaces `requiresAction`; it does not automatically release the team or its email claims.

## Architecture

The implementation keeps four focused boundaries:

1. **Payment command service** — owns create/retry commands, idempotency semantics, authoritative snapshots, and atomic local supersession.
2. **Payment state policy** — a pure module that classifies provider statuses and decides allowed monotonic transitions and settlement outcomes.
3. **Payment reconciliation service** — performs authenticated provider inquiry, then applies the result under database locks and elects a winner.
4. **Payment jobs and provider route** — claim due inquiries, finalize expiry, maintain worker health, and debounce public postbacks.

All flows that lock both entity types use the same order:

```text
team_registrations row
    -> relevant team_registration_payment_attempts rows
```

Provider network calls never run while database locks are held. The service reads the attempt to obtain its immutable inquiry reference, performs the inquiry, then opens a transaction, locks the registration first, locks/re-reads the attempt, and applies the result against current state.

## State Model

### Payment statuses

The existing enum remains and gains three values:

```text
creating
pending
paid
failed
expired
verification_required
cancelled
duplicate_paid
refunded
```

`cancelled` is local and does not assert provider cancellation. `duplicate_paid` means the provider verified real money after another attempt had already won. `verification_required` covers a verified payment that cannot safely fulfill the current registration, as well as snapshot mismatches.

The main allowed transitions are:

```text
creating -> pending | failed | cancelled | expired | verification_required
pending -> paid | failed | cancelled | expired | verification_required
failed | cancelled | expired -> paid | duplicate_paid | verification_required
verification_required -> paid | duplicate_paid | refunded
paid -> refunded
duplicate_paid -> refunded
```

Pending or failed inquiry results may update provider metadata but cannot revive `cancelled`, `failed`, or `expired`, and cannot downgrade `paid`, `duplicate_paid`, `refunded`, or an action-required verified settlement. A later, fully matching authenticated inquiry may resolve a non-settled, administratively unresolved `verification_required` attempt through the normal winner decision. Once `action_resolved_at` is set, another paid result is idempotent and cannot reopen the action or elect that attempt; only a later authenticated refund may move it to `refunded`. `is_winner` is immutable after it becomes true, including after a winning payment is refunded.

### Settlement outcomes

After a fully matching paid inquiry, the transaction chooses exactly one outcome:

- **Winner:** no winner exists, no different attempt has an unresolved action, attempt revision equals current revision, registration is payable, claims remain reserved, and the attempt's payment-session reservation is valid at settlement.
- **Duplicate:** a different winner already exists.
- **Review:** no winner exists, but the revision, registration state, reservation, or verified snapshot prevents automatic fulfillment.
- **Idempotent:** the same attempt already won or already has the same terminal settlement state.

The provider client preserves `paidAt` as a discriminated state: `absent`, `valid`, or `invalid`; it never collapses a present malformed value into absence. For winner election, `effective_settled_at` is the authenticated provider `paidAt` only when it is finite and within `attempt.created_at - 5 minutes <= paidAt <= inquiryCompletedAt + 5 minutes`; when `paidAt` is genuinely absent it is the time the authoritative inquiry started. A present invalid or out-of-range timestamp routes to `verification_required/provider_paid_at_invalid`. The attempt reservation is valid only when its `expires_at` equals the registration's current `payment_reservation_expires_at` and `effective_settled_at <= expires_at`. This lets a final inquiry started at the deadline finish safely, but prevents an impossible pre-form timestamp or an old payment session from automatically winning.

## Data Model

### `team_registration_configs`

Add a partial unique index on `payment_profile_code WHERE is_enabled=true`. The current credential set and provider dashboard return configuration are global per profile, so at most one event may be enabled for the same profile at a time.

### `team_registrations`

Add:

- `revision integer NOT NULL DEFAULT 1`
- `payment_reservation_expires_at timestamptz NULL`

`revision` increments for leader edits and pre-payment backoffice corrections that affect payable team data. `payment_reservation_expires_at` is the absolute, non-extendable deadline for the current payment session. The first attempt sets it to `min(now + TTL, registration_closes_at + TTL)`; retries retain it. It lets a team that started before closing use its remaining payment window without allowing indefinite extensions or early claim release.

### `team_registration_payment_attempts`

Add:

- `registration_revision_snapshot integer NOT NULL DEFAULT 0` for rollback/rolling-schema compatibility; every new state-aware application row must explicitly write the current revision
- `is_winner boolean NOT NULL DEFAULT false`
- `customer_email_snapshot varchar(255) NULL` for migration compatibility; required for every newly created attempt
- `customer_name_snapshot varchar(255) NULL` for migration compatibility; required for every newly created attempt
- `product_detail_snapshot varchar(255) NULL` for migration compatibility; required for every newly created attempt
- `form_action_url_snapshot varchar(1000) NULL` for migration compatibility; required for every newly created attempt
- `cancelled_at timestamptz NULL`
- `refunded_at timestamptz NULL`
- `cancellation_reason varchar(64) NULL`
- `superseded_by_attempt_id uuid NULL` self-reference with `ON DELETE SET NULL`
- `review_reason varchar(64) NULL`
- `action_required boolean NOT NULL DEFAULT false`
- `action_resolved_at timestamptz NULL`
- `action_resolution varchar(32) NULL`
- `action_resolution_note text NULL`
- `next_reconcile_at timestamptz NULL`
- `reconciliation_deadline_at timestamptz NULL`
- `inquiry_lease_until timestamptz NULL`
- `terminal_reconciliation_count integer NOT NULL DEFAULT 0`

Add a partial unique index on `registration_id WHERE is_winner = true`. Retain the existing partial unique index that permits only one `creating` or `pending` attempt per registration.

Add checks for `registration_revision_snapshot >= 0`, terminal count `0..4`, paired cancellation reason/time, `is_winner -> paid_at IS NOT NULL`, `refunded -> refunded_at IS NOT NULL`, no winner with `duplicate_paid`, and internally consistent open/resolved action fields. A previously cancelled attempt may later become paid, so cancellation audit fields are not tied exclusively to current `status=cancelled`.

Allowed cancellation reasons are `superseded_by_retry`, `registration_edited`, `sibling_paid`, `payment_review_required`, `provider_cancelled`, and `migration_safety`. The first local cancellation reason is immutable; a later provider-cancelled result updates provider fields without overwriting it. Allowed action resolutions are `refunded` and `closed_no_fulfillment`. Resolution changes the action workflow only; it never rewrites provider payment facts or elects a winner.

Stable review reasons are `duplicate_payment`, `other_payment_action_unresolved`, `registration_revision_changed`, `registration_not_payable`, `registration_expired`, `claims_released`, `payment_reservation_changed`, `payment_reservation_expired`, `provider_paid_at_invalid`, `reference_mismatch`, `merchant_mismatch`, `amount_mismatch`, `currency_mismatch`, `winner_refunded`, and `legacy_verification_required`. When several guards fail, choose the first applicable reason in this listed order after `duplicate_payment`; the stored comparison flags retain the remaining mismatch detail.

New attempts store the final validated/sanitized values actually sent in the redirect form, not unsanitized source strings. The redirect replay snapshots containing customer email, customer name, and product/team display text are operational PII, not financial facts. The existing privacy job clears those three nullable fields 90 days after the event ends when the attempt is terminal and has no unresolved action; reference, amount, currency, merchant, provider status, winner, and audit/action facts remain. `form_action_url_snapshot` may remain because it contains no customer data.

### `team_registration_payment_events`

Retain the unique provider-event-key index and add an index on `(reference_no, event_type, created_at)`. This supports both per-reference rolling-hour caps without scanning unrelated audit events.

### Worker heartbeat

Add `team_registration_job_state` keyed by `job_name`, with `last_started_at`, `last_succeeded_at`, `last_error_code`, and `updated_at`. `/health` reports the worker as `disabled` only when no Team Registration configuration is enabled and no registration/payment/email work remains; disabling an event never hides a worker that must reconcile existing attempts. Work remains when a registration is nonterminal, an attempt is active/leased/scheduled/action-required, an outbox row is unsent, or retention-managed member/payment snapshot data is not yet purged. Otherwise a missing heartbeat or one older than three minutes is `stale`, and a newer successful heartbeat is `healthy`. It does not restart the API merely because a separately deployed worker is stale.

## Shared Predicates and Definitions

The create service and status API use the same `canStartPayment` predicate. It is true only when:

- the current event configuration is enabled and a non-secret `paymentEnvironmentReady` input confirms that local credentials/URLs are valid and the configured profile/merchant match the local client;
- registration status is `ready_for_payment` or `payment_pending`;
- the validated team data is complete;
- no winner exists;
- no unresolved `action_required` attempt exists;
- all current member email claims are unreleased;
- any retained session selected for retry has profile/merchant snapshots matching the current locked configuration and validated local client;
- either an existing payment session has `payment_reservation_expires_at > now`, regardless of draft/event-close passage, or a new session has both `draft_expires_at > now` and `registration_closes_at > now`; and
- no `creating`/`pending` attempt exists, or `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=true` permits atomic supersession.

The predicate receives booleans/identifiers needed for these decisions, never credentials. At the exact boundaries, `draft_expires_at == now` cannot start a new session and `payment_reservation_expires_at == now` cannot retain one. An unexpired retained session remains payable after draft expiry or registration close because its absolute reservation already caps the approved grace window.

An active same-key replay is not a new logical attempt and therefore does not use the active-attempt/safe-retry branch of `canStartPayment`. It has a narrower shared replay check: ownership, active/unexpired attempt and matching session identity, plus the same enabled configuration and `paymentEnvironmentReady` profile/merchant safety. It cannot bypass a disabled or mismatched payment environment.

Every `action_required=true` row represents verified or conservatively possible money in this design, including quarantined legacy verification rows. Any unresolved action therefore makes `canRetry=false`; payment creation returns `409 PAYMENT_REVIEW_REQUIRED`. After an administrator resolves that action as `refunded` or `closed_no_fulfillment`, retry is allowed only if the remaining registration/window rules pass.

`payable team data` means category, team name, and every member field submitted through `replaceDraft` that affects identity, eligibility, contact, or the provider display snapshot. Any leader `replaceDraft` call increments revision once. A pre-payment backoffice change to team name or any member field also increments revision once and cancels active attempts.

`claims held` means every current member has one unreleased claim owned by this registration. `payment finalized` means no active attempt remains and every attempt at or beyond TTL has completed its final inquiry attempt or been placed on the explicit bounded terminal schedule. Registration expiry never releases claims while an unresolved verified-money action exists; such an action holds the registration for backoffice resolution.

## Create and Retry Flow

`POST /events/:eventCode/registrations/:registrationId/payment-attempts` keeps its current authentication and request shape.

1. Validate the key format, open a transaction, and lock the owned registration.
2. Lock/look up the same `(registration_id, idempotency_key)` before loading current pricing:
   - active and unexpired attempt: retain it as a replay candidate; after the configuration safety checks in step 3, return the same redirect response from its stored form snapshots even if its pricing round has since ended;
   - active attempt whose redirect TTL elapsed: make reconciliation due immediately and return the terminal-key response without expiring it inline; final inquiry/expiry remains the worker's responsibility, while a fresh key may start a new session only when both the draft and registration remain open under the shared predicate;
   - terminal attempt: return `409 IDEMPOTENCY_KEY_REUSED` with its safe status metadata;
   - no attempt: continue as a new logical attempt.
3. Lock the event configuration `FOR SHARE`, validate the local URLs/credentials, and re-check that it is enabled and matches the local payment profile/merchant before returning an active replay or creating a row. The backoffice configuration writer already locks this row `FOR UPDATE`, so the quote cannot combine fields from two configuration versions. Disabling the event stops the API from reissuing a stored form, although an already-open provider page still cannot be invalidated locally.
4. For a replay candidate, apply the shared replay check. For a new logical attempt, re-check the shared `canStartPayment` predicate, ownership, readiness, draft/session boundary, and absolute payment-session deadline using that locked configuration.
5. Count attempts actually created for this registration in the preceding ten minutes while the registration lock is held. Reject the eleventh new row; replaying the same key never consumes this limit.
6. Determine the attempt deadline/session kind:
   - existing unexpired payment session: retain its current absolute deadline;
   - no current session, unexpired draft, and registration still open: create a deadline capped at `registration_closes_at + TTL`;
   - otherwise reject with `REGISTRATION_EXPIRED`.
7. Resolve the quote:
   - existing session: reuse the highest attempt in that session whose revision/deadline match the current registration, require its merchant/profile to match the current validated client, and take only the current form action URL;
   - new session: load the current category, leader, pricing round, price, and form display values using the same transaction/configuration version.
8. Lock active attempts. When the safe-retry feature flag is false, preserve the legacy `PAYMENT_ATTEMPT_ACTIVE` response; when true, mark them `cancelled` with `superseded_by_retry` and `cancelled_at=now`.
9. Validate the complete redirect snapshot with the same pure builder used after commit, then insert the successor using the next attempt number, current revision, resolved quote/form snapshots, the retained/new absolute deadline, a new reference, and `status=pending`.
10. Link each predecessor to the successor, set registration status to `payment_pending`, retain/set `payment_reservation_expires_at`, and commit.
11. Construct the Pay Solutions redirect form deterministically only from the stored successor snapshots. Because the snapshot was validated before insert, rendering cannot create a committed-but-unreturnable attempt; if the HTTP response is lost, the same key replays it.

No provider network call occurs in this flow. The registration lock serializes concurrent keys; database uniqueness remains defense in depth. If successor insertion fails, the transaction rolls back and the previous attempt remains active.

## Edit Flow

`replaceDraft` and pre-payment backoffice corrections that affect payable data use a shared transaction helper:

1. Lock the registration.
2. Reject paid or expired registrations and reject payable-data edits with `PAYMENT_REVIEW_REQUIRED` while verified money has an unresolved action.
3. Lock and cancel active attempts with `registration_edited`.
4. Replace members and email claims.
5. Increment `revision` once for the logical edit.
6. Clear the payment reservation and set the registration to `ready_for_payment` or `draft` according to validation.

If reconciliation acquired the registration lock first and paid it, the edit observes `paid` and fails. If the edit commits first, reconciliation observes the new revision and routes the old settlement to review.

Audited backoffice corrections to an already paid team's display/member data do not increment the payable revision, do not alter immutable payment snapshots, and do not unlock payment creation. Pre-payment backoffice corrections obey the same unresolved-money edit block as leader edits.

## Provider Verification and Winner Election

The public postback remains untrusted. It normalizes a 12-digit reference, locates the attempt, and uses a 30-second database inquiry lease. Unknown references return an acknowledged/ignored response without inserting payment events.

For a known reference:

1. Normalize every event-key field with `trim()`; uppercase merchant/status/status-name/currency; normalize total to two decimals or `invalid`; use an empty string for a missing provider event ID/order; join `providerEventId`, reference, order, merchant, status, status name, total, and currency with Unicode unit separator `U+001F`; store `paysolutions:sha256:<hex SHA-256>` as `provider_event_key`.
2. In a short transaction, lock the attempt and cap newly stored `postback_received` events at 60 per reference in a rolling hour. Above the storage cap, insert at most one `postback_throttled` event per reference/UTC-hour using deterministic key `paysolutions:throttled:<reference>:<YYYYMMDDHH>` and do not store the varied payload; storage throttling does not by itself suppress the authoritative inquiry decision.
3. Insert the normalized event with `ON CONFLICT DO NOTHING`. Whether it inserts or is a duplicate, continue to the cooldown/hourly-cap decision. Event deduplication controls audit-row growth, not whether a later delivery may reveal a newly settled payment.
4. Enforce a per-reference postback inquiry cooldown of 30 seconds and a cap of 12 `postback_inquiry_started` events in a rolling hour, independent of event-key variation. When capped, acknowledge without pulling `next_reconcile_at` earlier; the existing five-minute/terminal worker schedule continues normally and cannot be used to bypass the postback cap.
5. Make `next_reconcile_at` due, acquire the 30-second inquiry lease, and record `postback_inquiry_started` in the same short transaction. If already leased, acknowledge without starting another request. Leaving the due timestamp in place lets the worker recover if the postback process crashes after commit.
6. Perform authenticated Pay Solutions inquiry outside a transaction.
7. Verify reference, merchant, amount, currency, and paid status against immutable snapshots.
8. Open a transaction, lock the registration first, then the attempt and siblings.
9. Re-evaluate current state and apply the state policy.

When an attempt wins, the same transaction:

- sets `status=paid`, `paid_at`, and `is_winner=true`;
- writes registration payment/category/pricing snapshots and locks the registration;
- cancels `creating` or `pending` siblings with `sibling_paid`;
- inserts confirmation-email outbox rows exactly once.

When another winner exists, the transaction sets `duplicate_paid`, `paid_at`, `action_required=true`, and `review_reason=duplicate_payment`. It never queues another confirmation email.

When verified or conservatively possible money requires review and no winner exists, the same transaction cancels every active sibling with `payment_review_required` and initializes their terminal schedules. A different attempt cannot become winner while that action remains unresolved; a later settlement on it is another review with `other_payment_action_unresolved`. This prevents a still-open replacement form from collecting another automatic payment during manual review.

Provider failures map an active attempt to `failed`; explicit provider cancellation maps an active attempt to `cancelled/provider_cancelled`. If the attempt was already locally cancelled, its original cancellation reason remains unchanged and only provider metadata is updated. Pending or unknown results update provider metadata only. Snapshot mismatch becomes `verification_required` and action-required when the provider indicates money was paid.

A paid/refund-classified inquiry with any reference, merchant, amount, or currency mismatch records an unresolved action and the primary stable mismatch reason. It keeps an existing `paid`, `duplicate_paid`, or `refunded` status monotonic; otherwise it uses `verification_required`. A non-money inquiry with a snapshot mismatch updates redacted metadata/comparison flags only and cannot fail, cancel, refund, or otherwise terminalize the local attempt because of the mismatch; normal reconciliation remains scheduled, and independently applicable TTL finalization may still expire it.

When an active attempt ends unpaid and has no active successor, one shared transition updates the registration:

- before the current payment-session deadline: `ready_for_payment`, retaining the deadline so retry uses only the remaining time;
- after that deadline but before registration closes: `ready_for_payment`, clearing the old deadline so the next attempt starts a new capped session;
- after registration closes/deadline with no unresolved verified-money action: `expired`, followed by claim release after finalization;
- with an unresolved verified-money action: remain held and return `PAYMENT_REVIEW_REQUIRED` until an administrator resolves it.

`TC`, `TEST COMPLETE`, and `TEST COMPLETED` count as paid only when `NODE_ENV` is not `production` and `TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES=true`. The flag defaults false, only the normalized literal `true` enables it, and production forces it false even if the environment variable is mistakenly set.

## Reconciliation and Expiry

The worker claims due attempts by updating `inquiry_lease_until` under `FOR UPDATE SKIP LOCKED`. Multiple worker instances may run without calling the provider concurrently for the same attempt.

Scheduling is bounded and deterministic:

- new/active `pending`: initialize `next_reconcile_at=min(now + 5 minutes, expires_at)`;
- after a still-pending inquiry: clear the lease and set the same five-minute rule;
- at TTL: claim and perform one final inquiry before local expiry;
- on transition to `cancelled`, `failed`, or `expired`: set terminal base time from `cancelled_at`, `failed_at`, or `expires_at`; set `terminal_reconciliation_count=0`, `reconciliation_deadline_at=base + 24 hours`, and `next_reconcile_at=now`;
- after the immediate terminal inquiry: count `1`, next at `base + 15 minutes`;
- after the 15-minute inquiry: count `2`, next at `base + 2 hours`;
- after the two-hour inquiry: count `3`, next at the 24-hour deadline;
- after the deadline inquiry: count `4`, clear `next_reconcile_at` and stop scheduled inquiry;
- provider success, non-success, and provider error all release `inquiry_lease_until` and advance the applicable schedule; a worker crash is recovered when the 30-second lease expires;
- after the deadline, any known-reference postback, including a duplicate event key, may still trigger inquiry subject to the per-reference cooldown/hourly cap.

The selectors are disjoint:

- a regular active candidate has `status=pending`, `next_reconcile_at <= now`, and `expires_at > now`;
- a final-expiry candidate has `status IN (creating, pending)`, `expires_at <= now`, and no live lease;
- a terminal-schedule candidate has `status IN (cancelled, failed, expired)`, `next_reconcile_at <= now`, and no live lease.

For an active attempt at `now == expires_at`, only the final-expiry selector is eligible. If a regular inquiry starts before TTL but completes at or after TTL, that result performs the final-expiry transition instead of scheduling `next_reconcile_at` back into the past. Every completed final inquiry leaves `creating`/`pending` through `paid`, `failed`, `cancelled`, `expired`, or `verification_required`; only a crash may cause the same phase to be reclaimed after the lease expires. These rules guarantee one provider call at the TTL boundary while retaining crash recovery.

If the final inquiry is unavailable, the attempt becomes locally `expired` so the user is not blocked and retains the bounded reconciliation schedule. A later settlement can win only if registration revision and reservation guards still pass. Otherwise it becomes action-required review.

The job order changes to:

```text
claim/reconcile due attempts
    -> perform final payment expiry inquiries
    -> finalize unpaid attempt states
    -> expire registrations and release claims
    -> process email outbox
    -> purge sensitive data
```

The privacy phase also applies the payment-form snapshot retention rule above and skips any attempt with an unresolved action.

Registration expiry skips a row whenever `payment_reservation_expires_at > now`, including the retry window after an unpaid attempt ended, and also skips any reservation that has not completed the finalization definition above. Claims are released only after the registration is safely expired, no winner exists, and no unresolved action records verified money. Resolving the action as `refunded` or `closed_no_fulfillment` re-evaluates the shared unpaid-registration transition: it returns to `ready_for_payment` only if the registration/window predicate permits, otherwise it expires and releases claims.

## API Contracts

### Create response

The existing fields remain. Add `attemptNumber` and `supersededPaymentAttemptId`:

```json
{
  "paymentAttemptId": "uuid",
  "attemptNumber": 2,
  "supersededPaymentAttemptId": "uuid-or-null",
  "referenceNo": "400000000002",
  "amount": "700.00",
  "currency": "THB",
  "expiresAt": "2026-08-10T12:30:00.000Z",
  "redirectForm": {
    "actionUrl": "https://payments.paysolutions.asia/payment",
    "method": "POST",
    "fields": {
      "merchantid": "TEAM12345",
      "refno": "400000000002",
      "customeremail": "leader@example.com",
      "customername": "Team Leader",
      "productdetail": "Category - Team Name",
      "total": "700.00",
      "cc": "00",
      "lang": "TH",
      "channel": "promptpay"
    }
  }
}
```

### Idempotency key reuse

```json
{
  "success": false,
  "requestId": "request-id",
  "error": {
    "code": "IDEMPOTENCY_KEY_REUSED",
    "message": "กรุณาเริ่มรายการชำระเงินใหม่",
    "paymentAttemptId": "uuid",
    "paymentStatus": "cancelled"
  }
}
```

### Payment status

The current top-level fields remain. `referenceNo`, `amount`, `currency`, and `paidAt` refer to the winner when a winner exists; otherwise they refer to the latest relevant attempt. Add:

```json
{
  "registrationId": "uuid",
  "registrationStatus": "paid",
  "paymentStatus": "paid",
  "referenceNo": "400000000001",
  "amount": "700.00",
  "currency": "THB",
  "paidAt": "2026-08-10T12:10:00.000Z",
  "refundedAt": null,
  "canRetry": false,
  "requiresAction": false,
  "unresolvedActionCount": 0,
  "reviewReason": null,
  "winnerPaymentAttemptId": "uuid",
  "latestPaymentAttemptId": "uuid"
}
```

Selection and aggregation are fixed:

- winner exists: top-level payment facts and `paymentStatus` come from the winner, including `refunded` for a refunded winner;
- no winner: facts come from the active attempt, otherwise the highest `attempt_number`;
- `latestPaymentAttemptId` always names the highest `attempt_number`, independent of winner;
- `requiresAction` is true when any attempt has unresolved `action_required=true`;
- `unresolvedActionCount` is the number of those attempts;
- `reviewReason` comes from the newest unresolved action by attempt number;
- `canRetry` is exactly the shared `canStartPayment` predicate, not merely `registrationStatus !== paid/expired`.

## Error Handling

- `IDEMPOTENCY_KEY_REQUIRED` — missing or malformed key.
- `IDEMPOTENCY_KEY_REUSED` — the same key names a terminal logical attempt or an active attempt whose redirect TTL has elapsed and is awaiting final reconciliation.
- `REGISTRATION_LOCKED` — the registration already has a winner.
- `REGISTRATION_EXPIRED` — the registration and reservation can no longer start a payment.
- `TEAM_REGISTRATION_DISABLED` — the event configuration is disabled; no stored form is reissued and no attempt is created.
- `PAYMENT_RETRY_RATE_LIMITED` — more than ten new attempts in ten minutes for the registration.
- `PAYMENT_REVIEW_REQUIRED` — payment creation is blocked because verified money has an unresolved action.
- `PAYMENT_ACTION_ALREADY_RESOLVED` — an administrator attempted a different second resolution.
- `PAYMENT_PROFILE_ALREADY_ENABLED` — another event already uses the same enabled merchant/profile return configuration.
- `PAYMENT_PROFILE_MISMATCH` — the event being enabled/charged does not match this deployment's local credential/profile identifier.
- `PAYMENT_PROFILE_IMMUTABLE` — an administrator attempted to change an event's profile code after its first payment attempt existed.
- `PAYMENT_MERCHANT_MISMATCH` — the local merchant ID differs from the attempt/session snapshot, so using the current credentials would query or charge the wrong merchant.
- `PAYMENT_PROVIDER_UNAVAILABLE` — a non-expiry inquiry could not produce an authoritative result; current payment state is preserved and retry is scheduled. At the TTL final-inquiry boundary, the attempt follows the explicit local-expiry rule above.

All constraint conflicts are mapped to stable Team Registration errors. Unexpected database/provider details remain server-side and responses retain `requestId`.

## Backoffice

List and detail responses expose:

- registration revision and payment reservation expiry;
- winner and latest-attempt identifiers;
- attempt revision, cancellation/refund times, cancellation reason, successor, provider status, and review reason;
- `actionRequired`, action resolution, and safe payment-event comparison flags.

Registration detail returns at most the newest 200 safe payment-event summaries plus `paymentEventCount`/`paymentEventsHasMore`; it never loads or returns an unbounded event history or `payload_redacted`. Older event inspection, if later needed, requires a separately paginated endpoint outside this change.

Add `paymentActionRequired` and the new payment statuses to backoffice filters. Readers may inspect actions. Only Team Registration admins may resolve an action through:

```text
POST /team-registrations/:registrationId/payment-attempts/:attemptId/resolve-action
```

The body requires `resolution` (`refunded` or `closed_no_fulfillment`) and a trimmed reason of 1–2,000 characters. It sets `action_required=false`, `action_resolved_at`, `action_resolution`, and the note, then re-evaluates the unpaid-registration transition and writes an audit log. A replay with the same resolution and normalized reason returns the stored resolution; any different second resolution or reason returns `409 PAYMENT_ACTION_ALREADY_RESOLVED`. Administrative resolution never changes attempt status, `paid_at`, amount, reference, winner election, or provider history. Only a later authenticated provider result may set status to `refunded`.

## Security and Provider Configuration

- Price, category, merchant, and currency come from server-side configuration and stored snapshots.
- Client-modified redirect fields cannot fulfill a registration unless authenticated inquiry matches every snapshot.
- Postback status is never trusted directly.
- Unknown references do not create database rows.
- Known-reference inquiries are leased for 30 seconds, identical provider events are deduplicated, stored postbacks are capped at 60 per reference/hour, and postback-triggered inquiries are capped at 12 per reference/hour.
- The payment-attempt route accepts no request body. The postback accepts at most 16 KiB of form/JSON data and persists only allowlisted, length-bounded normalized provider fields needed for event deduplication and inquiry triggering.
- Team access remains bound to event and normalized leader email.
- `TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE` is a local identifier for the credential/dashboard profile; it is not sent to Pay Solutions. It must equal the enabled event configuration's `paymentProfileCode` before payment creation.
- Enabling a Team Registration configuration also requires its profile code to match the local deployment profile; payment creation re-checks this as defense in depth.
- After an event has any payment attempt, its `paymentProfileCode` cannot be changed through backoffice. API/secret credentials may rotate within the same merchant profile, but the merchant ID/profile must not change while attempts require reconciliation.
- Every postback/worker inquiry entry point also compares the attempt profile and merchant snapshots with the local client before network I/O. A mismatch performs no provider call, follows the normal provider-error retry schedule, and surfaces a sanitized `PAYMENT_PROFILE_MISMATCH` or `PAYMENT_MERCHANT_MISMATCH` worker/error signal for operators.
- Only one event may be enabled for a payment profile. Enabling another returns a configuration conflict until the previous event is disabled, keeping the single provider-dashboard browser return URL unambiguous.
- `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED` defaults to `false` and only the trimmed, case-insensitive literal `true` enables it; missing/invalid values fail closed. While false, a fresh key still receives the legacy active-attempt conflict and `canRetry=false` when an active attempt exists; state/migration/worker code can be deployed and verified before atomic supersession is enabled.
- Test-paid statuses are disabled in production.
- The Pay Solutions client converts transport failures to a sanitized provider error before they reach route/worker logging. Logs, heartbeat errors, and events retain only allowlisted codes/reference/provider fields; Axios request config, headers, raw bodies, API keys, and secrets are never logged or persisted.
- Inquiry uses the existing 20-second timeout, refuses redirects, limits the response body to 64 KiB, and validates/normalizes only the first expected order row before reconciliation. This prevents credentials following a redirect and bounds a malformed provider response.
- Provider base/form URLs are parsed once, reject embedded user credentials, and require HTTPS in production. Plain HTTP is accepted only for loopback hosts outside production tests/development.
- Inquiry sends the provider-documented default product-detail search value `QWERTY`, configurable as `TEAM_REGISTRATION_PAY_SOLUTIONS_INQUIRY_PRODUCT_DETAIL` only when Pay Solutions gives profile-specific instructions. Staging must prove that a known reference is found with the configured value before enabling payment; the current hard-coded `TEAM_REGISTRATION` search value is removed.
- Provider dashboard configuration for the enabled event/profile must be verified to point postback to `/api/v1/team-registrations/payment-providers/paysolutions/postback` and its single browser return to that event's configured `paymentResultUrl`.

## Production Worker

Build output already contains the worker JavaScript. Add production scripts that run it with Node, for example:

```text
node dist/modules/team-registrations/jobs-runner.js
node dist/modules/team-registrations/jobs-runner.js --once
```

The production deployment runs this as a separate worker service. The API process does not start an uncoordinated in-process loop. Worker heartbeat is updated after each complete run. `/health` always returns HTTP 200 for API liveness, including when the nested Team Registration worker status is `stale`, so the Docker healthcheck does not restart a healthy API process. Alerts for stale heartbeat, provider error rate, action-required count, and reconciliation lag are operational deployment prerequisites documented by the repository; configuring the external alerting system is outside this repository.

## Migration Strategy

Do not modify `0024`, `0024a`, or `0025`.

1. Add one migration that only appends `cancelled`, `duplicate_paid`, and `refunded` to the PostgreSQL enum with `ADD VALUE IF NOT EXISTS`.
2. Add a following migration for columns, foreign keys, heartbeat table, checks, backfills, and indexes.
3. Preflight existing data before electing winners. The schema migration aborts unless every paid registration has exactly one paid attempt, every paid attempt belongs to a paid registration, no registration has multiple active attempts, and no payment profile has multiple enabled event configurations; operators repair anomalies before retrying the migration.
4. Mark the single paid attempt as winner with revision snapshot `1`. Backfill existing non-paid attempt revisions to `0`; locally cancel existing `creating/pending` attempts with `migration_safety` and place them on the terminal schedule. Conservatively set every legacy `verification_required` attempt to `action_required=true` with `legacy_verification_required`, because the old schema cannot prove whether its mismatch represented money. This forces any later legacy settlement into review rather than guessing whether the team was edited before revision tracking existed.
5. Backfill nullable form snapshots from current registration/category/member/config data for audit and replay diagnostics. New application rows require complete snapshots.
6. Make migrations tolerate both existing idempotency-index shapes introduced by `0024` and `0024a`.
7. Run the data preflight/backfill inside a brief Team Registration write-maintenance window: drain Team Registration API writes/provider handling and stop the old worker, re-run preflight, apply the migrations transactionally, deploy the state-aware API/worker with safe retry disabled, then reopen the routes. This prevents the old fulfillment code from inserting or settling an attempt between quarantine and deployment.
8. PostgreSQL enum values, additive columns, winner/action facts, and the state-aware reconciliation code remain during rollback.

## Testing

Implementation is delivered in three reviewable phases while the production retry flag remains off:

1. **Foundation:** state policy, enum/schema migration, legacy-data quarantine, atomic command code, revision safety, and winner election.
2. **Runtime safety:** postback limits, terminal reconciliation, expiry ordering, compiled worker, heartbeat, and backoffice action workflow.
3. **Enablement:** full concurrency/migration suite, provider-dashboard checks, staging smoke tests, documentation, and production feature-flag enablement.

### Unit tests

- provider paid/failed/cancelled/pending/refund classification;
- production gating of test statuses;
- allowed and forbidden monotonic transitions;
- winner, duplicate, and revision-review decisions;
- terminal reconciliation scheduling;
- shared `canStartPayment` decisions and absolute deadline retention;
- status-response winner selection.

### PostgreSQL integration tests

- same key returns the same active attempt;
- a fresh key atomically cancels A and creates B;
- repeated retries retain one absolute payment-session deadline;
- rollback leaves A active when B cannot be inserted;
- concurrent creates preserve one active attempt;
- edit versus reconciliation produces either a locked paid registration or a revision-review payment, never stale fulfillment;
- simultaneous paid inquiries elect one winner and one duplicate;
- stale non-paid inquiry cannot downgrade a terminal attempt;
- final expiry inquiry prevents paid claims from being released;
- unresolved verified-money action holds claims until resolution;
- multiple workers claim one inquiry once;
- migration backfill and invariants hold;
- legacy active attempts are safely cancelled/revision-quarantined and duplicate enabled profiles abort migration.

### Route tests

- event/email authorization isolation;
- active and terminal idempotency behavior;
- unknown and replayed postbacks are bounded;
- varied-payload replay cannot exceed the per-reference cooldown/hourly cap;
- forged postback `paid` status cannot fulfill without matching inquiry;
- amount, reference, merchant, and currency mismatches require review;
- backoffice readers can view but only admins can resolve actions;
- worker health reports healthy and stale heartbeats;
- incomplete drafts and unresolved verified-money actions report `canRetry=false` and reject creation consistently.

Use an isolated PostgreSQL database identified by `TEST_DATABASE_URL`; tests must never run against the development or production database.

## Rollout

1. Run an initial read-only preflight and back up the production database.
2. Enter the Team Registration write-maintenance window, stop the old worker, drain in-flight Team Registration requests, and re-run preflight.
3. Apply the enum and schema migrations with stop-on-error.
4. Deploy the state-aware API with test-paid statuses and safe retry disabled, then deploy the compiled worker and verify a fresh heartbeat.
5. Reopen Team Registration routes and confirm the team merchant profile, result URL, and postback URL in the provider dashboard.
6. Exercise staging flows for retry, provider failure, lost postback recovery, late cancelled settlement, revision mismatch, duplicate settlement, refund, and replay.
7. Set `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=true`, deploy/restart the API, and monitor duplicate/review queues, worker lag, and provider errors.

Rollback first sets `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=false`. Keep the state-aware reconciliation/API compatibility layer and additive schema in place; do not run the pre-change payment fulfillment code against winner/action data. If a full binary rollback is unavoidable, keep Team Registration payment/provider routes in maintenance and stop the worker until a state-aware build is restored. Recorded payment facts are never reversed by rollback.

## Success Criteria

- A fresh-key retry performs no provider network call and immediately returns a replacement attempt.
- The previous active attempt is `cancelled` when the replacement commits.
- Retry never extends the absolute payment-session deadline.
- A registration can have at most one winner at the database and service layers.
- A second real settlement is visible as `duplicate_paid` and cannot be silently ignored.
- An old-revision or released-reservation payment cannot fulfill the current team automatically.
- No stale callback or inquiry downgrades paid, duplicate, refunded, cancelled, or action-required settlement state.
- Failed or provider-cancelled attempts stop blocking retry immediately.
- Expiry performs a final inquiry before claims are released.
- Replayed postbacks produce bounded events and provider calls.
- `canRetry` and payment creation use one predicate and both block unresolved verified-money actions.
- The production worker runs compiled code and exposes a non-stale heartbeat.
- Tests cover state policy, API behavior, database concurrency, expiry, authorization, and deployment invariants.
