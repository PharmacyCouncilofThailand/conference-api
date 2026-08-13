-- Final hardening. Apply only after 07_prepare_hardening.sql and a successful
-- read-only verification. Never run this while a COUNT-based writer is live.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM abstracts WHERE tracking_id IS NULL) THEN
    RAISE EXCEPTION 'tracking_id contains NULL rows';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'abstract_tracking_identifiers_current_unique'
  ) THEN
    RAISE EXCEPTION 'current tracking assignment unique index is missing';
  END IF;
END
$$;

ALTER TABLE abstracts
  ALTER COLUMN tracking_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abstracts_current_tracking_fk') THEN
    ALTER TABLE abstracts
      ADD CONSTRAINT abstracts_current_tracking_fk
      FOREIGN KEY (id, event_id, tracking_id)
      REFERENCES abstract_tracking_identifiers (abstract_id, event_id, tracking_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

COMMIT;
