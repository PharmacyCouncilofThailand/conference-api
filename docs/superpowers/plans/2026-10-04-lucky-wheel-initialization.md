# Lucky Wheel Initialization Implementation Plan

**Goal:** Let a PRIS admin initialize the one wheel row required before the existing Backoffice management screen can load.

**Architecture:** A guarded, idempotent singleton creation API uses the existing `lucky_wheels` and audit tables. The Backoffice presents a dedicated first-time state, then reloads the existing wheel management flow.

**Tech Stack:** Fastify, PostgreSQL/Drizzle, Next.js, TypeScript.

## Task 1: API initialization

**Files:** `src/modules/lucky-wheel/service.ts`, `routes.ts`, `schemas.ts`, `routes.test.ts`, `service.integration.test.ts`.

- [x] Add focused tests for admin authentication, PRIS Main Session validation, create/retry/conflict/concurrency and exactly-one audit record.
- [x] Implement `PUT /api/backoffice/lucky-wheel/events/:eventId` with a strict `{mainSessionId}` body, a transaction and an event-unique insert. Return `201` on creation and `200` on replay.
- [x] Run route and service tests plus `npm run build`; proceed only when they pass.

## Task 2: Backoffice first-time state

**Files:** `conference-backoffice/src/app/lucky-wheel/page.tsx`, `src/lib/api.ts`, and focused test if present.

- [x] Map only `WHEEL_NOT_FOUND` to an initialization state. Leave other failures visible as errors.
- [x] Show the PRIS Main Session and an explicit create button. Keep initialization separate from publishing, stock, day window and QR opening.
- [x] Verify create/retry/error UX with focused checks, ESLint, TypeScript and production build.

## Final verification

- [x] Re-run relevant API and Backoffice tests/builds, inspect the diff and confirm no migration, sample prize, auto-open or live database change was introduced.
