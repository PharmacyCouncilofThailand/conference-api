BEGIN;

-- Optional fixed win chance for a segment. Live segments without one share
-- whatever percentage is left equally.
ALTER TABLE lucky_wheel_segments
  ADD COLUMN IF NOT EXISTS win_percent numeric(5, 2);

ALTER TABLE lucky_wheel_segments
  ADD CONSTRAINT lucky_wheel_segments_win_percent_check
  CHECK (win_percent IS NULL OR (win_percent > 0 AND win_percent <= 100));

COMMIT;
