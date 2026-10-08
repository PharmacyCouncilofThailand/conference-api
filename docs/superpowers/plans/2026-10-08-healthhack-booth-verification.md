# HealthHack and Booth verification — 2026-10-08

## Delivered behavior

All eight implementation tasks and the final verification gates passed. New accounts have one fixed `healthhack` or `booth` role and become active immediately. HealthHack stores `institution` and `healthHackLevel` (`m1`–`m6`, `undergraduate`); Booth stores `boothName`. Both retain passwords, Thai country/THB and the existing login, SSO, profile and checkout flows. Neither acquires Student status or staff permissions.

Pris2026 adds `/{locale}/signup/healthhack` and `/{locale}/signup/booth` with the existing signup UI. Secondary education requires the matching grade; changing the education group clears the grade. The general signup choosers in Pris2026 and conference-web are unchanged. New forms contain no identity, passport, pharmacy-license or verification-document inputs. Successful signup logs in and follows the existing safe redirect/default home behavior; it does not issue a ticket automatically.

Backoffice ticket and Event create/edit forms support both roles. Members support role filters, labels and expandable personal details. Lucky Wheel accepts both roles at its existing attendee gate and preserves the service's ticket, Main Session, check-in, schedule, credit, pause and stock conditions. Abstract and Presentation permissions, staff roles and the promo engine are unchanged.

## Test environment and authorization

- Disposable Docker container: `healthhack-booth-test-20261008`, PostgreSQL 16 Alpine, localhost port `55440`, tmpfs data directory. No production data was copied.
- Main database: `healthhack_booth_test` for migration, auth, checkout and browser fixtures.
- Second database in the same container: `healthhack_booth_wheel_test` for Wheel suites that reset `public`; these resets never targeted the main checkout database.
- The user explicitly authorized fixture deletion/schema resets only inside this new container. Container deletion requires separate permission after the tests pass.
- After all verification passed, the user authorized cleanup. The seven task-specific local servers were stopped, the exact container ID/localhost binding was checked, and the named container was removed. Checks confirmed it no longer exists and ports 3101–3107 no longer listen. Reports/screenshots and the Pris backup stash were retained.
- Drizzle export's test bootstrap originally emitted foreign keys before their required unique indexes. With user approval, only the scratch bootstrap SQL was reordered and the test schema rebuilt. Production schema/migration ordering was not changed for this workaround.
- Local API harness used the production route modules, synthetic `.invalid` accounts and dummy payment credentials. External mail was disabled. Paid provider requests were blocked; zero-total orders used the real internal checkout implementation.

## Final automated verification

Final checks ran against the completed source tree, after Task 8 and the last formatting edits. Commands were run separately in each repository.

| Repository / gate | Result |
| --- | --- |
| API `npm run build` | PASS |
| API feature and affected regression tests below | 61 passed, 0 failed, 0 skipped |
| API migration + auth + payment integration below | 4 passed, 0 failed, 0 skipped |
| API Wheel service + QR integration below | 6 passed, 0 failed, 0 skipped |
| Pris2026 `npm test` | 77 passed, 0 failed, 0 skipped; includes merged Presentation regressions |
| Pris2026 `npm run build` | PASS; both new routes and `presentation-submission` present |
| Pris2026 scoped ESLint | 0 errors; 1 unchanged profile hook warning |
| conference-web `npx vitest run` | 49 passed across 8 files, 0 failed |
| conference-web `npx tsc --noEmit`, `npm run build` | PASS |
| conference-web scoped ESLint | 0 errors; 1 unchanged image warning |
| Backoffice `npx tsc --noEmit`, `npm run build` | PASS |
| Backoffice lint compared with HEAD for all four edited pages | 38 baseline errors and 15 baseline warnings, exactly unchanged; 0 added |
| All four repositories `git diff --check` | PASS |

Final automated total: **197 tests passed**, no failures or skips in these executed suites. API integration suites outside this feature and its affected behavior were not run wholesale because several reset their database/schema; the table does not claim a full API repository suite pass. Backoffice has no test runner; types, production build, lint comparison and browser flows were checked.

API regression command:

```powershell
npx tsx --test src/schemas/auth.schema.test.ts src/schemas/events.schema.test.ts src/modules/payments/primary-ticket-authorization.test.ts src/modules/payments/database.test.ts src/modules/payments/api-contract.test.ts src/modules/payments/promo-usage.test.ts src/modules/lucky-wheel/routes.test.ts src/modules/lucky-wheel/policy.test.ts src/utils/studentEligibility.test.ts src/utils/ticketEligibility.test.ts src/utils/promoDiscount.test.ts src/utils/promoCodeNormalization.test.ts src/modules/pris2026/pricing-policy.test.ts
```

For integration runs, `TEST_DATABASE_URL` targeted only the named local test database and `DATABASE_URL` was set to a distinct, unusable localhost URL before route-test setup. Shared/unmarked payment database overrides were false. The payment callback was explicitly enabled with `PAYMENTS_RUN_INTEGRATION=true`.

```powershell
npx tsx --test --test-concurrency=1 src/database/healthhack-booth.migration.test.ts src/routes/auth/healthhack-booth.integration.test.ts src/modules/payments/free-checkout.integration.test.ts
npx tsx --test --test-concurrency=1 src/modules/lucky-wheel/service.integration.test.ts src/modules/lucky-wheel/qr-credits.integration.test.ts
```

The second command used only `healthhack_booth_wheel_test`. Migration tests applied SQL twice, preserved a legacy Student with null new fields, accepted all seven HealthHack levels and rejected `m7`. Auth tests exercised both new roles through register, fresh login, single-use SSO exchange and profile, duplicate email rejection, missing required input, forced Thai country, member list/detail and pending Student login denial. Payment tests retained atomicity, concurrency, rollback and idempotency checks. Wheel route tests exercised all six attendee endpoints for both new roles, preserved service errors and rejected an unknown role; real DB suites checked the existing service conditions and races.

## Browser, HTTP and database acceptance evidence

- Pris forms checked in TH/EN and narrow/wide viewports using the in-app browser: required fields, keyboard navigation, lower/upper grade options, group-change reset, undergraduate with no grade, password mismatch and failed-request retry. Requests retained the fixed role and omitted confirmation password, identity fields, documents and Student fields.
- Fresh HealthHack `m1` and Booth accounts were created through the actual Pris forms against the local API/database. Both auto-logged in, became active and displayed their specific profile fields. Signup did not create a registration.
- Fresh login and SSO preserved role, institution/level or booth name. The general Pris chooser still displayed the original options only.
- Backoffice browser flows created, edited and reopened tickets and Event ticket settings with both roles selected. Five captured ticket requests retained both roles without Student levels. Member filters and keyboard-operated detail disclosures showed the specific fields.
- Separate real API ticket POST/PATCH/list checks persisted `allowedRoles=healthhack,booth`. A General account submitting either restricted ticket ID directly received HTTP `409`, `TICKET_NOT_ELIGIBLE`, and no registration.
- Both new roles used conference-web SSO and saw matching THB and unrestricted tickets; HealthHack undergraduate did not receive Student pricing or USD tickets. Existing zero-price role slugs also produced confirmed registration codes/QRs.
- HealthHack completed the real browser checkout using a 100% local promo. Booth completed the real create-intent HTTP flow using the same internal zero-total path. Database assertions found confirmed registrations, `total_amount=0.00`, internal/free payment and the expected Main Session for both.
- Local zero-total codes: HealthHack `REG-MUZNHYY9NLW985`; Booth `REG-MUZNK34QRQOSHQ`. Pris ticket pages displayed the corresponding code/QR. Screenshots remain in workspace scratch artifacts: `.codex-tmp/healthhack-booth/healthhack-ticket.jpg` and `booth-ticket.jpg`.
- Invalid, expired and genuinely exhausted promo codes were rejected for each role: six HTTP `400`, `INVALID_PROMO` responses, no extra registration. The exhausted fixture included an actual recorded usage, rather than only a manually seeded counter.

## Diagnosed checks and approved exceptions

- The final combined DB command initially set `DATABASE_URL` equal to `TEST_DATABASE_URL`; database guards rejected two tests before any database work and the payment callback was skipped without its opt-in flag. Correcting only the test environment/flag produced the final 4/4 pass above. No guard was weakened.
- Pris originally lacked the merged Presentation page while generated Next types referenced it. Per explicit user instructions, only Pris was reset to latest merged main (`0f66321`), then the feature branch and changes were restored. The backup stash is retained; the final build and 77 tests include Presentation.
- Backoffice's 38 errors/15 warnings were demonstrated on HEAD and the edited tree with the same ESLint configuration. The user approved a no-new-lint gate; unrelated lint was not edited.
- With user approval, conference-web adds missing `@testing-library/dom@10.4.2` as a dev dependency required by existing `@testing-library/react@16.3.1`. The lock adds its dependency tree without changing existing package versions.
- The local API harness originally omitted `JWT_SECRET`, causing my-tickets to return 500. Configuring the synthetic test secret corrected the harness; real ticket readers then passed. No production route change was needed.

## Deployment and rollback

1. Apply and commit `drizzle/0040_healthhack_booth_roles.sql` to the target database before starting the new API. It adds enum values and nullable columns without rewriting existing accounts. The repository uses hand-managed SQL migrations; do not substitute `db:push` or regenerate unrelated schema.
2. Deploy the API, then Pris2026, conference-web compatibility and backoffice. Distribute the special signup URLs only when the API/schema support is available.
3. Configure actual tickets and promo codes through backoffice. No real ticket or promo code was created by this work. Unrestricted tickets remain available to the new roles; full-price purchases and add-ons retain existing rules. A 100% promo can discount add-ons according to the existing rule matching behavior.
4. If reverting application code after new accounts exist, retain the additive columns/enums and account data. Gate distribution of the special signup links first. Do not remove enum values/columns or alter existing roles as an automatic rollback.

No push, merge or deployment is part of delivery. Real email delivery, external paid payment providers, real Turnstile challenges and production migration were not exercised. Local artifacts are evidence only, not production configuration. The pre-existing change in `src/modules/presentations/data/approvedRound2Abstracts.ts` is excluded from this feature's commit.
