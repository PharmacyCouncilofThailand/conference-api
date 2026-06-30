-- =============================================================================
-- ส่วนที่ 2: Session — Pharma zone
-- =============================================================================

INSERT INTO sessions (
  event_id,
  session_code,
  session_name,
  session_type,
  is_main_session,
  requires_opt_in,
  description,
  room,
  start_time,
  end_time,
  max_capacity,
  is_active
)
SELECT
  e.id,
  'PHARMA-ZONE',
  'Pharma zone',
  'lecture',
  false,
  false,
  NULL,
  'Pharma Zone',
  TIMESTAMPTZ '2026-10-28 09:00:00+07',
  TIMESTAMPTZ '2026-10-30 17:00:00+07',
  0,
  true
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM sessions s
    WHERE s.event_id = e.id
      AND s.session_code = 'PHARMA-ZONE'
  );
