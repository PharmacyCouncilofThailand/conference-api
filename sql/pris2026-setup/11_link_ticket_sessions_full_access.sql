-- =============================================================================
-- ส่วนที่ 11: ผูก ticket_sessions — Early Bird / Regular / Late / Postgraduate
--
-- เข้าอัตโนมัติ:
--   - Main Session (is_main_session = true) — มีอยู่แล้ว
--   - Main Stage, Pharma zone, Health Hack
--
-- ไม่ผูก (ต้องติ๊กตอน checkout):
--   - Policy Innovation Workshop
--   - Pharmacy Networking
-- =============================================================================

INSERT INTO ticket_sessions (ticket_type_id, session_id)
SELECT t.id, s.id
FROM ticket_types t
JOIN events e ON e.id = t.event_id
JOIN sessions s ON s.event_id = e.id
WHERE e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.name IN ('Early Bird', 'Regular', 'Late / หน้างาน', 'Postgraduate')
  AND (
    s.is_main_session = true
    OR s.session_code IN ('MAIN-STAGE', 'PHARMA-ZONE', 'HEALTH-HACK')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_sessions ts
    WHERE ts.ticket_type_id = t.id
      AND ts.session_id = s.id
  );
