-- =============================================================================
-- ส่วนที่ 6: ตั๋ว Early Bird — ฿1,250
-- Role: pharmacist, medical_professional
-- ขาย: 1 Jul 2026 10:00 – 31 Jul 2026 23:59 (UTC+7)
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
  'early_bird',
  'Early Bird',
  1250.00,
  'THB',
  '["pharmacist","medical_professional"]',
  NULL,
  0,
  0,
  TIMESTAMPTZ '2026-07-01 10:00:00+07',
  TIMESTAMPTZ '2026-07-31 23:59:59+07',
  1000701,
  true,
  'Early Bird registration for pharmacists and medical professionals',
  '[]'::jsonb
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_types t
    WHERE t.event_id = e.id
      AND t.category = 'primary'
      AND t.priority = 'early_bird'
      AND t.name = 'Early Bird'
  );
