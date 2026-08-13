-- One-time migrator setup for reviewed namespace/floor evidence.
-- Load CSVs through a literal-path \copy command from a distinct loader login;
-- never use psql variable interpolation inside \copy.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS abstract_tracking_migration_batches (
  migration_batch_id uuid PRIMARY KEY,
  expected_namespace_digest text NOT NULL,
  expected_floor_digest text NOT NULL,
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abstract_tracking_manifest_namespaces (
  migration_batch_id uuid NOT NULL REFERENCES abstract_tracking_migration_batches(migration_batch_id) ON DELETE RESTRICT,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  prefix varchar(50) NOT NULL,
  padding_width smallint NOT NULL CHECK (padding_width BETWEEN 1 AND 12),
  evidence_source text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  approval_reason text NOT NULL,
  PRIMARY KEY (migration_batch_id, event_id)
);

CREATE TABLE IF NOT EXISTS abstract_tracking_manifest_floors (
  migration_batch_id uuid NOT NULL REFERENCES abstract_tracking_migration_batches(migration_batch_id) ON DELETE RESTRICT,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  presentation_type presentation_type NOT NULL,
  approved_floor bigint NOT NULL CHECK (approved_floor >= 0),
  evidence_source text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  approval_reason text NOT NULL,
  PRIMARY KEY (migration_batch_id, event_id, presentation_type)
);

-- Runtime cutover consumes the same reviewed floor table. It is intentionally
-- separate from the immutable migration batch so operators can apply a floor
-- after an additive schema expand and before enabling writes.
CREATE TABLE IF NOT EXISTS abstract_tracking_approved_floors (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  presentation_type presentation_type NOT NULL,
  approved_floor bigint NOT NULL CHECK (approved_floor >= 0),
  evidence_source text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  approval_reason text NOT NULL,
  PRIMARY KEY (event_id, presentation_type)
);

COMMENT ON TABLE abstract_tracking_approved_floors IS
  'Reviewed historical high-water marks. Never lower a value; floor + 1 is next native allocation.';

CREATE OR REPLACE FUNCTION guard_frozen_tracking_manifest()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM abstract_tracking_migration_batches b
    WHERE b.migration_batch_id = COALESCE(NEW.migration_batch_id, OLD.migration_batch_id)
      AND b.frozen_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'tracking manifest batch is frozen' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS abstract_tracking_manifest_namespace_frozen ON abstract_tracking_manifest_namespaces;
CREATE TRIGGER abstract_tracking_manifest_namespace_frozen
BEFORE INSERT OR UPDATE OR DELETE ON abstract_tracking_manifest_namespaces
FOR EACH ROW EXECUTE FUNCTION guard_frozen_tracking_manifest();
DROP TRIGGER IF EXISTS abstract_tracking_manifest_floor_frozen ON abstract_tracking_manifest_floors;
CREATE TRIGGER abstract_tracking_manifest_floor_frozen
BEFORE INSERT OR UPDATE OR DELETE ON abstract_tracking_manifest_floors
FOR EACH ROW EXECUTE FUNCTION guard_frozen_tracking_manifest();
DROP TRIGGER IF EXISTS abstract_tracking_manifest_batch_frozen ON abstract_tracking_migration_batches;
CREATE TRIGGER abstract_tracking_manifest_batch_frozen
BEFORE UPDATE OR DELETE ON abstract_tracking_migration_batches
FOR EACH ROW EXECUTE FUNCTION guard_frozen_tracking_manifest();

CREATE OR REPLACE FUNCTION freeze_abstract_tracking_manifest(p_batch uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  namespace_count bigint;
  floor_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM abstract_tracking_migration_batches
    WHERE migration_batch_id = p_batch AND frozen_at IS NULL
  ) THEN
    RAISE EXCEPTION 'manifest batch is missing or already frozen';
  END IF;
  SELECT count(*) INTO namespace_count
  FROM abstract_tracking_manifest_namespaces WHERE migration_batch_id = p_batch;
  SELECT count(*) INTO floor_count
  FROM abstract_tracking_manifest_floors WHERE migration_batch_id = p_batch;
  IF namespace_count = 0 OR floor_count < namespace_count * 2 THEN
    RAISE EXCEPTION 'manifest batch has incomplete namespace/floor coverage';
  END IF;
  UPDATE abstract_tracking_migration_batches
  SET frozen_at = clock_timestamp()
  WHERE migration_batch_id = p_batch;
END;
$$;
