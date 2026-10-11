# Session email preview implementation plan

**Goal:** Review each recipient's actual email template before creating session grants and email jobs.

**Architecture:** Add an admin-only, read-only preview endpoint using existing templates and eligibility policies. Both registration screens open one shared dialog with previous/next controls; final confirmation uses the existing idempotent create endpoint and its current validation.

**Constraints:** No database migration or dependency. No real response token in preview. Render HTML in a sandboxed iframe with navigation disabled. Preserve retries after uncertain create responses. Preview is advisory; grant creation rechecks current state.

- [x] Add POST `/preview`, sharing create input validation, admin access and feature flag. Return recipient, subject, HTML and skipped reasons; never create grants, tokens or jobs.
- [x] Test both templates, HTML escaping, duplicates, existing grants/invitations, invalid sessions, and endpoint authorization/validation. Fake database exposes only reads so any writes fail.
- [x] Add typed backoffice API and shared dialog. Display one email, count, previous/next, loading/error/empty states, back and final confirmation.
- [x] Connect bulk and individual registration flows. Freeze the reviewed operation, retain idempotency for retries, and only call create after final confirmation. Send only IDs represented in the preview.
- [x] Run focused tests, TypeScript/build checks, lint for new UI/API/types, and inspect dialog at desktop/mobile widths. Review diffs before committing each repository.

Validation: session grants 28/28 and session invitations 22/22 unit tests passed; backoffice preview/registration refresh 5/5 passed. API TypeScript build and Next production build passed; final backoffice TypeScript and focused lint passed. Browser harness with real React and fixture mail passed desktop/mobile pagination, cancellation focus, sandbox and final send payload. Design detector returned no findings. Full touched-page lint retains four pre-existing `no-explicit-any` errors and existing warnings; unrelated reward-collection browser test requires separately configured Playwright. Real database integration, live email delivery and deployment were not run.
