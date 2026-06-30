-- =============================================================================
-- ส่วนที่ 14: อัปเดตคำอธิบาย session opt-in (ถ้ารัน seed ไปแล้วก่อนปรับ copy)
-- =============================================================================

UPDATE sessions s
SET description = 'ต้องลงทะเบียนล่วงหน้าเพื่อเข้าร่วม (รับจำกัด 50 ที่)'
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'POLICY-INNOVATION';

UPDATE sessions s
SET description = 'ต้องลงทะเบียนล่วงหน้าเพื่อเข้าร่วม (รับจำกัด 300 ที่)'
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'PHARMACY-NETWORKING';
