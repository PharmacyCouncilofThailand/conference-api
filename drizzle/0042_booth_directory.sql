BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TYPE booth_type AS ENUM ('symposium','premium','standard');
CREATE TABLE booths (
 id serial PRIMARY KEY,
 event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
 name varchar(255) NOT NULL CHECK(length(btrim(name))>0),
 type booth_type NOT NULL,
 last_qualification_sequence integer NOT NULL DEFAULT 0 CHECK(last_qualification_sequence>=0),
 type_locked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,event_id)
);
CREATE INDEX booths_event_id_idx ON booths(event_id,id);
CREATE TABLE booth_members (
 id serial PRIMARY KEY,
 event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
 booth_id integer NOT NULL,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 joined_at timestamptz NOT NULL DEFAULT now(), first_ticket_confirmed_at timestamptz,
 qualifying_registration_id integer UNIQUE REFERENCES registrations(id) ON DELETE RESTRICT,
 qualifying_order_id integer UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
 qualified_at timestamptz, qualification_sequence integer, meal_coupon_eligible boolean,
 UNIQUE(event_id,user_id), UNIQUE(booth_id,qualification_sequence),
 FOREIGN KEY(booth_id,event_id) REFERENCES booths(id,event_id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(qualifying_registration_id,qualifying_order_id,qualified_at,qualification_sequence,meal_coupon_eligible)=0
  OR (num_nonnulls(qualifying_registration_id,qualifying_order_id,qualified_at,qualification_sequence,meal_coupon_eligible)=5
   AND qualification_sequence>0 AND first_ticket_confirmed_at IS NOT NULL))
);
CREATE INDEX booth_members_booth_id_idx ON booth_members(booth_id,id);
COMMIT;
