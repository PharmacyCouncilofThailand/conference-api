DO $$ BEGIN
  CREATE TYPE "public"."team_registration_status" AS ENUM ('draft', 'ready_for_payment', 'payment_pending', 'paid', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."team_registration_member_role" AS ENUM ('leader', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."team_registration_payment_status" AS ENUM ('creating', 'pending', 'paid', 'failed', 'expired', 'verification_required');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."team_registration_email_status" AS ENUM ('pending', 'processing', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "team_registration_configs" (
  "id" bigserial PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "timezone" varchar(64) DEFAULT 'Asia/Bangkok' NOT NULL,
  "registration_opens_at" timestamptz NOT NULL,
  "registration_closes_at" timestamptz NOT NULL,
  "min_members" smallint DEFAULT 3 NOT NULL,
  "max_members" smallint DEFAULT 5 NOT NULL,
  "min_age" smallint DEFAULT 15 NOT NULL,
  "max_age" smallint DEFAULT 30 NOT NULL,
  "draft_ttl_hours" integer DEFAULT 72 NOT NULL,
  "payment_attempt_ttl_minutes" integer DEFAULT 30 NOT NULL,
  "payment_profile_code" varchar(64) NOT NULL,
  "event_website_origin" varchar(500) NOT NULL,
  "payment_result_url" varchar(1000) NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "team_registration_config_window_check" CHECK (registration_closes_at > registration_opens_at),
  CONSTRAINT "team_registration_config_members_check" CHECK (min_members >= 1 AND max_members >= min_members),
  CONSTRAINT "team_registration_config_age_check" CHECK (min_age >= 1 AND max_age >= min_age),
  CONSTRAINT "team_registration_config_ttl_check" CHECK (draft_ttl_hours > 0 AND payment_attempt_ttl_minutes > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_configs_event_unique" ON "team_registration_configs" ("event_id");

CREATE TABLE IF NOT EXISTS "team_registration_categories" (
  "id" bigserial PRIMARY KEY,
  "config_id" bigint NOT NULL REFERENCES "team_registration_configs"("id") ON DELETE CASCADE,
  "code" varchar(64) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "education_level" varchar(32) NOT NULL,
  "pharmacy_rule" varchar(32) NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "team_registration_category_education_check" CHECK (education_level IN ('higher_education', 'upper_secondary')),
  CONSTRAINT "team_registration_category_pharmacy_check" CHECK (pharmacy_rule IN ('required', 'forbidden'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_categories_code_unique" ON "team_registration_categories" ("config_id", "code");

CREATE TABLE IF NOT EXISTS "team_registration_pricing_rounds" (
  "id" bigserial PRIMARY KEY,
  "config_id" bigint NOT NULL REFERENCES "team_registration_configs"("id") ON DELETE CASCADE,
  "code" varchar(64) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "team_registration_pricing_round_window_check" CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_pricing_rounds_code_unique" ON "team_registration_pricing_rounds" ("config_id", "code");
CREATE INDEX IF NOT EXISTS "team_registration_pricing_rounds_window_idx" ON "team_registration_pricing_rounds" ("config_id", "starts_at", "ends_at");

CREATE TABLE IF NOT EXISTS "team_registration_prices" (
  "id" bigserial PRIMARY KEY,
  "pricing_round_id" bigint NOT NULL REFERENCES "team_registration_pricing_rounds"("id") ON DELETE CASCADE,
  "category_id" bigint NOT NULL REFERENCES "team_registration_categories"("id") ON DELETE CASCADE,
  "amount" numeric(12,2) NOT NULL CHECK (amount >= 0),
  "currency" char(3) DEFAULT 'THB' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_prices_round_category_unique" ON "team_registration_prices" ("pricing_round_id", "category_id");

CREATE TABLE IF NOT EXISTS "team_registration_otp_challenges" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "email_normalized" varchar(255) NOT NULL,
  "otp_hash" varchar(255) NOT NULL,
  "reference_code" char(5) NOT NULL,
  "attempt_count" smallint DEFAULT 0 NOT NULL,
  "max_attempts" smallint DEFAULT 5 NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "verified_at" timestamptz,
  "superseded_at" timestamptz,
  "request_ip_hash" varchar(255),
  "user_agent_hash" varchar(255),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "team_registration_otp_lookup_idx" ON "team_registration_otp_challenges" ("event_id", "email_normalized", "created_at");

CREATE TABLE IF NOT EXISTS "team_registration_access_sessions" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "leader_email_normalized" varchar(255) NOT NULL,
  "token_hash" varchar(255) NOT NULL,
  "otp_challenge_id" uuid REFERENCES "team_registration_otp_challenges"("id"),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "last_activity_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_access_sessions_token_unique" ON "team_registration_access_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "team_registration_access_sessions_owner_idx" ON "team_registration_access_sessions" ("event_id", "leader_email_normalized");

CREATE TABLE IF NOT EXISTS "team_registrations" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "registration_code" varchar(50) NOT NULL,
  "event_id" integer NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "config_id" bigint NOT NULL REFERENCES "team_registration_configs"("id"),
  "category_id" bigint NOT NULL REFERENCES "team_registration_categories"("id"),
  "team_name" varchar(255) NOT NULL,
  "team_name_normalized" varchar(255) NOT NULL,
  "leader_email" varchar(255) NOT NULL,
  "leader_email_normalized" varchar(255) NOT NULL,
  "status" "team_registration_status" DEFAULT 'draft' NOT NULL,
  "category_code_snapshot" varchar(64),
  "category_name_snapshot" varchar(255),
  "pricing_round_code_snapshot" varchar(64),
  "pricing_round_name_snapshot" varchar(255),
  "amount_snapshot" numeric(12,2),
  "currency_snapshot" char(3),
  "draft_expires_at" timestamptz NOT NULL,
  "locked_at" timestamptz,
  "paid_at" timestamptz,
  "expired_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registrations_code_unique" ON "team_registrations" ("registration_code");
CREATE UNIQUE INDEX IF NOT EXISTS "team_registrations_active_team_name_unique" ON "team_registrations" ("event_id", "team_name_normalized") WHERE "status" IN ('draft', 'ready_for_payment', 'payment_pending', 'paid');
CREATE INDEX IF NOT EXISTS "team_registrations_status_expiry_idx" ON "team_registrations" ("status", "draft_expires_at");

CREATE TABLE IF NOT EXISTS "team_registration_members" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "registration_id" uuid NOT NULL REFERENCES "team_registrations"("id") ON DELETE CASCADE,
  "position" smallint NOT NULL,
  "member_role" "team_registration_member_role" NOT NULL,
  "title" varchar(16) NOT NULL,
  "first_name" varchar(150) NOT NULL,
  "last_name" varchar(150) NOT NULL,
  "nickname" varchar(100),
  "age" smallint NOT NULL,
  "university" varchar(255),
  "faculty" varchar(255),
  "school" varchar(255),
  "school_grade" varchar(8),
  "is_pharmacy_student" boolean DEFAULT false NOT NULL,
  "food_drug_allergies" text,
  "email" varchar(255) NOT NULL,
  "email_normalized" varchar(255) NOT NULL,
  "phone_number" varchar(32) NOT NULL,
  "line_id" varchar(100) NOT NULL,
  "emergency_contact_name" varchar(255),
  "emergency_contact_phone" varchar(32),
  "sensitive_data_purged_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "team_registration_member_title_check" CHECK (title IN ('mr', 'miss')),
  CONSTRAINT "team_registration_member_grade_check" CHECK (school_grade IS NULL OR school_grade IN ('m4', 'm5', 'm6'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_members_position_unique" ON "team_registration_members" ("registration_id", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_members_email_unique" ON "team_registration_members" ("registration_id", "email_normalized");
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_members_one_leader_unique" ON "team_registration_members" ("registration_id") WHERE "member_role" = 'leader';

CREATE TABLE IF NOT EXISTS "team_registration_email_claims" (
  "id" bigserial PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "registration_id" uuid NOT NULL REFERENCES "team_registrations"("id") ON DELETE CASCADE,
  "member_id" uuid NOT NULL REFERENCES "team_registration_members"("id") ON DELETE CASCADE,
  "email_normalized" varchar(255) NOT NULL,
  "claimed_at" timestamptz DEFAULT now() NOT NULL,
  "released_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_active_email_claim_unique" ON "team_registration_email_claims" ("event_id", "email_normalized") WHERE "released_at" IS NULL;
CREATE INDEX IF NOT EXISTS "team_registration_email_claim_registration_idx" ON "team_registration_email_claims" ("registration_id");

CREATE TABLE IF NOT EXISTS "team_registration_payment_attempts" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "registration_id" uuid NOT NULL REFERENCES "team_registrations"("id") ON DELETE CASCADE,
  "attempt_number" integer NOT NULL,
  "idempotency_key" varchar(100) NOT NULL,
  "provider" varchar(32) DEFAULT 'paysolutions' NOT NULL,
  "payment_profile_code" varchar(64) NOT NULL,
  "merchant_id_snapshot" varchar(64) NOT NULL,
  "reference_no" varchar(12) NOT NULL,
  "provider_order_no" varchar(100),
  "category_code_snapshot" varchar(64) NOT NULL,
  "category_name_snapshot" varchar(255) NOT NULL,
  "pricing_round_code_snapshot" varchar(64) NOT NULL,
  "pricing_round_name_snapshot" varchar(255) NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "currency" char(3) DEFAULT 'THB' NOT NULL,
  "channel" varchar(32) DEFAULT 'promptpay' NOT NULL,
  "status" "team_registration_payment_status" DEFAULT 'creating' NOT NULL,
  "provider_status" varchar(100),
  "provider_status_name" varchar(100),
  "form_created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "paid_at" timestamptz,
  "failed_at" timestamptz,
  "last_inquired_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_payment_attempt_number_unique" ON "team_registration_payment_attempts" ("registration_id", "attempt_number");
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_payment_idempotency_unique" ON "team_registration_payment_attempts" ("registration_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_payment_reference_unique" ON "team_registration_payment_attempts" ("reference_no");
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_payment_active_unique" ON "team_registration_payment_attempts" ("registration_id") WHERE "status" IN ('creating', 'pending');
CREATE INDEX IF NOT EXISTS "team_registration_payment_status_expiry_idx" ON "team_registration_payment_attempts" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "team_registration_payment_events" (
  "id" bigserial PRIMARY KEY,
  "payment_attempt_id" uuid REFERENCES "team_registration_payment_attempts"("id") ON DELETE SET NULL,
  "event_type" varchar(64) NOT NULL,
  "provider_event_key" varchar(255),
  "reference_no" varchar(12),
  "provider_status" varchar(100),
  "payload_redacted" jsonb,
  "merchant_matches" boolean,
  "amount_matches" boolean,
  "currency_matches" boolean,
  "processed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_payment_provider_event_unique" ON "team_registration_payment_events" ("provider_event_key");

CREATE TABLE IF NOT EXISTS "team_registration_email_outbox" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "registration_id" uuid NOT NULL REFERENCES "team_registrations"("id") ON DELETE CASCADE,
  "member_id" uuid NOT NULL REFERENCES "team_registration_members"("id") ON DELETE CASCADE,
  "template_code" varchar(64) NOT NULL,
  "delivery_key" varchar(100) DEFAULT 'initial' NOT NULL,
  "recipient_email" varchar(255) NOT NULL,
  "payload_snapshot" jsonb NOT NULL,
  "status" "team_registration_email_status" DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz,
  "sent_at" timestamptz,
  "last_error_code" varchar(100),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_email_delivery_unique" ON "team_registration_email_outbox" ("registration_id", "member_id", "template_code", "delivery_key");
CREATE INDEX IF NOT EXISTS "team_registration_email_pending_idx" ON "team_registration_email_outbox" ("status", "next_attempt_at");

CREATE TABLE IF NOT EXISTS "team_registration_audit_logs" (
  "id" bigserial PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "actor_backoffice_user_id" integer REFERENCES "backoffice_users"("id") ON DELETE SET NULL,
  "action" varchar(100) NOT NULL,
  "entity_type" varchar(100) NOT NULL,
  "entity_id" varchar(100) NOT NULL,
  "change_reason" text,
  "before_redacted" jsonb,
  "after_redacted" jsonb,
  "request_id" varchar(100),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "team_registration_audit_entity_idx" ON "team_registration_audit_logs" ("entity_type", "entity_id", "created_at");
