-- =============================================================================
-- ส่วนที่ 8: ตั๋ว Late / หน้างาน — ฿2,500
-- Role: pharmacist, medical_professional
-- ขาย: 16 Oct 2026 00:00 – 30 Oct 2026 17:00 (Bangkok) — เก็บเป็น UTC ใน DB
-- ต้องมี enum ticket_priority ค่า 'late' แล้ว (migration 0023)
-- =============================================================================

INSERT INTO ticket_types (
  event_id,
  category,
  priority,
  name,
  price,
  currency,
  allowed_roles,
  allowed_student_levels,
  quota,
  sold_count,
  sale_start_date,
  sale_end_date,
  display_order,
  is_active,
  description,
  features
)
SELECT
  e.id,
  'primary',
  'late',
  'Late / หน้างาน',
  2500.00,
  'THB',
  '["pharmacist","medical_professional"]',
  NULL,
  0,
  0,
  TIMESTAMP '2026-10-15 17:00:00',  -- Bangkok 2026-10-16 00:00
  TIMESTAMP '2026-10-30 10:00:00',  -- Bangkok 17:00
  4001016,
  true,
  'Late / on-site registration for pharmacists and medical professionals',
  '[]'::jsonb
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_types t
    WHERE t.event_id = e.id
      AND t.category = 'primary'
      AND t.priority = 'late'
      AND t.name = 'Late / หน้างาน'
  );
