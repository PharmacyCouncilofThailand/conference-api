BEGIN;

-- The application must be quiesced while this migration runs. Abort before any
-- schema or data change if legacy payment facts cannot be migrated safely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM team_registrations AS registration
    LEFT JOIN team_registration_payment_attempts AS attempt
      ON attempt.registration_id = registration.id
     AND attempt.status = 'paid'
    WHERE registration.status = 'paid'
    GROUP BY registration.id
    HAVING count(attempt.id) <> 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'payment retry migration aborted: every paid registration must have exactly one paid attempt';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts AS attempt
    JOIN team_registrations AS registration ON registration.id = attempt.registration_id
    WHERE attempt.status = 'paid'
      AND registration.status <> 'paid'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'payment retry migration aborted: a paid attempt belongs to a non-paid registration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts
    WHERE status IN ('creating', 'pending')
    GROUP BY registration_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'payment retry migration aborted: a registration has multiple active attempts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_configs
    WHERE is_enabled = true
    GROUP BY payment_profile_code
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'payment retry migration aborted: a payment profile is enabled for multiple events';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts
    GROUP BY registration_id, attempt_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'payment retry migration aborted: duplicate attempt numbers exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts
    WHERE idempotency_key IS NOT NULL
    GROUP BY registration_id, idempotency_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'payment retry migration aborted: duplicate idempotency keys exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts
    GROUP BY reference_no
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'payment retry migration aborted: duplicate payment references exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts
    WHERE status = 'paid'
      AND paid_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'payment retry migration aborted: a paid attempt has no paid timestamp';
  END IF;
END $$;

ALTER TABLE team_registrations
  ADD COLUMN revision integer DEFAULT 1 NOT NULL,
  ADD COLUMN payment_reservation_expires_at timestamptz;

ALTER TABLE team_registration_payment_attempts
  ADD COLUMN registration_revision_snapshot integer DEFAULT 0 NOT NULL,
  ADD COLUMN is_winner boolean DEFAULT false NOT NULL,
  ADD COLUMN customer_email_snapshot varchar(255),
  ADD COLUMN customer_name_snapshot varchar(255),
  ADD COLUMN product_detail_snapshot varchar(255),
  ADD COLUMN form_action_url_snapshot varchar(1000),
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN refunded_at timestamptz,
  ADD COLUMN cancellation_reason varchar(64),
  ADD COLUMN superseded_by_attempt_id uuid,
  ADD COLUMN review_reason varchar(64),
  ADD COLUMN action_required boolean DEFAULT false NOT NULL,
  ADD COLUMN action_resolved_at timestamptz,
  ADD COLUMN action_resolution varchar(32),
  ADD COLUMN action_resolution_note text,
  ADD COLUMN next_reconcile_at timestamptz,
  ADD COLUMN reconciliation_deadline_at timestamptz,
  ADD COLUMN inquiry_lease_until timestamptz,
  ADD COLUMN terminal_reconciliation_count integer DEFAULT 0 NOT NULL;

ALTER TABLE team_registration_payment_attempts
  ADD CONSTRAINT team_registration_payment_superseded_by_attempt_fk
  FOREIGN KEY (superseded_by_attempt_id)
  REFERENCES team_registration_payment_attempts(id)
  ON DELETE SET NULL;

-- Preserve the best available display snapshots for legacy diagnostics. The
-- provider form-action URL is environment-owned, so it intentionally remains
-- nullable for legacy rows. State-aware application inserts require all four.
UPDATE team_registration_payment_attempts AS attempt
SET
  customer_email_snapshot = left(registration.leader_email, 255),
  customer_name_snapshot = left(
    COALESCE(
      NULLIF((
        SELECT btrim(concat_ws(' ', member.first_name, member.last_name))
        FROM team_registration_members AS member
        WHERE member.registration_id = registration.id
          AND member.member_role = 'leader'
        ORDER BY member.position
        LIMIT 1
      ), ''),
      registration.team_name
    ),
    255
  ),
  product_detail_snapshot = left(
    concat_ws(
      ' - ',
      COALESCE(
        NULLIF(attempt.category_name_snapshot, ''),
        NULLIF(category.display_name, ''),
        NULLIF(attempt.category_code_snapshot, ''),
        'Team Registration'
      ),
      registration.team_name
    ),
    255
  )
FROM team_registrations AS registration
LEFT JOIN team_registration_categories AS category ON category.id = registration.category_id
WHERE registration.id = attempt.registration_id;

UPDATE team_registration_payment_attempts AS attempt
SET
  is_winner = true,
  registration_revision_snapshot = 1
FROM team_registrations AS registration
WHERE registration.id = attempt.registration_id
  AND registration.status = 'paid'
  AND attempt.status = 'paid';

UPDATE team_registration_payment_attempts
SET
  action_required = true,
  review_reason = 'legacy_verification_required',
  action_resolved_at = NULL,
  action_resolution = NULL,
  action_resolution_note = NULL,
  updated_at = now()
WHERE status = 'verification_required';

UPDATE team_registration_payment_attempts
SET
  status = 'cancelled',
  cancelled_at = now(),
  cancellation_reason = 'migration_safety',
  terminal_reconciliation_count = 0,
  reconciliation_deadline_at = now() + interval '24 hours',
  next_reconcile_at = now(),
  inquiry_lease_until = NULL,
  updated_at = now()
WHERE status IN ('creating', 'pending');

ALTER TABLE team_registrations
  ADD CONSTRAINT team_registrations_revision_check
  CHECK (revision >= 1);

ALTER TABLE team_registration_payment_attempts
  ADD CONSTRAINT team_registration_payment_revision_check
    CHECK (registration_revision_snapshot >= 0),
  ADD CONSTRAINT team_registration_payment_terminal_count_check
    CHECK (terminal_reconciliation_count BETWEEN 0 AND 4),
  ADD CONSTRAINT team_registration_payment_cancellation_pair_check
    CHECK ((cancelled_at IS NULL) = (cancellation_reason IS NULL)),
  ADD CONSTRAINT team_registration_payment_winner_paid_check
    CHECK (NOT is_winner OR (paid_at IS NOT NULL AND status IN ('paid', 'refunded'))),
  ADD CONSTRAINT team_registration_payment_refunded_check
    CHECK (status <> 'refunded' OR (refunded_at IS NOT NULL AND paid_at IS NOT NULL)),
  ADD CONSTRAINT team_registration_payment_duplicate_not_winner_check
    CHECK (status <> 'duplicate_paid' OR (NOT is_winner AND paid_at IS NOT NULL)),
  ADD CONSTRAINT team_registration_payment_cancellation_reason_check
    CHECK (
      cancellation_reason IS NULL
      OR cancellation_reason IN (
        'superseded_by_retry',
        'registration_edited',
        'sibling_paid',
        'payment_review_required',
        'provider_cancelled',
        'migration_safety'
      )
    ),
  ADD CONSTRAINT team_registration_payment_review_reason_check
    CHECK (
      review_reason IS NULL
      OR review_reason IN (
        'duplicate_payment',
        'other_payment_action_unresolved',
        'registration_revision_changed',
        'registration_not_payable',
        'registration_expired',
        'claims_released',
        'payment_reservation_changed',
        'payment_reservation_expired',
        'provider_paid_at_invalid',
        'reference_mismatch',
        'merchant_mismatch',
        'amount_mismatch',
        'currency_mismatch',
        'winner_refunded',
        'legacy_verification_required'
      )
    ),
  ADD CONSTRAINT team_registration_payment_action_resolution_check
    CHECK (action_resolution IS NULL OR action_resolution IN ('refunded', 'closed_no_fulfillment')),
  ADD CONSTRAINT team_registration_payment_action_fields_check
    CHECK (
      (
        action_required
        AND review_reason IS NOT NULL
        AND action_resolved_at IS NULL
        AND action_resolution IS NULL
        AND action_resolution_note IS NULL
      )
      OR
      (
        NOT action_required
        AND (
          (
            action_resolved_at IS NULL
            AND action_resolution IS NULL
            AND action_resolution_note IS NULL
          )
          OR
          (
            action_resolved_at IS NOT NULL
            AND action_resolution IS NOT NULL
            AND action_resolution_note IS NOT NULL
          )
        )
      )
    );

CREATE UNIQUE INDEX team_registration_payment_winner_unique
  ON team_registration_payment_attempts(registration_id)
  WHERE is_winner = true;

CREATE UNIQUE INDEX team_registration_configs_enabled_profile_unique
  ON team_registration_configs(payment_profile_code)
  WHERE is_enabled = true;

CREATE INDEX team_registration_payment_reconcile_due_idx
  ON team_registration_payment_attempts(status, next_reconcile_at, inquiry_lease_until)
  WHERE next_reconcile_at IS NOT NULL;

CREATE INDEX team_registration_payment_action_required_idx
  ON team_registration_payment_attempts(registration_id, attempt_number)
  WHERE action_required = true;

CREATE INDEX team_registration_payment_event_reference_type_created_idx
  ON team_registration_payment_events(reference_no, event_type, created_at);

CREATE TABLE team_registration_job_state (
  job_name varchar(64) PRIMARY KEY,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error_code varchar(100),
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Both historical idempotency-index shapes are intentionally retained. The
-- full index from 0024 and the nullable partial index from 0024a each preserve
-- uniqueness for every non-null state-aware idempotency key.

COMMIT;
