# PRIS 2026 Presentation cutover

This is an operator procedure. Implementation tests use one isolated Docker PostgreSQL database and injected Drive/R2/mail transports. No runtime migration, live file upload, email or deployment has been executed.

## Release inputs

- Record exact API, Pris2026 and Backoffice artifact SHAs, environment identity, backup reference, restore owner and existing supervisor commands before cutover. Production topology and backup commands are environment-specific; use the established deployment process.
- Review announcement files against both official rounds, current Abstract type/title/owner/tracking and category. Round 1 remains 119 rows: Oral 31, Highlighted Poster 39, Poster 49, two pending IDs. Round 2 totals depend on reviewed source. **Exclude uncommitted `LOCAL MANUAL TEST ONLY` Round 2 rows from release artifacts.** Never force target count to a fixed number.
- Keep Google OAuth credentials and `GOOGLE_DRIVE_FOLDER_ABSTRACTS`; no new root ENV. Poster uses existing R2 credentials/bucket/public base. Independent receiving/sending flags must be false during preparation.

## Coordinated cutover

1. Back up the explicitly selected runtime DB through its approved process. Record pre-cutover Abstract/users/events/tracking/other-system evidence. Stop the old Poster worker and pause old receiving/mail before replacing its tables. Stop API processes that write the old schema; allow the established supervisor's drain interval.
2. Run `sql/presentations-setup/01_preflight.sql` with the authorized SQL client and `ON_ERROR_STOP=1`. It is read-only. Require one PRIS-2026 Event, categories, tracking and staff-event assignments. Inspect identifiers, owner/category/type values, staff grants and legacy dependencies. If Presentation exists, verify instead of resetting it. Old Poster tables are expected when replacing the test workflow.
3. Apply **`drizzle/0039_pris2026_presentations.sql` once** through the approved migration process. Its transaction creates ten `presentation_*` tables and drops only the ten named `poster_*` test tables and their workflow guards. Abstracts, users, Events, categories, tracking and other systems remain. Keep historical 0038. Never substitute schema push/reset or `DROP ... CASCADE`. DB replacement does not delete external Drive/R2 objects.
4. Release matching API, Pris and Backoffice with `PRESENTATION_SUBMISSIONS_ENABLED=false` and `PRESENTATION_EMAILS_ENABLED=false`. Owner page: `/presentation-submission`; Backoffice: `/presentations`. APIs use `presentation`/`presentation-uploads` and `presentation-*` Backoffice endpoints. Old paths/jobs have no compatibility adapter.
5. Start API paused. Startup reconciles approved source without notices or rights resets. `npm run presentations:reconcile` explicitly reruns and exits 0/1 while closing its pool. Inject the named target `DATABASE_URL` through the existing secrets process, never a developer `.env` file.
6. Run read-only `sql/presentations-setup/02_verify.sql`. Require one ready settings row; review rounds/types/match states, identities, constraints, indexes, triggers and provider invariants. Empty mismatch/duplicate results required. Resolve incorrect source/type/owner data before enabling deployment, using existing authorized tools and reconciliation.
7. Initial exclusive close: **`2026-10-20T17:00:00.000Z`**, last permitted Thai second **20 October 2026 23:59:59**. Preserve audited Admin edits on restart/source update. Revision closes remain independent and immutable; acceptance must finish before its server deadline.
8. Organizer/Reviewer must be active, assigned to this Event and explicitly assigned `oral` and/or `poster`. Empty grants show no files. `poster` covers Highlighted Poster. Both roles read received works/history; Admin manages all. Owner upload requires the submitting account and matching real announcement in either round.
9. Oral uses `<GOOGLE_DRIVE_FOLDER_ABSTRACTS>/<EventCode>/Oral/Presentation Oral/<DB category name>/<canonical Abstract TrackingID>/`. Stored filename: `<TrackingID>_<original filename>` including extension. Every version has a new Drive fileId; duplicate names permitted. Share `anyone: reader`; open stored Drive view URL. Abstract locations unchanged. Poster/Highlighted retain R2 immutable attempt keys `events/<eventId>/presentations/<abstractId>/...`.
10. Run **one** worker: `SERVICE_ROLE=presentation-worker`, command `npm run presentations:worker`. Docker health: `dist/modules/presentations/jobs-runner.js --healthcheck`; `npm run presentations:worker:health` reads local heartbeat before DB import. Heartbeat under 60 seconds proves an iteration, not delivery. Review `/health/ready`, SQL and logs. Never run old/new workers together.
11. Review drafts and links. Oral: one PDF, >=2 pages, <=52,428,800 bytes. Poster/Highlighted: one single-page PDF, <=31,457,280 bytes. Correct ZIP on upload and initial/reminder/revision emails. Receipt uses accepted original filename/version/server time. Oral ZIP: `https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Oral%20Template.zip`.
12. Enable receiving after source/readiness/config checks. Enable mail separately after reviewing recipients/drafts. Admin explicitly previews/confirms initial/reminder batches. Startup/reconcile/source changes enqueue no notices. Unknown remains unknown until intentional fresh preview/resend; `sent` means provider acceptance.
13. Re-run verification; record deployed SHAs, source counts, deadline, flags and private backup reference. Live provider rehearsal/deployment require authorization for a named environment; implementation tests constitute neither step.

## Routine operations

| Need | Existing operation |
| --- | --- |
| Round 2/source | Keep stable round/id; test/review/release/reconcile. Preserve settings/used rights. No automatic mail. |
| Mismatch/alias | Correct through authorized tools and inspect snapshots. Admin reason/fresh fingerprint required for alias; no bypass of conflicts. |
| Main close | Versioned `PATCH .../presentation-settings` with reason/Idempotency-Key. Native input uses Thai seconds; revision closes/rights unchanged. |
| Initial/reminder | Preview `.../presentation-email-previews`, review recipients, confirm `.../presentation-notification-batches`. Stale queues nothing. |
| Revision | Preview immutable details/close/proposed ID, create one active request. Cancel with reason; terminal cannot reopen. Mail failure leaves rights intact. |
| Failed/unknown mail | Inspect stored body/attempt. Pending/sending cannot resend. Unknown requires acknowledgment/fresh preview. Ambiguous HTTP retry keeps exact key/payload. |
| Files | Original names/current pointer/all accepted versions. Oral opens Drive; Poster renders R2 PDF. Display original names, not stored prefixes. |
| Pause | Independent receiving/mail flags; accepted data readable. |
| Storage/DB uncertainty | Keep file/key; verify accepted binding before cleanup. Worker handles expired proven orphans and protects successful history. |
| Announcement PDF | Existing approved-announcement PDF asset/button process unchanged. |

## Rollback

Before real acceptance, restore through the environment's approved backup process if needed. Stop both workflows first; do not improvise reverse migration or delete external objects.

After real acceptance, pause receiving/mail and fix forward or release compatible artifacts. **Never drop Presentation uploads, rewrite history, delete accepted Drive/R2 files or restore used rights to return to Poster code.** Gracefully stop worker through its supervisor; let active iteration finish and preserve 180-second leases. Unknown mail is never automatically retried.

## Local verification

Authorized container: `pris2026-presentation-test-20261008`, PostgreSQL 16, `127.0.0.1:55073`, DB `confer_posters_integration_test`. Credentials remain in local untracked test ENV. Guarded resets target only that DB; runtime never reset.

Build API before integrations because deployment checks execute compiled reconciliation CLI. Run DB suites sequentially with approved `TEST_DATABASE_URL`; fixtures share the isolated DB. Pure tests use fake providers. See implementation plan execution checkpoints for actual results. Historical Poster acceptance reports are not evidence for this release.
