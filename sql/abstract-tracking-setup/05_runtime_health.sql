-- Operator/readiness snapshot. Read-only.
\set ON_ERROR_STOP on
SELECT current_user, current_database(), now() AS checked_at;
SELECT * FROM abstract_tracking_runtime WHERE singleton = true;
SELECT n.event_id, n.prefix, n.padding_width, n.locked_at,
       c.presentation_type, c.last_issued_number, c.updated_at
FROM abstract_tracking_namespaces n
JOIN abstract_tracking_counters c ON c.namespace_id = n.id
ORDER BY n.event_id, c.presentation_type;
