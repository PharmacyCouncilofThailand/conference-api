-- =============================================================================
-- ส่วนที่ 5: Session — Pharmacy Networking (จำกัด 300 + ต้องติ๊กตอน checkout)
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
  'PHARMACY-NETWORKING',
  'Pharmacy Networking',
  'other',
  false,
  true,
  'ต้องลงทะเบียนล่วงหน้าเพื่อเข้าร่วม (รับจำกัด 300 ที่)',
  'Networking Hall',
  TIMESTAMPTZ '2026-10-30 18:00:00+07',
  TIMESTAMPTZ '2026-10-30 21:00:00+07',
  300,
  true
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM sessions s
    WHERE s.event_id = e.id
      AND s.session_code = 'PHARMACY-NETWORKING'
  );
