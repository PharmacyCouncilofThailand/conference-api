-- =============================================================================
-- ส่วนที่ 13: ตรวจสอบหลังรัน (อ่านอย่างเดียว)
-- =============================================================================

SELECT
  t.id,
  t.name,
  t.priority,
  t.price,
  t.allowed_roles,
  t.allowed_student_levels,
  t.sale_start_date,
  t.sale_end_date,
  t.is_active
FROM ticket_types t
JOIN events e ON e.id = t.event_id
WHERE e.event_code = 'PRIS-2026'
ORDER BY t.display_order NULLS LAST, t.id;

SELECT
  t.name AS ticket_name,
  s.session_code,
  s.session_name,
  s.is_main_session,
  s.requires_opt_in
FROM ticket_sessions ts
JOIN ticket_types t ON t.id = ts.ticket_type_id
JOIN sessions s ON s.id = ts.session_id
JOIN events e ON e.id = t.event_id
WHERE e.event_code = 'PRIS-2026'
ORDER BY t.name, s.session_code;

SELECT
  s.session_code,
  s.session_name,
  s.requires_opt_in,
  s.max_capacity
FROM sessions s
JOIN events e ON e.id = s.event_id
WHERE e.event_code = 'PRIS-2026'
  AND s.requires_opt_in = true
ORDER BY s.session_code;
