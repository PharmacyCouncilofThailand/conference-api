-- =============================================================================
-- PRIS 2026 Round 2 corrective update
--
-- Stored timestamps use UTC values in timestamp-without-time-zone columns.
-- Bangkok references:
--   2026-08-31 17:00:00 UTC = 2026-09-01 00:00:00 Asia/Bangkok
--   2026-09-15 16:59:59.999 UTC = 2026-09-15 23:59:59.999 Asia/Bangkok
--   2026-09-20 16:59:59.999 UTC = 2026-09-20 23:59:59.999 Asia/Bangkok
--
-- Scope:
--   * Extend Early Bird row through 15 Sep 2026 Bangkok.
--   * Make Regular THB 2,500 from 1 Sep through event end.
--   * Disable Late row without deleting it.
--   * Extend abstract submission through 20 Sep 2026 Bangkok.
--   * Do not change Postgraduate/Undergraduate ticket rows.
-- =============================================================================

BEGIN;

UPDATE ticket_types AS t
SET sale_end_date = TIMESTAMP '2026-09-15 16:59:59.999'
FROM events AS e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'early_bird'
  AND t.currency = 'THB'
  AND t.name = 'Early Bird';

UPDATE ticket_types AS t
SET price = 2500.00,
    sale_start_date = TIMESTAMP '2026-08-31 17:00:00',
    sale_end_date = e.end_date,
    is_active = true
FROM events AS e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'regular'
  AND t.currency = 'THB'
  AND t.name = 'Regular';

UPDATE ticket_types AS t
SET is_active = false
FROM events AS e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'late'
  AND t.currency = 'THB';

UPDATE events
SET abstract_end_date = TIMESTAMP '2026-09-20 16:59:59.999',
    updated_at = NOW()
WHERE event_code = 'PRIS-2026';

COMMIT;

-- Verification: event dates
SELECT
  e.event_code,
  e.end_date,
  e.abstract_start_date,
  e.abstract_end_date
FROM events AS e
WHERE e.event_code = 'PRIS-2026';

-- Verification: all primary tickets, including student rows that this script must not modify
SELECT
  t.id,
  t.name,
  t.priority,
  t.price,
  t.currency,
  t.allowed_roles,
  t.allowed_student_levels,
  t.sale_start_date,
  t.sale_end_date,
  t.is_active
FROM ticket_types AS t
JOIN events AS e ON e.id = t.event_id
WHERE e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
ORDER BY t.display_order NULLS LAST, t.id;
