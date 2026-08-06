\if :{?event_code}
\else
\echo 'Required: psql -v event_code=YOUR_EVENT_CODE -f sql/team-registration-setup/00_configure_event.sql'
\quit
\endif

WITH selected_event AS (
  SELECT id FROM events WHERE event_code = :'event_code'
), upsert_config AS (
  INSERT INTO team_registration_configs (
    event_id, is_enabled, timezone, registration_opens_at, registration_closes_at,
    min_members, max_members, min_age, max_age, draft_ttl_hours,
    payment_attempt_ttl_minutes, payment_profile_code, event_website_origin,
    payment_result_url
  )
  SELECT id, false, 'Asia/Bangkok',
    '2026-08-14 17:00:00+00'::timestamptz,
    '2026-09-20 17:00:00+00'::timestamptz,
    3, 5, 15, 30, 72, 30, 'team_registration_default',
    'https://team-event.example.com',
    'https://team-event.example.com/payment/result'
  FROM selected_event
  ON CONFLICT (event_id) DO UPDATE SET updated_at = now()
  RETURNING id
)
INSERT INTO team_registration_categories (config_id, code, display_name, education_level, pharmacy_rule, display_order)
SELECT id, code, display_name, education_level, pharmacy_rule, display_order
FROM upsert_config
CROSS JOIN (VALUES
  ('higher_education_pharmacy', 'ระดับอุดมศึกษา — ทีมที่มีนักศึกษาเภสัชศาสตร์', 'higher_education', 'required', 1),
  ('higher_education_general', 'ระดับอุดมศึกษา — ทีมทั่วไป', 'higher_education', 'forbidden', 2),
  ('upper_secondary', 'ระดับมัธยมศึกษาตอนปลาย', 'upper_secondary', 'forbidden', 3)
) AS category(code, display_name, education_level, pharmacy_rule, display_order)
ON CONFLICT (config_id, code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  education_level = EXCLUDED.education_level,
  pharmacy_rule = EXCLUDED.pharmacy_rule,
  display_order = EXCLUDED.display_order,
  is_active = true,
  updated_at = now();

WITH config AS (
  SELECT c.id FROM team_registration_configs c JOIN events e ON e.id = c.event_id WHERE e.event_code = :'event_code'
)
INSERT INTO team_registration_pricing_rounds (config_id, code, display_name, starts_at, ends_at)
SELECT id, code, display_name, starts_at, ends_at
FROM config
CROSS JOIN (VALUES
  ('early_bird', 'Early Bird', '2026-08-14 17:00:00+00'::timestamptz, '2026-08-30 17:00:00+00'::timestamptz),
  ('regular', 'Regular', '2026-08-31 17:00:00+00'::timestamptz, '2026-09-20 17:00:00+00'::timestamptz)
) AS round(code, display_name, starts_at, ends_at)
ON CONFLICT (config_id, code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  is_active = true,
  updated_at = now();

WITH config AS (
  SELECT c.id FROM team_registration_configs c JOIN events e ON e.id = c.event_id WHERE e.event_code = :'event_code'
), matrix(round_code, category_code, amount) AS (
  VALUES
    ('early_bird', 'higher_education_pharmacy', 700.00::numeric),
    ('early_bird', 'higher_education_general', 750.00::numeric),
    ('early_bird', 'upper_secondary', 750.00::numeric),
    ('regular', 'higher_education_pharmacy', 800.00::numeric),
    ('regular', 'higher_education_general', 850.00::numeric),
    ('regular', 'upper_secondary', 850.00::numeric)
)
INSERT INTO team_registration_prices (pricing_round_id, category_id, amount, currency)
SELECT r.id, c.id, m.amount, 'THB'
FROM matrix m
JOIN config cfg ON true
JOIN team_registration_pricing_rounds r ON r.config_id = cfg.id AND r.code = m.round_code
JOIN team_registration_categories c ON c.config_id = cfg.id AND c.code = m.category_code
ON CONFLICT (pricing_round_id, category_id) DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, updated_at = now();
