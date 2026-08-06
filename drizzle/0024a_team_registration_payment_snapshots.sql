ALTER TABLE "team_registration_payment_attempts"
  ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(100),
  ADD COLUMN IF NOT EXISTS "category_code_snapshot" varchar(64),
  ADD COLUMN IF NOT EXISTS "category_name_snapshot" varchar(255),
  ADD COLUMN IF NOT EXISTS "pricing_round_code_snapshot" varchar(64),
  ADD COLUMN IF NOT EXISTS "pricing_round_name_snapshot" varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS "team_registration_payment_idempotency_unique"
  ON "team_registration_payment_attempts" ("registration_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
