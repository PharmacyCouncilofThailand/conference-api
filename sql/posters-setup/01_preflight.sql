-- Read-only preflight before manual migration 0038. Empty duplicate results expected.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT current_database(), current_schema(), current_setting('server_version') AS server_version;
SELECT id, event_code FROM events WHERE event_code = 'PRIS-2026';
SELECT name, to_regclass('public.' || name) AS prerequisite
FROM unnest(ARRAY['events','abstracts','users','backoffice_users','abstract_tracking_identifiers']) AS name;
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid = 'abstracts'::regclass;
-- Existing tracking migration 0029 must remain intact; never rebuild its history.
SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conname='abstracts_current_tracking_fk' AND conrelid='abstracts'::regclass;
SELECT indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND indexname='abstract_tracking_identifiers_current_unique';
SELECT event_id, tracking_id, count(*) FROM abstracts
WHERE event_id IN (SELECT id FROM events WHERE event_code='PRIS-2026')
GROUP BY event_id, tracking_id HAVING count(*) > 1;
-- A current ID and historical alias may refer to the same abstract; only multiple
-- distinct abstract matches are ambiguous. Source roster checks run in reconciliation.
WITH identifiers AS (
  SELECT event_id,tracking_id,id AS abstract_id FROM abstracts
  UNION
  SELECT event_id,tracking_id,abstract_id FROM abstract_tracking_identifiers
)
SELECT event_id,tracking_id,count(DISTINCT abstract_id) AS matches
FROM identifiers WHERE event_id IN (SELECT id FROM events WHERE event_code='PRIS-2026')
GROUP BY event_id,tracking_id HAVING count(DISTINCT abstract_id)>1;
SELECT name,to_regclass('public.' || name) AS existing_poster_table
FROM unnest(ARRAY['poster_settings','poster_targets','poster_announcements','poster_revision_requests',
  'poster_upload_attempts','poster_uploads','poster_operations','poster_email_jobs','poster_email_attempts','poster_audit_events']) AS name;
COMMIT;
