-- =============================================================================
-- ส่วนที่ 7: ตั๋ว Regular — ฿2,000
-- Role: pharmacist, medical_professional
-- ขาย: 1 Aug 2026 00:00 – 15 Oct 2026 23:59 (Bangkok) — เก็บเป็น UTC ใน DB
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
  'regular',
  'Regular',
  2000.00,
  'THB',
  '["pharmacist","medical_professional"]',
  NULL,
  0,
  0,
  TIMESTAMP '2026-07-31 17:00:00',  -- Bangkok 2026-08-01 00:00
  TIMESTAMP '2026-10-15 16:59:59',  -- Bangkok 23:59:59
  2000801,
  true,
  'Regular registration for pharmacists and medical professionals',
  '[]'::jsonb
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_types t
    WHERE t.event_id = e.id
      AND t.category = 'primary'
      AND t.priority = 'regular'
      AND t.name = 'Regular'
      AND t.allowed_roles = '["pharmacist","medical_professional"]'
  );
