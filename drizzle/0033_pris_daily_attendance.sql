BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS session_attendance_policies (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id),
  session_id integer NOT NULL REFERENCES sessions(id),
  mode varchar(16) NOT NULL DEFAULT 'daily',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_attendance_policies_mode_check CHECK (mode = 'daily')
);

CREATE UNIQUE INDEX IF NOT EXISTS session_attendance_policies_event_session_unique
  ON session_attendance_policies (event_id, session_id);

CREATE TABLE IF NOT EXISTS session_daily_checkins (
  id uuid PRIMARY KEY,
  registration_session_id integer NOT NULL REFERENCES registration_sessions(id),
  attendance_date date NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  checked_in_by integer REFERENCES backoffice_users(id),
  cancelled_at timestamptz,
  cancelled_by integer REFERENCES backoffice_users(id),
  cancellation_reason text,
  legacy_source_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_daily_checkins_cancellation_consistency_check CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
    OR
    (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS session_daily_checkins_active_day_unique
ON session_daily_checkins (registration_session_id, attendance_date)
WHERE cancelled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS session_daily_checkins_legacy_source_unique
ON session_daily_checkins (legacy_source_key)
WHERE legacy_source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS session_daily_checkins_registration_history_idx
  ON session_daily_checkins (registration_session_id, attendance_date, checked_in_at);

CREATE INDEX IF NOT EXISTS session_daily_checkins_date_report_idx
  ON session_daily_checkins (attendance_date, registration_session_id);

COMMIT;
