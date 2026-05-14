-- 0017: Align role/student-level support with src/database/schema.ts
-- Adds the student_level enum/column used by auth registration and ticket eligibility.

ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'pharmacist';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'medical_professional';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'student';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'general';--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."student_level" AS ENUM ('postgraduate', 'undergraduate');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "student_level" "public"."student_level";--> statement-breakpoint

ALTER TABLE "ticket_types"
  ADD COLUMN IF NOT EXISTS "allowed_student_levels" text;--> statement-breakpoint

COMMENT ON COLUMN "users"."student_level" IS 'Student education level for users with role=student';--> statement-breakpoint
COMMENT ON COLUMN "ticket_types"."allowed_student_levels" IS 'CSV of allowed student levels (postgraduate, undergraduate) or null for all';