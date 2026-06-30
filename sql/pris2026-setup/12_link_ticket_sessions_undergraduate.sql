-- =============================================================================
-- ส่วนที่ 12: ผูก ticket_sessions — Undergraduate เท่านั้น
--
-- เข้าได้:
--   - Main Session (is_main_session = true)
--   - Health Hack
-- =============================================================================

INSERT INTO ticket_sessions (ticket_type_id, session_id)
SELECT t.id, s.id
FROM ticket_types t
JOIN events e ON e.id = t.event_id
JOIN sessions s ON s.event_id = e.id
WHERE e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.name = 'Undergraduate'
  AND (
    s.is_main_session = true
    OR s.session_code = 'HEALTH-HACK'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_sessions ts
    WHERE ts.ticket_type_id = t.id
      AND ts.session_id = s.id
  );
