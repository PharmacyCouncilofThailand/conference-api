-- TEST-HARNESS ONLY. This is not a production migration and must never be
-- treated as evidence that the authoritative Drizzle migration chain is complete.
--
-- Approved scope (2026-10-01): only the isolated Docker databases owned by
-- Compose project `session-invitations-test`.

BEGIN;

DO $$
BEGIN
  IF current_database() NOT IN (
    'confer_session_grants_runtime_test',
    'confer_session_grants_integration_test'
  ) THEN
    RAISE EXCEPTION
      'refusing session-invitations test prerequisite on database %',
      current_database();
  END IF;
END
$$;

ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS attendee_type varchar(20);

-- Historical schema prerequisite required by the current Backoffice event reader.
-- Test-harness only: the authoritative migration chain does not currently prove
-- creation of this column, so this must not be treated as deployment evidence.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS website_url varchar(500);

COMMIT;
