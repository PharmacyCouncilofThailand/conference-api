BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE session_invitation_resend_requests (
  id uuid PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES backoffice_users(id),
  session_id integer NOT NULL REFERENCES sessions(id),
  idempotency_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_invitation_resend_actor_key_unique UNIQUE(actor_id,idempotency_key),
  CONSTRAINT session_invitation_resend_result_object CHECK(jsonb_typeof(result)='object')
);
CREATE INDEX session_invitation_resend_session_time_idx
  ON session_invitation_resend_requests(session_id,created_at);
ALTER TABLE registration_session_grant_items
  ADD COLUMN next_email_purpose varchar(16) NOT NULL DEFAULT 'initial',
  ADD COLUMN next_resend_request_id uuid REFERENCES session_invitation_resend_requests(id),
  ADD COLUMN last_resend_queued_at timestamptz,
  ADD CONSTRAINT session_grant_next_purpose_check
    CHECK(next_email_purpose IN ('initial','retry','resend')),
  ADD CONSTRAINT session_grant_resend_request_check
    CHECK(next_email_purpose <> 'resend' OR next_resend_request_id IS NOT NULL);
ALTER TABLE registration_session_grant_email_attempts
  ADD COLUMN purpose varchar(16) NOT NULL DEFAULT 'initial',
  ADD COLUMN resend_request_id uuid REFERENCES session_invitation_resend_requests(id),
  ADD CONSTRAINT session_grant_attempt_purpose_check
    CHECK(purpose IN ('initial','retry','resend'));
CREATE INDEX session_grant_attempt_resend_request_idx
  ON registration_session_grant_email_attempts(resend_request_id,item_id,attempt_no);
COMMIT;
