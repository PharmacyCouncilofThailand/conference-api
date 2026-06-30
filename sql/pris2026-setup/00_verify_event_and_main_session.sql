-- =============================================================================
-- ส่วนที่ 0: ตรวจสอบก่อนรัน (อ่านอย่างเดียว ไม่แก้ข้อมูล)
-- แก้ 'PRIS-2026' ถ้า event_code ใน DB ไม่ตรง
-- =============================================================================

SELECT
  e.id          AS event_id,
  e.event_code,
  e.event_name,
  e.status,
  e.start_date,
  e.end_date
FROM events e
WHERE e.event_code = 'PRIS-2026';

SELECT
  s.id            AS session_id,
  s.session_code,
  s.session_name,
  s.is_main_session,
  s.requires_opt_in,
  s.max_capacity,
  s.start_time,
  s.end_time
FROM sessions s
JOIN events e ON e.id = s.event_id
WHERE e.event_code = 'PRIS-2026'
ORDER BY s.is_main_session DESC, s.session_code;
