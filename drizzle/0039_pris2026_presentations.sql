BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('presentation_settings','presentation_targets','presentation_announcements',
      'presentation_revision_requests','presentation_upload_attempts','presentation_uploads','presentation_operations',
      'presentation_email_jobs','presentation_email_attempts','presentation_audit_events')) THEN
    RAISE EXCEPTION 'Presentation schema already exists: refuse replacement';
  END IF;
  IF to_regclass('public.poster_targets') IS NOT NULL THEN
    ALTER TABLE poster_targets DROP CONSTRAINT IF EXISTS poster_current_file_same_target;
  END IF;
END $$;
DROP TABLE IF EXISTS poster_email_attempts;
DROP TABLE IF EXISTS poster_email_jobs;
DROP TABLE IF EXISTS poster_operations;
DROP TABLE IF EXISTS poster_audit_events;
DROP TABLE IF EXISTS poster_uploads;
DROP TABLE IF EXISTS poster_upload_attempts;
DROP TABLE IF EXISTS poster_revision_requests;
DROP TABLE IF EXISTS poster_announcements;
DROP TABLE IF EXISTS poster_targets;
DROP TABLE IF EXISTS poster_settings;
DROP FUNCTION IF EXISTS poster_request_immutable();
DROP INDEX IF EXISTS poster_abstract_event_identity;
CREATE UNIQUE INDEX presentation_abstract_event_identity ON abstracts(event_id,id);
CREATE TABLE presentation_settings (
  event_id integer PRIMARY KEY REFERENCES events(id),
  closes_at timestamptz NOT NULL DEFAULT '2026-10-20T17:00:00Z',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  manifest_digest char(64), reconcile_ready boolean NOT NULL DEFAULT false,
  last_reconciled_at timestamptz, reconcile_error text,
  CHECK(isfinite(closes_at))
);
CREATE TABLE presentation_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  abstract_id integer NOT NULL, current_upload_id uuid,
  initial_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,abstract_id), UNIQUE(id,event_id),
  FOREIGN KEY(event_id,abstract_id) REFERENCES abstracts(event_id,id)
);
CREATE TABLE presentation_announcements (
  event_id integer NOT NULL REFERENCES events(id), source_key text NOT NULL,
  source_row jsonb NOT NULL, source_digest char(64) NOT NULL,
  target_id uuid, match_state text NOT NULL DEFAULT 'incomplete',
  match_fingerprint char(64), match_snapshot jsonb NOT NULL DEFAULT '{}',
  verified_fingerprint char(64), verified_by integer REFERENCES backoffice_users(id),
  verified_at timestamptz, verification_reason text,
  present boolean NOT NULL DEFAULT true,
  PRIMARY KEY(event_id,source_key),
  FOREIGN KEY(target_id,event_id) REFERENCES presentation_targets(id,event_id),
  CHECK(match_state IN ('ready','alias_pending','conflict','missing','incomplete')),
  CHECK(verified_at IS NULL OR (verified_by IS NOT NULL AND verification_reason IS NOT NULL AND length(btrim(verification_reason))>0))
);
CREATE TABLE presentation_revision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES presentation_targets(id),
  details text NOT NULL CHECK(length(btrim(details))>0), closes_at timestamptz NOT NULL CHECK(isfinite(closes_at)),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','expired','cancelled')),
  requested_by integer NOT NULL REFERENCES backoffice_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz,
  cancelled_by integer REFERENCES backoffice_users(id), cancelled_at timestamptz, cancellation_reason text,
  UNIQUE(target_id,id),
  CHECK((status='submitted')=(submitted_at IS NOT NULL)),
  CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK(status<>'cancelled' OR (cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL AND length(btrim(cancellation_reason))>0))
);
CREATE UNIQUE INDEX presentation_one_open_request ON presentation_revision_requests(target_id) WHERE status='open';
CREATE TABLE presentation_upload_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES presentation_targets(id),
  user_id integer NOT NULL REFERENCES users(id), request_id uuid,
  operation_key uuid NOT NULL, fingerprint char(64) NOT NULL,
  storage_provider text NOT NULL CHECK(storage_provider IN ('r2','drive')),
  object_key text UNIQUE, drive_file_id text UNIQUE, drive_folder_id text,
  original_filename text NOT NULL, stored_filename text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type='application/pdf'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 52428800 ELSE 31457280 END),
  digest char(64) NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','stored','accepted','rejected','cleanup_pending','cleaned')),
  lease_until timestamptz NOT NULL, claim_token uuid NOT NULL,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(target_id,user_id,operation_key), UNIQUE(target_id,id),
  CHECK((storage_provider='r2' AND object_key IS NOT NULL AND drive_file_id IS NULL AND drive_folder_id IS NULL)
    OR (storage_provider='drive' AND object_key IS NULL
      AND ((drive_file_id IS NULL AND drive_folder_id IS NULL AND state NOT IN ('stored','accepted'))
        OR (drive_file_id IS NOT NULL AND drive_folder_id IS NOT NULL)))),
  FOREIGN KEY(target_id,request_id) REFERENCES presentation_revision_requests(target_id,id)
);
CREATE TABLE presentation_uploads (
  id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES presentation_targets(id),
  attempt_id uuid NOT NULL UNIQUE, request_id uuid,
  version integer NOT NULL CHECK(version>0), user_id integer NOT NULL REFERENCES users(id),
  storage_provider text NOT NULL CHECK(storage_provider IN ('r2','drive')),
  object_key text UNIQUE, drive_file_id text UNIQUE, drive_folder_id text,
  file_url text NOT NULL, original_filename text NOT NULL, stored_filename text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type='application/pdf'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 52428800 ELSE 31457280 END), digest char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE(target_id,id), UNIQUE(target_id,version),
  CHECK((storage_provider='r2' AND object_key IS NOT NULL AND drive_file_id IS NULL AND drive_folder_id IS NULL)
    OR (storage_provider='drive' AND object_key IS NULL AND drive_file_id IS NOT NULL AND drive_folder_id IS NOT NULL)),
  FOREIGN KEY(target_id,attempt_id) REFERENCES presentation_upload_attempts(target_id,id),
  FOREIGN KEY(target_id,request_id) REFERENCES presentation_revision_requests(target_id,id)
);
CREATE UNIQUE INDEX presentation_one_initial_upload ON presentation_uploads(target_id) WHERE request_id IS NULL;
CREATE UNIQUE INDEX presentation_one_revision_upload ON presentation_uploads(request_id) WHERE request_id IS NOT NULL;
ALTER TABLE presentation_targets ADD CONSTRAINT presentation_current_file_same_target
  FOREIGN KEY(id,current_upload_id) REFERENCES presentation_uploads(target_id,id);
CREATE TABLE presentation_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  actor_id integer NOT NULL REFERENCES backoffice_users(id), action text NOT NULL,
  operation_key uuid NOT NULL, fingerprint char(64) NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(event_id,actor_id,action,operation_key)
);
CREATE TABLE presentation_email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES presentation_targets(id),
  kind text NOT NULL CHECK(kind IN ('initial','reminder','revision','receipt')),
  request_id uuid, upload_id uuid, batch_id uuid, automatic_receipt_for uuid UNIQUE,
  triggered_by integer REFERENCES backoffice_users(id), parent_job_id uuid REFERENCES presentation_email_jobs(id),
  payload jsonb NOT NULL, subject text NOT NULL, html text NOT NULL, template_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','unknown','suppressed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  claim_token uuid, lease_until timestamptz, request_started_at timestamptz,
  error_code text, provider_message_id text,
  FOREIGN KEY(target_id,request_id) REFERENCES presentation_revision_requests(target_id,id),
  FOREIGN KEY(target_id,upload_id) REFERENCES presentation_uploads(target_id,id),
  FOREIGN KEY(target_id,automatic_receipt_for) REFERENCES presentation_uploads(target_id,id),
  CHECK(kind<>'revision' OR request_id IS NOT NULL), CHECK(kind<>'receipt' OR upload_id IS NOT NULL)
);
CREATE INDEX presentation_pending_mail ON presentation_email_jobs(created_at,id) WHERE state='pending';
CREATE TABLE presentation_email_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES presentation_email_jobs(id),
  claim_token uuid NOT NULL, result text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), request_started_at timestamptz,
  finished_at timestamptz, error_code text, provider_message_id text,
  recipient text, subject text NOT NULL, html text NOT NULL, template_version text NOT NULL,
  CHECK(result IN ('sending','sent','failed','unknown','suppressed')), UNIQUE(job_id,claim_token)
);
CREATE TABLE presentation_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  abstract_id integer REFERENCES abstracts(id), actor_id integer REFERENCES backoffice_users(id),
  action text NOT NULL, reason text, before_state jsonb, after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION presentation_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.details IS DISTINCT FROM OLD.details OR NEW.closes_at IS DISTINCT FROM OLD.closes_at
     OR NEW.target_id IS DISTINCT FROM OLD.target_id THEN
    RAISE EXCEPTION 'Presentation request terms are immutable';
  END IF;
  IF OLD.status<>'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal presentation requests cannot reopen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presentation_request_immutable_guard BEFORE UPDATE ON presentation_revision_requests
  FOR EACH ROW EXECUTE FUNCTION presentation_request_immutable();
COMMIT;
