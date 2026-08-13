# Durable abstract tracking rollout

This is a manual, fix-forward rollout. Do not run `drizzle-kit generate`,
`db:push`, or the old `COUNT(*)` allocator against production after cutover.

## Order

1. Run `00_preflight.sql` with the read-only production URL. Export the output.
   Keep every issued ID unchanged; for the incident, verify `P022` and set the
   reviewed poster floor to `22` (or a higher evidence-backed floor).
2. Apply `01_stage_manifest_tables.sql` with the migration URL. Load the
   reviewed CSVs using literal paths, for example:

   ```sh
   psql "$MANIFEST_LOADER_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -c "INSERT INTO abstract_tracking_migration_batches (migration_batch_id, expected_namespace_digest, expected_floor_digest) VALUES ('00000000-0000-0000-0000-000000000001', '<namespace-sha256>', '<floor-sha256>')"
   psql "$MANIFEST_LOADER_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -c "\\copy abstract_tracking_manifest_namespaces FROM '/restricted/event-namespaces.csv' CSV HEADER"
   psql "$MANIFEST_LOADER_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -c "\\copy abstract_tracking_manifest_floors FROM '/restricted/series-floors.csv' CSV HEADER"
   ```

   `\copy` does not interpolate `psql -v` variables. Freeze and digest the
   batch outside this repository; never edit a frozen batch.
3. Apply `drizzle/0028_abstract_tracking_allocator.sql` with the migration
   URL. It widens the column, imports existing IDs byte-for-byte, installs the
   durable allocation/alias registry, and leaves type-changing resubmits
   disabled until history is ready; initial allocations use the guarded counter
   immediately after the expand.
4. Load one row per `(event_id,presentation_type)` into
   `abstract_tracking_approved_floors`. Use `approved_floor=22` for PRIS poster
   only when the audit confirms P022 was issued. Never lower a floor. Load the
   reviewed rows explicitly (do not derive them from `COUNT(*)`):

   ```sql
   INSERT INTO abstract_tracking_approved_floors
     (event_id, presentation_type, approved_floor, evidence_source, approved_by, approved_at, approval_reason)
   SELECT event_id, presentation_type, approved_floor, evidence_source, approved_by, approved_at, approval_reason
   FROM abstract_tracking_manifest_floors
   WHERE migration_batch_id = '00000000-0000-0000-0000-000000000001';
   ```

   If the reviewed prefix differs from `events.event_code`, configure the
   namespace endpoint/namespace table before cutover and verify every existing
   ID remains an alias. Never lower a floor.
5. Run `02_online_backfill.sql`, then `02_backfill_verify.sql` and the read-only
   `02_expand_verify.sql`. Any missing namespace, NULL ID, or stale floor blocks
   the next step.
6. Run `03_cutover.sql`. It takes the exclusive advisory lock, raises counters
   with `GREATEST`, locks positive-floor namespaces, enables `history_ready`,
   and disables the legacy bridge. The next PRIS poster ID is floor + 1,
   normally `PRIS-2026-P023`. It never updates or deletes P022.
7. Run `04_post_cutover_verify.sql` and `05_runtime_health.sql` with the
   read-only URL. `/health/ready` must be 200 before reopening traffic.
8. Later, after all rows have non-null current history, run `07_prepare_hardening.sql`,
   verify it, and apply `drizzle/0029_abstract_tracking_hardening.sql`. This is
   a separate maintenance step; do not roll back to a build that still writes
   with `COUNT(*)`.

## Emergency pause

Use `06_set_abstract_write_pause.sql` with the migration URL. It takes the same
exclusive advisory lock as cutover. Resume only after the invariant is repaired.
The API returns a stable 503 `ABSTRACT_WRITES_PAUSED`; it does not expose SQL
errors or advise blind non-idempotent retries.

## Invariants

- Allocation is atomic per immutable namespace/type counter.
- Counter values only increase. Deleting/archiving an abstract never decrements
  or reuses a number.
- Existing tracking IDs, including P022, are permanent historical identifiers.
- A presentation-type change allocates a new current ID and keeps the previous
  ID as an alias; old IDs remain resolvable.
- `eventCode` edits do not mutate the tracking namespace.
- Any future unique collision is an invariant alert/controlled 503, not a loop
  that retries the same candidate.
