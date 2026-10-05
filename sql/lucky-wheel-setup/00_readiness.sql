-- Scoped, READ ONLY. Supply reviewed psql -v event_id=... -v main_session_id=...
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT set_config('pris.setup_event_id', :'event_id', true),
       set_config('pris.setup_main_session_id', :'main_session_id', true);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM events e JOIN sessions s ON s.event_id=e.id
    JOIN lucky_wheels w ON w.event_id=e.id AND w.main_session_id=s.id
    WHERE e.id=current_setting('pris.setup_event_id')::int
      AND s.id=current_setting('pris.setup_main_session_id')::int
      AND e.event_code='PRIS-2026' AND s.is_main_session AND s.is_active
      AND isfinite(s.start_time) AND isfinite(s.end_time) AND s.start_time<s.end_time
  ) THEN RAISE EXCEPTION 'Reviewed PRIS event/Main Session/wheel binding mismatch'; END IF;
END $$;

SELECT e.id AS event_id,e.event_code,s.id AS main_session_id,s.session_name,
       s.start_time,s.end_time,p.mode,p.enabled,w.paused,w.version,w.pool_revision
FROM events e JOIN sessions s ON s.event_id=e.id
JOIN lucky_wheels w ON w.event_id=e.id AND w.main_session_id=s.id
LEFT JOIN session_attendance_policies p ON p.event_id=e.id AND p.session_id=s.id
WHERE e.id=current_setting('pris.setup_event_id')::int
  AND s.id=current_setting('pris.setup_main_session_id')::int;

-- IDs only; no participant names, emails or ticket codes in generic logs.
SELECT r.id AS registration_id,r.user_id,rs.id AS registration_session_id,
       (rs.id IS NULL) AS missing_entitlement,(r.user_id IS NULL) AS unlinked_account
FROM registrations r LEFT JOIN registration_sessions rs ON rs.registration_id=r.id
  AND rs.session_id=current_setting('pris.setup_main_session_id')::int
WHERE r.event_id=current_setting('pris.setup_event_id')::int AND r.status='confirmed'
ORDER BY r.id;

-- Mirrors readiness.classifyLegacy precedence, including cancelled imported sources.
WITH source AS (
  SELECT rs.id,rs.checked_in_at,rs.checked_in_by,s.start_time,s.end_time,
    ((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date AS day,
    'registration_sessions:'||rs.id::text AS source_key
  FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id
  JOIN sessions s ON s.id=rs.session_id AND s.event_id=r.event_id
  WHERE r.event_id=current_setting('pris.setup_event_id')::int
    AND s.id=current_setting('pris.setup_main_session_id')::int AND rs.checked_in_at IS NOT NULL
)
SELECT source.id AS registration_session_id,source.day AS attendance_date,
  source.checked_in_at AT TIME ZONE 'UTC' AS checked_in_at,source.checked_in_by,
  CASE
    WHEN EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.legacy_source_key=source.source_key) THEN 'alreadyImported'
    WHEN NOT EXISTS (SELECT 1 FROM backoffice_users b WHERE b.id=source.checked_in_by) THEN 'LEGACY_SCANNER_MISSING'
    WHEN NOT isfinite(source.checked_in_at) OR source.checked_in_at<source.start_time OR source.checked_in_at>source.end_time THEN 'LEGACY_TIME_INVALID'
    WHEN EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.registration_session_id=source.id AND d.attendance_date=source.day AND d.cancelled_at IS NULL) THEN
      CASE WHEN EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.registration_session_id=source.id AND d.attendance_date=source.day AND d.cancelled_at IS NULL
        AND d.checked_in_at=(source.checked_in_at AT TIME ZONE 'UTC') AND d.checked_in_by=source.checked_in_by)
        THEN 'alreadyCovered' ELSE 'LEGACY_DAILY_CONFLICT' END
    WHEN EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.registration_session_id=source.id AND d.attendance_date=source.day AND d.cancelled_at IS NOT NULL) THEN 'CANCELLATION_CONFLICT'
    ELSE 'import'
  END AS classification
FROM source ORDER BY source.id;
COMMIT;
