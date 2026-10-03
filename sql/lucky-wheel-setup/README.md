# Lucky Wheel database setup

This directory contains reviewed, manual SQL support for PRIS2026 Lucky Wheel. It is not an automatic production migration path.

## Order and safety

1. Run `00_readiness.sql` read-only against the intended environment and review every result set.
2. Confirm exactly one intended PRIS2026 Main Session, inspect missing entitlement links, null `user_id` rows, and legacy check-ins. Do not repair anything implicitly.
3. Apply `drizzle/0033_pris_daily_attendance.sql` through the deployment process that owns manually numbered SQL migrations.
4. Do **not** use `db:push` as evidence that 0033 ran. The repository's Drizzle journal is older than the manually managed SQL sequence.
5. Verify schema state directly:
   - `pg_catalog.pg_class` / `to_regclass` shows `session_attendance_policies` and `session_daily_checkins`.
   - `pg_indexes` shows `session_daily_checkins_active_day_unique`, `session_daily_checkins_legacy_source_unique`, `session_daily_checkins_registration_history_idx`, and `session_daily_checkins_date_report_idx`.
   - `pg_constraint` shows the cancellation-consistency check and foreign keys.
6. Enabling daily attendance is a separate, audited operational step. Insert/update a policy only after the exact event/session IDs have been reviewed. The migration deliberately does not auto-enable every Main Session.
7. The legacy backfill belongs to the controlled cutover in Task 2. Do not copy legacy timestamps into daily history before the shared writer/cutover checks are ready.

## Local verification

Use only a dedicated test database whose database/schema name contains `test`, and keep it distinct from `DATABASE_URL`. The integration harness must retain the repository's destructive-test guard. Verify migration reruns, partial unique indexes, cancellation history, and original entitlement counts before marking the task complete.

No production data, credentials, event/session IDs, prize setup, or R2 values belong in this directory.


## Reviewed release runbook

Deployment remains a separate reviewed operation. The commands below are not authorization to run against production; the operator must first select the reviewed target, backup destination, event/session IDs, prize inventory, R2 configuration and collection deadline.

### 1. Readiness and backup

1. Export the intended deployment database URL through the deployment secret manager. Do not copy credentials into this repository or acceptance evidence.
2. Run the read-only inventory and save its output for review:
   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/lucky-wheel-setup/00_readiness.sql
   ```
3. Confirm exactly one intended PRIS event/Main Session pair, every confirmed registration that should participate has its existing entitlement, and every null user or legacy check-in is understood before mutation.
4. Take the deployment-owned PostgreSQL backup before schema/cutover work:
   ```sh
   pg_dump --format=custom --file="$BACKUP_FILE" "$DATABASE_URL"
   ```
   The operator must verify the backup artifact exists and is restorable under the deployment procedure before continuing.

### 2. Schema and daily-attendance cutover

Apply the reviewed numbered SQL through the deployment process that owns manually numbered migrations. Do not use `db:push` as migration evidence.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0033_pris_daily_attendance.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0034_lucky_wheel.sql
```

Re-run the readiness inventory and direct catalog checks for the tables, indexes, constraints and activation trigger before enabling policy. Deploy the shared daily-attendance writer before the legacy backfill, then run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/lucky-wheel-setup/01_backfill_daily_attendance.sql
```

The backfill prints conflicts and does not overwrite them. Any returned conflict must be reconciled explicitly before daily attendance is enabled for the reviewed PRIS event/Main Session pair.

### 3. Reconciliation before enablement

Before wheel enablement, record and review:

- confirmed entitlement count for the intended event/Main Session;
- active daily check-in duplicates: expected zero;
- Lucky Wheel duplicate account/event/day spins: expected zero;
- negative physical-prize stock: expected zero;
- imported legacy daily rows and any conflicts;
- current wheel version/pool revision and audit history.

Use the same invariant SQL recorded in the Task 12 acceptance evidence. Do not delete cancelled attendance, redemption corrections or audit history to make totals balance.

### 4. Admin operational setup

1. Verify the intended admin identities are active and event-scoped.
2. Configure the exact reviewed Main Session; do not create a second entitlement/session model for the wheel.
3. Configure real bilingual prize names and stock through the admin adjustment flow. Do not seed sample prizes.
4. Configure and verify the R2 bucket/public base/credentials through the deployment secret/config process; upload only wheel images and verify history retains referenced images.
5. Configure the real collection instructions and deadline.
6. Publish the reviewed configuration while the wheel remains paused.
7. Re-read the authoritative admin state and confirm configuration version, pool revision, stock and audit entries.

### 5. Controlled smoke activation

Keep the wheel paused until readiness, reconciliation, admin setup, staging/device checks and rollback ownership are confirmed. During the reviewed smoke window:

1. verify original PRIS login and original Main Session QR/check-in;
2. verify eligibility without allocating a prize;
3. unpause under an identified admin;
4. perform only the explicitly authorized smoke spin/collection flow;
5. verify history/proof, reward lookup, identity check and exactly-once handover;
6. recheck stock, duplicate-day and attendance invariants;
7. pause again if the activation window is not immediately continuing.

No local implementation command in this repository authorizes a live smoke allocation.

### 6. Incident pause and rollback

For an incident, pause the wheel first through the admin pause operation so existing attendance, spins, reward proofs, audit rows and redemption history remain queryable. Do not refund stock or daily rights automatically.

A code rollback must preserve both `session_daily_checkins` history and all Lucky Wheel allocation/redemption tables. Do not restore the old once-per-session scan semantics while a live event depends on daily attendance. Schema/data rollback or backup restore is a separate incident decision requiring explicit database-owner review; never drop the new history tables merely to roll back application code.

After any rollback or incident change, rerun readiness/catalog checks and the invariant queries before re-enabling the wheel.
