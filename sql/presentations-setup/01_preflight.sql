-- Read-only preflight before manual migration 0038. Empty duplicate results expected.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
  IF (SELECT count(*) FROM events WHERE event_code='PRIS-2026')<>1 THEN
    RAISE EXCEPTION 'Expected exactly one PRIS-2026 event';
  END IF;
  IF to_regclass('public.abstract_tracking_identifiers') IS NULL OR to_regclass('public.staff_event_assignments') IS NULL THEN
    RAISE EXCEPTION 'Tracking/Event-assignment prerequisite is missing';
  END IF;
  IF to_regclass('public.presentation_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'Poster schema already exists: verify applied migration, do not migrate blindly';
  END IF;
END $$;
SELECT current_database(), current_schema(), current_setting('server_version') AS server_version;
SELECT id, event_code FROM events WHERE event_code = 'PRIS-2026';
SELECT a.id,a.tracking_id,a.user_id,(u.id IS NOT NULL) AS owner_exists,
  (u.email IS NOT NULL AND btrim(u.email)<>'') AS email_present
FROM abstracts a JOIN events e ON e.id=a.event_id LEFT JOIN users u ON u.id=a.user_id
WHERE e.event_code='PRIS-2026' ORDER BY a.id;
SELECT name, to_regclass('public.' || name) AS prerequisite
FROM unnest(ARRAY['events','abstracts','users','backoffice_users','abstract_tracking_identifiers','staff_event_assignments']) AS name;
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
SELECT name,to_regclass('public.' || name) AS existing_presentation_table
FROM unnest(ARRAY['presentation_settings','presentation_targets','presentation_announcements','presentation_revision_requests',
  'presentation_upload_attempts','presentation_uploads','presentation_operations','presentation_email_jobs','presentation_email_attempts','presentation_audit_events']) AS name;
COMMIT;
