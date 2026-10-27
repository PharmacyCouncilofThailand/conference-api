-- Durable per-recipient log for backoffice Email Manual sends.
-- A row is written as 'sending' before the provider call and finished as
-- 'sent' or 'failed'; skipped recipients are logged with their reason.
-- Rows left in 'sending' mean the outcome is unknown (process interrupted).
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS manual_email_logs (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL,
  event_id integer NOT NULL REFERENCES events(id),
  template varchar(64) NOT NULL,
  recipient_type varchar(16) NOT NULL,
  recipient_id integer NOT NULL,
  recipient_email varchar(255),
  recipient_name varchar(255),
  subject text,
  status varchar(16) NOT NULL,
  reason text,
  triggered_by integer REFERENCES backoffice_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT manual_email_logs_status_check CHECK (status IN ('sending', 'sent', 'failed', 'skipped'))
);
CREATE INDEX IF NOT EXISTS manual_email_logs_event_template_created_idx
  ON manual_email_logs (event_id, template, created_at DESC);
CREATE INDEX IF NOT EXISTS manual_email_logs_batch_idx
  ON manual_email_logs (batch_id);
CREATE INDEX IF NOT EXISTS manual_email_logs_sent_lookup_idx
  ON manual_email_logs (event_id, template, recipient_id) WHERE status = 'sent';
COMMIT;
