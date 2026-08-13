-- Enable the durable allocator only after the reviewed floors have been loaded
-- and the post-expand audit is clean. Run with MIGRATION_DATABASE_URL.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(20260813, 1);

DO $$
DECLARE
  missing_count bigint;
  floor_count bigint;
  series_count bigint;
BEGIN
  IF to_regclass('public.abstract_tracking_migration_batches') IS NULL THEN
    RAISE EXCEPTION 'manifest staging tables are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abstract_tracking_migration_batches WHERE frozen_at IS NOT NULL) THEN
    RAISE EXCEPTION 'no frozen reviewed tracking manifest exists';
  END IF;

  SELECT count(*) INTO series_count
  FROM abstract_tracking_namespaces n CROSS JOIN (VALUES ('oral'::presentation_type), ('poster'::presentation_type)) t(presentation_type);
  SELECT count(*) INTO floor_count FROM abstract_tracking_approved_floors;
  IF floor_count < series_count THEN
    RAISE EXCEPTION 'reviewed floor manifest must cover every namespace/type series';
  END IF;

  SELECT count(*) INTO missing_count
  FROM events e
  JOIN abstract_tracking_approved_floors f ON f.event_id = e.id
  LEFT JOIN abstract_tracking_namespaces n ON n.event_id = e.id
  LEFT JOIN abstract_tracking_counters c
    ON c.namespace_id = n.id AND c.presentation_type = f.presentation_type
  WHERE n.id IS NULL OR c.namespace_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'tracking namespace/counter is missing for reviewed floor series';
  END IF;
END
$$;

UPDATE abstract_tracking_counters c
SET last_issued_number = GREATEST(c.last_issued_number, f.approved_floor),
    updated_at = clock_timestamp()
FROM abstract_tracking_namespaces n
JOIN abstract_tracking_approved_floors f ON f.event_id = n.event_id
WHERE c.namespace_id = n.id
  AND c.presentation_type = f.presentation_type;

UPDATE abstract_tracking_namespaces n
SET locked_at = COALESCE(n.locked_at, clock_timestamp()), updated_at = clock_timestamp()
WHERE EXISTS (
  SELECT 1 FROM abstract_tracking_counters c
  WHERE c.namespace_id = n.id AND c.last_issued_number > 0
);

INSERT INTO abstract_tracking_audit_events (event_type, actor_type, reason_code, after_state)
VALUES ('abstract_tracking.cutover_completed', 'migration', 'allocator_enabled',
        jsonb_build_object('allocatorEnabled', true, 'historyReady', true));

UPDATE abstract_tracking_runtime
SET allocator_enabled = true,
    history_ready = true,
    legacy_bridge_enabled = false,
    abstract_writes_paused = false,
    write_pause_reason = NULL,
    updated_at = clock_timestamp()
WHERE singleton = true;

COMMIT;
