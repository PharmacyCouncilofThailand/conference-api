-- Strictly read-only verification after 0028/online backfill.
\set ON_ERROR_STOP on

SELECT singleton, allocator_enabled, history_ready, legacy_bridge_enabled,
       abstract_writes_paused
FROM abstract_tracking_runtime
WHERE singleton = true;

SELECT n.event_id, n.prefix, n.padding_width, n.locked_at,
       c.presentation_type, c.last_issued_number,
       f.approved_floor,
       c.last_issued_number >= COALESCE(f.approved_floor, 0) AS floor_ok
FROM abstract_tracking_namespaces n
JOIN abstract_tracking_counters c ON c.namespace_id = n.id
LEFT JOIN abstract_tracking_approved_floors f
  ON f.event_id = n.event_id AND f.presentation_type = c.presentation_type
ORDER BY n.event_id, c.presentation_type;

SELECT count(*) AS existing_ids_without_history
FROM abstracts a
WHERE a.tracking_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM abstract_tracking_identifiers i
    WHERE i.tracking_id = a.tracking_id
  );

SELECT count(*) AS null_tracking_ids FROM abstracts WHERE tracking_id IS NULL;

SELECT tracking_id, count(*) AS duplicate_count
FROM abstracts
WHERE tracking_id IS NOT NULL
GROUP BY tracking_id
HAVING count(*) > 1;
