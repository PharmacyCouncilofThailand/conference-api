-- Additive metadata only. Existing registrations, tickets and payments are preserved.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS holder_type varchar(32),
  ADD COLUMN IF NOT EXISTS holder_type_source text,
  ADD COLUMN IF NOT EXISTS holder_type_updated_at timestamp;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'registrations'::regclass
      AND conname = 'registrations_holder_type_check'
  ) THEN
    ALTER TABLE registrations ADD CONSTRAINT registrations_holder_type_check
      CHECK (holder_type IS NULL OR holder_type IN (
        'council_committee', 'college_committee', 'vip', 'speaker',
        'presenter', 'participant', 'exhibitor', 'health_hack',
        'media', 'staff_mc', 'reviewer'
      ));
  END IF;
END $$;
