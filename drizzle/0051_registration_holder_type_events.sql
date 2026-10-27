-- Audit trail for PRIS holder type decisions. Additive only; registrations are untouched.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS registration_holder_type_events (
  id serial PRIMARY KEY,
  registration_id integer NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  previous_type varchar(32),
  new_type varchar(32),
  previous_source text,
  new_source text NOT NULL,
  actor_id integer REFERENCES backoffice_users(id),
  reason text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registration_holder_type_events_registration_idx
  ON registration_holder_type_events(registration_id, created_at);
COMMIT;
