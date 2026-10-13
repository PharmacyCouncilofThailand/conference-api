# Booth implementation verification — 2026-10-14

Implemented in the existing chat and checkout, on branch `codex/booth-directory-coupons` in conference-api, Pris2026 and conference-backoffice. No conference-web source changes, production migration, deployment, real participants, real Booth creation or real email delivery.

## Checkpoints

1. Database: Event-scoped Booth and member tables, fixed quotas 8/4/2, composite references and immutable qualification references; atomic account/membership signup.
2. Confirmation: serialize qualification per Booth, grant once per member only for confirmed main tickets from validated percentage-100 zero-total checkout; guard account deletion and qualifying-ticket cancellation/transfer including over-quota members. Primary ticket confirmation also freezes type on other ticket creation paths.
3. Screens: signup selector; authenticated owner profile/ticket note; Admin directory/edit/report; authorized staff success/duplicate scan/list note; complete Excel with daily attendance and preserved phone text.
4. Verification: real PostgreSQL acceptance, original checkout/authorization/SSO/check-in regression, builds and synthetic browser review. Bootstrap was additionally verified from an empty database using the committed setup script.

## Executed checks

| Check | Result |
| --- | --- |
| Booth policy/schema + existing auth schema | 4 passed |
| Booth PostgreSQL acceptance | 2 passed, no skips |
| Existing HealthHack/Booth register/login/SSO/profile | 1 passed |
| `npm run test:payments:integration` | 2 passed, no skips |
| `npm run test:pris-ticket-authorization:integration` | 2 passed, no skips |
| Existing attendance `checkin-flow.integration.test.ts` | 1 passed; 100 concurrent scans, daily identity, undo and report |
| PRIS Booth readers and existing ticket journey | 3 passed |
| Backoffice duplicate note and Excel | 2 passed |
| API TypeScript build | passed |
| PRIS and backoffice TypeScript checks | passed |
| New frontend files ESLint | passed |
| Backoffice production build | passed |
| PRIS production build | passed with local tooling/font workaround described below |
| Git diff whitespace check | passed in all changed repositories |

Acceptance includes real multipart signup, quota+1 per type with independent concurrent promos, stable duplicate allocation, invalid signup atomicity, forced transaction rollback, no-code/fixed-discount exclusion, Admin/staff authorization, eligible/over-quota protections, frozen type with editable name, fresh owner reads, authorized duplicate scan, cancelled attendance exclusion, and a full 1,001-member export versus paginated report.

The combined final regression command skipped two opt-in payment cases as intended by their existing guards. Both were then executed separately through their prescribed npm scripts, with no skips; the separate results above are the evidence for those cases.

## Browser evidence

Used only synthetic Event/account/ticket data against API port 3302, PRIS port 3101 and backoffice port 3103. Verified Booth dropdown selection, Admin directory/detail/daily columns, owner profile and ticket eligibility. Downloaded Excel through the browser and read the resulting workbook: phone leading zero, coupon note and checked-in date were preserved. Screenshots were saved under workspace `tmp/booth-members-review.png` and `tmp/booth-ticket-review.png`; synthetic browser exports are local test evidence, not production reports.

## Local limitations and deployment

PRIS's existing SWC native cache permissions and Google font loader prevented its standard local build. It passed using a task-owned SWC cache and downloaded real Google font response fixtures via `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`. No app dependencies/configuration were changed for that workaround. A normal CI/production build without those local fixtures remains to be run in the deployment environment. Real CAPTCHA, outgoing email delivery and physical scanner hardware were not tested; local email credentials were absent and signup notification errors were logged without affecting signup.

Run the explicit additive migration before deploying API/frontends, then configure real Event Booth names and valid promos while registration remains closed. See [rollout instructions](booth-api.md). The historical Drizzle journal does not automatically apply `0042_booth_directory.sql`.

## Disposable database

Exactly one task database was created: `pris_booth_test`, PostgreSQL 16, container `pris-booth-development-test`, loopback port 55434, compose project `pris-booths-test`, tmpfs storage. It contained only generated synthetic data. Bootstrap and acceptance used separate schemas inside this same database, never an additional database. Task-started local servers were stopped after verification. Cleanup status is recorded below after Docker removal; unrelated existing Docker containers must remain intact.

Cleanup complete: `docker compose -f docker-compose.booths-test.yml down --volumes` succeeded. Container and task network no longer exist, deleting the tmpfs-backed database. Confirmed the two pre-existing `railway-backup` containers on ports 55432/55433 remain running.

The automatic command policy rejected recursive removal of the task-owned SWC cache folders (`C:\booth-swc-cache-01a1362e`, `C:\Users\JaoNo\AppData\Local\booth-swc-native-cache`, workspace `tmp/booth-swc-native-cache`) with `blocked by policy`. These caches and local verification artifacts were retained. They contain tooling/test evidence, not a retained PostgreSQL database.
