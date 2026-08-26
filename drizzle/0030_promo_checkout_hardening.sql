BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM promo_codes
    WHERE discount_type = 'percentage'
      AND (discount_value < 0 OR discount_value > 100)
  ) THEN
    RAISE EXCEPTION 'promo checkout hardening aborted: percentage promo outside 0..100 exists';
  END IF;

  IF EXISTS (
    SELECT order_id
    FROM promo_code_usages
    WHERE order_id IS NOT NULL
    GROUP BY order_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'promo checkout hardening aborted: duplicate promo usage rows exist for an order';
  END IF;
END
$$;

ALTER TABLE promo_codes
  ADD CONSTRAINT promo_codes_percentage_discount_range_check
  CHECK (discount_type <> 'percentage' OR (discount_value >= 0 AND discount_value <= 100));

CREATE UNIQUE INDEX promo_code_usages_order_unique
  ON promo_code_usages(order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX promo_code_usages_active_promo_idx
  ON promo_code_usages(promo_code_id, status)
  WHERE status IN ('pending', 'used');

CREATE INDEX promo_code_usages_active_user_idx
  ON promo_code_usages(promo_code_id, user_id, status)
  WHERE status IN ('pending', 'used');

COMMIT;
