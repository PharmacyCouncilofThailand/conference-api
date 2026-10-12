# Ticket Session Event Isolation Implementation Plan

> Execute inline in the current session; the user has authorized the code fix.

**Goal:** Prevent Tickets from retaining or saving sessions from another event.

**Architecture:** Keep the existing page and endpoints. Use effect cleanup to ignore stale responses and a shared route-local lookup to validate session ownership before writes.

**Tech Stack:** React, TypeScript, Fastify, Drizzle, node:test.

## Global Constraints

- Preserve endpoint and payload compatibility, including legacy `sessionId`.
- Keep main-session defaults for new primary tickets and explicit selections when editing.
- No dependency additions, database migration, historical data cleanup, or deployment.

## Tasks

- [x] Add route regression tests in `src/routes/backoffice/events.tickets.test.ts`. Use Fastify injection with mocked database methods; assert foreign/missing session IDs return 400 without writes, valid IDs succeed, legacy fields are checked, omitted/empty arrays retain their existing meaning, and URL event mismatches return 404.
- [x] Add failing component regression tests in `conference-backoffice/tests/ticketSessions.test.mjs` using the existing TypeScript/VM test pattern. Control session promises and exercise the rendered event/category controls and save button to prove event reset, late-response cleanup, edit/duplicate behavior, and explicit deselection.
- [x] Modify `src/routes/backoffice/events.ts`: share session ownership validation between POST and PATCH; validate before writes and scope PATCH ticket lookup/update by event.
- [x] Modify `conference-backoffice/src/app/tickets/page.tsx`: load sessions inside the effect with cleanup; clear state on event change; filter selection to current sessions; disable save/category until loaded; display API validation messages.
- [x] Run `npx tsx --test src/routes/backoffice/events.tickets.test.ts src/schemas/events.schema.test.ts` and `npm run build` in the API; run `node --test tests/ticketSessions.test.mjs` and `npx tsc --noEmit --incremental false` in backoffice; inspect the final diff.

## Results

API: 10 route regression tests and 1 existing schema test passed. Backoffice: 7 component regression tests passed. API TypeScript build and backoffice TypeScript checks passed. Database methods and browser dependencies were mocked; no live database or deployed browser verification was performed.
