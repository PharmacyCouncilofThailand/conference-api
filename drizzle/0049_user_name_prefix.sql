BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_prefix varchar(50);
COMMIT;
