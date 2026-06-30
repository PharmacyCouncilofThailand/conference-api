-- =============================================================================
-- ส่วนที่ 9: ตั๋ว Postgraduate — ฿1,250
-- Role: student + level postgraduate
-- ขาย: 1 Jul 2026 10:00 – 30 Oct 2026 17:00 (UTC+7)
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
  'Postgraduate',
  1250.00,
  'THB',
  '["student"]',
  '["postgraduate"]',
  0,
  0,
  TIMESTAMPTZ '2026-07-01 10:00:00+07',
  TIMESTAMPTZ '2026-10-30 17:00:00+07',
  2000701,
  true,
  'Student postgraduate rate',
  '[]'::jsonb
FROM events e
WHERE e.event_code = 'PRIS-2026'
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_types t
    WHERE t.event_id = e.id
      AND t.category = 'primary'
      AND t.name = 'Postgraduate'
  );
