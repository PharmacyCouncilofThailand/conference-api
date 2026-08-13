-- Prepare the final current-ID invariant. Run only after 04_post_cutover_verify
-- reports zero missing/null identifiers. This script is resumable: an existing
-- matching index is accepted; a wrong definition aborts.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM abstracts WHERE tracking_id IS NULL) THEN
    RAISE EXCEPTION 'cannot harden tracking_id while NULL identifiers remain';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS abstract_tracking_identifiers_current_unique
  ON abstract_tracking_identifiers(abstract_id, event_id, tracking_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abstracts_tracking_id_not_null') THEN
    ALTER TABLE abstracts
      ADD CONSTRAINT abstracts_tracking_id_not_null CHECK (tracking_id IS NOT NULL) NOT VALID;
  END IF;
END
$$;
