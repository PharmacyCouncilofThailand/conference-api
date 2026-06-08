-- 0020: Remove sponsor profile bank account fields
-- Payment account details are now hardcoded/configured by the sponsor frontend.

ALTER TABLE "sponsor_event_profiles"
  DROP COLUMN IF EXISTS "bank_name",
  DROP COLUMN IF EXISTS "bank_account_name",
  DROP COLUMN IF EXISTS "bank_account_number",
  DROP COLUMN IF EXISTS "payment_note";
