BEGIN;

ALTER TABLE lucky_wheel_redemption_confirmations
  ALTER COLUMN collection_point DROP NOT NULL;

ALTER TABLE lucky_wheel_redemptions
  DROP CONSTRAINT lucky_wheel_redemptions_state_check,
  ADD CONSTRAINT lucky_wheel_redemptions_state_check CHECK (
    (status = 'open' AND redeemed_at IS NULL AND redeemed_by IS NULL)
    OR (status = 'redeemed' AND redeemed_at IS NOT NULL AND redeemed_by IS NOT NULL)
  );

COMMIT;
