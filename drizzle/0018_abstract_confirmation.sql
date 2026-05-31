-- 0018: Abstract approval confirmation flow
-- Adds approval/rejection/confirmation timestamps + reviewer audit to `abstracts`,
-- and a separate `abstract_confirmations` table for hashed single-use tokens.

ALTER TABLE "abstracts"
  ADD COLUMN IF NOT EXISTS "approved_at"     timestamp NULL,
  ADD COLUMN IF NOT EXISTS "rejected_at"     timestamp NULL,
  ADD COLUMN IF NOT EXISTS "confirmed_at"    timestamp NULL,
  ADD COLUMN IF NOT EXISTS "review_comment"  text       NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_by"     integer    NULL;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "abstracts"
    ADD CONSTRAINT "abstracts_reviewed_by_backoffice_users_id_fk"
    FOREIGN KEY ("reviewed_by") REFERENCES "backoffice_users"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Backfill: best-effort approvedAt for existing accepted abstracts
UPDATE "abstracts"
   SET "approved_at" = COALESCE("approved_at", "created_at")
 WHERE "status" = 'accepted' AND "approved_at" IS NULL;
--> statement-breakpoint

UPDATE "abstracts"
   SET "rejected_at" = COALESCE("rejected_at", "created_at")
 WHERE "status" = 'rejected' AND "rejected_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "abstract_confirmations" (
  "id"           serial PRIMARY KEY,
  "abstract_id"  integer NOT NULL,
  "token_hash"   varchar(128) NOT NULL,
  "expires_at"   timestamp NOT NULL,
  "used_at"      timestamp NULL,
  "sent_at"      timestamp NOT NULL DEFAULT now(),
  "created_at"   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "abstract_confirmations_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "abstract_confirmations_abstract_id_abstracts_id_fk"
    FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_abstract_confirmations_abstract"
  ON "abstract_confirmations"("abstract_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_abstract_confirmations_active"
  ON "abstract_confirmations"("abstract_id")
  WHERE "used_at" IS NULL;
