BEGIN;

ALTER TABLE lucky_wheel_qr_codes
  DROP CONSTRAINT lucky_wheel_qr_codes_open_consistency_check,
  ADD CONSTRAINT lucky_wheel_qr_codes_open_consistency_check CHECK (
    (opened_by IS NULL AND opened_at IS NULL AND opened_reason IS NULL)
    OR (opened_by IS NOT NULL AND opened_at IS NOT NULL
      AND (opened_reason IS NULL OR btrim(opened_reason) <> ''))
  ),
  DROP CONSTRAINT lucky_wheel_qr_codes_close_consistency_check,
  ADD CONSTRAINT lucky_wheel_qr_codes_close_consistency_check CHECK (
    (closed_by IS NULL AND closed_at IS NULL AND closed_reason IS NULL)
    OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
      AND (closed_reason IS NULL OR btrim(closed_reason) <> ''))
  );

CREATE OR REPLACE FUNCTION validate_lucky_wheel_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_session RECORD;
BEGIN
  IF NEW.enabled THEN
    SELECT event_id, is_main_session, start_time, end_time
      INTO target_session
    FROM sessions
    WHERE id = NEW.main_session_id;

    IF NOT FOUND
       OR target_session.event_id <> NEW.event_id
       OR target_session.is_main_session IS NOT TRUE THEN
      RAISE EXCEPTION 'Lucky wheel must target the configured event Main Session';
    END IF;

    IF target_session.start_time >= target_session.end_time THEN
      RAISE EXCEPTION 'Lucky wheel Main Session must have a valid time window';
    END IF;

    IF NEW.published_configuration IS NULL THEN
      RAISE EXCEPTION 'Lucky wheel must have a published configuration before enabling';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
