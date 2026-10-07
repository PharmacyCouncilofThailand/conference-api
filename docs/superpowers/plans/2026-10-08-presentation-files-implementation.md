# PRIS 2026 Presentation Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the un-deployed Poster workflow with one Presentation workflow that receives owner-submitted Oral PDFs in Google Drive and Poster/Highlighted Poster PDFs in R2.

**Architecture:** Retain one reconciliation, upload-attempt, version, revision, email and audit lifecycle. Select validation and storage from the authoritative Abstract type, persist provider identities before sending file bytes, and enforce current staff event/type assignments on every protected read. Replace only the ten Poster workflow tables in a new transaction; do not migrate test data or preserve old routes.

**Tech Stack:** Existing Node.js/TypeScript/Fastify, PostgreSQL/Drizzle raw SQL, googleapis OAuth/Drive v3, existing R2 adapter, pdf-lib, Next.js/React/next-intl, Node test runner and existing React test harnesses. No new dependency.

## Global Constraints

- Approved spec: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-08-presentation-files-design.md`, approved 8 October 2026; design commit `c8bf916`.
- Inventory: adjacent specs file `2026-10-08-presentation-files-inventory.json`; 82 existing files plus migration and Drive helper test = 84 proposed implementation files. Planning/spec artifacts are excluded.
- Oral: PDF >=2 pages, no maximum pages, maximum 52,428,800 bytes, Google Drive `anyone: reader` and stored Drive view URL.
- Poster/Highlighted Poster: PDF exactly 1 page, maximum 31,457,280 bytes, existing public R2 storage. Highlighted Poster maps to `poster` in Abstract DB and staff assignment.
- Main inclusive Thai deadline: `2026-10-20T23:59:59+07:00`; exclusive DB/API close: `2026-10-20T17:00:00.000Z`. Admin deadline edits, version checking, reasons and audits remain supported.
- Eligibility: approved source round 1/2, current matching DB data, owner account only; preserve existing initial/revision rights and checks. Do not invent type-change/reset workflows.
- Drive path: root ENV `GOOGLE_DRIVE_FOLDER_ABSTRACTS` / EventCode / Oral / Presentation Oral / authoritative category name / canonical TrackingID.
- Drive filename: TrackingID + `_` + full uploaded original filename, including its original extension; duplicate names allowed, distinct fileId for each new version, never overwrite accepted files.
- DB retains original/stored names, provider identities/URL, version, receive time, related request and latest pointer. No private viewing API.
- Organizer/Reviewer: active account AND event assigned AND type assigned; empty assigned types means no records; admin manages all. Preserve viewer received-only/redaction behavior. No new category restriction.
- Rename active workflow modules/types/errors/routes/env/scripts/worker to Presentation. Preserve Abstract enum values, Abstract Drive ENV mappings and historical migration 0038; no legacy URL/job compatibility.
- One new migration replaces only `poster_*` tables/test data. Preserve Abstract/users/events/tracking/session/payment/media/sponsor data; no broad reset, `DROP SCHEMA`, or `CASCADE` in the operational migration.
- Keep live provider/storage/mail/deploy and runtime migration outside this implementation plan's code-edit/test authorization. Integration resets run only through the existing approved test guard.
- User has an uncommitted `conference-api/src/modules/posters/data/approvedRound2Abstracts.ts` containing two local test rows. Preserve that exact work. Never deploy those rows as approved announcements and never silently discard them to pass a test.
- Test DB physical name `confer_posters_integration_test` remains the existing allowlisted target; renaming application symbols is not permission to create/rename a DB or loosen the guard.

## Workspace and commands

Workspace is three independent repositories beneath `D:/confer/confer/conference`, not one Git repository. Each task lists paths relative to that common workspace. For commands use its stated CWD. Do not use `git add .` or commit the local Round 2 changes.

API/Pris have `node_modules/.bin/tsx.cmd`; Backoffice does not. Use the existing API tsx executable to run Backoffice Node tests. Existing observed Node is v24.16.0; do not install a test runner merely because Backoffice has no test script.

```powershell
# CWD D:/confer/confer/conference/conference-api
./node_modules/.bin/tsx.cmd --test src/modules/presentations/policy.test.ts
./node_modules/.bin/tsc.cmd --noEmit

# CWD D:/confer/confer/conference/Pris2026
./node_modules/.bin/tsx.cmd --test src/lib/presentationSubmissionState.test.ts
./node_modules/.bin/tsc.cmd --noEmit

# CWD D:/confer/confer/conference/conference-backoffice
../conference-api/node_modules/.bin/tsx.cmd --test src/lib/presentationUi.test.ts
./node_modules/.bin/tsc.cmd --noEmit
```

Before an integration command, require TEST_DATABASE_URL to already be explicitly supplied through the established test environment, different from DATABASE_URL. Its parser must confirm host `127.0.0.1`, port `55073`, database `/confer_posters_integration_test`, no query/search_path options. Missing/unavailable target is a reported check limitation; do not invent credentials or change allowlists. Each integration test uses the existing reset guard and `--test-concurrency=1`.

## File map and task ownership

| Task | Files/responsibility |
| --- | --- |
| 1 | Move all inventoried workflow modules/components/libs/types/pages/tests; imports and compile wiring; preserve user data |
| 2 | `conference-api/drizzle/0039_pris2026_presentations.sql`, module migration/test-support/deployment tests; isolated schema and preservation proof |
| 3 | API module `policy.ts`, `file-validation.ts`, `types.ts`, `access.ts`, policy/validation tests; authoritative policy/location/contracts |
| 4 | `conference-api/src/services/googleDrive.ts` and new `googleDrive.presentation.test.ts`; folder/file IDs, checksums, public sharing |
| 5 | API module `storage.ts`, `storage.test.ts`, `jobs-runner.ts`; two-provider writes/deletes and cleanup |
| 6 | API module `uploads.ts`, `reconcile.ts`, `revisions.ts`, their integration/workflow tests; atomic rights and acceptance |
| 7 | API module `access.ts`, `readers.ts`, their unit/integration tests; event/type read authorization |
| 8 | API module `schemas.ts`, `public.routes.ts`, `backoffice.routes.ts`, `src/index.ts`, route tests; new APIs and bounds |
| 9 | Pris Presentation page/components/api/state/types, Header/redirect helpers, TH/EN messages, seven existing tests; owner UI |
| 10 | BO Presentation pages/components/api/types/helper, AuthContext/Sidebar/users page/helper test; staff UI |
| 11 | API module `email-template.ts`, `email-jobs.ts`, `operations.ts`, `revisions.ts`, `uploads.ts`, email tests and external emailService.test.ts; four mail kinds |
| 12 | API startup/worker/index/package/Dockerfile/.env.example and setup SQL/runbook/deployment tests; operational contracts |
| 13 | Existing cross-system tests/build/browser verification and final report; acceptance gate, no automatic deploy |

All module paths below are `conference-api/src/modules/presentations/` after Task 1. Task 1 is a mechanical baseline, not a deployable release. Tasks 2–12 converge on the single release; do not deploy intermediate schemas/contracts.

## Task 1: Preserve baseline and mechanically rename the workflow

**Files:** Move the 38 API module runtime/test/support files, Pris/BO workflow files and routes listed in the inventory. Modify external import in `conference-api/src/services/emailService.test.ts`, API index/package/Dockerfile, frontend consumers, AuthContext/Sidebar and root `poster` translation namespace. Preserve `drizzle/0038_pris2026_posters.sql` and actual values `oral`, `poster`, `highlighted-poster`.

**Interfaces:** Produces the existing function contracts with Presentation names: `PresentationDatabase`, `PresentationTx`, `PresentationActor`, `OwnerPresentationDto`, `requirePresentationOwner`, `requirePresentationStaff`, `reconcilePresentations`, `readOwnerPresentation`, `submitPresentationUpload`, `readPresentationList`, `readPresentationDetail`, `createPresentationRevision`, `renderPresentationEmail`. Existing DTO fields are changed explicitly in Task 3, not by global replacement.

- [ ] Record `git status --short` and HEAD in each repository. Snapshot only the user-changed Round 2 file bytes/hash to a local artifact outside tracked paths, and note its local rows independently of the official Round 1 source.

```powershell
# CWD common workspace; reversible backup, no user file reset
$taskSource = 'conference-api/src/modules/posters/data/approvedRound2Abstracts.ts'
$taskBackupDir = 'D:/confer/confer/conference/.test-artifacts/presentation-planning-baseline'
New-Item -ItemType Directory -Force -Path $taskBackupDir | Out-Null
Copy-Item -LiteralPath $taskSource -Destination (Join-Path $taskBackupDir 'approvedRound2Abstracts.ts')
Get-FileHash -Algorithm SHA256 -LiteralPath $taskSource
```

- [ ] Run pre-change safe unit checks only: API policy/file-validation/storage/email-template/readers/emailService and Pris four Poster tests + redirect tests. Record the known `data.test.ts` source119/Round2empty mismatch without running provider or runtime DB operations. API command:

```powershell
# CWD conference-api; expected exit 0 or a documented pre-existing failure
./node_modules/.bin/tsx.cmd --test src/modules/posters/policy.test.ts src/modules/posters/file-validation.test.ts src/modules/posters/storage.test.ts src/modules/posters/email-template.test.ts src/modules/posters/readers.test.ts src/services/emailService.test.ts
```

- [ ] Move exact files from the manifest. For each computed path resolve it under the common workspace, reject destination collisions, create only its parent, then `Move-Item -LiteralPath`. Use these target substitutions, including test names; do not move a directory containing unrelated files:

```powershell
function Get-PresentationTarget([string]$taskPath) {
  $taskPath = $taskPath.Replace('/modules/posters/', '/modules/presentations/')
  $taskPath = $taskPath.Replace('/components/posters/', '/components/presentations/')
  $taskPath = $taskPath.Replace('/types/posters.ts', '/types/presentations.ts')
  $taskPath = $taskPath.Replace('/app/[locale]/poster-submission/', '/app/[locale]/presentation-submission/')
  $taskPath = $taskPath.Replace('/app/posters/', '/app/presentations/')
  $taskPath = $taskPath.Replace('/lib/poster', '/lib/presentation')
  $taskPath = $taskPath.Replace('/Poster', '/Presentation')
  $taskPath = $taskPath.Replace('/sql/posters-setup/', '/sql/presentations-setup/')
  return $taskPath.Replace('/pris2026-posters.md', '/pris2026-presentations.md')
}
$taskRoot = [IO.Path]::GetFullPath('D:/confer/confer/conference')
$taskInventory = Get-Content -Raw -LiteralPath 'conference-api/docs/superpowers/specs/2026-10-08-presentation-files-inventory.json' | ConvertFrom-Json
foreach ($taskEntry in $taskInventory | Where-Object { -not $_.new }) {
  $taskOld = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskEntry.path))
  $taskNew = [IO.Path]::GetFullPath((Join-Path $taskRoot (Get-PresentationTarget $taskEntry.path)))
  foreach ($taskResolved in @($taskOld, $taskNew)) {
    if (-not $taskResolved.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped workspace' }
  }
  if ($taskOld -eq $taskNew) { continue }
  if (Test-Path -LiteralPath $taskNew) { throw "Destination exists: $taskNew" }
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($taskNew)) | Out-Null
  Move-Item -LiteralPath $taskOld -Destination $taskNew
}
```

- [ ] Update imports and workflow identifiers only in inventoried targets. Replace active `POSTER_*` errors/flags, compound `*Poster*` / `*poster*` identifiers, `/posters`, `/poster-submission`, `modules/posters`, `types/posters`, `components/posters`, `poster-settings/targets/...` route tokens. Do not replace standalone type values, displayed type names, source titles, tracking IDs, Abstract helpers/ENV or historical docs/migrations. Exact namespace changes:

```ts
// API/BO namespace and translation usage after moves
api.presentations.list(eventId, query, token);
useTranslations('presentation');
// Root messages key: "poster": {...} becomes "presentation": {...}.
// Nested keys poster/highlighted/ oral continue describing actual types.
```

- [ ] Update package command paths and Docker compiled paths immediately, while retaining guards on the existing approved physical test DB. Verify old source routes no longer have page.tsx. Re-run baseline safe tests under new paths and compile all three repositories. Expected: no rename-caused import/type errors; baseline failures recorded separately.
- [ ] Commit only mechanical scope in each repo with `refactor(presentations): rename submission workflow`; stage explicit paths/hunks. If staging moved source data, restore the pre-change content in the staged blob and keep user changes unstaged at the new path. Do not commit those local rows.

```powershell
# CWD conference-api; preserve HEAD's source blob in the rename commit, not the local test rows.
$taskOldSource='src/modules/posters/data/approvedRound2Abstracts.ts'
$taskNewSource='src/modules/presentations/data/approvedRound2Abstracts.ts'
$taskHeadBlob=(git rev-parse "HEAD:$taskOldSource").Trim()
git rm --cached -- $taskOldSource
git update-index --add --cacheinfo "100644,$taskHeadBlob,$taskNewSource"
git diff -- $taskNewSource
# Expected: user's original local test rows remain an unstaged change under the new path.
```

## Task 2: New schema migration and realistic isolated test support

**Files:** Create `conference-api/drizzle/0039_pris2026_presentations.sql`; modify `migration.integration.test.ts`, `deployment.integration.test.ts`, `test-support.ts`. Existing historical SQL 0038 is read-only test input.

**Interfaces:** `preparePresentationScenario(t, options?: { type?: 'oral'|'poster'; round?: 1|2 }): Promise<{client,database,fixture,announcement,ownerActor,adminActor}>`; `resetPresentationTestDatabase`, `openPresentationTestDatabase`, `seedPresentationScenario`. Fixture exposes `eventId`, `categoryId`, `abstractId`, `ownerId`, `adminId`, `owner`, `admin`, `operationKey` with current semantics. `Announcement.round` retains 1/2.

The full test function signature is `preparePresentationScenario(t:TestContext,options:{type?:'oral'|'poster';round?:1|2}={})`. Keep resource cleanup in t.after and preserve the existing pool/DB whitelist.

- [ ] Add a migration test that applies old 0038 to a synthetic legacy fixture, inserts test rows into all ten tables, then applies new SQL. Before/after compare `users`, `events`, `abstracts`, `abstract_categories`, `abstract_tracking_identifiers`, `staff_event_assignments`, and an unrelated sentinel table with rows/indexes. Assert every old table is absent and every new table exists, new deadline correct, no old test rows copied, all preserved rows unchanged. Fresh-schema and reapply checks use the same guard.

```ts
// Add inside migration.integration.test.ts; these assertions follow actual fixture setup.
const oldNames = ['settings','targets','announcements','revision_requests','upload_attempts','uploads','operations','email_jobs','email_attempts','audit_events'];
for (const suffix of oldNames) {
  const [old] = await client`SELECT to_regclass(${'public.poster_' + suffix}) AS name`;
  const [current] = await client`SELECT to_regclass(${'public.presentation_' + suffix}) AS name`;
  assert.equal(old.name, null);
  assert.notEqual(current.name, null);
}
const [setting] = await client`INSERT INTO presentation_settings(event_id) VALUES(${fixture.eventId}) RETURNING closes_at`;
assert.equal(new Date(setting.closes_at).toISOString(), '2026-10-20T17:00:00.000Z');
```

- [ ] Run only migration.integration.test.ts on the approved integration target, concurrency 1. Before SQL exists the expected failure is missing new migration, not a changed runtime database.
- [ ] Create this complete transaction SQL. It deliberately drops the legacy FK cycle before children, refuses an existing new schema, avoids CASCADE and does not delete external storage:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('presentation_settings','presentation_targets','presentation_announcements',
      'presentation_revision_requests','presentation_upload_attempts','presentation_uploads','presentation_operations',
      'presentation_email_jobs','presentation_email_attempts','presentation_audit_events')) THEN
    RAISE EXCEPTION 'Presentation schema already exists: refuse replacement';
  END IF;
  IF to_regclass('public.poster_targets') IS NOT NULL THEN
    ALTER TABLE poster_targets DROP CONSTRAINT IF EXISTS poster_current_file_same_target;
  END IF;
END $$;
DROP TABLE IF EXISTS poster_email_attempts;
DROP TABLE IF EXISTS poster_email_jobs;
DROP TABLE IF EXISTS poster_operations;
DROP TABLE IF EXISTS poster_audit_events;
DROP TABLE IF EXISTS poster_uploads;
DROP TABLE IF EXISTS poster_upload_attempts;
DROP TABLE IF EXISTS poster_revision_requests;
DROP TABLE IF EXISTS poster_announcements;
DROP TABLE IF EXISTS poster_targets;
DROP TABLE IF EXISTS poster_settings;
DROP FUNCTION IF EXISTS poster_request_immutable();
DROP INDEX IF EXISTS poster_abstract_event_identity;
CREATE UNIQUE INDEX presentation_abstract_event_identity ON abstracts(event_id,id);
CREATE TABLE presentation_settings (
  event_id integer PRIMARY KEY REFERENCES events(id),
  closes_at timestamptz NOT NULL DEFAULT '2026-10-20T17:00:00Z',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  manifest_digest char(64), reconcile_ready boolean NOT NULL DEFAULT false,
  last_reconciled_at timestamptz, reconcile_error text,
  CHECK(isfinite(closes_at))
);
CREATE TABLE presentation_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  abstract_id integer NOT NULL, current_upload_id uuid,
  initial_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,abstract_id), UNIQUE(id,event_id),
  FOREIGN KEY(event_id,abstract_id) REFERENCES abstracts(event_id,id)
);
CREATE TABLE presentation_announcements (
  event_id integer NOT NULL REFERENCES events(id), source_key text NOT NULL,
  source_row jsonb NOT NULL, source_digest char(64) NOT NULL,
  target_id uuid, match_state text NOT NULL DEFAULT 'incomplete',
  match_fingerprint char(64), match_snapshot jsonb NOT NULL DEFAULT '{}',
  verified_fingerprint char(64), verified_by integer REFERENCES backoffice_users(id),
  verified_at timestamptz, verification_reason text,
  present boolean NOT NULL DEFAULT true,
  PRIMARY KEY(event_id,source_key),
  FOREIGN KEY(target_id,event_id) REFERENCES presentation_targets(id,event_id),
  CHECK(match_state IN ('ready','alias_pending','conflict','missing','incomplete')),
  CHECK(verified_at IS NULL OR (verified_by IS NOT NULL AND verification_reason IS NOT NULL AND length(btrim(verification_reason))>0))
);
CREATE TABLE presentation_revision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES presentation_targets(id),
  details text NOT NULL CHECK(length(btrim(details))>0), closes_at timestamptz NOT NULL CHECK(isfinite(closes_at)),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','expired','cancelled')),
  requested_by integer NOT NULL REFERENCES backoffice_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz,
  cancelled_by integer REFERENCES backoffice_users(id), cancelled_at timestamptz, cancellation_reason text,
  UNIQUE(target_id,id),
  CHECK((status='submitted')=(submitted_at IS NOT NULL)),
  CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK(status<>'cancelled' OR (cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL AND length(btrim(cancellation_reason))>0))
);
CREATE UNIQUE INDEX presentation_one_open_request ON presentation_revision_requests(target_id) WHERE status='open';
CREATE TABLE presentation_upload_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES presentation_targets(id),
  user_id integer NOT NULL REFERENCES users(id), request_id uuid,
  operation_key uuid NOT NULL, fingerprint char(64) NOT NULL,
  storage_provider text NOT NULL CHECK(storage_provider IN ('r2','drive')),
  object_key text UNIQUE, drive_file_id text UNIQUE, drive_folder_id text,
  original_filename text NOT NULL, stored_filename text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type='application/pdf'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 52428800 ELSE 31457280 END),
  digest char(64) NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','stored','accepted','rejected','cleanup_pending','cleaned')),
  lease_until timestamptz NOT NULL, claim_token uuid NOT NULL,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(target_id,user_id,operation_key), UNIQUE(target_id,id),
  CHECK((storage_provider='r2' AND object_key IS NOT NULL AND drive_file_id IS NULL AND drive_folder_id IS NULL)
    OR (storage_provider='drive' AND object_key IS NULL
      AND ((drive_file_id IS NULL AND drive_folder_id IS NULL AND state NOT IN ('stored','accepted'))
        OR (drive_file_id IS NOT NULL AND drive_folder_id IS NOT NULL)))),
  FOREIGN KEY(target_id,request_id) REFERENCES presentation_revision_requests(target_id,id)
);
CREATE TABLE presentation_uploads (
  id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES presentation_targets(id),
  attempt_id uuid NOT NULL UNIQUE, request_id uuid,
  version integer NOT NULL CHECK(version>0), user_id integer NOT NULL REFERENCES users(id),
  storage_provider text NOT NULL CHECK(storage_provider IN ('r2','drive')),
  object_key text UNIQUE, drive_file_id text UNIQUE, drive_folder_id text,
  file_url text NOT NULL, original_filename text NOT NULL, stored_filename text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type='application/pdf'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND CASE WHEN storage_provider='drive' THEN 52428800 ELSE 31457280 END), digest char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE(target_id,id), UNIQUE(target_id,version),
  CHECK((storage_provider='r2' AND object_key IS NOT NULL AND drive_file_id IS NULL AND drive_folder_id IS NULL)
    OR (storage_provider='drive' AND object_key IS NULL AND drive_file_id IS NOT NULL AND drive_folder_id IS NOT NULL)),
  FOREIGN KEY(target_id,attempt_id) REFERENCES presentation_upload_attempts(target_id,id),
  FOREIGN KEY(target_id,request_id) REFERENCES presentation_revision_requests(target_id,id)
);
CREATE UNIQUE INDEX presentation_one_initial_upload ON presentation_uploads(target_id) WHERE request_id IS NULL;
CREATE UNIQUE INDEX presentation_one_revision_upload ON presentation_uploads(request_id) WHERE request_id IS NOT NULL;
ALTER TABLE presentation_targets ADD CONSTRAINT presentation_current_file_same_target
  FOREIGN KEY(id,current_upload_id) REFERENCES presentation_uploads(target_id,id);
CREATE TABLE presentation_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  actor_id integer NOT NULL REFERENCES backoffice_users(id), action text NOT NULL,
  operation_key uuid NOT NULL, fingerprint char(64) NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(event_id,actor_id,action,operation_key)
);
CREATE TABLE presentation_email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES presentation_targets(id),
  kind text NOT NULL CHECK(kind IN ('initial','reminder','revision','receipt')),
  request_id uuid, upload_id uuid, batch_id uuid, automatic_receipt_for uuid UNIQUE,
  triggered_by integer REFERENCES backoffice_users(id), parent_job_id uuid REFERENCES presentation_email_jobs(id),
  payload jsonb NOT NULL, subject text NOT NULL, html text NOT NULL, template_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','unknown','suppressed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  claim_token uuid, lease_until timestamptz, request_started_at timestamptz,
  error_code text, provider_message_id text,
  FOREIGN KEY(target_id,request_id) REFERENCES presentation_revision_requests(target_id,id),
  FOREIGN KEY(target_id,upload_id) REFERENCES presentation_uploads(target_id,id),
  FOREIGN KEY(target_id,automatic_receipt_for) REFERENCES presentation_uploads(target_id,id),
  CHECK(kind<>'revision' OR request_id IS NOT NULL), CHECK(kind<>'receipt' OR upload_id IS NOT NULL)
);
CREATE INDEX presentation_pending_mail ON presentation_email_jobs(created_at,id) WHERE state='pending';
CREATE TABLE presentation_email_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES presentation_email_jobs(id),
  claim_token uuid NOT NULL, result text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), request_started_at timestamptz,
  finished_at timestamptz, error_code text, provider_message_id text,
  recipient text, subject text NOT NULL, html text NOT NULL, template_version text NOT NULL,
  CHECK(result IN ('sending','sent','failed','unknown','suppressed')), UNIQUE(job_id,claim_token)
);
CREATE TABLE presentation_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  abstract_id integer REFERENCES abstracts(id), actor_id integer REFERENCES backoffice_users(id),
  action text NOT NULL, reason text, before_state jsonb, after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION presentation_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.details IS DISTINCT FROM OLD.details OR NEW.closes_at IS DISTINCT FROM OLD.closes_at
     OR NEW.target_id IS DISTINCT FROM OLD.target_id THEN
    RAISE EXCEPTION 'Presentation request terms are immutable';
  END IF;
  IF OLD.status<>'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal presentation requests cannot reopen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presentation_request_immutable_guard BEFORE UPDATE ON presentation_revision_requests
  FOR EACH ROW EXECUTE FUNCTION presentation_request_immutable();
COMMIT;
```

- [ ] Extend isolated fixture schema with `abstract_categories(id,event_id,name)`, `abstracts.category_id`, and `backoffice_users.assigned_presentation_types jsonb DEFAULT '[]'`. Seed one category and link the Abstract. Parameterize the existing fixture rather than adding a new fixture framework:

```ts
// In preparePresentationScenario after seedPresentationScenario and before reconcile.
const type = options.type ?? 'poster';
const round = options.round ?? 1;
const tracking = `PRIS-2026-${type === 'oral' ? 'O' : 'P'}001`;
await client`UPDATE abstracts SET presentation_type=${type},tracking_id=${tracking} WHERE id=${fixture.abstractId}`;
const announcement: Announcement = {
  id: 1, sequence: 1, trackingId: tracking, title: 'ตัวอย่างผลงาน', presentationType: type,
  categoryId: fixture.categoryId, categoryName: 'สาขาตัวอย่าง', submitterName: 'ชื่อ นามสกุล', affiliation: null, round,
};
await reconcilePresentations(database, [announcement]);
await client`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '1 hour' WHERE event_id=${fixture.eventId}`;
```

- [ ] Apply migration tests for current-upload FK consistency, one initial file, one successful revision/request, request immutability/terminal states, provider identities and exact provider byte limits. Inject a late SQL failure to prove the transaction restores old tables/rows. Assert reapply fails before deleting any new rows.
- [ ] Keep resetPresentationTestDatabase responsible for base fixture tables only. preparePresentationScenario applies new 0039 after reset and before seed/reconcile; legacy migration rehearsal explicitly applies old 0038 itself. This prevents double application and makes fresh/legacy tests independent. No schema push and no journal rewrite. Run migration checks to PASS, then commit `feat(presentations): replace poster test schema safely`.

## Task 3: Shared policy, authoritative location and PDF validation

**Files:** Module `types.ts`, `policy.ts`, `file-validation.ts`, `access.ts`, `policy.test.ts`, `file-validation.test.ts`; both frontend `types/presentations.ts` mirror only DTO contracts.

**Interfaces:** `AbstractPresentationType = 'oral'|'poster'`; `StorageProvider = 'drive'|'r2'`; `DriveLocation = { eventCode:string; trackingId:string; categoryName:string }`; `PresentationFileInput = {buffer:Buffer;filename:string;mimetype:string}`. `validatePresentationFile(file, type)` returns original buffer/name, canonical PDF MIME/extension, sizeBytes, SHA-256 digest, MD5 checksum, pageCount and presentationType. `DbCandidate` gains authoritative eventCode/categoryName for Drive lookup. All owners are still read from users/Abstract/event in DB.

- [ ] Add tests for Oral 1/2/100 pages, Poster/Highlighted page policy, malformed/encrypted/EOF/MIME/filename cases and exact byte ceilings/+1. Use PDFDocument.create; no real uploaded document needed:

```ts
test('Oral accepts two pages while Poster rejects the identical bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  const buffer = Buffer.from(await pdf.save());
  const input = { buffer, filename: 'slides.PDF', mimetype: 'application/pdf' };
  const oral = await validatePresentationFile(input, 'oral');
  assert.equal(oral.pageCount, 2);
  assert.equal(oral.buffer, buffer);
  await assert.rejects(validatePresentationFile(input, 'poster'), { code: 'PRESENTATION_PDF_PAGE_COUNT' });
});
```

- [ ] Run validator/policy tests: expect failures before type parameter/policy exists. Add these policy exports without a registry:

```ts
export type AbstractPresentationType = 'oral' | 'poster';
export const MAX_ORAL_BYTES = 52_428_800;
export const MAX_POSTER_BYTES = 31_457_280; // Poster remains an actual type, not a legacy workflow name.
export const DEFAULT_PRESENTATION_CLOSE = '2026-10-20T17:00:00.000Z';
export const maxPresentationBytes = (type: AbstractPresentationType) => type === 'oral' ? MAX_ORAL_BYTES : MAX_POSTER_BYTES;
export const presentationStorageProvider = (type: AbstractPresentationType) => type === 'oral' ? 'drive' as const : 'r2' as const;
```

- [ ] Replace validator with this full enforcement boundary; validation must not infer type from file or multipart:

```ts
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { fail } from './access.js';
import { maxPresentationBytes, type AbstractPresentationType } from './policy.js';

export async function validatePresentationFile(
  file: { buffer: Buffer; filename: string; mimetype: string }, type: AbstractPresentationType,
) {
  const { buffer, filename, mimetype } = file;
  if (!buffer.length) fail('PRESENTATION_FILE_INVALID', 422);
  if (buffer.length > maxPresentationBytes(type)) fail('PRESENTATION_FILE_TOO_LARGE', 413);
  if (!filename || filename.length > 255 || filename.includes('\0')) fail('PRESENTATION_FILENAME_INVALID', 422);
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') fail('PRESENTATION_FILE_TYPE_MISMATCH', 415);
  if (buffer.lastIndexOf('%%EOF') < 5) fail('PRESENTATION_FILE_INVALID', 422);
  let document: PDFDocument;
  try { document = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: true, updateMetadata: false }); }
  catch { return fail('PRESENTATION_FILE_INVALID', 422); }
  if (document.isEncrypted) fail('PRESENTATION_PDF_ENCRYPTED', 422);
  let pageCount: number;
  try { pageCount = document.getPageCount(); }
  catch { return fail('PRESENTATION_FILE_INVALID', 422); }
  if (type === 'oral' ? pageCount < 2 : pageCount !== 1) fail('PRESENTATION_PDF_PAGE_COUNT', 422);
  if (!filename.toLowerCase().endsWith('.pdf') || !['', 'application/octet-stream', 'application/pdf'].includes(mimetype.toLowerCase())) {
    fail('PRESENTATION_FILE_TYPE_MISMATCH', 415);
  }
  return { buffer, filename, mimeType: 'application/pdf' as const, extension: 'pdf' as const,
    sizeBytes: buffer.length, pageCount, presentationType: type,
    digest: createHash('sha256').update(buffer).digest('hex'), md5Checksum: createHash('md5').update(buffer).digest('hex') };
}
```

- [ ] Extend requirePresentationOwner/readCandidates SELECT with `e.event_code AS "eventCode"` and authoritative `c.name AS "categoryName"` using `LEFT JOIN abstract_categories c ON c.id=a.category_id AND c.event_id=a.event_id`; preserve event/owner/active/role and existing lock clauses. Category lookup is required for Oral storage only; do not fabricate it from client data or make an inner join deny otherwise-eligible legacy Poster records. DbCandidate.categoryName is string|null.
- [ ] Define the DTO/storage identity contract used by Tasks 4–11:

```ts
export type StorageProvider='drive'|'r2';
export type DriveLocation={eventCode:string;trackingId:string;categoryName:string};
export type PresentationFileInput={buffer:Buffer;filename:string;mimetype:string};
export type StorageIdentity = { storageProvider: 'drive'|'r2'; objectKey: string|null;
  driveFileId: string|null; driveFolderId: string|null; storedFileName: string; fileUrl: string|null };
export type UploadDto = { id:string;version:number;fileName:string;storedFileName:string;
  mimeType:'application/pdf';sizeBytes:number;fileUrl:string;storageProvider:'drive'|'r2';driveFileId:string|null;
  receivedAt:string;revisionRequestId:string|null };
// fileName is the original name shown to users; SQL original_filename maps to fileName.
```

- [ ] Re-run validator/policy tests; update callers with explicit owner type, never a default that silently treats Oral as Poster. The new DTO shape is a cross-module contract change; full API/frontend typechecks are final gates in Task 13 after consumers are migrated. Record intermediate errors instead of claiming they passed or introducing temporary optional fields. Commit `feat(presentations): enforce per-type PDF policies`.

## Task 4: Drive helper with file identity and public sharing

**Files:** Modify only `conference-api/src/services/googleDrive.ts`; create `conference-api/src/services/googleDrive.presentation.test.ts`.

**Interfaces:** Export `generatePresentationDriveFileId(drive?)`, `getOrCreatePresentationDriveFolder(parentId,name,drive?)`, `writePresentationDriveFile(input,drive?)`, `inspectPresentationDriveFile(fileId,drive?)`. Optional injected Drive client uses the installed googleapis Drive v3 type; production defaults to the existing OAuth client. Existing uploadToGoogleDrive/media/sponsor helpers keep signatures/return values/permission behavior.

`DriveWriteInput = {fileId,parentId,fileName,buffer,digest,md5Checksum,attemptId}`; inspection returns `id,name,mimeType,size,md5Checksum,parents,appProperties`. write returns `{fileId,fileUrl,storedFileName}` only after byte identity and anyone-reader permission are confirmed.

- [ ] Add tests with an injected fake `drive.files`/`drive.permissions`: initial create, retry conflict same ID, same name different IDs, mismatched checksum/name/parent/attempt ID, permission failure, failed metadata read, escaped folder queries and folder duplicates. Every fake asserts zero real network calls.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {writePresentationDriveFile} from './googleDrive.js';

test('same Drive ID replays without overwrite; same name new ID retains both versions',async()=>{
  const files=new Map<string,Record<string,unknown>>();
  const publicIds=new Set<string>();
  let creates=0;
  const fake={files:{
    create:async(input:any)=>{
      const id=input.requestBody.id;
      if(files.has(id))throw Object.assign(Error('conflict'),{code:409});
      const chunks:Buffer[]=[];
      for await(const chunk of input.media.body)chunks.push(Buffer.from(chunk));
      const bytes=Buffer.concat(chunks);creates++;
      files.set(id,{...input.requestBody,size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')});
      return {data:{id}};
    },
    get:async({fileId}:{fileId:string})=>{const file=files.get(fileId);if(!file)throw Object.assign(Error('missing'),{code:404});return {data:file};},
  },permissions:{
    list:async({fileId}:{fileId:string})=>({data:{permissions:publicIds.has(fileId)?[{type:'anyone',role:'reader'}]:[]}}),
    create:async(input:any)=>{assert.deepEqual(input.requestBody,{type:'anyone',role:'reader'});publicIds.add(input.fileId);return {data:{id:'permission'}};},
  }} as unknown as NonNullable<Parameters<typeof writePresentationDriveFile>[1]>;
  const buffer=Buffer.from('%PDF-binary-helper-fixture');
  const input={fileId:'file-A',parentId:'work-folder',fileName:'PRIS-2026-O001_slides.pdf',buffer,
    digest:createHash('sha256').update(buffer).digest('hex'),md5Checksum:createHash('md5').update(buffer).digest('hex'),attemptId:'attempt-A'};
  const first=await writePresentationDriveFile(input,fake);
  const replay=await writePresentationDriveFile(input,fake);
  const second=await writePresentationDriveFile({...input,fileId:'file-B',attemptId:'attempt-B'},fake);
  assert.equal(first.fileId,replay.fileId);assert.notEqual(first.fileId,second.fileId);
  assert.equal(creates,2);assert.equal(files.size,2);assert.equal(publicIds.size,2);
  assert.equal(first.storedFileName,second.storedFileName);
  assert.equal(second.fileUrl,'https://drive.google.com/file/d/file-B/view');
});
```

This is a storage-helper check, not a PDF validity check; real PDF validation remains Task 3.
- [ ] Run the new helper test to confirm failure before exports exist. Add the exact helper identity checks and shared URL behavior:

```ts
// Add to googleDrive.ts; use existing google import, Readable and getDriveClient.
type PresentationDriveClient = ReturnType<typeof getDriveClient>;
export type DriveWriteInput = { fileId:string;parentId:string;fileName:string;buffer:Buffer;
  digest:string;md5Checksum:string;attemptId:string };
const presentationDriveTimeout = 60_000;
const driveLiteral = (value:string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function generatePresentationDriveFileId(drive:PresentationDriveClient=getDriveClient()):Promise<string> {
  const response = await drive.files.generateIds({ count:1,space:'drive' }, { timeout:presentationDriveTimeout });
  const id = response.data.ids?.[0];
  if (!id) throw Error('PRESENTATION_DRIVE_ID_MISSING');
  return id;
}
export async function getOrCreatePresentationDriveFolder(parentId:string,name:string,drive:PresentationDriveClient=getDriveClient()):Promise<string> {
  return getOrCreateFolder(parentId,name,drive,true);
}
export async function inspectPresentationDriveFile(fileId:string,drive:PresentationDriveClient=getDriveClient()) {
  const response = await drive.files.get({fileId,fields:'id,name,mimeType,size,md5Checksum,parents,appProperties'}, {timeout:presentationDriveTimeout});
  return response.data;
}
export async function writePresentationDriveFile(input:DriveWriteInput,drive:PresentationDriveClient=getDriveClient()) {
  try {
    await drive.files.create({requestBody:{id:input.fileId,name:input.fileName,mimeType:'application/pdf',parents:[input.parentId],
      appProperties:{presentationAttemptId:input.attemptId,sha256:input.digest}},media:{mimeType:'application/pdf',body:Readable.from(input.buffer)},fields:'id'},
      {timeout:presentationDriveTimeout});
  } catch (error) {
    const existing = await inspectPresentationDriveFile(input.fileId,drive).catch(()=>null);
    if (!existing) throw Object.assign(Error('PRESENTATION_STORAGE_OUTCOME_UNKNOWN'),{cause:error,storageOutcome:'unknown'});
  }
  let actual:Awaited<ReturnType<typeof inspectPresentationDriveFile>>;
  try { actual=await inspectPresentationDriveFile(input.fileId,drive); }
  catch(error) { throw Object.assign(Error('PRESENTATION_STORAGE_OUTCOME_UNKNOWN'),{cause:error,storageOutcome:'unknown'}); }
  if (actual.id!==input.fileId || actual.name!==input.fileName || actual.mimeType!=='application/pdf' ||
    Number(actual.size)!==input.buffer.length || actual.md5Checksum!==input.md5Checksum || !actual.parents?.includes(input.parentId) ||
    actual.appProperties?.presentationAttemptId!==input.attemptId || actual.appProperties?.sha256!==input.digest) {
    throw Error('PRESENTATION_DRIVE_FILE_MISMATCH');
  }
  const permissions = await drive.permissions.list({fileId:input.fileId,fields:'permissions(type,role)'},{timeout:presentationDriveTimeout});
  if (!permissions.data.permissions?.some(p=>p.type==='anyone' && p.role==='reader')) {
    await drive.permissions.create({fileId:input.fileId,requestBody:{type:'anyone',role:'reader'},fields:'id'},{timeout:presentationDriveTimeout});
  }
  return {fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName};
}
```

- [ ] Extend the existing private getOrCreateFolder, rather than duplicating folder resolution. Existing callers use the same defaults; Presentation's DB-serialized lookup passes fresh=true. Replace its body with:

```ts
async function getOrCreateFolder(parentFolderId:string,folderName:string,
  drive:PresentationDriveClient=getDriveClient(),fresh=false):Promise<string> {
  const cacheKey=`${parentFolderId}/${folderName}`;
  if(!fresh&&subfolderCache[cacheKey])return subfolderCache[cacheKey];
  if(!fresh&&Object.prototype.hasOwnProperty.call(folderCreationPromises,cacheKey))return folderCreationPromises[cacheKey];
  const operation=(async()=>{
    const found=await drive.files.list({q:`name='${driveLiteral(folderName)}' and '${driveLiteral(parentFolderId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields:'files(id,name)',spaces:'drive',pageSize:100},{timeout:presentationDriveTimeout});
    if(fresh&&(found.data.files?.length??0)>1)throw Error('PRESENTATION_DRIVE_FOLDER_AMBIGUOUS');
    const existingId=found.data.files?.[0]?.id;
    if(existingId){if(!fresh)subfolderCache[cacheKey]=existingId;return existingId;}
    const generatedId=fresh?await generatePresentationDriveFileId(drive):undefined;
    let id:string|undefined;
    try{
      const created=await drive.files.create({requestBody:{...(generatedId?{id:generatedId}:{}),name:folderName,
        mimeType:'application/vnd.google-apps.folder',parents:[parentFolderId]},fields:'id'},{timeout:presentationDriveTimeout});
      id=created.data.id??undefined;
    }catch(error){
      if(!generatedId)throw error;
      const existing=await drive.files.get({fileId:generatedId,fields:'id,name,mimeType,parents'},
        {timeout:presentationDriveTimeout}).catch(()=>null);
      if(existing?.data.id!==generatedId||existing.data.name!==folderName||
        existing.data.mimeType!=='application/vnd.google-apps.folder'||!existing.data.parents?.includes(parentFolderId))throw error;
      id=generatedId;
    }
    if(!id)throw Error('PRESENTATION_DRIVE_FOLDER_ID_MISSING');
    if(!fresh)subfolderCache[cacheKey]=id;
    return id;
  })();
  if(!fresh){
    folderCreationPromises[cacheKey]=operation;
    void operation.finally(()=>{delete folderCreationPromises[cacheKey];}).catch(()=>undefined);
  }
  return operation;
}
```

- [ ] Use narrow fixture casts for the fake installed google client, not an exported generic factory/registry. Test 409 as an identity check, never as unconditional success; verify same attempt never invokes files.update and new version allocates another ID. Do not alter original filename or add suffixes.
- [ ] Run `./node_modules/.bin/tsx.cmd --test src/services/googleDrive.presentation.test.ts` to PASS. Full API typecheck follows the contract migration in Task 13, not a temporary DTO compatibility hack. Commit `feat(presentations): store public Oral PDFs with stable Drive identities`.

## Task 5: Provider-aware storage, identity persistence and cleanup

**Files:** Module `storage.ts`, `storage.test.ts`, `uploads.ts` reservation DTO declaration, `jobs-runner.ts` cleanup dispatch; `googleDrive.ts` imports from Task 4.

**Interfaces:** Retain R2 put/delete shape as `R2PresentationStorage`. `PresentationStorage = {r2:()=>R2PresentationStorage;drive:DrivePresentationStorage}`; default factory is lazy so a Poster request does not require Google config and an Oral request does not require R2 config. `AttemptReservation` exposes `kind`, `attemptId`, `claimToken`, `identity:StorageIdentity`, `location:DriveLocation|null`, `upload:UploadDto|null`. `storePresentationAttempt(database,attempt,file,storage)` prepares/persists Drive identity before upload and returns void; `readUploadDto` maps the new columns; `cleanupFailedAttempt` keeps its existing signature with the new storage type.

- [ ] Update existing memory storage in uploads/workflow tests to the new shape; assert one-provider dispatch and lazy config. Add storage unit checks: Drive ID DB write precedes write bytes, stored mark follows sharing, claim/lease loss prevents upload, original R2 checksum/bytes/cache-control unchanged, cleanup never touches accepted/current/history, unknown DB commit preserves resource.

```ts
// storage.test.ts: inspect order through the existing SQL-double harness.
const calls:string[]=[];
const storage:PresentationStorage={
  r2:()=>{assert.fail('Oral must not initialize R2');},
  drive:{rootFolderId:()=> 'root-test',generateId:async()=>{calls.push('generate');return 'drive-test-id';},
    folder:async()=> 'folder-test-id',write:async input=>{calls.push('write');assert.equal(input.fileId,'drive-test-id');
      return {fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName};},
    delete:async()=>{calls.push('delete');}},
};
// DB double appends persist when UPDATE presentation_upload_attempts SET drive_file_id is executed.
// After storePresentationAttempt: assert order generate < persist < write < stored.
```

- [ ] Run storage.test.ts expecting failure before provider handling. Define complete adapter contracts/factory:

```ts
import { generatePresentationDriveFileId, getOrCreatePresentationDriveFolder,
  writePresentationDriveFile, deleteFromGoogleDrive, type DriveWriteInput } from '../../services/googleDrive.js';
export type R2PresentationStorage={publicBaseUrl:string;
  putObject(input:{key:string;body:Buffer;contentType:string;cacheControl:string;signal?:AbortSignal}):Promise<void>;
  deleteObject(key:string):Promise<void>};
export type DrivePresentationStorage={rootFolderId():string;generateId():Promise<string>;
  folder(parentId:string,name:string):Promise<string>;
  write(input:DriveWriteInput):Promise<{fileId:string;fileUrl:string;storedFileName:string}>;
  delete(fileId:string):Promise<void>};
export type PresentationStorage={r2:()=>R2PresentationStorage;drive:DrivePresentationStorage};
export function createPresentationStorage():PresentationStorage {
  return {
    r2:()=>{try{const config=readR2ImageConfig();
      if(!new URL(config.publicBaseUrl).hostname.endsWith('.r2.dev'))fail('PRESENTATION_STORAGE_CONFIG',503);
      return {publicBaseUrl:config.publicBaseUrl,...createR2ImageStorage(config)};}
      catch{return fail('PRESENTATION_STORAGE_CONFIG',503);}},
    drive:{rootFolderId:()=>{const id=process.env.GOOGLE_DRIVE_FOLDER_ABSTRACTS?.trim();
      if(!id)fail('PRESENTATION_STORAGE_CONFIG',503);return id!;},
      generateId:()=>generatePresentationDriveFileId(),folder:(parent,name)=>getOrCreatePresentationDriveFolder(parent,name),
      write:input=>writePresentationDriveFile(input),delete:id=>deleteFromGoogleDrive(id)},
  };
}
```

- [ ] Resolve Drive folder with a parent/name advisory lock and fresh service lookup, not the old in-process cache. Bytes upload remains outside DB transactions:

```ts
async function resolveOralFolder(database:PresentationDatabase,location:DriveLocation,storage:PresentationStorage):Promise<string> {
  let parent=storage.drive.rootFolderId();
  for(const name of [location.eventCode,'Oral','Presentation Oral',location.categoryName,location.trackingId]) {
    const currentParent=parent;
    parent=await database.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`presentation-folder:${currentParent}:${name}`},0))`);
      return storage.drive.folder(currentParent,name);
    });
  }
  return parent;
}
```

- [ ] For a Drive reserved attempt, reuse identity if already persisted; otherwise generate fileId and resolve folder, then claim the identity with a guarded update. A lost DB response means no bytes are sent until a subsequent read proves which ID committed:

```ts
const folderId=await resolveOralFolder(database,attempt.location!,storage);
const fileId=await storage.drive.generateId();
const [identity]=await rows<{driveFileId:string;driveFolderId:string}>(database,sql`
  UPDATE presentation_upload_attempts SET drive_file_id=${fileId},drive_folder_id=${folderId}
  WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state='reserved'
    AND lease_until>clock_timestamp() AND drive_file_id IS NULL AND drive_folder_id IS NULL
  RETURNING drive_file_id AS "driveFileId",drive_folder_id AS "driveFolderId"`);
if(!identity)fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
// Retain this complete identity in the attempt, then use these exact IDs for the provider call.
attempt.identity.driveFileId=identity.driveFileId;
attempt.identity.driveFolderId=identity.driveFolderId;
const written=await storage.drive.write({fileId:identity.driveFileId,parentId:identity.driveFolderId,
  fileName:attempt.identity.storedFileName,buffer:file.buffer,digest:file.digest,md5Checksum:file.md5Checksum,attemptId:attempt.attemptId});
attempt.identity.fileUrl=written.fileUrl;
```

- [ ] Add the branch for already-persisted Drive ID to skip generate/folder/update and call write with persisted IDs; validate both ID/folder are present together. For R2, call its old put method with original file bytes and new objectKey. Both branches then `UPDATE ... SET state='stored' ... WHERE state='reserved' AND claim_token ... AND lease_until>clock_timestamp() RETURNING id`; no returned ID is retry-required, not acceptance.
- [ ] Distinguish unknown provider outcome from proven failure. Unknown Drive create/read outcome remains reserved/recoverable until lease expiry; do not let the existing immediate cleanup-on-error path erase an in-flight resource. Add `storageOutcome:'unknown'` to provider error handling and a skip guard for early cleanup. A successful resource inspection does not by itself create an accepted DB upload.
- [ ] Extend cleanup's locked read to provider/fileId/objectKey and keep the current terminal-claim-before-delete transaction, querying every successful upload by attempt AND matching provider identity. Drive id null means bytes were never sent by this implementation; known fileId deletes via Drive; R2 deletes objectKey. Exact dispatch after a committed cleanup claim:

```ts
if(attempt.storage_provider==='drive') {
  if(attempt.drive_file_id)await storage.drive.delete(attempt.drive_file_id);
} else {
  await storage.r2().deleteObject(attempt.object_key!);
}
```

- [ ] Update readUploadDto SELECT: original_filename AS fileName, stored_filename AS storedFileName, file_url AS fileUrl, storage_provider AS storageProvider, drive_file_id AS driveFileId; retain receivedAt ISO conversion/request/version.
- [ ] Run storage unit + guarded uploads integration tests to PASS; commit `feat(presentations): dispatch storage and protect provider identities`.

## Task 6: Reconciliation and atomic owner upload/revision acceptance

**Files:** Module `reconcile.ts`, `uploads.ts`, `revisions.ts`, `test-support.ts`, reconcile/uploads/revisions/workflow integration tests.

**Interfaces:** `readUploadGate(tx,actor,abstractId,requestId):Promise<UploadGate>` gains `presentationType:'oral'|'poster'` and `location:DriveLocation`; `reserveUploadAttempt(database,actor,abstractId,key,requestId,file):Promise<AttemptReservation>` writes provider/name/reservation metadata, not Drive bytes; `finalizePresentationAttempt(database,actor,abstractId,requestId,attempt,file,storage):Promise<UploadDto>` receives ValidatedFile from Task 3, reads persisted provider identity, rechecks file policy, and atomically writes latest version/request/receipt. submit retains one injected PresentationStorage parameter.

- [ ] Add Oral initial/revision success integration scenarios with two-page PDF and injected memory Drive. Add same-name revision with distinct fileId, same successful key replay, concurrent initial uploads, sharing fail, lease/DB failure, type/owner/deadline races, and both-round eligibility. Tests inspect persisted DB metadata, not just HTTP status.

```ts
test('Oral initial receipt and same-key replay use one Drive file and one version',async t=>{
  const {client,database,fixture,ownerActor}=await preparePresentationScenario(t,{type:'oral',round:2});
  const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
  const file={buffer:Buffer.from(await pdf.save()),filename:'slides.pdf',mimetype:'application/pdf'};
  const driveIds:string[]=[];
  const storage:PresentationStorage={r2:()=>{assert.fail('Oral used R2');},drive:{
    rootFolderId:()=> 'root-test',folder:async(_parent,name)=>`folder-${name}`,generateId:async()=>randomUUID(),
    write:async input=>{driveIds.push(input.fileId);return {fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName};},
    delete:async()=>{assert.fail('Accepted file deleted');}}};
  const key=randomUUID();
  const first=await submitPresentationUpload(database,ownerActor,fixture.abstractId,key,null,file,storage);
  const replay=await submitPresentationUpload(database,ownerActor,fixture.abstractId,key,null,file,storage);
  assert.equal(replay.replayed,true);assert.equal(replay.upload.id,first.upload.id);assert.equal(driveIds.length,1);
  const [saved]=await client`SELECT * FROM presentation_uploads`;
  assert.equal(saved.version,1);assert.equal(saved.original_filename,'slides.pdf');
  assert.equal(saved.stored_filename,'PRIS-2026-O001_slides.pdf');assert.equal(saved.storage_provider,'drive');
  assert.equal(saved.drive_file_id,driveIds[0]);
});
```

- [ ] Run focused integrations expecting Oral gate failure before edits. Remove exactly three Oral exclusions in reconcile (target creation, initial_enabled ready rows, assertInitialReady), retaining all existing match/alias/duplicate/remap/source/incomplete/withdrawn/used-right logic. The matching function still maps Highlighted to poster.
- [ ] Replace owner poster-only guard with membership of the existing Abstract enum; validate input with requirePresentationOwner's current type before any reservation/storage. Include file validated type in reservation fingerprint and verify it matches the gate's locked owner type:

```ts
// In readUploadGate after requirePresentationOwner.
if(!['oral','poster'].includes(owner.presentationType))fail('PRESENTATION_NOT_ELIGIBLE');
return {targetId:target.id,eventId:event.event_id,abstractId,closesAt:close,requestId,
  presentationType:owner.presentationType,
  location:{eventCode:owner.eventCode,trackingId:owner.canonicalTrackingId??'',categoryName:owner.categoryName??''}};
// In submitPresentationUpload, before reserveUploadAttempt.
const owner=await requirePresentationOwner(database,actor,abstractId);
const validated=await validatePresentationFile(file,owner.presentationType);
```

- [ ] Retain the old successful-replay branch before new-right checks; never call readUploadGate as a preliminary unconditional check that makes replay fail after its right was consumed. New reservation inserts provider, stored name and identity:

```ts
const gate=await readUploadGate(tx,actor,abstractId,requestId);
if(file.presentationType!==gate.presentationType)fail('PRESENTATION_ROSTER_CONFLICT');
const provider=presentationStorageProvider(gate.presentationType);
if(provider==='drive'&&(!gate.location.eventCode||!gate.location.trackingId||!gate.location.categoryName))fail('PRESENTATION_STORAGE_CONTEXT_INVALID');
const objectKey=provider==='r2'?`events/${gate.eventId}/presentations/${abstractId}/${id}.pdf`:null;
const storedFileName=provider==='drive'?`${gate.location.trackingId}_${file.filename}`:file.filename;
await tx.execute(sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,request_id,operation_key,fingerprint,
  storage_provider,object_key,original_filename,stored_filename,mime_type,size_bytes,digest,lease_until,claim_token)
  VALUES(${id}::uuid,${gate.targetId}::uuid,${actor.id},${requestId}::uuid,${key}::uuid,${fingerprint},${provider},${objectKey},
    ${file.filename},${storedFileName},${file.mimeType},${file.sizeBytes},${file.digest},clock_timestamp()+interval '5 minutes',${claimToken}::uuid)`);
```

- [ ] Extend readBoundUpload to compare claimed provider/actual stored identities in addition to target/user/request/claim token. Drive IDs persisted after reservation must be read fresh, not compared to a stale null reservation field. R2 objectKey check stays.
- [ ] Finalize reads the persisted attempt identity and checks `storage_provider` against current owner type, page/size policy already validated, state='stored'/lease, active request and server close. Persist `file_url` from `drive_file_id` for Drive or R2 base/key; write original/stored filenames and version using these complete column/value lists:

```ts
const fileUrl=a.storage_provider==='drive'
  ?`https://drive.google.com/file/d/${a.drive_file_id}/view`
  :new URL(a.object_key!,`${storage.r2().publicBaseUrl.replace(/\/$/,'')}/`).toString();
await tx.execute(sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,request_id,version,user_id,
  storage_provider,object_key,drive_file_id,drive_folder_id,file_url,original_filename,stored_filename,mime_type,size_bytes,digest,received_at)
  VALUES(${a.id}::uuid,${gate.targetId}::uuid,${a.id}::uuid,${requestId}::uuid,${count.n+1},${actor.id},${a.storage_provider},
    ${a.object_key},${a.drive_file_id},${a.drive_folder_id},${fileUrl},${a.original_filename},${a.stored_filename},${a.mime_type},
    ${a.size_bytes},${a.digest},${acceptedAt.toISOString()}::timestamptz)`);
```

Before that INSERT use the same validated file on initial and stored-attempt recovery paths:

```ts
if(a.storage_provider!==presentationStorageProvider(gate.presentationType) ||
  file.sizeBytes>maxPresentationBytes(gate.presentationType) ||
  (gate.presentationType==='oral'?file.pageCount<2:file.pageCount!==1))fail('PRESENTATION_ROSTER_CONFLICT');
// In submitPresentationUpload's reserved/stored branch:
const upload=await finalizePresentationAttempt(database,actor,abstractId,requestId,attempt,validated,storage);
return {upload,replayed:false};
```

- [ ] Keep current pointer/request submitted/attempt accepted/automatic receipt insertion in the same transaction. Receipt fallback subject becomes “ระบบได้รับไฟล์นำเสนอแล้ว”; template version becomes presentation-receipt-failed-v1. Rendering failure is recorded, DB insert/commit failure rolls back acceptance. Unknown DB outcome re-reads bound upload before cleanup; unknown provider outcome defers deletion to the lease recovery path from Task 5.
- [ ] Add file pageCount/validated type to attempt data retained for finalize policy recheck: pass the validated result into finalize rather than trusting request values; recovery of a stored attempt still runs through submit with the same original file/key. Keep successful replay independent of closed deadline, same as existing behavior.
- [ ] Run focused integrations to PASS including legacy Poster behavior and existing revision tests; commit `feat(presentations): accept Oral and Poster through one atomic workflow`.

## Task 7: Current DB staff grants and correct protected readers

**Files:** Module `access.ts`, `readers.ts`, `access.integration.test.ts`, `readers.test.ts`, `readers.integration.test.ts`; `test-support.ts` already has assigned_presentation_types from Task 2.

**Interfaces:** `requirePresentationStaff(q,actor,eventId,manage):Promise<{manage:boolean;types:Array<'oral'|'poster'>}>`. Non-admin empty types returns no readable rows; manage true still requires admin. Owner reader retains OwnerPresentationDto shape with new upload metadata. Staff list/detail use the returned fresh grants.

- [ ] Add tests for admin all, Organizer/Reviewer same-event only, empty array no rows/count=0/detail 404, oral-only, poster-only including Highlighted, revoked/invalid/inactive account and changed assignments after token issuance. Keep existing mail/match redaction tests. Use both role names, not just Reviewer.

```ts
test('staff type grants are read fresh and empty does not mean all',async t=>{
  const {client,database,fixture}=await preparePresentationScenario(t);
  await client`UPDATE backoffice_users SET role='organizer',assigned_presentation_types='[]'::jsonb WHERE id=${fixture.adminId}`;
  await client`INSERT INTO staff_event_assignments(staff_id,event_id) VALUES(${fixture.adminId},${fixture.eventId})`;
  const actor={...fixture.admin,role:'organizer'};
  assert.deepEqual((await requirePresentationStaff(database,actor,fixture.eventId,false)).types,[]);
  await client`UPDATE backoffice_users SET assigned_presentation_types='["oral"]'::jsonb WHERE id=${fixture.adminId}`;
  assert.deepEqual((await requirePresentationStaff(database,actor,fixture.eventId,false)).types,['oral']);
  await assert.rejects(requirePresentationStaff(database,actor,fixture.eventId,true),{code:'PRESENTATION_ACCESS_DENIED'});
});
```
- [ ] Run readers/access checks expecting over-broad results before edits. Extend the existing fresh staff SELECT and return grants; validate type membership with exact allowed values, not a default-to-all branch:

```ts
// Existing requirePresentationStaff keeps role/email/active/event/assignment validation.
const types=actor.role==='admin'?['oral','poster'] as const:
  Array.isArray(staff.assignedPresentationTypes)
    ?staff.assignedPresentationTypes.filter((v:unknown):v is 'oral'|'poster'=>v==='oral'||v==='poster'):[];
return {manage:actor.role==='admin',types:[...new Set(types)]};
```

- [ ] readRosterRows includes all three announcement types. Add grants filtering before query filters/count/pagination; detail checks the same authoritative type (current Abstract type, not client input). Correct canNotify so ready Oral can be selected by admin. Do not filter the public announcement roster by staff grants.

```ts
const grants=await requirePresentationStaff(database,actor,eventId,false);
const all=await readRosterRows(database,eventId,now,grants.manage?null:grants.types);
const authorized=all.filter(row=>grants.manage || !!row.currentUpload);
// Apply search/round/type/status/received filters, counts and slice to authorized.
// Detail also confirms the linked Abstract's current presentation_type is included in grants.types.
```

Extend private `readRosterRows(q,eventId,now,allowedTypes:Array<'oral'|'poster'>|null=null)` so source labels cannot grant access to a different current DB type. Empty array returns [] before fetching roster/files/mail. Add this clause to the roster SQL using its existing joined `abstracts ab`:

```ts
if(allowedTypes!==null&&allowedTypes.length===0)return [];
const typeScope=allowedTypes===null?sql`true`:
  sql`ab.presentation_type IN (SELECT jsonb_array_elements_text(${JSON.stringify(allowedTypes)}::jsonb))`;
// Existing roster WHERE: event_id=${eventId} AND source type in the three types AND ${typeScope}.
// All detail callers pass the same fresh grants rather than readRosterRows's admin default.
```

- [ ] Owner reader removes poster-only block; fallback type must use `owner.presentationType` when announcement metadata is missing, not hard-coded poster. Initial ready/source checks remain unchanged except Oral eligibility. Revision does not acquire new rights from type changes.
- [ ] Run unit + guarded access/readers integrations to PASS. Commit `fix(presentations): enforce event and assigned type on protected reads`.

## Task 8: New API paths, schemas and multipart limits

**Files:** Module `schemas.ts`, `public.routes.ts`, `backoffice.routes.ts`, `routes.integration.test.ts`; API `src/index.ts` registration; clients consume in Tasks 9/10.

**Interfaces:** GET `/:abstractId/presentation`; POST `/:abstractId/presentation-uploads`; twelve BO method/path pairs retain existing envelopes and parameter/body semantics with `presentation-*` tokens. POST accepts exactly one file field and optional UUID requestId; client-supplied type/provider rejected. No old paths registered.

- [ ] Add route tests for new owner/BO paths, strict type query oral/poster/highlighted-poster, unknown multipart fields, wrong owner before byte buffering, oral 50MiB/Poster30MiB caps, old paths 404, auth/idempotency unchanged.

```ts
test('new owner route is registered and the old route has no adapter',async t=>{
  const {database,fixture,ownerActor}=await preparePresentationScenario(t);
  const app=Fastify();t.after(()=>app.close());
  app.addHook('onRequest',async request=>{request.user=ownerActor as typeof request.user;});
  await app.register(presentationOwnerRoutes,{database,prefix:'/api/abstracts'});
  const current=await app.inject({method:'GET',url:`/api/abstracts/${fixture.abstractId}/presentation`});
  assert.equal(current.statusCode,200);assert.equal(current.json().data.abstractId,fixture.abstractId);
  const old=await app.inject({method:'GET',url:`/api/abstracts/${fixture.abstractId}/poster`});
  assert.equal(old.statusCode,404);
});
```

Import Fastify from fastify, presentationOwnerRoutes from public.routes.js and existing fixture/assert/test symbols. The injected user is test-only; production continues using the authenticated registration in src/index.ts.
- [ ] Run route tests expecting new endpoint/size failures. In POST resolve owner once before reading parts; pass authoritative max into multipart helper:

```ts
async function readPresentationMultipart(request:FastifyRequest,maxBytes:number) {
  let file:{buffer:Buffer;filename:string;mimetype:string}|undefined;
  let requestId:string|null=null;
  for await(const part of request.parts({limits:{files:1,fields:1,parts:2,fileSize:maxBytes}})) {
    if(part.type==='file') {
      if(part.fieldname!=='file'||file)fail('PRESENTATION_ONE_FILE_REQUIRED',422);
      file={buffer:await part.toBuffer(),filename:part.filename,mimetype:part.mimetype};
      if(part.file.truncated)fail('PRESENTATION_FILE_TOO_LARGE',413);
    } else {
      if(part.fieldname!=='requestId'||requestId!==null||typeof part.value!=='string')fail('PRESENTATION_INVALID_FIELDS',422);
      requestId=z.string().uuid().parse(part.value);
    }
  }
  if(!file)fail('PRESENTATION_ONE_FILE_REQUIRED',422);
  return {file:file!,requestId};
}
// POST after params/auth/strict query/key validation:
const owner=await requirePresentationOwner(database,actor,abstractId);
const input=await readPresentationMultipart(request,maxPresentationBytes(owner.presentationType));
```

- [ ] Extend `listQuerySchema.presentationType` to z.enum(['oral','poster','highlighted-poster']); register owner and BO plugins under existing /api/abstracts and /api/backoffice prefixes. Preserve approved-abstracts public roster endpoint and its allowlist response.
- [ ] Map Fastify multipart errors to PRESENTATION codes/statuses like the existing implementation; global multipart 50MiB already matches the Oral ceiling, so do not increase global caps for unrelated uploads.
- [ ] Run route integrations to PASS; full typecheck is Task 13 after mail and client DTO consumers converge. Commit `feat(presentations): expose renamed APIs with authoritative upload bounds`.

## Task 9: Participant Presentation page, selection, links and bilingual copy

**Files:** `Pris2026/src/app/[locale]/presentation-submission/page.tsx`; `src/components/presentations/PresentationWorkspace.tsx`, `PresentationConfirmDialog.tsx`, `PresentationSuccessDialog.tsx`; `src/lib/presentationApi.ts`, `presentationSubmissionState.ts`, `localizedRedirect.ts`, `refreshRedirect.ts`; `src/types/presentations.ts`; `src/components/layout/Header.tsx`; `src/app/[locale]/approved-abstracts/page.tsx`; `messages/th.json`, `en.json` and seven inventoried tests.

**Interfaces:** `getOwnerPresentation(token,abstractId,requestId?,signal?):Promise<OwnerPresentationDto>`; `uploadPresentation({token,abstractId,requestId,file,key,onProgress,signal?}):Promise<{upload:UploadDto;replayed:boolean}>`; `fileProblem(file,type:AnnouncementType):string|null`; `presentationReturnPath(search):string|null`. DTO/fileUrl/name fields are exactly Task 3's contract; errors use PRESENTATION prefix.

- [ ] Extend selection and workspace/page tests with Oral DTO, 50MiB ceiling, Oral requirements/template, Drive URL history/current link, original filename shown, filename retained for confirm/receipt and type-specific size text. Keep uncertainty/key/remount/100%-progress/focus assertions. Add redirect tests with the new path and duplicate/invalid abstractId/requestId cases.

```ts
test('declared sizes are checked against the owner type',()=>{
  const bytes=new Uint8Array(52_428_801);
  assert.equal(fileProblem(new File([bytes.subarray(1)],'slides.pdf',{type:'application/pdf'}),'oral'),null);
  assert.equal(fileProblem(new File([bytes],'slides.pdf',{type:'application/pdf'}),'oral'),'PRESENTATION_FILE_TOO_LARGE');
  assert.equal(fileProblem(new File([bytes.subarray(0,31_457_281)],'poster.pdf',{type:'application/pdf'}),'poster'),'PRESENTATION_FILE_TOO_LARGE');
  assert.equal(fileProblem(new File(['x'],'poster.png',{type:'image/png'}),'oral'),'PRESENTATION_FILE_TYPE');
});
```

- [ ] Run selection/workspace/page/api/redirect tests expecting failures for Oral requirements or updated DTO. Replace fileProblem with this complete client declaration check (page count stays on API):

```ts
export function fileProblem(file:File,type:AnnouncementType):string|null {
  if(file.size<1)return 'PRESENTATION_FILE_EMPTY';
  if(file.size>(type==='oral'?52_428_800:31_457_280))return 'PRESENTATION_FILE_TOO_LARGE';
  return /\.pdf$/i.test(file.name)&&['','application/octet-stream','application/pdf'].includes(file.type.toLowerCase())
    ?null:'PRESENTATION_FILE_TYPE';
}
```

- [ ] Pass owner.presentationType at every fileProblem caller in page/workspace, including effect dependency when a new type arrives. Keep explicit `application/pdf` Blob preview and URL revocation. Add type/requirements/template variables without a new UI framework:

```tsx
const oral=o.presentationType==='oral';
const typeKey=oral?'oral':o.presentationType==='highlighted-poster'?'highlighted':'poster';
const maxMiB=oral?50:30;
const pageRule=t(oral?'pageRuleOral':'pageRulePoster');
const templateUrl=oral
  ?'https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Oral%20Template.zip'
  :'https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Poster%20Template.zip';
// Replace the corresponding existing JSX children; preserve classes, dialog focus and structure.
<PageHero title1={t(o.selectedRequest?'revisionHeroTitle':'heroTitle')} title2={t(typeKey)} inlineTitle inlineTitleTight />
<p>{t(oral?'requirementsOral':'requirementsPoster')}</p>
<a href={templateUrl} target="_blank" rel="noopener noreferrer">{t(oral?'downloadOralTemplate':'downloadPosterTemplate')}</a>
<span>PDF · {maxMiB} MiB</span>
<a href={o.currentUpload!.fileUrl} target="_blank" rel="noopener noreferrer">{o.currentUpload!.fileName}</a>
{p.error&&<p role="alert">{t.has(`errors.${p.error}`)?t(`errors.${p.error}`,{maxMiB,pageRule}):t('uploadError')}</p>}
```

The JSX snippets replace existing elements, not adjacent duplicated UI. currentUpload's anchor remains inside its existing non-null condition.

- [ ] Change current/history DTO references publicUrl to fileUrl in workflow components only; copied UploadDto is PDF-only because old upload test data is intentionally discarded. Preserve original fileName for every confirmation/receipt, and never show stored prefix as the user's uploaded name.
- [ ] Update API URLs to presentation/presentation-uploads; retain FormData, bearer, Idempotency-Key, XHR timeout/progress, network-unknown classification and original retry File/key. getApprovedAnnouncements retains the existing roster URL after its module import move.
- [ ] Retarget presentationReturnPath, eventReturnQuery, normalizeLocalizedRedirectPath, refresh preservation and Header locale switch to `/presentation-submission`, preserving query validation. Do not add redirects or aliases for poster-submission.
- [ ] Add these exact messages under root presentation; keep other messages and accessibility/error texts, adjusting active workflow wording without renaming actual types:

```json
{
  "th": {
    "oral": "Oral",
    "requirementsOral": "ไฟล์ PDF หนึ่งไฟล์ อย่างน้อย 2 หน้า ขนาดไม่เกิน 50 MiB และไม่ตั้งรหัสผ่าน",
    "requirementsPoster": "ไฟล์ PDF หนึ่งไฟล์ หนึ่งหน้า ขนาดไม่เกิน 30 MiB และไม่ตั้งรหัสผ่าน",
    "downloadOralTemplate": "ดาวน์โหลด Template สำหรับ Oral (.ZIP)",
    "downloadPosterTemplate": "ดาวน์โหลด Template สำหรับ Poster (.ZIP)",
    "pageRuleOral": "อย่างน้อย 2 หน้า",
    "pageRulePoster": "หนึ่งหน้า",
    "errors": {
      "PRESENTATION_FILE_TOO_LARGE": "ไฟล์ต้องมีขนาดไม่เกิน {maxMiB} MiB",
      "PRESENTATION_PDF_PAGE_COUNT": "ไฟล์ PDF ต้องมี {pageRule}"
    }
  },
  "en": {
    "oral": "Oral",
    "requirementsOral": "One PDF file, at least 2 pages, maximum 50 MiB, without password protection.",
    "requirementsPoster": "One PDF file, exactly 1 page, maximum 30 MiB, without password protection.",
    "downloadOralTemplate": "Download Oral Template (.ZIP)",
    "downloadPosterTemplate": "Download Poster Template (.ZIP)",
    "pageRuleOral": "at least 2 pages",
    "pageRulePoster": "exactly 1 page",
    "errors": {
      "PRESENTATION_FILE_TOO_LARGE": "The file must not exceed {maxMiB} MiB.",
      "PRESENTATION_PDF_PAGE_COUNT": "The PDF must have {pageRule}."
    }
  }
}
```

Merge these messages into the existing root presentation object and its existing errors object, retaining all other error keys. Update the existing React-test translator stub to interpolate these supplied values so its assertions exercise the same visible text:

```ts
const translate=(key:string,values:Record<string,string|number>={})=>
  String(lookup(key)??key).replace(/\{(\w+)\}/g,(_match,name:string)=>String(values[name]??`{${name}}`));
```

- [ ] Re-run all seven focused tests and Pris typecheck/focused ESLint. Expected no new failures; an unrelated pre-existing test/type error must be cited separately, not fixed by weakening types. Commit `feat(presentations): unify owner UI with Oral PDF rules and Drive links`.

## Task 10: Backoffice Presentation screens and Organizer type assignment

**Files:** `conference-backoffice/src/app/presentations/page.tsx`, `[abstractId]/page.tsx`; six renamed `src/components/presentations/Presentation*.tsx`; `src/lib/api.ts`, `presentationUi.ts`, `presentationUi.test.ts`; `src/types/presentations.ts`; `src/contexts/AuthContext.tsx`, `src/components/layout/Sidebar.tsx`; `src/app/users/page.tsx`.

**Interfaces:** `api.presentations` retains the existing twelve method signatures/envelopes/idempotency fields on new URLs; `User.assignedPresentationTypes` remains the existing field. Type assignment create/update payload supports Organizer and Reviewer; existing API users routes/schema already accept it.

- [ ] Extend the existing BO helper/harness check for new paths/envelopes, badge mapping, Drive links, received-only viewer controls and type assignment payload. Add assertions that Reviewer categories remain unchanged while Organizer sends assignedPresentationTypes. Use the existing test executable from API, no new runner dependency:

```ts
test('Organizer type assignment does not create Reviewer category restrictions',()=>{
  assert.deepEqual(presentationUserAssignments('organizer',['oral'],['clinical']),{assignedPresentationTypes:['oral']});
  assert.deepEqual(presentationUserAssignments('reviewer',['poster'],['clinical']),{
    assignedCategories:['clinical'],assignedPresentationTypes:['poster']});
  assert.deepEqual(presentationUserAssignments('admin',['oral'],['clinical']),{});
});
```

```powershell
# CWD conference-backoffice
../conference-api/node_modules/.bin/tsx.cmd --test src/lib/presentationUi.test.ts
```

- [ ] Run to fail before UI edits. Use a three-type label in list/detail/history while preserving status/progress classes and query scope:

```tsx
const typeLabels={oral:'Oral',poster:'Poster','highlighted-poster':'Highlighted Poster'};
<span>{typeLabels[row.announcement.presentationType]}</span>
<select aria-label="ประเภทการนำเสนอ" value={presentationType} onChange={event=>filter(setPresentationType,event.target.value)}>
  <option value="">ทุกประเภท</option><option value="oral">Oral</option>
  <option value="poster">Poster</option><option value="highlighted-poster">Highlighted Poster</option>
</select>
```

- [ ] api.presentations URLs use new BO tokens; page/detail/back links use /presentations and eventId. AuthContext/Sidebar allowlists replace /posters with /presentations for both roles; permission enforcement stays in API. Label headers/current file/revision/selection/pagination itemName Presentation, and keep admin-only fields/buttons.
- [ ] Show accepted Oral as its stored Drive view link, not an iframe pointed at a Drive view page. R2 PDF preview stays inline. Remove the old historical PNG-specific branch from these new-schema pages/tests because no old uploads are copied:

```tsx
{detail.row.currentUpload && (detail.row.currentUpload.storageProvider==='drive'
  ?<a href={detail.row.currentUpload.fileUrl} target="_blank" rel="noopener noreferrer">เปิดไฟล์ Oral ใน Google Drive</a>
  :<iframe src={detail.row.currentUpload.fileUrl} title={`ไฟล์นำเสนอ ${detail.row.announcement.title}`} className="h-[650px] w-full" />)}
```

- [ ] In both user create/edit dialogs show the existing presentation-type controls for Organizer or Reviewer; keep category controls Reviewer-only. Replace payload spreads in create and PATCH handlers exactly:

```ts
// Export in the already-inventoried presentationUi.ts; both users handlers reuse it.
export function presentationUserAssignments(role:string,types:string[],categories:string[]) {
  return {
    ...(role==='reviewer'&&{assignedCategories:categories}),
    ...(['organizer','reviewer'].includes(role)&&{assignedPresentationTypes:types}),
  };
}
// users/page.tsx create and PATCH: spread this into their existing names/email/role/password body.
const assignments=presentationUserAssignments(formData.role,formData.assignedPresentationTypes,formData.assignedCategories);
```

Update helper text to “เลือกประเภทที่เจ้าหน้าที่ได้รับมอบหมาย หากไม่เลือกจะไม่เห็นไฟล์นำเสนอ” and expose only oral/poster checkboxes. No separate Highlighted or new category grants. Do not edit API users.ts just for an already-supported field.
- [ ] Re-run BO helper check, typecheck and focused ESLint; verify create/edit Organizer persists assignments through existing API. Commit `feat(presentations): unify backoffice and expose staff type assignments`.

## Task 11: Four type-aware emails and current worker prechecks

**Files:** Module `types.ts`, `email-template.ts`, `email-template.test.ts`, `email-jobs.ts`, `email-jobs.integration.test.ts`, `operations.ts`, `operations.integration.test.ts`, `revisions.ts`, `uploads.ts`; external `conference-api/src/services/emailService.test.ts`.

**Interfaces:** `MailPayload` gains `presentationType:AnnouncementType`; `buildMailPayload` reads current DB/source type; `renderPresentationEmail(p)` returns `{subject,html,templateVersion}`; `buildSubmissionUrl` uses presentation-submission. Preview digest includes the type; initial/reminder/revision worker owner gate supports oral/poster. No old payload compatibility branch.

- [ ] Add tests across 3 announcement types × 4 mail kinds for subject/type/requirements/template/link/deadline/escaping. Verify no receipt Template requirement, correct received upload version/name/time, HTML escaping of original filename/revision details and no actual provider calls. Existing email transport tests stay unchanged except import path/name.

```ts
test('Oral initial email uses the Oral ZIP, two-page minimum and 50 MiB',()=>{
  const payload:MailPayload={kind:'initial',abstractId:1,trackingId:'PRIS-2026-O001',title:'Synthetic <title>',
    submitterName:'Synthetic Owner',recipient:'owner@example.invalid',websiteOrigin:'https://example.invalid',
    closesAt:'2026-10-20T17:00:00.000Z',revisionRequestId:null,revisionDetails:null,upload:null,presentationType:'oral'};
  const rendered=renderPresentationEmail(payload);
  assert.match(rendered.subject,/Oral/);assert.match(rendered.html,/อย่างน้อย 2 หน้า/);
  assert.match(rendered.html,/50 MiB/);assert.match(rendered.html,/Presentation%20Oral%20Template.zip/);
  assert.match(rendered.html,/presentation-submission\?abstractId=1/);
  assert.match(rendered.html,/Synthetic &lt;title&gt;/);assert.doesNotMatch(rendered.html,/30 MiB/);
});
```
- [ ] Run mail tests to fail for Oral text/worker gate. Add complete renderer helpers and replace the pure renderer while preserving contact/signature and not using unescaped DB fields:

```ts
const oralTemplate='https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Oral%20Template.zip';
const posterTemplate='https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Poster%20Template.zip';
const escape=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const thaiDate=(iso:string,offset=0)=>new Intl.DateTimeFormat('th-TH-u-ca-buddhist',{
  timeZone:'Asia/Bangkok',dateStyle:'long',timeStyle:'medium',hour12:false,
}).format(new Date(Date.parse(iso)+offset)).replace(/:/g,'.');

export function renderPresentationEmail(p:MailPayload):{subject:string;html:string;templateVersion:string} {
  if(!z.string().email().safeParse(p.recipient).success)throw Error('PRESENTATION_EMAIL_INVALID');
  const type=p.presentationType==='oral'?'Oral':p.presentationType==='highlighted-poster'?'Highlighted Poster':'Poster';
  const href=escape(buildSubmissionUrl(p.websiteOrigin,p.abstractId,p.revisionRequestId??p.upload?.revisionRequestId??undefined));
  let subject:string,content:string;
  if(p.kind==='receipt') {
    if(!p.upload)throw Error('PRESENTATION_RECEIPT_UPLOAD_MISSING');
    subject=`แจ้งการได้รับไฟล์นำเสนอ ${type} รหัส ${p.trackingId} ในงาน PRIS 2026`;
    content=`<p>ระบบได้รับไฟล์นำเสนอ ${type} สำหรับผลงานของท่านเรียบร้อยแล้ว</p>
      <ul><li><strong>รหัสผลงาน:</strong> ${escape(p.trackingId)}</li><li><strong>ชื่อผลงาน:</strong> ${escape(p.title)}</li>
      <li><strong>ชื่อไฟล์:</strong> ${escape(p.upload.fileName)}</li><li><strong>ฉบับที่:</strong> ${p.upload.version}</li>
      <li><strong>วันและเวลาที่ระบบได้รับ:</strong> ${escape(thaiDate(p.upload.receivedAt))} น. (เวลาประเทศไทย)</li></ul>
      <p><a href="${href}">ดูไฟล์ที่ส่ง</a></p>`;
  } else {
    if(!p.closesAt)throw Error('PRESENTATION_MAIL_DEADLINE_MISSING');
    const oral=p.presentationType==='oral';
    const verb=p.kind==='revision'?'แจ้งขอแก้ไข':p.kind==='reminder'?'เตือนส่ง':'แจ้งส่ง';
    subject=`${verb}ไฟล์นำเสนอ ${type} รหัส ${p.trackingId} ในงาน PRIS 2026`;
    content=`<p>สภาเภสัชกรรมขอเรียน${p.kind==='reminder'?'เตือน':'แจ้ง'}ให้ท่านดำเนินการ${p.kind==='revision'?'แก้ไขและ':''}ส่งไฟล์นำเสนอ ${type} สำหรับผลงานดังต่อไปนี้</p>
      <ul><li><strong>รหัสผลงาน:</strong> ${escape(p.trackingId)}</li><li><strong>ชื่อผลงาน:</strong> ${escape(p.title)}</li>
      ${p.kind==='revision'?`<li><strong>รายละเอียดการแก้ไข:</strong> ${escape(p.revisionDetails??'').replace(/\r?\n/g,'<br>')}</li>`:''}
      <li><strong>กำหนดส่ง:</strong> ${escape(thaiDate(p.closesAt,-1000))} น. (เวลาประเทศไทย)</li></ul>
      <p><strong>ข้อกำหนดของไฟล์</strong></p><ul><li>ไฟล์ PDF หนึ่งไฟล์ ${oral?'อย่างน้อย 2 หน้า ขนาดไม่เกิน 50 MiB':'หนึ่งหน้า ขนาดไม่เกิน 30 MiB'}</li><li>ไฟล์ PDF ต้องไม่ตั้งรหัสผ่าน</li></ul>
      <p><a href="${oral?oralTemplate:posterTemplate}">ดาวน์โหลด Template สำหรับ ${oral?'Oral':'Poster'} (.ZIP)</a></p>
      <p><strong>ขั้นตอนและเงื่อนไขการส่ง</strong></p><ol><li>เข้าสู่ระบบด้วยบัญชีที่ใช้ส่งบทคัดย่อของผลงานนี้</li>
      <li>การส่งสำเร็จเมื่อระบบตรวจสอบและบันทึกไฟล์เรียบร้อยแล้ว</li><li>สิทธิ์นี้ส่งสำเร็จได้หนึ่งครั้ง หากต้องการแก้ไขภายหลังกรุณาติดต่อเจ้าหน้าที่</li></ol>
      <p><a href="${href}">ส่งไฟล์นำเสนอที่นี่</a></p>`;
  }
  const html=`<!doctype html><html lang="th"><body><p>เรียน คุณ${escape(p.submitterName)}</p>${content}
    <p>หากมีข้อสงสัยเพิ่มเติม สามารถติดต่อได้ที่ <a href="mailto:pr@pharmacycouncil.org">pr@pharmacycouncil.org</a></p>
    <p>จึงเรียนมาเพื่อ${p.kind==='receipt'?'โปรดทราบ':'โปรดดำเนินการ'}</p><p>ขอแสดงความนับถือ</p><p>สภาเภสัชกรรม</p><p>(The Pharmacy Council of Thailand)</p>
    <p><em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้</em></p></body></html>`;
  return {subject,html,templateVersion:`presentation-${p.kind}-v1`};
}
```

- [ ] buildSubmissionUrl preserves current HTTPS/origin/path/credentials validation and switches its path to `/th/presentation-submission`. buildMailPayload SELECT includes `a.presentation_type`; retrieve the active announcement type to retain Highlighted label but do not use an input type. Map new upload columns as Task 3. Snapshot contains the type before render/digest.
- [ ] Replace worker `a.presentation_type='poster'` owner query with `IN ('oral','poster')`; require active owner/current staff checks and existing readiness/deadline/no-current-file/current-request/fingerprint checks. Claimed provider acceptance still means sent, not inbox delivery; unknown remains unknown, no auto-resend.
- [ ] Preserve initial/reminder preview-confirm and idempotent batch keys; revise payload/type shape in preview/create/resend/receipt paths together to avoid stale fingerprints introduced by inconsistent copies. No migration of old jobs or legacy renderer versions.
- [ ] Run mail/operations/revision integration checks + emailService unit test to PASS; commit `feat(presentations): render and deliver type-aware presentation emails`.

## Task 12: Startup, worker commands, preflight/verification and rollout runbook

**Files:** Module `startup.ts`, `jobs-runner.ts`, `deployment.integration.test.ts`; API `src/index.ts`, `package.json`, `Dockerfile`, `.env.example`; moved `sql/presentations-setup/01_preflight.sql`, `02_verify.sql`, `docs/superpowers/runbooks/pris2026-presentations.md`.

**Interfaces:** `initializePresentations`, `presentationReadiness`, `presentationWorkerHealthy`, `runPresentationWorkerIteration`; flags/commands/SERVICE_ROLE per approved spec. Reconcile startup while paused continues without overwriting custom deadline/used rights and without queueing notifications.

- [ ] Extend deployment integration to legacy-to-new migration, fresh install, paused source reconciliation, compiled CLI exit0/1/clean pool close, renamed healthcheck before DB import, custom deadline preservation and new provider cleanup. No duplicate worker or second runtime DB.

```ts
test('renamed worker healthcheck does not import a runtime DB',async()=>{
  await writeFile(presentationHeartbeatPath,String(Date.now()));
  try {
    await promisify(execFile)(process.execPath,['--import','tsx','src/modules/presentations/jobs-runner.ts','--healthcheck'],{
      env:{...process.env,DATABASE_URL:'invalid-synthetic-healthcheck-url'},timeout:10000});
  }finally {await unlink(presentationHeartbeatPath).catch(()=>undefined);}
});
```

Import writeFile/unlink from node:fs/promises, promisify from node:util, execFile from node:child_process and presentationHeartbeatPath from jobs-runner.ts; these are installed stdlib/existing symbols. This test only touches the newly named test heartbeat, never the legacy worker heartbeat.
- [ ] Run deployment check to fail for old compile paths/config names. Update operational literals explicitly:

```json
{
  "test:presentations": "tsx --test src/modules/presentations/policy.test.ts src/modules/presentations/data.test.ts src/modules/presentations/file-validation.test.ts src/modules/presentations/storage.test.ts src/modules/presentations/email-template.test.ts src/modules/presentations/readers.test.ts src/services/googleDrive.presentation.test.ts",
  "test:presentations:integration": "tsx --test --test-concurrency=1 src/modules/presentations/migration.integration.test.ts src/modules/presentations/reconcile.integration.test.ts src/modules/presentations/access.integration.test.ts src/modules/presentations/operations.integration.test.ts src/modules/presentations/revisions.integration.test.ts src/modules/presentations/uploads.integration.test.ts src/modules/presentations/email-jobs.integration.test.ts src/modules/presentations/readers.integration.test.ts src/modules/presentations/routes.integration.test.ts src/modules/presentations/workflow.integration.test.ts src/modules/presentations/deployment.integration.test.ts",
  "presentations:worker:dev": "tsx watch src/modules/presentations/jobs-runner.ts",
  "presentations:worker": "node dist/modules/presentations/jobs-runner.js",
  "presentations:worker:health": "node dist/modules/presentations/jobs-runner.js --healthcheck",
  "presentations:reconcile": "node dist/modules/presentations/startup.js --reconcile"
}
```

`.env.example` uses PRESENTATION_SUBMISSIONS_ENABLED=false and PRESENTATION_EMAILS_ENABLED=false, retains GOOGLE_DRIVE_FOLDER_ABSTRACTS, existing Google credentials and Abstract-only folder ENV names. Docker SERVICE_ROLE is presentation-worker with `dist/modules/presentations/jobs-runner.js --healthcheck`; existing other SERVICE_ROLE branches remain identical. Heartbeat `pris-presentation-worker-heartbeat`.

- [ ] Replace preflight with an explicit read-only check of one PRIS event, required tracking/categories/assignments objects, no presentation schema already initialized, recognized old schema states and dependency inventory. It must not require zero old poster tables, because replacement of those tables is the authorized migration. Read-only assertions:

```sql
BEGIN READ ONLY;
DO $$ BEGIN
  IF (SELECT count(*) FROM events WHERE event_code='PRIS-2026')<>1 THEN RAISE EXCEPTION 'Expected exactly one PRIS-2026 event'; END IF;
  IF to_regclass('public.presentation_settings') IS NOT NULL THEN RAISE EXCEPTION 'Presentation schema already exists: verify, do not reset'; END IF;
  IF to_regclass('public.abstract_tracking_identifiers') IS NULL OR to_regclass('public.staff_event_assignments') IS NULL OR to_regclass('public.abstract_categories') IS NULL THEN RAISE EXCEPTION 'Presentation prerequisites missing'; END IF;
END $$;
SELECT current_database(),current_schema();
SELECT a.id,a.tracking_id,a.presentation_type,a.user_id,c.name AS category_name
FROM abstracts a JOIN events e ON e.id=a.event_id LEFT JOIN abstract_categories c ON c.id=a.category_id AND c.event_id=a.event_id
WHERE e.event_code='PRIS-2026' ORDER BY a.id;
COMMIT;
```

- [ ] Verification preserves old invariant checks under new names and adds provider/size checks/current owner identity counts, settings close/version, type/source/match/round counts and that no poster tables remain. Include this exact provider invariant query; an empty result is PASS:

```sql
SELECT id,storage_provider,size_bytes,drive_file_id,object_key FROM presentation_uploads
WHERE (storage_provider='drive' AND (size_bytes>52428800 OR drive_file_id IS NULL OR object_key IS NOT NULL))
   OR (storage_provider='r2' AND (size_bytes>31457280 OR object_key IS NULL OR drive_file_id IS NOT NULL));
```

- [ ] Rewrite runbook for coordinated new API/worker/Pris/BO rollout. Include explicit environment/backup/operator evidence, stopped legacy worker/receiving, migration transaction, official source review (exclude local Round2 test rows), reconciliation while disabled, rights/grants/Drive sharing checks, one worker, readiness, separately enable receiving/mail. Do not run deploy merely because code checks passed.
- [ ] Document rollback: before accepting real new data use the environment's approved migration backup process if needed; after accepting data pause flags and fix forward/compatible artifact, never drop presentation uploads or delete Drive/R2 objects to restore the old code. Leave old SQL 0038 in history.
- [ ] Build API then run guarded deployment tests and healthcheck tests to PASS; commit `chore(presentations): align worker and replacement rollout checks`.

## Task 13: Final proof and handoff

**Files:** All changed code/tests from Tasks 1–12; execution reports beneath `D:/confer/confer/conference/.test-artifacts/presentations/`; update the runbook acceptance evidence links. No new production feature or broad refactor.

**Interfaces:** Produces reviewable cross-repo diffs/commit SHAs, acceptance results, baseline exceptions, approved source status and executable release runbook. Does not itself deploy or call live providers.

- [ ] Check coverage against every item in the approved spec Acceptance section and every path in the 84-entry inventory. Record any actual count delta and why; do not claim the estimate is the final diff count.
- [ ] Resolve data.test.ts baseline without discarding user source edits: assert official Round1 data directly and test loader composition with the current Round2 module, rather than force Round2 empty. The two manual rows remain clearly local-only and their removal from a release source requires the real approved roster, not a fabricated replacement. Exact split:

```ts
import { approvedRound1Abstracts } from './data/approvedRound1Abstracts.js';
import { approvedRound2Abstracts } from './data/approvedRound2Abstracts.js';
assert.equal(approvedRound1Abstracts.length,119);
assert.deepEqual(loadPresentationAnnouncements(),[...approvedRound1Abstracts,...approvedRound2Abstracts]);
assert.equal(createHash('sha256').update(JSON.stringify(approvedRound1Abstracts)).digest('hex'),
  '290765d7e029bd1ecf9e550ebffc9e1d2fb27c09192faae802ccd11e4de6b812');
```

- [ ] Run focused full gates once after all code changes (then repeat only failed/newly affected checks). Commands and expected results:

```powershell
# CWD conference-api
npm run build
npm run test:presentations
./node_modules/.bin/tsx.cmd --test src/services/emailService.test.ts src/services/emailTemplates.test.ts
# Only with the already-authorized integration environment, not guessed DATABASE_URL:
npm run test:presentations:integration

# CWD Pris2026
./node_modules/.bin/tsx.cmd --test src/lib/presentationApi.test.ts src/lib/presentationSubmissionState.test.ts src/lib/presentationPage.test.ts src/lib/presentationWorkspace.test.ts src/lib/localizedRedirect.test.ts src/lib/refreshRedirect.test.ts src/lib/approvedAnnouncementsPage.test.ts
./node_modules/.bin/tsc.cmd --noEmit
npm run build

# CWD conference-backoffice
../conference-api/node_modules/.bin/tsx.cmd --test src/lib/presentationUi.test.ts
./node_modules/.bin/tsc.cmd --noEmit
npm run build
```

Expected exit0 for changed-scope tests/builds. If a baseline unrelated error survives, provide its exact file/message and prove it predates this work; do not hide it as a new success. Missing integration target is unverified acceptance, not PASS. No claim of 84-file implementation completion without the protected-storage/rights/migration gates.

- [ ] Run focused ESLint only for changed frontend paths, not a whole-repo cleanup. Run `git diff --check` in each repo. Inspect old workflow literals with explicit exclusions for type names/history/approved test DB guard:

```powershell
rg -n 'modules/posters|components/posters|types/posters|poster-submission|/posters|POSTER_SUBMISSIONS_ENABLED|POSTER_EMAILS_ENABLED|poster-worker' conference-api/src conference-api/package.json conference-api/Dockerfile conference-api/.env.example Pris2026/src conference-backoffice/src
# Expected: no active old workflow literal; actual Abstract type/ENV/history is not in this expression.
```

- [ ] In the existing local test preview run TH/EN owner Oral initial/revision/upload-unknown/receipt/history, Poster page-count/size failure, Organizer oral-only, Reviewer poster-only with Highlighted, empty type assignment no records, and Admin preview/confirm/revision. Use doubles/synthetic accounts, no live email/R2/Drive upload. The plan does not authorize opening a second service on the existing port; check established running services first.
- [ ] Review final SQL against drop allowlist and preserved objects; review provider identity/cleanup race scenarios and fresh staff grants. Confirm no legacy adapters/payload compatibility, new dependency, private proxy, new root ENV or type-change/reset feature slipped in.
- [ ] Ensure the user Round2 file is still uncommitted at its new path, with content unchanged except necessary type import/module rename; compare original data/rows to the preserved snapshot. Stage only remaining scoped code/docs/tests and commit `test(presentations): prove shared submission and replacement safety` per affected repository.
- [ ] Report final SHAs/checks/limitations and link the release runbook. Runtime migration/deploy/real provider tests remain separate explicit actions against a named environment.

## Requirement-to-task coverage

| Approved requirement | Tasks |
| --- | --- |
| Full workflow rename/no legacy routes or jobs | 1, 8, 9, 10, 11, 12, 13 |
| Real source rounds 1/2/current owner/matching | 3, 6, 8, 13 |
| Oral >=2 pages/50MiB, Poster1page/30MiB | 2, 3, 6, 8, 9, 11 |
| Shared editable Thai deadline | 2, 3, 6, 9, 10, 11, 12 |
| Existing initial/revision lifecycle and data checks | 5, 6, 7, 11, 13 |
| Staff event AND type, empty none, Highlighted=poster | 2, 7, 10, 13 |
| Oral Drive hierarchy/name/public link/fileId/version | 3, 4, 5, 6, 9, 10 |
| R2 Poster preservation | 3, 5, 6, 9, 10 |
| Type-aware Template and four email kinds | 9, 11 |
| Destructive scope only Poster test tables, other systems preserved | 2, 12, 13 |
| No private API/new ENV root/new dependency/new type-change workflow | All tasks |

## Execution selection

Plan work ends after this document and approved spec are saved/reviewed. Choose either:

1. Subagent-driven task execution with review after each task, using `vendor/superpowers/skills/subagent-driven-development/SKILL.md`.
2. Inline execution in this chat with checkpoints, using `vendor/superpowers/skills/executing-plans/SKILL.md`.

Both skills exist locally. Read the chosen skill when execution is requested, not during this planning-only turn. Do not spawn agents, create a worktree, start implementation, execute migration, or deploy as part of producing the plan.
