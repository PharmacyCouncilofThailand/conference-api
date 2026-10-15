-- Optional rollback only. Deploy code with the 50 MB ceiling before using this.
-- Abort if larger uploads exist; never delete accepted files to force rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE presentation_upload_attempts, presentation_uploads IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM presentation_upload_attempts WHERE storage_provider='drive' AND size_bytes>52428800)
    OR EXISTS(SELECT 1 FROM presentation_uploads WHERE storage_provider='drive' AND size_bytes>52428800) THEN
    RAISE EXCEPTION 'Cannot restore 50 MB: larger Oral files exist';
  END IF;
END $$;
ALTER TABLE presentation_upload_attempts
  DROP CONSTRAINT presentation_upload_attempts_check,
  ADD CONSTRAINT presentation_upload_attempts_check
    CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 52428800 ELSE 31457280 END);
ALTER TABLE presentation_uploads
  DROP CONSTRAINT presentation_uploads_check,
  ADD CONSTRAINT presentation_uploads_check
    CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 52428800 ELSE 31457280 END);
COMMIT;
