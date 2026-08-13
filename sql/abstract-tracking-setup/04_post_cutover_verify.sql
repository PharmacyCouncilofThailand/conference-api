-- Strictly read-only post-cutover invariant check.
\set ON_ERROR_STOP on

SELECT singleton, allocator_enabled, history_ready, legacy_bridge_enabled,
       abstract_writes_paused, updated_at
FROM abstract_tracking_runtime
WHERE singleton = true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM abstract_tracking_runtime WHERE singleton = true AND allocator_enabled AND history_ready) THEN
    RAISE EXCEPTION 'allocator is not ready';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abstract_tracking_counters c
    JOIN abstract_tracking_namespaces n ON n.id = c.namespace_id
    LEFT JOIN abstract_tracking_approved_floors f
      ON f.event_id = n.event_id AND f.presentation_type = c.presentation_type
    WHERE f.approved_floor IS NOT NULL AND c.last_issued_number < f.approved_floor
  ) THEN
    RAISE EXCEPTION 'counter is below approved floor';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abstract_tracking_namespaces n
    JOIN abstract_tracking_counters c ON c.namespace_id = n.id
    WHERE c.last_issued_number > 0 AND n.locked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'positive counter has an unlocked namespace';
  END IF;
END
$$;

SELECT a.id, a.tracking_id, a.presentation_type
FROM abstracts a
WHERE a.tracking_id IS NULL
   OR NOT EXISTS (
     SELECT 1 FROM abstract_tracking_identifiers i
     WHERE i.abstract_id = a.id AND i.tracking_id = a.tracking_id
   )
ORDER BY a.id;

SELECT tracking_id, count(*)
FROM abstracts
WHERE tracking_id IS NOT NULL
GROUP BY tracking_id
HAVING count(*) > 1;
