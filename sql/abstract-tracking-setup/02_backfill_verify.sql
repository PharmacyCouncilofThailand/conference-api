-- Read-only verification for the online backfill.
\set ON_ERROR_STOP on
SELECT count(*) AS abstracts_without_history
FROM abstracts a
WHERE a.tracking_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM abstract_tracking_identifiers i WHERE i.tracking_id = a.tracking_id);

SELECT n.event_id, c.presentation_type, c.last_issued_number,
       f.approved_floor,
       (c.last_issued_number >= COALESCE(f.approved_floor, 0)) AS floor_ok
FROM abstract_tracking_namespaces n
JOIN abstract_tracking_counters c ON c.namespace_id = n.id
LEFT JOIN abstract_tracking_approved_floors f
  ON f.event_id = n.event_id AND f.presentation_type = c.presentation_type
ORDER BY n.event_id, c.presentation_type;
