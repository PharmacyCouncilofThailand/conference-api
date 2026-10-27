# Presentation category scope — verification

Date: 2026-10-27 (Asia/Bangkok)

## Delivered amendment

- Organizer and Reviewer need the intersection of current database Event, presentation-type and category grants to see received presentation files.
- Categories use the existing `assigned_categories` names. Authorization joins the actual Abstract category and Event; stale JWT claims or announcement/snapshot category names cannot grant access.
- Empty, missing or malformed category assignments expose no works. Direct detail requests outside category scope return 404.
- List `categoryId` narrows the authoritative database category before totals, counts and pagination. It cannot broaden access.
- List `categories` options are scoped to the selected Event and category grants, independent of list page/search/type/category filters. Admin sees all Event categories.
- Backoffice has a category dropdown, resets pagination and email selection on category changes, and does not send an old category ID under a new Event. Both list and detail immediately invalidate data when local category grants change.
- Organizer now gets category assignment in both create and edit user forms. Both Organizer and Reviewer save selected category names and presentation types through the existing user API. No existing accounts were edited automatically.
- The earlier latest-file-only rendering, history/workflow redaction and Admin functionality remain in place.

## Parallel work and review

All implementers, reviewers and the browser agent used `gpt-6.1-sol` with `medium` effort. API, category filter and user assignment runtime work ran concurrently under separate file ownership. Shared UI tests were edited first by the filter agent, then by the assignment agent after an explicit lease transfer.

Independent API, filter and assignment reviews passed without Critical, Important or Minor findings. Final combined review also returned **Ready to merge: Yes / Ship**, with no deferred findings. Review covered both amendment commit ranges and connected API/UI save and authorization paths.

## Automated results

| Check | Result |
| --- | --- |
| API `npm run test:presentations` | 70 passed |
| Guarded serial readers/routes/access integration | 12 passed |
| API `npm run build` | Passed |
| Backoffice full `presentationUi.test.ts` | 33 passed |
| Backoffice production build | Passed, 44 routes |
| Prettier on all seven changed Backoffice files | Passed |
| Full Backoffice ESLint comparison | Same 94 errors/53 warnings as untouched main; normalized findings identical |
| Targeted lint | No new findings; users page retains its baseline 5 errors/3 warnings; other changed paths clean |
| Git diff checks | Passed in both repositories |

RED/GREEN evidence includes the previously rejected categoryId query, unauthorized work under empty category grants, missing dropdown, stale detail under same-object grant changes, missing Organizer category payload and absent Organizer category loading.

Database-backed tests exercise both roles, malformed/missing/empty/mixed grants, category/type/Event intersection, direct denial, count/page boundaries, independent authorized options, category-filter tampering, stale actor claims, immediate database grant revocation, forged announcement metadata and inconsistent category/Event links. Existing latest-file/privacy and Admin regression cases remain covered.

The real UsersPage component harness drives create/edit for both Organizer and Reviewer: Event category loading, preselected categories, checkbox select/deselect, category/type save payload and Event assignment. It does not infer success from source-text matching.

## Browser and environment

The additional browser smoke uses the actual Backoffice UI with synthetic localhost accounts/API responses. It is UI verification, separate from the actual database-backed integration tests above. Its detailed report and screenshot evidence are preserved in the local category-scope output folder. Real downloads, external Google Drive, production sessions and live user changes are outside this check.

Native Chrome smoke passed for Organizer authorized options, category rows/counts, category combined with type/search, stable options while filtering, clearing the filter, Event reset without the old category query, and Reviewer category selection. Five screenshots and request/AX assertions were captured. Optional Admin filtering and Users create/edit were not repeated in the browser; automated component/API tests cover those paths. Temporary servers and the dedicated test window were closed afterward.

Integration used only the guarded disposable PostgreSQL 16 target `127.0.0.1:55073/confer_posters_integration_test`, separate from its dummy runtime URL. Existing guards remained unchanged. Fake storage was used, no worker or external mail ran, and the task's container was removed after checks. Generated credentials stay out of Git and are deleted with task scratch artifacts.

No production migration was needed: `assigned_categories` already exists. Only the integration test table definition was corrected to include that existing column. No dependencies or endpoints were added, and Abstracts authorization was unchanged.

## Commits and rollout

- API: `a5ee758`.
- Backoffice assignment runtime: `3ab7218`; category filter/scope: `2d21f31`; form regression tests: `65c777f`.
- Both feature worktrees remain on `feat/presentation-latest-file-viewer`; original main checkouts are unchanged. No merge, push or deployment has run.
- Release the API before Backoffice so authorization is enforced before exposing the new controls.
- **Existing Organizer/Reviewer accounts without category assignments will see no presentation files until an Admin assigns categories.** There is no automatic fallback or grant backfill.
