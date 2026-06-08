-- 0019: Sponsor module
-- Adds sponsor landing-page content, packages, Drive-backed media, and
-- sponsor application tracking. This is intentionally separate from ticket
-- orders/payments/registrations.

DO $$ BEGIN
  CREATE TYPE "sponsor_package_type" AS ENUM ('booth', 'symposium', 'bundle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "sponsor_media_type" AS ENUM ('past_sponsor_logo', 'previous_year_impression', 'brochure', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "sponsor_application_status" AS ENUM ('submitted', 'under_review', 'approved', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "sponsor_payment_status" AS ENUM ('pending_review', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_event_profiles" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL UNIQUE,
  "about_title" varchar(255),
  "about_description" text,
  "organizer_logo_url" varchar(2000),
  "brochure_url" varchar(2000),
  "bank_name" varchar(255),
  "bank_account_name" varchar(255),
  "bank_account_number" varchar(50),
  "payment_note" text,
  "registration_open_at" timestamp,
  "registration_close_at" timestamp,
  "is_published" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_event_profiles_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_stats" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "value_text" varchar(50) NOT NULL,
  "label" varchar(255) NOT NULL,
  "description" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_stats_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_packages" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "package_type" "sponsor_package_type" NOT NULL,
  "code" varchar(50) NOT NULL,
  "option_label" varchar(100),
  "name" varchar(255) NOT NULL,
  "description" text,
  "price" numeric(10, 2) NOT NULL DEFAULT 0,
  "currency" varchar(3) NOT NULL DEFAULT 'THB',
  "quota" integer NOT NULL DEFAULT 0,
  "badge_text" varchar(100),
  "theme_key" varchar(50),
  "is_recommended" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_packages_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_package_features" (
  "id" serial PRIMARY KEY,
  "package_id" integer NOT NULL,
  "feature_text" varchar(500) NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_package_features_package_id_sponsor_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "sponsor_packages"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_package_components" (
  "id" serial PRIMARY KEY,
  "bundle_package_id" integer NOT NULL,
  "component_package_id" integer NOT NULL,
  "component_role" varchar(50),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_package_components_bundle_package_id_sponsor_packages_id_fk"
    FOREIGN KEY ("bundle_package_id") REFERENCES "sponsor_packages"("id") ON DELETE CASCADE,
  CONSTRAINT "sponsor_package_components_component_package_id_sponsor_packages_id_fk"
    FOREIGN KEY ("component_package_id") REFERENCES "sponsor_packages"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_benefits" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "title" varchar(255) NOT NULL,
  "description" text,
  "icon_key" varchar(50),
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_benefits_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_media_assets" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "media_type" "sponsor_media_type" NOT NULL,
  "title" varchar(255),
  "caption" varchar(500),
  "file_url" varchar(2000) NOT NULL,
  "file_name" varchar(255),
  "mime_type" varchar(100),
  "file_size" integer,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_media_assets_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_timeline_items" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "period_label" varchar(100) NOT NULL,
  "title" varchar(255) NOT NULL,
  "description" text,
  "start_date" timestamp,
  "end_date" timestamp,
  "is_highlight" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_timeline_items_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_applications" (
  "id" serial PRIMARY KEY,
  "application_no" varchar(50) NOT NULL UNIQUE,
  "event_id" integer NOT NULL,
  "company_name" varchar(255) NOT NULL,
  "contact_full_name" varchar(255) NOT NULL,
  "business_email" varchar(255) NOT NULL,
  "phone" varchar(50) NOT NULL,
  "billing_name" varchar(255) NOT NULL,
  "tax_id" varchar(13) NOT NULL,
  "billing_address" text NOT NULL,
  "payment_slip_url" varchar(2000),
  "payment_slip_file_name" varchar(255),
  "logo_url" varchar(2000),
  "logo_file_name" varchar(255),
  "total_amount" numeric(10, 2) NOT NULL DEFAULT 0,
  "currency" varchar(3) NOT NULL DEFAULT 'THB',
  "application_status" "sponsor_application_status" NOT NULL DEFAULT 'submitted',
  "payment_status" "sponsor_payment_status" NOT NULL DEFAULT 'pending_review',
  "internal_note" text,
  "rejection_reason" text,
  "reviewed_by" integer,
  "reviewed_at" timestamp,
  "confirmed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_applications_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "sponsor_applications_reviewed_by_backoffice_users_id_fk"
    FOREIGN KEY ("reviewed_by") REFERENCES "backoffice_users"("id") ON DELETE SET NULL,
  CONSTRAINT "sponsor_applications_tax_id_13_digits_chk"
    CHECK ("tax_id" ~ '^[0-9]{13}$')
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sponsor_application_items" (
  "id" serial PRIMARY KEY,
  "application_id" integer NOT NULL,
  "package_id" integer,
  "package_type" "sponsor_package_type" NOT NULL,
  "package_name_snapshot" varchar(255) NOT NULL,
  "price_snapshot" numeric(10, 2) NOT NULL DEFAULT 0,
  "quantity" integer NOT NULL DEFAULT 1,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "sponsor_application_items_application_id_sponsor_applications_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "sponsor_applications"("id") ON DELETE CASCADE,
  CONSTRAINT "sponsor_application_items_package_id_sponsor_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "sponsor_packages"("id") ON DELETE SET NULL,
  CONSTRAINT "sponsor_application_items_quantity_positive_chk"
    CHECK ("quantity" > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_sponsor_packages_event_code_unique"
  ON "sponsor_packages"("event_id", "code");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_stats_event_sort"
  ON "sponsor_stats"("event_id", "sort_order");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_packages_event_type_sort"
  ON "sponsor_packages"("event_id", "package_type", "sort_order");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_package_features_package_sort"
  ON "sponsor_package_features"("package_id", "sort_order");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_package_components_bundle"
  ON "sponsor_package_components"("bundle_package_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_media_event_type_sort"
  ON "sponsor_media_assets"("event_id", "media_type", "sort_order");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_timeline_event_sort"
  ON "sponsor_timeline_items"("event_id", "sort_order");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_applications_event_status_created"
  ON "sponsor_applications"("event_id", "application_status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sponsor_application_items_package"
  ON "sponsor_application_items"("package_id");
