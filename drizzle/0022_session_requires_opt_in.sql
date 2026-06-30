ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "requires_opt_in" boolean DEFAULT false NOT NULL;
