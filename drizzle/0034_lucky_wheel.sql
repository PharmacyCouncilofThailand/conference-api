BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS lucky_wheels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  main_session_id integer NOT NULL REFERENCES sessions(id),
  enabled boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  pool_revision integer NOT NULL DEFAULT 1,
  published_configuration jsonb,
  collection_instructions jsonb,
  collection_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheels_version_positive_check CHECK (version > 0),
  CONSTRAINT lucky_wheels_pool_revision_positive_check CHECK (pool_revision > 0),
  CONSTRAINT lucky_wheels_configuration_object_check CHECK (
    published_configuration IS NULL OR jsonb_typeof(published_configuration) = 'object'
  ),
  CONSTRAINT lucky_wheels_collection_instructions_object_check CHECK (
    collection_instructions IS NULL OR jsonb_typeof(collection_instructions) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheels_event_unique
  ON lucky_wheels (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheels_event_main_session_unique
  ON lucky_wheels (event_id, main_session_id);

CREATE TABLE IF NOT EXISTS lucky_wheel_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  object_key text NOT NULL,
  public_url text NOT NULL,
  mime_type varchar(32) NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  size_bytes integer NOT NULL,
  created_by integer REFERENCES backoffice_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT lucky_wheel_images_dimensions_check CHECK (width > 0 AND height > 0),
  CONSTRAINT lucky_wheel_images_size_check CHECK (size_bytes > 0),
  CONSTRAINT lucky_wheel_images_object_key_nonblank_check CHECK (btrim(object_key) <> ''),
  CONSTRAINT lucky_wheel_images_public_url_nonblank_check CHECK (btrim(public_url) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_images_object_key_unique
  ON lucky_wheel_images (object_key);
CREATE INDEX IF NOT EXISTS lucky_wheel_images_event_created_idx
  ON lucky_wheel_images (event_id, created_at);

CREATE TABLE IF NOT EXISTS lucky_wheel_segments (
  id uuid PRIMARY KEY,
  wheel_id uuid NOT NULL REFERENCES lucky_wheels(id),
  kind varchar(16) NOT NULL,
  name_th varchar(160) NOT NULL,
  name_en varchar(160) NOT NULL,
  image_id uuid REFERENCES lucky_wheel_images(id),
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL,
  remaining integer,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_segments_kind_check CHECK (kind IN ('prize', 'no_prize')),
  CONSTRAINT lucky_wheel_segments_name_th_nonblank_check CHECK (btrim(name_th) <> ''),
  CONSTRAINT lucky_wheel_segments_name_en_nonblank_check CHECK (btrim(name_en) <> ''),
  CONSTRAINT lucky_wheel_segments_position_check CHECK (position >= 0 AND position <= 255),
  CONSTRAINT lucky_wheel_segments_quantity_consistency_check CHECK (
    (kind = 'prize' AND remaining IS NOT NULL AND remaining >= 0)
    OR (kind = 'no_prize' AND remaining IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_segments_wheel_position_unique
  ON lucky_wheel_segments (wheel_id, position);
CREATE INDEX IF NOT EXISTS lucky_wheel_segments_wheel_live_idx
  ON lucky_wheel_segments (wheel_id, enabled, position);

CREATE TABLE IF NOT EXISTS lucky_wheel_spins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wheel_id uuid NOT NULL REFERENCES lucky_wheels(id),
  event_id integer NOT NULL REFERENCES events(id),
  user_id integer NOT NULL REFERENCES users(id),
  play_date date NOT NULL,
  attendance_id uuid NOT NULL REFERENCES session_daily_checkins(id),
  attendance_checked_in_at timestamptz NOT NULL,
  segment_id uuid NOT NULL REFERENCES lucky_wheel_segments(id),
  outcome_kind varchar(16) NOT NULL,
  awarded_name_th varchar(160) NOT NULL,
  awarded_name_en varchar(160) NOT NULL,
  awarded_image_key text,
  configuration_version integer NOT NULL,
  pool_revision integer NOT NULL,
  configuration_snapshot jsonb NOT NULL,
  outcome_snapshot jsonb NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  reward_token_digest char(64),
  reward_token_envelope text,
  reward_code_digest char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_spins_outcome_kind_check CHECK (outcome_kind IN ('prize', 'no_prize')),
  CONSTRAINT lucky_wheel_spins_configuration_version_check CHECK (configuration_version > 0),
  CONSTRAINT lucky_wheel_spins_pool_revision_check CHECK (pool_revision > 0),
  CONSTRAINT lucky_wheel_spins_request_hash_check CHECK (request_hash ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT lucky_wheel_spins_reward_no_prize_check CHECK (
    outcome_kind = 'prize'
    OR (reward_token_digest IS NULL AND reward_token_envelope IS NULL AND reward_code_digest IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_spins_event_user_day_unique
  ON lucky_wheel_spins (event_id, user_id, play_date);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_spins_event_user_request_unique
  ON lucky_wheel_spins (event_id, user_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_spins_reward_token_digest_unique
  ON lucky_wheel_spins (reward_token_digest)
  WHERE reward_token_digest IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_spins_reward_code_digest_unique
  ON lucky_wheel_spins (reward_code_digest)
  WHERE reward_code_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS lucky_wheel_spins_event_created_idx
  ON lucky_wheel_spins (event_id, created_at);

CREATE TABLE IF NOT EXISTS lucky_wheel_audit_events (
  id bigserial PRIMARY KEY,
  wheel_id uuid NOT NULL REFERENCES lucky_wheels(id),
  event_id integer NOT NULL REFERENCES events(id),
  actor_backoffice_user_id integer NOT NULL REFERENCES backoffice_users(id),
  operation varchar(64) NOT NULL,
  idempotency_key uuid,
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_audit_events_operation_nonblank_check CHECK (btrim(operation) <> ''),
  CONSTRAINT lucky_wheel_audit_events_reason_nonblank_check CHECK (
    reason IS NULL OR btrim(reason) <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_audit_events_request_unique
  ON lucky_wheel_audit_events (event_id, actor_backoffice_user_id, operation, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS lucky_wheel_audit_events_wheel_created_idx
  ON lucky_wheel_audit_events (wheel_id, created_at);

CREATE TABLE IF NOT EXISTS lucky_wheel_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id uuid NOT NULL REFERENCES lucky_wheel_spins(id),
  event_id integer NOT NULL REFERENCES events(id),
  claim_generation integer NOT NULL DEFAULT 1,
  status varchar(16) NOT NULL DEFAULT 'open',
  redeemed_at timestamptz,
  redeemed_by integer REFERENCES backoffice_users(id),
  collection_point varchar(255),
  delivered_details text,
  confirmation_idempotency_key uuid,
  confirmation_request_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_redemptions_claim_generation_check CHECK (claim_generation > 0),
  CONSTRAINT lucky_wheel_redemptions_status_check CHECK (status IN ('open', 'redeemed')),
  CONSTRAINT lucky_wheel_redemptions_state_check CHECK (
    (status = 'open' AND redeemed_at IS NULL AND redeemed_by IS NULL)
    OR
    (status = 'redeemed' AND redeemed_at IS NOT NULL AND redeemed_by IS NOT NULL
      AND collection_point IS NOT NULL AND btrim(collection_point) <> '')
  ),
  CONSTRAINT lucky_wheel_redemptions_request_hash_check CHECK (
    confirmation_request_hash IS NULL OR confirmation_request_hash ~ '^[0-9a-fA-F]{64}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_redemptions_spin_unique
  ON lucky_wheel_redemptions (spin_id);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_redemptions_confirmation_request_unique
  ON lucky_wheel_redemptions (event_id, redeemed_by, confirmation_idempotency_key)
  WHERE confirmation_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS lucky_wheel_redemptions_event_status_idx
  ON lucky_wheel_redemptions (event_id, status, created_at);

CREATE TABLE IF NOT EXISTS lucky_wheel_redemption_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id uuid NOT NULL REFERENCES lucky_wheel_redemptions(id),
  spin_id uuid NOT NULL REFERENCES lucky_wheel_spins(id),
  event_id integer NOT NULL REFERENCES events(id),
  claim_generation integer NOT NULL,
  actor_backoffice_user_id integer NOT NULL REFERENCES backoffice_users(id),
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  collection_point varchar(255) NOT NULL,
  delivered_details text,
  CONSTRAINT lucky_wheel_redemption_confirmations_generation_check CHECK (claim_generation > 0),
  CONSTRAINT lucky_wheel_redemption_confirmations_request_hash_check CHECK (
    request_hash ~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT lucky_wheel_redemption_confirmations_collection_point_check CHECK (
    btrim(collection_point) <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_redemption_confirmations_generation_unique
  ON lucky_wheel_redemption_confirmations (redemption_id, claim_generation);
CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_redemption_confirmations_request_unique
  ON lucky_wheel_redemption_confirmations (event_id, actor_backoffice_user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS lucky_wheel_redemption_confirmations_spin_idx
  ON lucky_wheel_redemption_confirmations (spin_id, claim_generation, confirmed_at);

CREATE TABLE IF NOT EXISTS lucky_wheel_redemption_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id uuid NOT NULL REFERENCES lucky_wheel_redemptions(id),
  event_id integer NOT NULL REFERENCES events(id),
  actor_backoffice_user_id integer NOT NULL REFERENCES backoffice_users(id),
  from_generation integer NOT NULL,
  to_generation integer NOT NULL,
  reopen boolean NOT NULL,
  reason text NOT NULL,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lucky_wheel_redemption_corrections_generation_check CHECK (
    from_generation > 0 AND to_generation > 0 AND to_generation >= from_generation
  ),
  CONSTRAINT lucky_wheel_redemption_corrections_reason_nonblank_check CHECK (btrim(reason) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_wheel_redemption_corrections_request_unique
  ON lucky_wheel_redemption_corrections (event_id, actor_backoffice_user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS lucky_wheel_redemption_corrections_redemption_idx
  ON lucky_wheel_redemption_corrections (redemption_id, created_at);

CREATE OR REPLACE FUNCTION validate_lucky_wheel_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_session RECORD;
BEGIN
  IF NEW.enabled THEN
    SELECT event_id, is_main_session, start_time, end_time
      INTO target_session
    FROM sessions
    WHERE id = NEW.main_session_id;

    IF NOT FOUND
       OR target_session.event_id <> NEW.event_id
       OR target_session.is_main_session IS NOT TRUE THEN
      RAISE EXCEPTION 'Lucky wheel must target the configured event Main Session';
    END IF;

    IF target_session.start_time >= target_session.end_time THEN
      RAISE EXCEPTION 'Lucky wheel Main Session must have a valid time window';
    END IF;

    IF NEW.published_configuration IS NULL
       OR NEW.collection_instructions IS NULL
       OR NEW.collection_deadline IS NULL THEN
      RAISE EXCEPTION 'Lucky wheel must have published configuration and collection settings before enabling';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lucky_wheels_activation_guard ON lucky_wheels;
CREATE TRIGGER lucky_wheels_activation_guard
BEFORE INSERT OR UPDATE OF
  event_id, main_session_id, enabled, published_configuration,
  collection_instructions, collection_deadline
ON lucky_wheels
FOR EACH ROW
EXECUTE FUNCTION validate_lucky_wheel_activation();

COMMIT;
