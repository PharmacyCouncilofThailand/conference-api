-- Optional daily scan window (Bangkok "HH:MM") for daily attendance policies.
-- When both are set, a daily session accepts scans on each Bangkok day of the
-- session span, only between open (inclusive) and close (exclusive).
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE session_attendance_policies
  ADD COLUMN IF NOT EXISTS daily_open_time varchar(5),
  ADD COLUMN IF NOT EXISTS daily_close_time varchar(5);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_attendance_daily_window_check') THEN
    ALTER TABLE session_attendance_policies ADD CONSTRAINT session_attendance_daily_window_check CHECK (
      (daily_open_time IS NULL AND daily_close_time IS NULL)
      OR (daily_open_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND daily_close_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND daily_open_time < daily_close_time)
    );
  END IF;
END $$;
COMMIT;
