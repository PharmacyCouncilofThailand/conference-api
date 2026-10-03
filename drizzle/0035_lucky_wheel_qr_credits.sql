BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheels_id_event_unique
  ON lucky_wheels (id, event_id);

CREATE TABLE IF NOT EXISTS lucky_wheel_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wheel_id uuid NOT NULL,
  event_id integer NOT NULL REFERENCES events(id),
  play_date date NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_days_wheel_event_fk
    FOREIGN KEY (wheel_id, event_id) REFERENCES lucky_wheels (id, event_id),
  CONSTRAINT lucky_wheel_days_version_positive_check CHECK (version > 0),
  CONSTRAINT lucky_wheel_days_window_check CHECK (
    start_at < end_at
    AND (start_at AT TIME ZONE 'Asia/Bangkok')::date = play_date
    AND end_at <= ((play_date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_days_wheel_date_unique
  ON lucky_wheel_days (wheel_id, play_date);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_days_id_event_date_unique
  ON lucky_wheel_days (id, event_id, play_date);

CREATE TABLE IF NOT EXISTS lucky_wheel_qr_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL,
  event_id integer NOT NULL REFERENCES events(id),
  play_date date NOT NULL,
  name varchar(160) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'closed',
  created_by integer NOT NULL REFERENCES backoffice_users(id),
  opened_by integer REFERENCES backoffice_users(id),
  opened_at timestamptz,
  opened_reason text,
  closed_by integer REFERENCES backoffice_users(id),
  closed_at timestamptz,
  closed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_qr_codes_day_event_date_fk
    FOREIGN KEY (day_id, event_id, play_date)
    REFERENCES lucky_wheel_days (id, event_id, play_date),
  CONSTRAINT lucky_wheel_qr_codes_name_nonblank_check CHECK (btrim(name) <> ''),
  CONSTRAINT lucky_wheel_qr_codes_status_check CHECK (status IN ('closed', 'open')),
  CONSTRAINT lucky_wheel_qr_codes_open_consistency_check CHECK (
    (opened_by IS NULL AND opened_at IS NULL AND opened_reason IS NULL)
    OR (opened_by IS NOT NULL AND opened_at IS NOT NULL
      AND opened_reason IS NOT NULL AND btrim(opened_reason) <> '')
  ),
  CONSTRAINT lucky_wheel_qr_codes_close_consistency_check CHECK (
    (closed_by IS NULL AND closed_at IS NULL AND closed_reason IS NULL)
    OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
      AND closed_reason IS NOT NULL AND btrim(closed_reason) <> '')
  )
);

CREATE INDEX IF NOT EXISTS lucky_wheel_qr_codes_day_status_idx
  ON lucky_wheel_qr_codes (day_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_qr_codes_id_event_date_unique
  ON lucky_wheel_qr_codes (id, event_id, play_date);

CREATE TABLE IF NOT EXISTS lucky_wheel_credit_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_id uuid NOT NULL,
  event_id integer NOT NULL REFERENCES events(id),
  play_date date NOT NULL,
  user_id integer NOT NULL REFERENCES users(id),
  attendance_id uuid NOT NULL REFERENCES session_daily_checkins(id),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  displayed_deadline_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by integer REFERENCES backoffice_users(id),
  revocation_reason text,
  spent_at timestamptz,
  CONSTRAINT lucky_wheel_credit_claims_qr_event_date_fk
    FOREIGN KEY (qr_id, event_id, play_date)
    REFERENCES lucky_wheel_qr_codes (id, event_id, play_date),
  CONSTRAINT lucky_wheel_credit_claims_revocation_consistency_check CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL
      AND btrim(revocation_reason) <> '')
  ),
  CONSTRAINT lucky_wheel_credit_claims_not_spent_and_revoked_check CHECK (
    spent_at IS NULL OR revoked_at IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_credit_claims_qr_user_unique
  ON lucky_wheel_credit_claims (qr_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_credit_claims_id_event_user_date_unique
  ON lucky_wheel_credit_claims (id, event_id, user_id, play_date);
CREATE INDEX IF NOT EXISTS lucky_wheel_credit_claims_user_spend_idx
  ON lucky_wheel_credit_claims (user_id, spent_at, claimed_at);

ALTER TABLE lucky_wheel_spins
  ADD COLUMN IF NOT EXISTS credit_claim_id uuid REFERENCES lucky_wheel_credit_claims(id);

DROP INDEX IF EXISTS lucky_wheel_spins_event_user_day_unique;
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_spins_event_user_day_legacy_unique
  ON lucky_wheel_spins (event_id, user_id, play_date)
  WHERE credit_claim_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_spins_credit_claim_unique
  ON lucky_wheel_spins (credit_claim_id)
  WHERE credit_claim_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lucky_wheel_spins_credit_owner_day_fk'
  ) THEN
    ALTER TABLE lucky_wheel_spins
      ADD CONSTRAINT lucky_wheel_spins_credit_owner_day_fk
      FOREIGN KEY (credit_claim_id, event_id, user_id, play_date)
      REFERENCES lucky_wheel_credit_claims (id, event_id, user_id, play_date);
  END IF;
END;
$$;

COMMIT;
