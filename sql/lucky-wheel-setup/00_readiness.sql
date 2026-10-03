-- PRIS2026 Lucky Wheel readiness inventory.
-- READ ONLY: this file must not repair, grant, backfill, or enable anything.

-- 1) Exact entitlement inventory required by the approved plan.
SELECT r.id, r.reg_code, r.user_id, s.id AS main_session_id,
       rs.id AS registration_session_id
FROM registrations r
JOIN events e ON e.id = r.event_id
JOIN sessions s ON s.event_id = e.id AND s.is_main_session = true
LEFT JOIN registration_sessions rs
  ON rs.registration_id = r.id AND rs.session_id = s.id
WHERE e.event_code = 'PRIS-2026'
  AND r.status = 'confirmed'
ORDER BY r.id, s.id;

-- 2) Main Sessions and whether an explicit daily-attendance policy exists/enabled.
SELECT e.id AS event_id, e.event_code, s.id AS session_id, s.session_code,
       s.session_name, s.start_time, s.end_time,
       p.id AS policy_id, p.mode, p.enabled
FROM events e
JOIN sessions s ON s.event_id = e.id AND s.is_main_session = true
LEFT JOIN session_attendance_policies p
  ON p.event_id = e.id AND p.session_id = s.id
WHERE e.event_code = 'PRIS-2026'
ORDER BY s.id;

-- 3) Confirmed registrations that cannot yet be mapped to one PRIS account.
SELECT r.id, r.reg_code, r.email, r.user_id
FROM registrations r
JOIN events e ON e.id = r.event_id
WHERE e.event_code = 'PRIS-2026'
  AND r.status = 'confirmed'
  AND r.user_id IS NULL
ORDER BY r.id;

-- 4) Existing legacy Main Session check-ins to review before controlled backfill.
SELECT r.id AS registration_id, r.reg_code,
       s.id AS main_session_id, rs.id AS registration_session_id,
       rs.checked_in_at, rs.checked_in_by
FROM registrations r
JOIN events e ON e.id = r.event_id
JOIN sessions s ON s.event_id = e.id AND s.is_main_session = true
JOIN registration_sessions rs
  ON rs.registration_id = r.id AND rs.session_id = s.id
WHERE e.event_code = 'PRIS-2026'
  AND rs.checked_in_at IS NOT NULL
ORDER BY rs.checked_in_at, rs.id;
