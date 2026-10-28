# Media Account Implementation Plan

**Goal:** Add Media accounts with the approved Speaker-equivalent behavior.

**Architecture:** Extend existing role lists and package mappings. Reuse ticket-based promo rules and the special signup form with explicit title keys. Preserve hidden public signup choices.

**Tech Stack:** TypeScript, Fastify, Drizzle/PostgreSQL, Next.js/React.

## Tasks

- [x] Add Media registration and ticket schema regressions; confirm they fail before implementation.
- [x] Add `media` to the database enum, API types, signup validation/mappings, login/SSO, member filtering, ticket package mappings and attendee allowlists. Add `0056_media_user_role.sql` with `ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'media';`.
- [x] Extend backoffice ticket and member options, Conference Hub role labels and package mapping, and PRIS translated profile labels and direct `/signup/media` form. Do not modify public signup selectors.
- [x] Extend existing authorization and promo tests to cover Media and Speaker isolation.
- [x] Run focused API tests and Conference Hub utility tests.
- [x] Run `npx tsc --noEmit --incremental false` in all four apps, check translations and hidden selectors, and inspect final diffs.

Do not apply migrations, deploy, create real ticket/promo records, change user roles or commit unless requested.

Validation complete: 23 API tests and 14 Conference Hub utility tests passed. TypeScript passed in conference-api, conference-backoffice, conference-web and Pris2026. Thai/English translations, hidden public signup selectors, the direct Media signup route and diff whitespace checks passed. Production database migration and live signup/checkout were not run.
