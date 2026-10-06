-- Read-only verification after migration 0038 and after reconciliation.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
  IF (SELECT count(*) FROM poster_settings s JOIN events e ON e.id=s.event_id WHERE e.event_code='PRIS-2026')<>1 THEN
    RAISE EXCEPTION 'Expected exactly one PRIS-2026 poster settings row';
  END IF;
  IF EXISTS(SELECT 1 FROM poster_settings s JOIN events e ON e.id=s.event_id WHERE e.event_code='PRIS-2026' AND NOT s.reconcile_ready) THEN
    RAISE EXCEPTION 'Poster reconciliation is not ready';
  END IF;
  IF EXISTS(SELECT 1 FROM poster_targets GROUP BY event_id,abstract_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate target'; END IF;
  IF EXISTS(SELECT 1 FROM poster_revision_requests WHERE status='open' GROUP BY target_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate open request'; END IF;
  IF EXISTS(SELECT 1 FROM poster_uploads WHERE request_id IS NULL GROUP BY target_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate initial upload'; END IF;
  IF EXISTS(SELECT 1 FROM poster_targets t LEFT JOIN poster_uploads u ON u.id=t.current_upload_id AND u.target_id=t.id WHERE t.current_upload_id IS NOT NULL AND u.id IS NULL) THEN RAISE EXCEPTION 'Current file target mismatch'; END IF;
END $$;
SELECT name,to_regclass('public.' || name) AS poster_table
FROM unnest(ARRAY['poster_settings','poster_targets','poster_announcements','poster_revision_requests',
  'poster_upload_attempts','poster_uploads','poster_operations','poster_email_jobs','poster_email_attempts','poster_audit_events']) AS name;
SELECT conrelid::regclass AS table_name,conname,contype,convalidated,pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE connamespace='public'::regnamespace
  AND conrelid::regclass::text LIKE 'poster_%' ORDER BY 1,2;
SELECT indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND indexname LIKE 'poster_%' ORDER BY indexname;
SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
WHERE tgrelid='poster_revision_requests'::regclass AND NOT tgisinternal;
SELECT s.*,e.event_code FROM poster_settings s JOIN events e ON e.id=s.event_id;
SELECT e.id,e.event_code,count(t.id) AS targets,count(t.current_upload_id) AS current_uploads
FROM events e LEFT JOIN poster_targets t ON t.event_id=e.id
WHERE e.event_code='PRIS-2026' GROUP BY e.id,e.event_code;
SELECT event_id,match_state,present,count(*) FROM poster_announcements GROUP BY event_id,match_state,present;
SELECT source_row->>'round' AS round,source_row->>'presentationType' AS presentation_type,
  count(*) AS announcements,count(*) FILTER (WHERE source_row->>'trackingId' IS NOT NULL) AS with_tracking
FROM poster_announcements WHERE present GROUP BY 1,2 ORDER BY 1,2;
SELECT state,count(*) FROM poster_email_jobs GROUP BY state ORDER BY state;
SELECT target_id,count(*) FROM poster_revision_requests WHERE status='open' GROUP BY target_id HAVING count(*)>1;
SELECT t.id,t.current_upload_id FROM poster_targets t
LEFT JOIN poster_uploads u ON u.target_id=t.id AND u.id=t.current_upload_id
WHERE t.current_upload_id IS NOT NULL AND u.id IS NULL;
COMMIT;
