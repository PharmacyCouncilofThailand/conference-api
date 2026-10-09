-- Add PNG for R2 posters while retaining PDF-only Drive uploads and existing data.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE presentation_upload_attempts
  DROP CONSTRAINT presentation_upload_attempts_mime_type_check,
  ADD CONSTRAINT presentation_upload_attempts_mime_type_check
    CHECK(mime_type='application/pdf' OR (mime_type='image/png' AND storage_provider='r2'));
ALTER TABLE presentation_uploads
  DROP CONSTRAINT presentation_uploads_mime_type_check,
  ADD CONSTRAINT presentation_uploads_mime_type_check
    CHECK(mime_type='application/pdf' OR (mime_type='image/png' AND storage_provider='r2'));
COMMIT;
