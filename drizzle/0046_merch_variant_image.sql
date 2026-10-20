-- Option photo: a variant may point at one of its product's photos.
-- Safe to re-run. Apply before deploying the API that reads image_id.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE merch_variants
  ADD COLUMN IF NOT EXISTS image_id uuid REFERENCES merch_images(id) ON DELETE SET NULL;
COMMIT;
