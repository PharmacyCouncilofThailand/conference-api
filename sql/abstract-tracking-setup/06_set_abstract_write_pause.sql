-- Emergency submit/resubmit switch. Use the migrator connection:
--   psql "$MIGRATION_DATABASE_URL" -v pause=true -v pause_reason='incident' -f 06_set_abstract_write_pause.sql
-- The exclusive advisory lock makes the toggle race-safe with all Release-A
-- write transactions that acquire the shared lock before their DB work.
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(20260813, 1);

UPDATE abstract_tracking_runtime
SET abstract_writes_paused = :'pause'::boolean,
    write_pause_reason = CASE WHEN :'pause'::boolean THEN left(:'pause_reason', 64) ELSE NULL END,
    updated_at = clock_timestamp()
WHERE singleton = true;

INSERT INTO abstract_tracking_audit_events (event_type, actor_type, reason_code, after_state)
VALUES ('abstract_tracking.write_pause_changed', 'operator',
        CASE WHEN :'pause'::boolean THEN 'paused' ELSE 'resumed' END,
        jsonb_build_object('paused', :'pause'::boolean, 'reason', left(:'pause_reason', 64)));
COMMIT;
