-- Merchandise preorder module: 14 new tables + 1 sequence. Existing tables are untouched.
-- Apply by hand (the drizzle journal stops at 0007); see docs/merchandise-runbook.md.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- An old backup branch created same-named merch_* tables with different shapes: refuse to run
-- over any of them instead of failing half-way or silently reusing a wrong shape.
DO $$
DECLARE
  existing text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY ord) INTO existing
  FROM unnest(ARRAY['merch_stores', 'merch_categories', 'merch_images', 'merch_banners', 'merch_products', 'merch_variants', 'merch_bundle_components', 'merch_cart_items', 'merch_orders', 'merch_order_items', 'merch_payment_attempts', 'merch_payment_events', 'merch_email_outbox', 'merch_audit_log', 'merch_payment_reference_seq']) WITH ORDINALITY AS t(name, ord)
  WHERE to_regclass(name) IS NOT NULL;
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION '0043_merchandise: already exist: %', existing
      USING HINT = 'Rename or drop the old merch_* objects (see docs/merchandise-runbook.md) and run this file again.';
  END IF;
END
$$;

CREATE SEQUENCE merch_payment_reference_seq START 1;

CREATE TABLE merch_stores (
  event_id integer PRIMARY KEY REFERENCES events(id),
  enabled boolean NOT NULL DEFAULT false,
  opens_at timestamptz,
  closes_at timestamptz,
  production_info_th text,
  shipping_info_th text,
  next_order_seq integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_stores_window_check CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at),
  CONSTRAINT merch_stores_next_order_seq_check CHECK (next_order_seq >= 1)
);

CREATE TABLE merch_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  name_th text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  visible boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merch_categories_event_idx ON merch_categories (event_id, sort_order);

CREATE TABLE merch_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  object_key text NOT NULL,
  public_url text NOT NULL,
  mime_type text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  byte_size integer NOT NULL,
  uploaded_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_images_object_key_unique UNIQUE (object_key),
  CONSTRAINT merch_images_size_check CHECK (width > 0 AND height > 0 AND byte_size >= 0)
);
CREATE INDEX merch_images_event_idx ON merch_images (event_id, created_at);

CREATE TABLE merch_banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  image_id uuid NOT NULL REFERENCES merch_images(id),
  link_url text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merch_banners_event_idx ON merch_banners (event_id, sort_order);

CREATE TABLE merch_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  kind text NOT NULL,
  name_th text NOT NULL,
  description_th text,
  size_chart_th text,
  image_ids uuid[] NOT NULL DEFAULT '{}',
  category_id uuid REFERENCES merch_categories(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  publish_state text NOT NULL DEFAULT 'draft',
  sale_enabled boolean NOT NULL DEFAULT false,
  base_price integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_products_kind_check CHECK (kind IN ('single', 'bundle')),
  CONSTRAINT merch_products_publish_state_check CHECK (publish_state IN ('draft', 'published')),
  CONSTRAINT merch_products_base_price_check CHECK (base_price IS NULL OR base_price >= 0)
);
CREATE INDEX merch_products_event_idx ON merch_products (event_id, sort_order);

CREATE TABLE merch_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES merch_products(id) ON DELETE CASCADE,
  size_th text,
  color_th text,
  price integer,
  sale_enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_variants_price_check CHECK (price IS NULL OR price >= 0)
);
CREATE UNIQUE INDEX merch_variants_product_option_unique
  ON merch_variants (product_id, coalesce(size_th, ''), coalesce(color_th, ''));

CREATE TABLE merch_bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_product_id uuid NOT NULL REFERENCES merch_products(id) ON DELETE CASCADE,
  component_product_id uuid NOT NULL REFERENCES merch_products(id),
  quantity_per_bundle integer NOT NULL DEFAULT 1,
  mode text NOT NULL,
  fixed_variant_id uuid,
  allowed_variant_ids uuid[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_bundle_components_quantity_check CHECK (quantity_per_bundle >= 1),
  CONSTRAINT merch_bundle_components_mode_check CHECK (mode IN ('fixed', 'selectable'))
);
CREATE INDEX merch_bundle_components_bundle_idx ON merch_bundle_components (bundle_product_id, sort_order);

CREATE TABLE merch_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  user_id integer NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL,
  variant_id uuid,
  bundle_selections jsonb NOT NULL DEFAULT '[]'::jsonb,
  selection_key text NOT NULL,
  quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_cart_items_quantity_check CHECK (quantity BETWEEN 1 AND 9999),
  CONSTRAINT merch_cart_items_selection_unique UNIQUE (user_id, event_id, product_id, selection_key)
);

CREATE TABLE merch_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  order_number text NOT NULL,
  buyer_user_id integer NOT NULL REFERENCES users(id),
  buyer_name text NOT NULL,
  buyer_email text NOT NULL,
  buyer_phone text,
  recipient_name text NOT NULL,
  recipient_phone text NOT NULL,
  address_line text NOT NULL,
  subdistrict text NOT NULL,
  district text NOT NULL,
  province text NOT NULL,
  postal_code text NOT NULL,
  company text,
  delivery_note text,
  subtotal integer NOT NULL,
  shipping_fee integer NOT NULL DEFAULT 50,
  total integer NOT NULL,
  payment_status text NOT NULL DEFAULT 'pending',
  paid_at timestamptz,
  paid_at_source text,
  paid_attempt_id uuid,
  shipping_status text NOT NULL DEFAULT 'not_shipped',
  carrier text,
  tracking_id text,
  shipped_at timestamptz,
  idempotency_key text NOT NULL,
  idempotency_fingerprint text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_orders_order_number_unique UNIQUE (order_number),
  CONSTRAINT merch_orders_idempotency_unique UNIQUE (buyer_user_id, idempotency_key),
  CONSTRAINT merch_orders_money_check CHECK (subtotal >= 0 AND shipping_fee >= 0 AND total >= 0),
  CONSTRAINT merch_orders_payment_status_check CHECK (payment_status IN ('pending', 'paid')),
  CONSTRAINT merch_orders_paid_at_source_check CHECK (paid_at_source IS NULL OR paid_at_source IN ('provider', 'first_seen')),
  CONSTRAINT merch_orders_shipping_status_check CHECK (shipping_status IN ('not_shipped', 'shipped'))
);
CREATE INDEX merch_orders_event_created_idx ON merch_orders (event_id, created_at);
CREATE INDEX merch_orders_buyer_idx ON merch_orders (buyer_user_id, created_at);

CREATE TABLE merch_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  variant_id uuid,
  kind text NOT NULL,
  name_th text NOT NULL,
  size_th text,
  color_th text,
  quantity integer NOT NULL,
  unit_price integer NOT NULL,
  line_total integer NOT NULL,
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_order_items_quantity_check CHECK (quantity BETWEEN 1 AND 9999),
  CONSTRAINT merch_order_items_money_check CHECK (unit_price >= 0 AND line_total >= 0),
  CONSTRAINT merch_order_items_kind_check CHECK (kind IN ('single', 'bundle'))
);
CREATE INDEX merch_order_items_order_idx ON merch_order_items (order_id, sort_order);

CREATE TABLE merch_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES merch_orders(id),
  reference_no char(12) NOT NULL,
  amount integer NOT NULL,
  status text NOT NULL,
  provider_order_no text,
  transaction_id text,
  provider_created_raw text,
  provider_expires_raw text,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz,
  qr_payload_enc bytea,
  paid_at timestamptz,
  paid_at_source text,
  last_check_at timestamptz,
  last_check_result text,
  next_check_at timestamptz,
  check_count integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  review_reason text,
  review_resolved_at timestamptz,
  review_resolved_by integer,
  review_note text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_payment_attempts_reference_unique UNIQUE (reference_no),
  CONSTRAINT merch_payment_attempts_amount_check CHECK (amount >= 0),
  CONSTRAINT merch_payment_attempts_status_check CHECK (status IN ('creating', 'active', 'create_failed', 'create_unknown', 'expired', 'paid')),
  CONSTRAINT merch_payment_attempts_paid_at_source_check CHECK (paid_at_source IS NULL OR paid_at_source IN ('provider', 'first_seen')),
  CONSTRAINT merch_payment_attempts_last_check_result_check CHECK (last_check_result IS NULL OR last_check_result IN ('paid', 'not_found', 'not_paid_status', 'mismatch', 'error')),
  CONSTRAINT merch_payment_attempts_review_reason_check CHECK (review_reason IS NULL OR review_reason IN ('duplicate_payment', 'amount_mismatch', 'merchant_mismatch', 'currency_mismatch', 'test_status_in_production'))
);
CREATE UNIQUE INDEX merch_payment_attempts_one_open
  ON merch_payment_attempts (order_id) WHERE status IN ('creating', 'active');
CREATE INDEX merch_payment_attempts_due_idx
  ON merch_payment_attempts (next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX merch_payment_attempts_order_idx ON merch_payment_attempts (order_id, created_at);

CREATE TABLE merch_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid REFERENCES merch_payment_attempts(id),
  kind text NOT NULL,
  reference_no text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  sanitized jsonb NOT NULL DEFAULT '{}'::jsonb,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_payment_events_kind_check CHECK (kind IN ('postback', 'inquiry'))
);
CREATE INDEX merch_payment_events_reference_idx ON merch_payment_events (reference_no, received_at);

CREATE TABLE merch_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES merch_orders(id),
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merch_email_outbox_order_type_unique UNIQUE (order_id, type),
  CONSTRAINT merch_email_outbox_type_check CHECK (type IN ('paid', 'shipped')),
  CONSTRAINT merch_email_outbox_status_check CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown'))
);
CREATE INDEX merch_email_outbox_due_idx ON merch_email_outbox (status, next_attempt_at);

CREATE TABLE merch_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id integer NOT NULL REFERENCES events(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  actor_backoffice_user_id integer,
  reason text,
  contact_confirmed boolean,
  contact_note text,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merch_audit_log_entity_idx ON merch_audit_log (entity_type, entity_id, created_at);

COMMENT ON COLUMN merch_products.base_price IS 'THB, whole baht';
COMMENT ON COLUMN merch_variants.price IS 'THB, whole baht';
COMMENT ON COLUMN merch_orders.subtotal IS 'THB, whole baht';
COMMENT ON COLUMN merch_orders.shipping_fee IS 'THB, whole baht';
COMMENT ON COLUMN merch_orders.total IS 'THB, whole baht';
COMMENT ON COLUMN merch_order_items.unit_price IS 'THB, whole baht';
COMMENT ON COLUMN merch_order_items.line_total IS 'THB, whole baht';
COMMENT ON COLUMN merch_payment_attempts.amount IS 'THB, whole baht';

COMMIT;
