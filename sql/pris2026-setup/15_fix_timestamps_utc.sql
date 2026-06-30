-- =============================================================================
-- ส่วนที่ 15: แก้เวลา session / ตั๋ว PRIS-2026 ให้เป็น UTC
--
-- ใช้เมื่อรัน seed ไฟล์ 01–10 แบบ TIMESTAMPTZ '+07' แล้วค่าใน DB ไม่ตรง UTC
-- (คอลัมน์เป็น timestamp without time zone — เก็บ UTC แล้วให้หน้าเว็บ +7)
--
-- ไม่แก้ PRIS-2026-MAIN (main session) ที่สร้างจาก backoffice อยู่แล้ว
-- รันซ้ำได้ — ตั้งค่าเป้าหมายเดิมทุกครั้ง
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sessions (01–05)
-- -----------------------------------------------------------------------------

UPDATE sessions s
SET
  start_time = TIMESTAMP '2026-10-28 02:00:00',  -- Bangkok 09:00
  end_time   = TIMESTAMP '2026-10-30 10:00:00',  -- Bangkok 17:00
  updated_at = NOW()
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'MAIN-STAGE';

UPDATE sessions s
SET
  start_time = TIMESTAMP '2026-10-28 02:00:00',
  end_time   = TIMESTAMP '2026-10-30 10:00:00',
  updated_at = NOW()
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'PHARMA-ZONE';

UPDATE sessions s
SET
  start_time = TIMESTAMP '2026-10-29 06:00:00',  -- Bangkok 13:00
  end_time   = TIMESTAMP '2026-10-29 10:00:00',  -- Bangkok 17:00
  updated_at = NOW()
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'POLICY-INNOVATION';

UPDATE sessions s
SET
  start_time = TIMESTAMP '2026-10-29 02:00:00',  -- Bangkok 09:00
  end_time   = TIMESTAMP '2026-10-29 05:00:00',  -- Bangkok 12:00
  updated_at = NOW()
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'HEALTH-HACK';

UPDATE sessions s
SET
  start_time = TIMESTAMP '2026-10-30 11:00:00',  -- Bangkok 18:00
  end_time   = TIMESTAMP '2026-10-30 14:00:00',  -- Bangkok 21:00
  updated_at = NOW()
FROM events e
WHERE s.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND s.session_code = 'PHARMACY-NETWORKING';

-- -----------------------------------------------------------------------------
-- Tickets (06–10)
-- -----------------------------------------------------------------------------

UPDATE ticket_types t
SET
  sale_start_date = TIMESTAMP '2026-07-01 03:00:00',  -- Bangkok 10:00
  sale_end_date   = TIMESTAMP '2026-07-31 16:59:59'  -- Bangkok 23:59:59
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'early_bird'
  AND t.name = 'Early Bird';

UPDATE ticket_types t
SET
  sale_start_date = TIMESTAMP '2026-07-31 17:00:00',  -- Bangkok 2026-08-01 00:00
  sale_end_date   = TIMESTAMP '2026-10-15 16:59:59'  -- Bangkok 23:59:59
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'regular'
  AND t.name = 'Regular'
  AND t.allowed_roles = '["pharmacist","medical_professional"]';

UPDATE ticket_types t
SET
  sale_start_date = TIMESTAMP '2026-10-15 17:00:00',  -- Bangkok 2026-10-16 00:00
  sale_end_date   = TIMESTAMP '2026-10-30 10:00:00'  -- Bangkok 17:00
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'late'
  AND t.name = 'Late / หน้างาน';

UPDATE ticket_types t
SET
  sale_start_date = TIMESTAMP '2026-07-01 03:00:00',
  sale_end_date   = TIMESTAMP '2026-10-30 10:00:00'
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.name = 'Postgraduate';

UPDATE ticket_types t
SET
  sale_start_date = TIMESTAMP '2026-07-01 03:00:00',
  sale_end_date   = TIMESTAMP '2026-10-30 10:00:00'
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.name = 'Undergraduate';

-- -----------------------------------------------------------------------------
-- ตรวจหลังแก้ (อ่านอย่างเดียว)
-- -----------------------------------------------------------------------------

SELECT
  s.session_code,
  s.start_time,
  s.end_time
FROM sessions s
JOIN events e ON e.id = s.event_id
WHERE e.event_code = 'PRIS-2026'
  AND s.session_code IN (
    'MAIN-STAGE',
    'PHARMA-ZONE',
    'POLICY-INNOVATION',
    'HEALTH-HACK',
    'PHARMACY-NETWORKING'
  )
ORDER BY s.session_code;

SELECT
  t.name,
  t.priority,
  t.sale_start_date,
  t.sale_end_date
FROM ticket_types t
JOIN events e ON e.id = t.event_id
WHERE e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
ORDER BY t.display_order NULLS LAST, t.id;
