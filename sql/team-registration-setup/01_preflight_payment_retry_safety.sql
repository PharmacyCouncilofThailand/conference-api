\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

\echo '1. Paid registrations with more than one locally paid attempt (expect 0 rows)'
SELECT
  registration.id AS registration_id,
  registration.registration_code,
  count(attempt.id) AS paid_attempt_count
FROM team_registrations AS registration
JOIN team_registration_payment_attempts AS attempt
  ON attempt.registration_id = registration.id
 AND attempt.status::text = 'paid'
WHERE registration.status::text = 'paid'
GROUP BY registration.id, registration.registration_code
HAVING count(attempt.id) > 1
ORDER BY registration.registration_code;

\echo '2. Paid registrations with no locally paid attempt (expect 0 rows)'
SELECT
  registration.id AS registration_id,
  registration.registration_code
FROM team_registrations AS registration
WHERE registration.status::text = 'paid'
  AND NOT EXISTS (
    SELECT 1
    FROM team_registration_payment_attempts AS attempt
    WHERE attempt.registration_id = registration.id
      AND attempt.status::text = 'paid'
  )
ORDER BY registration.registration_code;

\echo '3. Paid attempts whose registration is not paid (expect 0 rows)'
SELECT
  attempt.id AS payment_attempt_id,
  attempt.reference_no,
  attempt.registration_id,
  registration.status::text AS registration_status
FROM team_registration_payment_attempts AS attempt
JOIN team_registrations AS registration ON registration.id = attempt.registration_id
WHERE attempt.status::text = 'paid'
  AND registration.status::text <> 'paid'
ORDER BY attempt.created_at;

\echo '4. Legacy verification-required attempts that will be quarantined for action'
SELECT
  attempt.id AS payment_attempt_id,
  attempt.registration_id,
  attempt.reference_no,
  attempt.provider_status,
  attempt.provider_status_name,
  attempt.created_at
FROM team_registration_payment_attempts AS attempt
WHERE attempt.status::text = 'verification_required'
ORDER BY attempt.created_at;

\echo '4b. Locally paid attempts with no paid timestamp (expect 0 rows)'
SELECT
  attempt.id AS payment_attempt_id,
  attempt.registration_id,
  attempt.reference_no
FROM team_registration_payment_attempts AS attempt
WHERE attempt.status::text = 'paid'
  AND attempt.paid_at IS NULL
ORDER BY attempt.created_at;

\echo '5. Registrations with more than one active attempt (expect 0 rows)'
SELECT
  registration_id,
  count(*) AS active_attempt_count,
  array_agg(id ORDER BY attempt_number) AS payment_attempt_ids
FROM team_registration_payment_attempts
WHERE status::text IN ('creating', 'pending')
GROUP BY registration_id
HAVING count(*) > 1
ORDER BY registration_id;

\echo '6. Enabled events sharing one payment profile (expect 0 rows)'
SELECT
  payment_profile_code,
  count(*) AS enabled_event_count,
  array_agg(event_id ORDER BY event_id) AS event_ids
FROM team_registration_configs
WHERE is_enabled = true
GROUP BY payment_profile_code
HAVING count(*) > 1
ORDER BY payment_profile_code;

\echo '7a. Duplicate attempt numbers (expect 0 rows)'
SELECT
  registration_id,
  attempt_number,
  count(*) AS duplicate_count
FROM team_registration_payment_attempts
GROUP BY registration_id, attempt_number
HAVING count(*) > 1
ORDER BY registration_id, attempt_number;

\echo '7b. Duplicate non-null idempotency keys (expect 0 rows)'
SELECT
  registration_id,
  idempotency_key,
  count(*) AS duplicate_count
FROM team_registration_payment_attempts
WHERE idempotency_key IS NOT NULL
GROUP BY registration_id, idempotency_key
HAVING count(*) > 1
ORDER BY registration_id, idempotency_key;

\echo '7c. Duplicate provider references (expect 0 rows)'
SELECT
  reference_no,
  count(*) AS duplicate_count
FROM team_registration_payment_attempts
GROUP BY reference_no
HAVING count(*) > 1
ORDER BY reference_no;

\echo '8. Current team_registration_payment_idempotency_unique definition'
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'team_registration_payment_attempts'
  AND indexname = 'team_registration_payment_idempotency_unique';

\echo '9a. Installed Team Registration columns'
SELECT
  table_name,
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name LIKE 'team_registration%'
ORDER BY table_name, ordinal_position;

\echo '9b. Installed Team Registration enum values'
SELECT
  type_name,
  enum_value,
  sort_order
FROM (
  SELECT
    pg_type.typname AS type_name,
    pg_enum.enumlabel AS enum_value,
    pg_enum.enumsortorder AS sort_order
  FROM pg_type
  JOIN pg_enum ON pg_enum.enumtypid = pg_type.oid
  JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
  WHERE pg_namespace.nspname = current_schema()
    AND pg_type.typname LIKE 'team_registration%'
) AS installed_enums
ORDER BY type_name, sort_order;

\echo '10. Zero-anomaly summary (migration_blocker_count must be 0)'
WITH anomaly_counts AS (
  SELECT 'paid_registration_multiple_paid_attempts' AS anomaly, count(*) AS anomaly_count
  FROM (
    SELECT registration.id
    FROM team_registrations AS registration
    JOIN team_registration_payment_attempts AS attempt
      ON attempt.registration_id = registration.id
     AND attempt.status::text = 'paid'
    WHERE registration.status::text = 'paid'
    GROUP BY registration.id
    HAVING count(attempt.id) > 1
  ) AS anomalies

  UNION ALL

  SELECT 'paid_registration_without_paid_attempt', count(*)
  FROM team_registrations AS registration
  WHERE registration.status::text = 'paid'
    AND NOT EXISTS (
      SELECT 1
      FROM team_registration_payment_attempts AS attempt
      WHERE attempt.registration_id = registration.id
        AND attempt.status::text = 'paid'
    )

  UNION ALL

  SELECT 'paid_attempt_registration_not_paid', count(*)
  FROM team_registration_payment_attempts AS attempt
  JOIN team_registrations AS registration ON registration.id = attempt.registration_id
  WHERE attempt.status::text = 'paid'
    AND registration.status::text <> 'paid'

  UNION ALL

  SELECT 'paid_attempt_missing_paid_at', count(*)
  FROM team_registration_payment_attempts AS attempt
  WHERE attempt.status::text = 'paid'
    AND attempt.paid_at IS NULL

  UNION ALL

  SELECT 'multiple_active_attempts', count(*)
  FROM (
    SELECT registration_id
    FROM team_registration_payment_attempts
    WHERE status::text IN ('creating', 'pending')
    GROUP BY registration_id
    HAVING count(*) > 1
  ) AS anomalies

  UNION ALL

  SELECT 'duplicate_enabled_payment_profile', count(*)
  FROM (
    SELECT payment_profile_code
    FROM team_registration_configs
    WHERE is_enabled = true
    GROUP BY payment_profile_code
    HAVING count(*) > 1
  ) AS anomalies

  UNION ALL

  SELECT 'duplicate_attempt_number', count(*)
  FROM (
    SELECT registration_id, attempt_number
    FROM team_registration_payment_attempts
    GROUP BY registration_id, attempt_number
    HAVING count(*) > 1
  ) AS anomalies

  UNION ALL

  SELECT 'duplicate_idempotency_key', count(*)
  FROM (
    SELECT registration_id, idempotency_key
    FROM team_registration_payment_attempts
    WHERE idempotency_key IS NOT NULL
    GROUP BY registration_id, idempotency_key
    HAVING count(*) > 1
  ) AS anomalies

  UNION ALL

  SELECT 'duplicate_reference', count(*)
  FROM (
    SELECT reference_no
    FROM team_registration_payment_attempts
    GROUP BY reference_no
    HAVING count(*) > 1
  ) AS anomalies
)
SELECT
  anomaly,
  anomaly_count,
  sum(anomaly_count) OVER () AS migration_blocker_count
FROM anomaly_counts
ORDER BY anomaly;

ROLLBACK;
