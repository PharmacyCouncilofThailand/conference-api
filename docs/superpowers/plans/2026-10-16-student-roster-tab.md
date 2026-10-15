# Student roster tab implementation plan

**Goal:** Separate the 242 general and 18 student Round 2 works on approved-abstracts and update roster tests for 260 works.

**Architecture:** Add optional `participantGroup` announcement metadata; missing values mean general. Students keep `presentationType: oral` and existing source IDs, targets and upload rights. Reuse the public announcement endpoint, filter helper and incumbent UI. Round 1 stays unchanged.

**Tech stack:** TypeScript, existing React/Next.js and node:test.

## Constraints

- API worktree: `codex/round2-roster-20261015` in the existing isolated checkout.
- Frontend worktree: the same branch name in the sibling `Pris2026` checkout, based on observed `origin/main`.
- No primary checkout edits, Railway writes, email sends, schema changes, commits or pushes.
- Keep the supplied PDFs unchanged; serve them as static files from the frontend worktree.
- Student sequence numbers are 1–18 within their group. General counts remain Oral 47 / Highlighted Poster 47 / Poster 148.

## Steps

- [x] Update API announcement contract/public projection and mark exactly the 18 student rows. Fix 247-era tests, assert group membership, identities, counts, source ID reservations and per-group sequences.
- [x] Add frontend DTO/filter support with backwards-compatible general defaults and focused filter tests.
- [x] Add the general/student switch using existing styles, group-specific counts/categories/search/pagination and the correct PDF. Preserve Round 1 history and Thai/English labels.
- [x] Verify API tests/typecheck, frontend focused tests/typecheck/lint/build, then inspect desktop/mobile once and fix material issues together.
- [x] Confirm primary roster hashes/checkouts and snapshot are unchanged; report final validation and any remaining limitations.

## Verification result

API source/policy tests 22/22 and frontend filter/page tests 12/12 pass. Both TypeScript checks, focused frontend lint and the production Webpack build pass. Desktop 1440px and mobile 390px show separate 242/18 groups with the correct document links; no horizontal overflow, and mobile group buttons are 44px high. UI verification used a loopback read-only fixture exported from the real public projection, with no running API/worker. A read-only snapshot check still matches all 260 records; 274 email jobs and 27 uploads are unchanged. The mechanical detector reports one inherited root selection-color warning, outside the new controls. No main/primary checkout edits, schema changes, live DB writes, emails, commits or pushes.
