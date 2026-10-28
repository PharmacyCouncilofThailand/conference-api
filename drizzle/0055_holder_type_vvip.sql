-- Add the VVIP holder type (28 Oct 2026). The key order must match
-- HOLDER_TYPE_KEYS in src/modules/registration-holder-types/catalog.ts because
-- the holder importer compares PostgreSQL's normalized CHECK definition.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_holder_type_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_holder_type_check
  CHECK (holder_type IS NULL OR holder_type IN (
    'vvip', 'council_committee', 'college_committee', 'vip', 'speaker',
    'presenter', 'participant', 'exhibitor', 'health_hack',
    'media', 'staff_mc', 'reviewer'
  ));
COMMIT;
