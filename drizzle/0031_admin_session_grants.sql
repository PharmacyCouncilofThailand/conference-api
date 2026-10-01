BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE registration_sessions IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM registration_sessions
    GROUP BY registration_id, session_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'admin session grants aborted: duplicate entitlement pairs require reviewed remediation';
  END IF;
END $$;

ALTER TABLE registration_sessions
  ALTER COLUMN ticket_type_id DROP NOT NULL;

CREATE UNIQUE INDEX registration_sessions_registration_session_unique
  ON registration_sessions(registration_id, session_id);

CREATE TABLE registration_session_grant_batches (
  id uuid PRIMARY KEY,
  actor_id integer NOT NULL,
  actor_name_snapshot text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  session_id integer NOT NULL REFERENCES sessions(id),
  event_id integer NOT NULL REFERENCES events(id),
  session_name_snapshot text NOT NULL,
  requested_count integer NOT NULL CHECK (requested_count BETWEEN 1 AND 500),
  added_count integer NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(actor_id, idempotency_key),
  CHECK (completed_at IS NULL OR requested_count = added_count + skipped_count)
);

CREATE TABLE registration_session_grant_items (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES registration_session_grant_batches(id),
  requested_registration_id integer NOT NULL CHECK (requested_registration_id > 0),
  registration_session_id integer REFERENCES registration_sessions(id) ON DELETE SET NULL,
  reg_code_snapshot text,
  name_snapshot text,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('added','skipped')),
  reason_code varchar(64),
  recipient_email_snapshot text,
  notification_snapshot jsonb,
  email_status varchar(24) NOT NULL CHECK (
    email_status IN ('not_applicable','pending','sending','sent','failed','unknown','suppressed')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  last_error_code varchar(100),
  claim_token uuid,
  claimed_until timestamptz,
  next_trigger varchar(16) NOT NULL DEFAULT 'system' CHECK (next_trigger IN ('system','admin')),
  next_triggered_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, requested_registration_id),
  UNIQUE(registration_session_id),
  CHECK (
    (outcome='skipped' AND email_status='not_applicable' AND reason_code IS NOT NULL)
    OR
    (outcome='added' AND email_status<>'not_applicable' AND reason_code IS NULL)
  )
);

CREATE INDEX session_grant_items_queue_idx
  ON registration_session_grant_items(created_at, id)
  WHERE email_status='pending';

CREATE INDEX session_grant_items_lease_idx
  ON registration_session_grant_items(claimed_until)
  WHERE email_status='sending';

CREATE INDEX session_grant_items_registration_idx
  ON registration_session_grant_items(requested_registration_id, created_at);

CREATE TABLE registration_session_grant_email_attempts (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES registration_session_grant_items(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  claim_token uuid NOT NULL,
  trigger varchar(16) NOT NULL CHECK (trigger IN ('system','admin')),
  triggered_by integer,
  recipient_email text NOT NULL,
  template_version varchar(32) NOT NULL,
  subject_snapshot text NOT NULL,
  result varchar(16) NOT NULL CHECK (result IN ('sending','sent','failed','unknown','suppressed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  request_started_at timestamptz,
  finished_at timestamptz,
  error_code varchar(100),
  error_message text,
  provider_message_id text,
  UNIQUE(item_id, attempt_no)
);

COMMIT;
