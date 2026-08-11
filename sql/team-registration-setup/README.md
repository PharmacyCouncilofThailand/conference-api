# Team Registration Payment Retry Rollout

This runbook installs the safe-retry state model without treating a local
`cancelled` row as provider-side invalidation. An old Pay Solutions reference can
still settle: the first eligible verified settlement wins, and a later settlement
is retained as `duplicate_paid` for backoffice refund handling.

## Before deployment

1. Back up the database and confirm the API artifact contains both migrations and
   the compiled Team Registration worker.
2. Set `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=false`.
3. Run the read-only preflight once while the service is live to identify data
   repair work before scheduling the maintenance window.
4. In the Pay Solutions dashboard, verify the merchant/profile, production result
   URL, and postback URL
   `/api/v1/team-registrations/payment-providers/paysolutions/postback`. Confirm the
   configured Event result URL uses the approved HTTPS Event origin. In staging,
   prove that Inquiry Order finds a known reference with the configured
   `TEAM_REGISTRATION_PAY_SOLUTIONS_INQUIRY_PRODUCT_DETAIL` (default `QWERTY`).
5. Quiesce Team Registration writes and Pay Solutions postback handling, then stop
   the old Team Registration worker. Other application traffic may remain online
   only if it cannot write these tables.
6. Re-run the read-only preflight after the drain and require
   `migration_blocker_count = 0`:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f sql/team-registration-setup/01_preflight_payment_retry_safety.sql
   ```

7. Investigate every returned anomaly. Do not edit the preflight or bypass a
   migration exception to force deployment.

## Migration and deploy order

Apply the repository migrations through the normal one-time migration mechanism.
`0026_team_registration_payment_statuses.sql` must commit before
`0027_team_registration_payment_retry_safety.sql` starts; the second migration
uses the enum values added by the first.

Then:

1. Deploy the new API and worker artifact while safe retry remains off.
2. Start `npm run jobs:team-registrations:prod` as a continuously supervised,
   separately scalable process. A 60-second interval is the default. For the
   repository Docker image, set `SERVICE_ROLE=worker`; otherwise its healthcheck
   correctly assumes the API role and port 3002. The worker container check uses a
   30-second process-activity pulse with a three-minute expiry. It intentionally
   ignores operational `lastErrorCode` values so a provider/email failure alerts
   operators without restarting a live worker or interrupting a long batch.
3. Confirm `GET /health` reports `worker.teamRegistrations.status=healthy` and a
   recent `lastSucceededAt`.
4. In staging, verify same-key replay, fresh-key retry, first-payment winner,
   second-reference duplicate, provider refund, TTL final inquiry, and worker
   restart/lease recovery.
5. Set `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=true` and restart only the API
   processes that read environment variables. Keep the worker running.

Never run test-paid status handling in production.
`TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES=true` is honored only outside
`NODE_ENV=production`, but production should still leave it explicitly false.

The expected reconciliation cadence is active every five minutes plus the exact
TTL final inquiry, followed for locally terminal references at immediate,
15-minute, 2-hour, and 24-hour checkpoints. Postback audit storage is capped at 60
rows/reference/hour; postback-triggered inquiry has a 30-second cooldown and a
12/reference/hour cap. A worker heartbeat older than three minutes is `stale`.

## Duplicate-payment response

Backoffice can find registrations with unresolved money handling using
`paymentActionRequired=true`. For each item:

1. Confirm the immutable winner reference and the `duplicate_paid` reference; do
   not change the winner or fulfill the registration twice.
2. Refund the duplicate reference through the approved Pay Solutions/backoffice
   process. There is no automated refund call in this service.
3. Let authenticated inquiry observe the provider refund when possible. It changes
   the duplicate attempt to `refunded` and closes that action automatically.
4. If operational evidence must close the action manually, an admin may call
   `POST /api/backoffice/team-registrations/:registrationId/payment-attempts/:attemptId/resolve-action`
   with `resolution=refunded` (or `closed_no_fulfillment`) and an audit reason.
   This records workflow resolution only; it never rewrites provider facts.

## Rollback and incident controls

If retry behavior must be stopped, first set
`TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=false` and restart the API. This
restores the legacy active-attempt conflict while retaining winner, duplicate,
audit, and reconciliation safety. Do not roll back the enum/column migrations
while the new API or worker is running, and do not stop the worker while any old
or superseded reference remains scheduled.

If worker health is `stale`, keep safe retry off, inspect the worker's sanitized
error code and process logs, restore provider/database connectivity, and wait for
a fresh successful heartbeat before enabling retry. Database credentials and Pay
Solutions API/secret keys must never be placed in audit notes or support tickets.

`PAYMENT_PROFILE_ALREADY_ENABLED` means another Event still owns the same enabled
profile. Verify the intended Event, disable the old configuration, then enable the
new one; never remove the unique index or change an Event profile after attempts
exist.

After migration and after enabling retry, run these non-PII invariant checks. Every
count except `unresolved_actions` and normal scheduled work must remain zero:

```sql
SELECT count(*) AS multiple_winner_registrations
FROM (
  SELECT registration_id
  FROM team_registration_payment_attempts
  WHERE is_winner
  GROUP BY registration_id
  HAVING count(*) > 1
) AS anomaly;

SELECT count(*) AS multiple_active_registrations
FROM (
  SELECT registration_id
  FROM team_registration_payment_attempts
  WHERE status IN ('creating', 'pending')
  GROUP BY registration_id
  HAVING count(*) > 1
) AS anomaly;

SELECT count(*) AS paid_without_winner
FROM team_registrations AS registration
WHERE registration.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM team_registration_payment_attempts AS attempt
    WHERE attempt.registration_id = registration.id AND attempt.is_winner
  );

SELECT count(*) AS unresolved_actions
FROM team_registration_payment_attempts
WHERE action_required AND action_resolved_at IS NULL;
```

Configure alerts in the deployment/observability platform (the API does not send
administrator notifications itself) for worker `stale`, any heartbeat
`lastErrorCode`, reconciliation due-time lag over five minutes, and any new
unresolved payment action. A duplicate/action alert is the backoffice signal to
start the refund procedure above.
