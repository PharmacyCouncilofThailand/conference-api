-- Migration: Add allowedStudentLevels column to ticket_types table
-- This column stores CSV of student levels: "postgraduate,undergraduate" or null for all

ALTER TABLE "ticket_types" ADD COLUMN IF NOT EXISTS "allowed_student_levels" text;

-- Comment for documentation
COMMENT ON COLUMN "ticket_types"."allowed_student_levels" IS 'CSV of allowed student levels (postgraduate, undergraduate) or null for all';
