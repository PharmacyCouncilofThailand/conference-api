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
