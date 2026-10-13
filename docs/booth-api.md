# Booth directory and meal coupon API

Implemented for the approved 2026-10-14 design. Booth membership is per user/Event; only a new Booth signup creates it. One main ticket confirmed through checkout with a validated percentage-100 promo and zero total assigns one permanent sequence. Quotas per Booth: Symposium 8, Premium 4, Standard 2. Over-quota members still receive their tickets. No redemption, transfer or withdrawal feature.

## Routes

| Route | Access | Result |
| --- | --- | --- |
| GET `/api/public/events/:eventCode/booths?page=1&limit=100` | Public | `success,booths:[{id,eventId,name,type}],pagination` |
| POST `/auth/register` | Public signup, existing anti-bot | Existing multipart fields plus `accountType=booth,boothId,eventCode`; creates account and membership atomically |
| GET `/api/users/me/booth-membership?eventCode=...` | Owner attendee JWT | `success,membership`; null when no membership in that real Event |
| GET `/api/backoffice/events/:eventId/booths` | Admin | Summary counts, quota, typeLockedAt and pagination; supports search/type filters |
| POST `/api/backoffice/events/:eventId/booths` | Admin | JSON `{name,type}`; 201 with Booth summary |
| PATCH `/api/backoffice/events/:eventId/booths/:boothId` | Admin | JSON with name/type only; type locks once a main ticket has been confirmed |
| GET `/api/backoffice/events/:eventId/booths/:boothId/members` | Admin | Member report, daily attendance columns and pagination; supports search |
| GET `/api/backoffice/events/:eventId/booths/:boothId/members/export` | Admin | All members from one read-only snapshot, no page or fixed row limit |

`mealCouponEligible=null` means not assessed; true means “มีสิทธิ์รับคูปองอาหาร”; false means assessed after quota was reached. Date/time values are ISO timestamps; UI/Excel use Asia/Bangkok. Daily cell keys are `YYYY-MM-DD:sessionId`; values are checked_in/not_checked_in/no_ticket/no_access. Cancelled scans do not count.

Read latest owner membership for profile/ticket. Eligibility is not carried as a trusted JWT claim. Check-in response registration and duplicate details include the note only after existing staff Event/Session authorization. No additional staff access to Booth lists/export is granted.

Errors: 400 INVALID_INPUT, 401 unauthenticated, 403 unauthorized role, 404 EVENT_NOT_FOUND/BOOTH_NOT_FOUND, 409 BOOTH_TYPE_LOCKED/BOOTH_MEMBER_DELETE_FORBIDDEN/BOOTH_QUALIFYING_TICKET_PROTECTED/BOOTH_REGISTRATION_CHANGED, 500 INTERNAL_ERROR. Expected conflicts do not alter any data.

## Local development

The compose project `pris-booths-test` contains one disposable PostgreSQL database `pris_booth_test`, bound to loopback port 55434. Existing Docker containers are unrelated and are never removed by this workflow.

```powershell
docker compose -f docker-compose.booths-test.yml up -d --wait
$env:TEST_DATABASE_URL='postgres://booth_test:booth_test@127.0.0.1:55434/pris_booth_test'
npm exec --no -- tsx src/scripts/setup-booth-test-database.ts
npm exec --no -- tsx --test src/modules/booths/policy.test.ts src/modules/booths/schemas.test.ts src/schemas/auth.schema.test.ts
npm exec --no -- tsx --test src/modules/booths/acceptance.integration.test.ts
```

The setup script requires an empty test database and creates the current schema with composite unique indexes before foreign keys. Test guards reject an unmarked target or one matching the normal runtime database/schema. No real participant data is copied. Set the application DATABASE_URL to this local URL only for a development server. For the existing attendance regression's static DB import, use a distinct unused runtime search_path in DATABASE_URL while TEST_DATABASE_URL points to the actual test schema.

After all requested checks pass, stop task-started local servers then run `docker compose -f docker-compose.booths-test.yml down --volumes`. The tmpfs-backed database is deleted. Keep it intact for diagnosis if relevant tests are still failing.

## Production rollout

Keep Booth registration unopened. Apply `drizzle/0042_booth_directory.sql` once before deploying the new API. Alternatively explicitly configure BOOTH_MIGRATION_DATABASE_URL and run `npm exec --no -- tsx src/scripts/apply-booth-migration.ts`; its preflight rejects an existing/partial Booth schema or legacy Booth accounts. The historical Drizzle journal does not list this hand-maintained migration.

Deploy API/backoffice, enter actual Booth names/types as Admin, deploy PRIS, verify its Event code/main-ticket role/promo availability and daily attendance policy, then open signup. No source change is required in conference-web. Production deployment and real Booth/ticket/promo creation were not performed during local development.

Retain membership/coupon tables and mutation protections if rolling forward after a release issue. Do not drop allocated data or restore free-text signup once registrations exist.
