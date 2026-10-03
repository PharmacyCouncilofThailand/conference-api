BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Controlled cutover fence: the shared writer must already be deployed before
-- this script is run. These locks keep the legacy source and new history stable
-- while conflicts are classified and copied.
LOCK TABLE registration_sessions IN SHARE MODE;
LOCK TABLE session_daily_checkins IN SHARE ROW EXCLUSIVE MODE;

-- Reconciliation report. Any row returned here is intentionally NOT overwritten.
WITH source AS (
  SELECT rs.id,
         ((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date AS attendance_date,
         rs.checked_in_at AT TIME ZONE 'UTC' AS checked_in_at,
         rs.checked_in_by,
         'registration_sessions:' || rs.id::text AS legacy_source_key
  FROM registration_sessions rs
  JOIN sessions s ON s.id = rs.session_id
  JOIN session_attendance_policies p
    ON p.session_id = s.id AND p.event_id = s.event_id
  WHERE p.mode = 'daily' AND rs.checked_in_at IS NOT NULL
)
SELECT
  source.id AS registration_session_id,
  source.attendance_date,
  source.checked_in_at,
  source.checked_in_by,
  source.legacy_source_key,
  active.id AS conflicting_attendance_id,
  active.checked_in_at AS conflicting_checked_in_at
FROM source
LEFT JOIN session_daily_checkins imported
  ON imported.legacy_source_key = source.legacy_source_key
LEFT JOIN session_daily_checkins active
  ON active.registration_session_id = source.id
 AND active.attendance_date = source.attendance_date
 AND active.cancelled_at IS NULL
WHERE imported.id IS NULL
  AND active.id IS NOT NULL
ORDER BY source.id;

WITH source AS (
  SELECT rs.id,
         ((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date AS attendance_date,
         rs.checked_in_at AT TIME ZONE 'UTC' AS checked_in_at,
         rs.checked_in_by,
         'registration_sessions:' || rs.id::text AS legacy_source_key
  FROM registration_sessions rs
  JOIN sessions s ON s.id = rs.session_id
  JOIN session_attendance_policies p
    ON p.session_id = s.id AND p.event_id = s.event_id
  WHERE p.mode = 'daily' AND rs.checked_in_at IS NOT NULL
)
INSERT INTO session_daily_checkins (
  id,
  registration_session_id,
  attendance_date,
  checked_in_at,
  checked_in_by,
  legacy_source_key
)
SELECT
  gen_random_uuid(),
  source.id,
  source.attendance_date,
  source.checked_in_at,
  source.checked_in_by,
  source.legacy_source_key
FROM source
WHERE NOT EXISTS (
  SELECT 1
  FROM session_daily_checkins imported
  WHERE imported.legacy_source_key = source.legacy_source_key
)
AND NOT EXISTS (
  SELECT 1
  FROM session_daily_checkins active
  WHERE active.registration_session_id = source.id
    AND active.attendance_date = source.attendance_date
    AND active.cancelled_at IS NULL
)
ON CONFLICT (legacy_source_key)
  WHERE legacy_source_key IS NOT NULL
DO NOTHING;

COMMIT;
