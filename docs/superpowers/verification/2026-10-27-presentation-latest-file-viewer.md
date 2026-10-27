# Presentation latest-file viewer — verification

Date: 2026-10-27 (Asia/Bangkok)

## Delivered behavior

- Organizer and Reviewer can open the Presentations menu, list and detail routes for their existing assigned Events and presentation types.
- Their list includes only received works. Detail returns and renders only the current accepted file; an open revision does not hide that file.
- Viewer API responses clear revision links, requests, email jobs, audit, verification data and workflow status. Internal status/match filters cannot expose revision state through totals or pagination.
- Viewer UI omits historical files, requests, email/audit sections, workflow counters/filters/deadlines and management actions, including when handed an Admin-shaped payload.
- Account, role, token, type/Event grant and Event changes invalidate old results during rendering. Admin batch/history results are scoped separately from list filters so ordinary filtering retains the current batch.
- Admin history, filters, counts, file versions and management behavior remain available. No database schema, dependency, endpoint, owner workflow or provider changes were required.

## Parallel work and review

Every implementation, browser and review subagent used `gpt-6.1-sol` with `medium` effort, as requested. No worker agent dispatched additional agents.

The API implementer owned API readers/unit/integration tests. The list/access implementer owned role/menu/list/table and first held the shared UI test file. The detail implementer owned the detail page, then received exclusive ownership of the UI test file after the list implementer released it. Runtime work ran concurrently; shared-file edits were serialized.

Independent task reviews covered API, list/access and detail. The list review identified an initial-render gap in Admin batch/history scoping. A dedicated regression reproduced the issue, commit `4cd0221` fixed it, and scoped re-review accepted the fix without new findings. A final review covered both repositories together.

## Automated evidence

| Check | Result |
| --- | --- |
| API `npm run test:presentations` | 68 passed, 0 failed/skipped |
| API serial readers/routes/access integration | 11 passed, 0 failed/skipped |
| API `npm run build` | Passed |
| Backoffice `tsx --test src/lib/presentationUi.test.ts` | 31 passed, 0 failed/skipped |
| Backoffice `npm run build` after scope fix | Passed, all 44 routes generated/compiled |
| ESLint on all six changed Backoffice runtime/test files | Passed |
| Prettier on all six changed Backoffice runtime/test files | Passed |
| `git diff --check` in both repositories | Passed |
| Full Backoffice ESLint | 94 errors and 53 warnings; normalized findings exactly match unmodified main |

API integration command:

```bash
npx --no-install tsx --test --test-concurrency=1 src/modules/presentations/readers.integration.test.ts src/modules/presentations/routes.integration.test.ts src/modules/presentations/access.integration.test.ts
```

Integration used an isolated PostgreSQL 16 container at the existing allowlisted test endpoint `127.0.0.1:55073/confer_posters_integration_test`, with a separate runtime URL and existing reset guards. Storage was fake; no worker or external delivery ran. Credentials were generated only in ignored local test-environment files and are not part of this commit. No existing database/container was changed.

RED/GREEN evidence exists for the API projection, page access, received list/table, detail access/history/file availability/session changes, and the Admin auxiliary-state scope fix. The final formatting commit was checked to preserve emitted JavaScript semantics; the UI suite still passed afterward.

## Browser smoke

Actual Next.js UI was exercised through the in-app browser with synthetic Organizer, Reviewer and Admin accounts and an isolated localhost API fixture. This is UI smoke verification; the table above separately records the actual database-backed API integration tests.

Passed cases: menu/direct list/detail access for both viewer roles; latest-only detail; Oral/Poster/Highlighted Poster link/render choices; unavailable current URL without fallback; Reviewer search; Organizer type and Round filters; logout/login across roles; retained Admin tabs, counters, filters, historical file, revision and management sections. Captured viewer requests contained no settings-history read or presentation mutation.

Browser limitations: no real provider download/Google Drive navigation, actual PDF-content check, pagination beyond page one, browser Event-switch/race exercise, or Admin write action. Session/grant races and pagination/counts were exercised in automated tests. No production deployment or production end-to-end session was used.

## Commits and rollout

- API runtime/unit: `2bda3d8`; integration regression: `27e6da6`.
- Backoffice access: `1fe58f4`; detail: `8c89cf0`; list: `93c6d24`; detail tests: `c41276b`; scope fix: `4cd0221`; formatting: `03ae3c1`.
- Both repositories use branch `feat/presentation-latest-file-viewer` in separate linked worktrees. Original main checkouts remain unchanged.
- Release the API projection before enabling the new Backoffice. The old API can still return viewer revision/history metadata even when the new UI hides it.
- Work is local and unpushed. Merge/push/deployment are separate from this implementation.
