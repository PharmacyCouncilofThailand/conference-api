-- =============================================================================
-- ส่วนที่ 3: Session — Policy Innovation Workshop (จำกัด 50 + ต้องติ๊กตอน checkout)
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
  'POLICY-INNOVATION',
  'Policy Innovation Workshop',
  'workshop',
  false,
  true,
  'ต้องลงทะเบียนล่วงหน้าเพื่อเข้าร่วม (รับจำกัด 50 ที่)',
  'Workshop Room A',
  TIMESTAMPTZ '2026-10-29 13:00:00+07',
  TIMESTAMPTZ '2026-10-29 17:00:00+07',
  50,
  true
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM sessions s
    WHERE s.event_id = e.id
      AND s.session_code = 'POLICY-INNOVATION'
  );
