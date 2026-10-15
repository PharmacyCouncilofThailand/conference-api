-- Expand Oral/Drive uploads to 100 MB; retain the 30 MB R2 Poster limit.
-- Safe to re-run. Apply before deploying the API/frontend with the larger limit.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE presentation_upload_attempts
  DROP CONSTRAINT presentation_upload_attempts_check,
  ADD CONSTRAINT presentation_upload_attempts_check
    CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 104857600 ELSE 31457280 END);
ALTER TABLE presentation_uploads
  DROP CONSTRAINT presentation_uploads_check,
  ADD CONSTRAINT presentation_uploads_check
    CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 104857600 ELSE 31457280 END);
COMMIT;
