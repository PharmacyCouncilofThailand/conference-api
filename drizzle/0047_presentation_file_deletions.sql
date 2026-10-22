BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE presentation_file_deletions (
  upload_id uuid PRIMARY KEY,
  target_id uuid NOT NULL,
  replacement_upload_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','deleting','deleted')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  error_code text,
  FOREIGN KEY(target_id,upload_id) REFERENCES presentation_uploads(target_id,id),
  FOREIGN KEY(target_id,replacement_upload_id) REFERENCES presentation_uploads(target_id,id),
  CHECK(upload_id<>replacement_upload_id),
  CHECK((state='deleting' AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state<>'deleting' AND claim_token IS NULL AND lease_until IS NULL)),
  CHECK((state='deleted')=(deleted_at IS NOT NULL))
);
CREATE INDEX presentation_file_deletions_due ON presentation_file_deletions(next_attempt_at,created_at)
  WHERE state='pending';
CREATE INDEX presentation_file_deletions_expired ON presentation_file_deletions(lease_until)
  WHERE state='deleting';

CREATE VIEW presentation_upload_files AS
SELECT u.id,u.target_id,u.attempt_id,u.request_id,u.version,u.user_id,u.storage_provider,
  u.object_key,u.drive_file_id,u.drive_folder_id,
  CASE WHEN d.upload_id IS NULL THEN u.file_url ELSE NULL END AS file_url,
  u.original_filename,u.stored_filename,u.mime_type,u.size_bytes,u.digest,u.received_at,
  CASE WHEN d.upload_id IS NULL THEN 'available' WHEN d.state='deleted' THEN 'deleted'
    ELSE 'deletion_pending' END AS file_status,d.deleted_at
FROM presentation_uploads u LEFT JOIN presentation_file_deletions d ON d.upload_id=u.id;
COMMIT;
