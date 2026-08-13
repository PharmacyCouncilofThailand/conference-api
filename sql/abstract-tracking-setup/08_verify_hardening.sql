-- Read-only hardening verification. Use -v phase=prepared|complete.
\set ON_ERROR_STOP on

SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.abstracts'::regclass
  AND conname IN ('abstracts_tracking_id_not_null', 'abstracts_current_tracking_fk');

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'abstract_tracking_identifiers_current_unique';

SELECT count(*) AS null_tracking_ids FROM abstracts WHERE tracking_id IS NULL;
