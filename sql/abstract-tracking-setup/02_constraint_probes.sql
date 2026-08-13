-- Disposable clone/test database only. This script intentionally runs in a
-- transaction and rolls back. Never run it against production.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF current_database() ILIKE '%prod%' THEN
    RAISE EXCEPTION 'constraint probes are forbidden on production-like databases';
  END IF;
END
$$;

BEGIN;
-- Permission/constraint probes belong here when the separated test roles are
-- provisioned. The rollback guarantees no test identifier survives.
SELECT 1 FROM abstract_tracking_runtime WHERE singleton = true FOR UPDATE;
ROLLBACK;
