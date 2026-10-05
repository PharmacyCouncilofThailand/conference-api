# PRIS daily attendance and shared QR release runbook

These scripts inspect one reviewed event/Main Session; they do not grant tickets, enable policy or import attendance. `01_backfill_daily_attendance.sql` is retained as a **read-only** candidate/conflict report and includes the same scoped inventory as `00_readiness.sql`. The sole import/activation path is the authenticated, audited admin setup endpoint.

## Reviewed target and backup

1. Resolve DATABASE_URL from the selected environment's secret configuration. Record host/port/database only, never credentials. Local and Railway are separate targets; a successful Local run does not authorize Railway activation.
2. Review event code `PRIS-2026`, the original active Main Session, its finite valid times and the wheel's exact binding. Preserve existing ticket/QR/registration/entitlement IDs. Do not create replacement sessions/grants or pre-create attendance.
3. Take a full custom-format PostgreSQL backup and verify restore into an isolated, guarded test database before operational mutation. Use the database owner's supported pg_dump/pg_restore version. Keep backup artifacts private, outside Git.
4. Run with explicit reviewed IDs; omitted/invalid/mismatched IDs fail instead of broadening scope:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" -v main_session_id="$MAIN_SESSION_ID" -f sql/lucky-wheel-setup/00_readiness.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" -v main_session_id="$MAIN_SESSION_ID" -f sql/lucky-wheel-setup/01_backfill_daily_attendance.sql
```

Inspect missing confirmed entitlements, unlinked accounts and every legacy classification. These SQL reports do not replace the API's readiness fingerprint. No names/emails/ticket codes belong in generic acceptance logs.

## Schema and all-writer gate

Verify manually managed migrations **0033–0036** through the deployment owner's process; never use `db:push` or the older Drizzle journal as proof. These migrations do not automatically enable the daily policy.

- 0033: daily policy/history, active-day and legacy-source unique indexes, cancellation checks/FKs.
- 0034: wheel/segments/spins/audit, reward confirmations/corrections and activation guard.
- 0035: shared QR/day windows/credit claims, one account per QR, one allocation per spent credit; multiple spins per day allowed.
- 0036: initial prize quantities and optional collection deadline/instructions, event website URL based QR link.

Check actual `pg_class`, `pg_indexes`, `pg_constraint`, columns and trigger/function definitions against the numbered SQL. Verify **every** running scanner/undo/API writer uses the shared attendance cutover fence. Stop if an old instance or deployment version is unknown. Deploy/restart is separately reviewed; this runbook does not authorize push/deploy.

## Paused, reviewed admin setup

1. Keep the wheel paused; record original pause/configuration/pool/QR state. Pausing stops new claims/spins and preserves existing results/credits/stock.
2. Use a real active authenticated admin, select the existing bound Main Session and reload authoritative readiness. Resolve blockers explicitly; do not fabricate missing evidence or bypass login.
3. Submit `POST /api/backoffice/lucky-wheel/events/:eventId/attendance-setup` with `mainSessionId`, current `expectedReadinessRevision`, meaningful `reason` and a new UUID `idempotencyKey`.
4. An in-flight scanner may make setup wait then return `ATTENDANCE_SETUP_STALE`: no setup writes commit. Reload and review the new facts, then submit a new command/key. For uncertain response or BUSY, retry the **same exact command/key**; never manufacture a second operation before determining its outcome.
5. Setup atomically enables the explicit daily policy and imports only proven UTC legacy timestamps/scanners as their actual Asia/Bangkok dates. No other days are invented. Imported cancellations stay cancelled. Audit records actor/reason/counts/source digest/IDs.
6. Reload server state; verify setupComplete, exact import count/actor/time/audit, source preservation, unchanged original ticket/grant counts, no duplicate active attendance or legacy source. Setup never opens QR or unpauses automatically.

## Daily scanner, QR and participant flow

- Selected, assigned and check-all scans share daily rules only for the configured Main Session. Scanner shows server Thai date. Same-day duplicate returns the first active record/time; next-day scan creates that day's history. Workshops retain their original rules. Cancel one exact daily ID; preserve other days/history.
- Admin sets one Thai daily interval for **both** QR claims and spins, freely editable with actor/reason/old-new audit. Unspent non-revoked credits temporarily stop outside the current interval and resume when reopened in the same Thai day. Previous-day credits permanently expire.
- Create named closed QR batches; explicitly open only reviewed date/name/IDs after separate operational authorization. Multiple QR may stay open together; opening B never closes A. Download PNG links to PRIS via event website_url and never opens QR/grants credit. No fallback input code or screen projection flow.
- One logged-in confirmed account with original Main entitlement and today's active attendance receives one credit per QR. Re-scan/retry/concurrent requests return the original claim. At spin re-check attendance, interval, pause and actual stock; consume one distinct credit and allocate stock atomically. Paused/empty physical stock stops both new claims/spins without spending rights, even with unlimited no-prize segments.
- Publish real bilingual prizes with initial quantity once. Later use audited positive stock top-ups. Do not seed sample prizes. Verify wheel-image R2 separately. Stock is shared across days; nothing refills automatically.
- Keep reward QR/manual lookup, owner verification and exactly-once staff collection. Participant shows static pickup instruction; no mandatory hidden collection deadline. Collection does not cut stock again. Cancelled attendance never reverses committed spin/result/stock automatically.

For operational Local repair, import only the photographed incident's proven legacy history through setup. Leave current QR closed unless exact opening is explicitly authorized. Do not allocate a smoke prize or mutate a real participant's check-in merely to demonstrate a test.

## Verification and rollback

Use guarded isolated test databases, sequential destructive wheel suites then full-schema synthetic attendance suites, builds/lint and authenticated desktop/mobile browser checks. Do not reset operational data or change admin passwords to bypass access. Keep real device/LINE/camera/R2 checks explicitly NOT VERIFIED if unavailable.

Reconcile per selected event/session: active-day duplicates=0, duplicate legacy sources=0, duplicate account/QR claims=0, duplicate credit spends=0, negative stock=0; original sessions/tickets/entitlements and legacy timestamp/scanner unchanged; setup audit exactly once. Preserve allocation/redemption/history audit counts before/after setup. Account/event/day spin uniqueness is obsolete.

For an incident, pause wheel and close new QR claims through admin operations. Preserve schema/history/source/credits/spins/stock/confirmations/corrections. Never auto-refund, drop history, disable daily policy or restore an old single-session writer once live daily attendance depends on it. Schema restore/data rollback requires a separate reviewed database-owner incident decision. Reconcile and review readiness again before reopening.
