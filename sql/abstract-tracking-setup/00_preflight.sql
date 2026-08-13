-- Read-only production audit. Run with the read-only database role.
-- This file never updates abstracts, IDs, counters, or event codes.
\set ON_ERROR_STOP on

SELECT current_user AS current_user,
       current_database() AS database_name,
       current_setting('transaction_read_only') AS transaction_read_only;

-- Existing uniqueness invariant.
SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.abstracts'::regclass
  AND conname = 'abstracts_tracking_id_unique';

SELECT tracking_id, count(*) AS duplicate_count, array_agg(id ORDER BY id) AS abstract_ids
FROM abstracts
WHERE tracking_id IS NOT NULL
GROUP BY tracking_id
HAVING count(*) > 1
ORDER BY tracking_id;

-- Parse only a bounded numeric suffix. Oversized suffixes are reported, not cast.
WITH parsed AS (
  SELECT a.id, a.event_id, a.presentation_type, a.tracking_id, e.event_code,
         r.parts[1] AS prefix, r.parts[2] AS marker, r.parts[3] AS suffix_text
  FROM abstracts a
  JOIN events e ON e.id = a.event_id
  LEFT JOIN LATERAL regexp_match(a.tracking_id, '^(.+)-([OP])([0-9]+)$') AS r(parts) ON true
)
SELECT event_id, event_code, presentation_type,
       count(*) AS row_count,
       count(*) FILTER (WHERE tracking_id IS NULL) AS null_ids,
       count(*) FILTER (WHERE tracking_id IS NOT NULL AND prefix IS NULL) AS malformed_ids,
       count(*) FILTER (WHERE suffix_text IS NOT NULL AND length(suffix_text) > 18) AS oversized_suffixes,
       count(*) FILTER (WHERE prefix IS NOT NULL AND prefix <> event_code) AS prefix_mismatches,
       count(*) FILTER (
         WHERE marker IS NOT NULL
           AND marker <> CASE presentation_type WHEN 'oral' THEN 'O' ELSE 'P' END
       ) AS type_mismatches,
       max(CASE WHEN suffix_text IS NOT NULL AND length(suffix_text) <= 18 THEN suffix_text::bigint END) AS observed_max_suffix
FROM parsed
GROUP BY event_id, event_code, presentation_type
ORDER BY event_id, presentation_type;

-- Prefix reuse across events is unsafe because the production uniqueness scope is global.
WITH parsed AS (
  SELECT a.event_id, r.parts[1] AS prefix, r.parts[2] AS marker
  FROM abstracts a
  CROSS JOIN LATERAL regexp_match(a.tracking_id, '^(.+)-([OP])([0-9]+)$') AS r(parts)
  WHERE a.tracking_id IS NOT NULL
)
SELECT prefix, marker, array_agg(DISTINCT event_id ORDER BY event_id) AS event_ids
FROM parsed
GROUP BY prefix, marker
HAVING count(DISTINCT event_id) > 1
ORDER BY prefix, marker;

-- Reproduce the incident candidate; P022 must remain untouched.
WITH series AS (
  SELECT e.id AS event_id, e.event_code,
         t.presentation_type,
         count(a.id)::bigint AS current_count,
         e.event_code || '-' || CASE t.presentation_type WHEN 'oral' THEN 'O' ELSE 'P' END
           || lpad((count(a.id) + 1)::text, 3, '0') AS legacy_candidate
  FROM events e
  CROSS JOIN (VALUES ('oral'::presentation_type), ('poster'::presentation_type)) t(presentation_type)
  LEFT JOIN abstracts a
    ON a.event_id = e.id AND a.presentation_type = t.presentation_type
  GROUP BY e.id, e.event_code, t.presentation_type
)
SELECT s.*, EXISTS (
  SELECT 1 FROM abstracts a WHERE a.tracking_id = s.legacy_candidate
) AS candidate_already_exists
FROM series s
WHERE s.event_code = 'PRIS-2026' AND s.presentation_type = 'poster';

-- Event-code capacity audit. New namespaces must be explicitly configured if
-- the rendered ID cannot fit the legacy column contract.
SELECT id, event_code, length(event_code) AS event_code_length
FROM events
WHERE length(event_code) > 74
ORDER BY length(event_code) DESC, id;
