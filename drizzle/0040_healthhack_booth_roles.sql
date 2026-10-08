BEGIN;

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'healthhack';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'booth';

DO $$
BEGIN
  CREATE TYPE health_hack_level AS ENUM ('m1','m2','m3','m4','m5','m6','undergraduate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS health_hack_level health_hack_level;
ALTER TABLE users ADD COLUMN IF NOT EXISTS booth_name varchar(255);

COMMIT;
