-- 0016: Add missing registered_from_event column to users table
-- This column tracks which event the user signed up from (e.g. new-pharmacist app)

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "registered_from_event" varchar(50);
