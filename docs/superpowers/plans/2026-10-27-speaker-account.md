# Speaker Account Implementation Plan

**Goal:** Add the approved Speaker account type across the API, PRIS, Conference Hub and backoffice.

**Architecture:** Extend existing role enums and mappings. Reuse the special signup form with booth-only controls gated by `isBooth`. Continue using ticket IDs for promo eligibility.

**Tech Stack:** TypeScript, Fastify, PostgreSQL/Drizzle, React/Next.js.

## Tasks

- [x] Add `speaker` to user role schema, registration schema/mappings, login/SSO mappings and attendee allowlists; add additive migration 0053.
- [x] Add Speaker to backoffice ticket role options and member filtering; support role-based paid/free package resolution and enforce stored identity for free registration.
- [x] Reuse signup form for `/signup/speaker`, link it from signup, translate labels and display Speaker in profiles and Conference Hub.
- [x] Run `npx tsx --test src/schemas/auth.schema.test.ts src/schemas/events.schema.test.ts src/utils/ticketEligibility.test.ts src/modules/payments/primary-ticket-authorization.test.ts src/utils/promoDiscount.test.ts` in conference-api.
- [x] Run `npx tsc --noEmit` in conference-api, conference-backoffice, conference-web and Pris2026; inspect diffs and whitespace checks.

Deployment: apply `ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'speaker';` before API rollout. Configure actual Speaker tickets and promo codes in backoffice after rollout when event, prices and code details are supplied.

Validation: API checks passed (23 tests); Conference Hub utilities passed (12 tests). TypeScript passed for API, backoffice, Conference Hub and PRIS. HTTP guard and promo engine tests use in-memory database mocks; production migration and live checkout were not run.
