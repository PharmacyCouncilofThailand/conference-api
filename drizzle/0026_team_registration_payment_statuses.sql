ALTER TYPE "public"."team_registration_payment_status"
  ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TYPE "public"."team_registration_payment_status"
  ADD VALUE IF NOT EXISTS 'duplicate_paid';

ALTER TYPE "public"."team_registration_payment_status"
  ADD VALUE IF NOT EXISTS 'refunded';
