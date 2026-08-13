-- Bounded, restartable backfill for an expanded database. The current 0028
-- imports existing IDs atomically; this script is idempotent and applies any
-- reviewed floor rows added after expand. Every chunk holds the shared cutover
-- lock so the exclusive cutover cannot overlap a write.
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock_shared(20260813, 1);

UPDATE abstract_tracking_counters c
SET last_issued_number = GREATEST(
      c.last_issued_number,
      COALESCE((
        SELECT max(a.sequence_number)
        FROM abstract_tracking_allocations a
        JOIN abstract_tracking_namespaces n ON n.event_id = a.event_id
        WHERE a.event_id = n.event_id
          AND a.presentation_type = c.presentation_type
          AND c.namespace_id = n.id
          AND a.sequence_number IS NOT NULL
      ), 0),
      COALESCE((
        SELECT f.approved_floor
        FROM abstract_tracking_approved_floors f
        JOIN abstract_tracking_namespaces n ON n.event_id = f.event_id
        WHERE c.namespace_id = n.id AND f.presentation_type = c.presentation_type
      ), 0)
    ),
    updated_at = clock_timestamp()
WHERE EXISTS (SELECT 1 FROM abstract_tracking_namespaces n WHERE n.id = c.namespace_id);

UPDATE abstract_tracking_namespaces n
SET locked_at = COALESCE(n.locked_at, clock_timestamp()), updated_at = clock_timestamp()
WHERE EXISTS (
  SELECT 1 FROM abstract_tracking_counters c
  WHERE c.namespace_id = n.id AND c.last_issued_number > 0
);
COMMIT;
