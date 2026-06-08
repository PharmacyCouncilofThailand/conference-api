-- 0021: Add configurable organizer logo for sponsor profile

ALTER TABLE "sponsor_event_profiles"
  ADD COLUMN IF NOT EXISTS "organizer_logo_url" varchar(2000);
