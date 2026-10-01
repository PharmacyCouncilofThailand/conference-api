BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE sessions
  ADD COLUMN admin_grant_requires_confirmation boolean NOT NULL DEFAULT false;

ALTER TABLE registration_session_grant_batches
  ADD COLUMN invited_count integer NOT NULL DEFAULT 0;
ALTER TABLE registration_session_grant_batches
  ADD CONSTRAINT session_grant_batches_invited_nonnegative CHECK (invited_count >= 0);

ALTER TABLE registration_session_grant_batches
  DROP CONSTRAINT IF EXISTS registration_session_grant_batches_check;
ALTER TABLE registration_session_grant_batches
  DROP CONSTRAINT IF EXISTS registration_session_grant_batches_completion_count_check;
ALTER TABLE registration_session_grant_batches
  ADD CONSTRAINT registration_session_grant_batches_completion_count_check
  CHECK (completed_at IS NULL OR requested_count = added_count + invited_count + skipped_count);

ALTER TABLE registration_session_grant_items
  DROP CONSTRAINT IF EXISTS registration_session_grant_items_outcome_check;
ALTER TABLE registration_session_grant_items
  ADD CONSTRAINT registration_session_grant_items_outcome_check
  CHECK (outcome IN ('added','invited','skipped'));
ALTER TABLE registration_session_grant_items
  DROP CONSTRAINT IF EXISTS registration_session_grant_items_check;
ALTER TABLE registration_session_grant_items
  DROP CONSTRAINT IF EXISTS registration_session_grant_items_outcome_email_check;
ALTER TABLE registration_session_grant_items
  ADD CONSTRAINT registration_session_grant_items_outcome_email_check
  CHECK (
    (outcome='skipped' AND email_status='not_applicable' AND reason_code IS NOT NULL)
    OR (outcome IN ('added','invited') AND email_status<>'not_applicable' AND reason_code IS NULL)
  );

CREATE TABLE session_invitations (
  id uuid PRIMARY KEY,
  registration_id integer NOT NULL REFERENCES registrations(id),
  session_id integer NOT NULL REFERENCES sessions(id),
  grant_item_id uuid NOT NULL UNIQUE REFERENCES registration_session_grant_items(id),
  status varchar(16) NOT NULL CHECK (status IN ('pending','accepted','declined','expired','revoked')),
  token_hash varchar(64) NOT NULL UNIQUE,
  token_ciphertext jsonb,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  closed_at timestamptz,
  close_reason varchar(64),
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_invitations_lifecycle_check CHECK (
    (status='pending' AND responded_at IS NULL AND closed_at IS NULL AND token_ciphertext IS NOT NULL)
    OR (status IN ('accepted','declined') AND responded_at IS NOT NULL AND closed_at IS NOT NULL AND token_ciphertext IS NULL)
    OR (status IN ('expired','revoked') AND responded_at IS NULL AND closed_at IS NOT NULL AND token_ciphertext IS NULL)
  )
);

CREATE UNIQUE INDEX session_invitations_pending_pair_unique
  ON session_invitations(registration_id,session_id) WHERE status='pending';
CREATE INDEX session_invitations_pending_capacity_idx
  ON session_invitations(session_id,expires_at,registration_id) WHERE status='pending';

COMMIT;
