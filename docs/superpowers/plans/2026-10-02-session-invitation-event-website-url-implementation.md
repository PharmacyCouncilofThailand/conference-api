# Session Invitation Event Website URL Implementation Plan

> Execute this focused delta task-by-task using checkbox (`- [ ]`) tracking. This plan does not authorize work outside the invitation-link origin change described here. Preparing this document does not edit application code or run tests.

**Goal:** Build every new session-invitation response link from the invited session's `events.website_url`, persist the validated origin in the existing durable notification snapshot, and remove `PRIS_FRONTEND_URL` from the invitation runtime contract.

**Architecture:** Resolve and validate the Event website inside the existing `createGrant` transaction before any invitation batch/item/reservation is inserted. Store only the normalized origin in the invited item's existing JSONB `notification_snapshot`; the worker uses that snapshot for first delivery and every retry while continuing to read only the encryption key from server environment. There is no new table, column, migration, frontend flow, dependency, or compatibility fallback because production invitations have never been enabled.

**Tech Stack:** TypeScript, Node.js `URL` and `node:crypto`, Drizzle/PostgreSQL, `node:test`, existing Docker Compose invitation test project, fake mail recorder, and Chromium/CDP harness.

**Decision approved:** Use `events.website_url` rather than `PRIS_FRONTEND_URL`. Production has no existing invitation rows that need backfill or compatibility fallback.

**Related completed design:** [2026-10-01-admin-session-invitations-design.md](../specs/2026-10-01-admin-session-invitations-design.md)

## Global constraints

- Change only invitation response-link origin selection and its directly owned tests, fixtures, runtime configuration, and readiness evidence.
- Do not change invitation lifecycle, capacity, entitlement creation, deadline, API routes, response page, Backoffice workflow, mail transport, payment, registration, check-in, or existing immediate-grant behavior.
- Do not add a database table, column, migration, dependency, fallback environment variable, or generalized URL framework.
- `SESSION_INVITATION_ENCRYPTION_KEY` remains mandatory and server-only. Remove only `PRIS_FRONTEND_URL` from API/tools/worker invitation configuration.
- `events.website_url` is required only when `sessions.admin_grant_requires_confirmation=true`. Ungated immediate grants retain existing behavior.
- Invitation website validation is fail-closed: production requires an HTTPS origin with no credentials, query, fragment, or non-root path. Non-production may use HTTP only for `localhost`, `127.0.0.1`, or `[::1]`.
- A trailing `/` is valid and normalizes to `URL.origin`. A path such as `/pris`, query, fragment, username, or password is invalid. Do not silently discard it.
- Do not use `buildEventEmailContext()` fallback values (`CONFER_URL` or generic conference hub) for invitation response links.
- The normalized origin is immutable for that invitation because it is stored at creation. Changing `events.website_url` affects only later invitations; retries keep the original destination.
- A missing or invalid snapshot origin fails the mail item safely. Worker must not reread the current Event website and must not generate a new token or deadline.
- Existing `CORS_ORIGIN` configuration must still allow the actual Event website origin. Do not dynamically trust every database URL for CORS.
- All RED/GREEN, unit, integration, build, worker, fake-mail, regression, and browser checks run only in newly created isolated Docker containers under Compose project `session-invitations-test`. Host use is limited to source/Git inspection and Docker orchestration.
- Preserve unrelated user work. Current untracked `docs/superpowers/plans/2026-10-01-admin-session-invitations-continuation-prompt.md` is outside this plan and must not be staged or edited.
- Complete each task and its Docker checks before starting the next. If an actual later-task dependency blocks a check, record and revisit it immediately when the prerequisite passes. Stop for any scope/design conflict.
- Create one cohesive commit only after Tasks 1–4 and final verification pass. Use a title and detailed body; stage explicit files only; do not push.

## File map

| File | Planned responsibility |
| --- | --- |
| `src/modules/session-grants/invitation-token.ts` | Read encryption key independently; validate/normalize Event invitation origin; build response URL |
| `src/modules/session-grants/invitation-token.test.ts` | Unit contract for key and Event URL validation |
| `src/modules/session-grants/email-template.ts` | Type the invited notification snapshot's durable `responseOrigin` |
| `src/modules/session-grants/service.ts` | Select `events.website_url`, validate it, and snapshot normalized origin atomically |
| `src/modules/session-grants/invitations.integration.test.ts` | Creation failure, snapshot, immutability, idempotency, and ungated compatibility proof |
| `src/modules/session-grants/email-jobs.ts` | Build first-send/retry link from snapshot while reading only encryption key from environment |
| `src/modules/session-grants/invitation-email.integration.test.ts` | First send, retry, changed Event website, invalid snapshot, and key failure proof |
| `review/session-invitations-review-fixture.ts` | Give synthetic Events valid origins and build valid invited snapshots |
| `review/session-invitations-e2e-accept-latest.mjs` | Assert captured email uses the snapshotted public Event origin before internal Docker navigation |
| `docker-compose.session-invitations-test.yml` | Remove obsolete `PRIS_FRONTEND_URL` from API/tools/worker containers |
| `docs/superpowers/verification/admin-session-invitations/final-readiness.md` | Replace obsolete production ENV action with Event URL/CORS preflight evidence after tests pass |
| `docs/superpowers/verification/admin-session-invitations/gates.json` | Replace origin-from-ENV evidence with origin-from-Event/snapshot evidence after tests pass |

No changes are planned in `conference-backoffice`, `Pris2026`, `conference-web`, database schema, or Drizzle migration files.

## Stable interfaces

Replace the combined runtime reader with two narrowly owned helpers:

```ts
export function readInvitationEncryptionKey(
  env: NodeJS.ProcessEnv,
): Buffer;

export function parseInvitationFrontendOrigin(
  value: string | null | undefined,
  nodeEnv: string | undefined,
): string;

export function buildInvitationUrl(
  rawToken: string,
  frontendOrigin: string,
): string;
```

`parseInvitationFrontendOrigin()` returns `url.origin`, never the original string. It throws `GrantError(503, "SESSION_INVITATION_CONFIG_ERROR", safeMessage)` without echoing the rejected value.

Extend snapshot types without affecting legacy immediate-grant snapshots:

```ts
export interface GrantNotificationSnapshot {
  personName: string | null;
  regCode: string;
  eventName: string;
  eventShortName: string;
  eventDates: string;
  eventVenue: string;
  sessionName: string;
  sessionType: string | null;
  startTime: string;
  endTime: string;
  room: string | null;
  participantUrl: string | null;
}

export interface InvitationNotificationSnapshot
  extends GrantNotificationSnapshot {
  responseOrigin: string;
}
```

`responseOrigin` is deliberately absent from `GrantNotificationSnapshot`; this prevents changing the durable shape of existing `outcome="added"` messages. Invitation creation constructs an `InvitationNotificationSnapshot`. Worker treats invited JSONB as untrusted runtime data and validates `responseOrigin` again.

## Task 1 — Split encryption-key configuration from Event origin validation

**Files:**

- Modify: `src/modules/session-grants/invitation-token.ts`
- Modify: `src/modules/session-grants/invitation-token.test.ts`

**Produces:** `readInvitationEncryptionKey()` and `parseInvitationFrontendOrigin()` for Tasks 2–3.

- [ ] Add failing key-only tests proving a valid base64 encoding of exactly 32 bytes returns the key without `PRIS_FRONTEND_URL`, while missing, malformed, noncanonical, 31-byte, and 33-byte values throw `SESSION_INVITATION_CONFIG_ERROR` without exposing the input.

```ts
const parsed = readInvitationEncryptionKey({
  SESSION_INVITATION_ENCRYPTION_KEY: key.toString("base64"),
} as NodeJS.ProcessEnv);
assert.equal(parsed.equals(key), true);
```

- [ ] Add failing origin-table tests. Production accepts `https://pris.example.test` and its trailing-slash form, both normalized to `https://pris.example.test`. Test accepts `http://localhost:3004`, `http://127.0.0.1:3004`, and `http://[::1]:3004`. Reject null/blank, malformed URL, production HTTP, credentials, `/pris`, query, and fragment.

```ts
assert.equal(
  parseInvitationFrontendOrigin("https://pris.example.test/", "production"),
  "https://pris.example.test",
);
assert.throws(
  () => parseInvitationFrontendOrigin("https://pris.example.test/path", "production"),
  (error: unknown) =>
    error instanceof GrantError &&
    error.code === "SESSION_INVITATION_CONFIG_ERROR",
);
```

- [ ] Run RED inside Docker. Expected: imports do not exist or old combined config still requires `PRIS_FRONTEND_URL`.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc './node_modules/.bin/tsx --test src/modules/session-grants/invitation-token.test.ts'
```

- [ ] Replace `readInvitationConfig()` with the two helpers. Reuse the current base64 canonicality check and URL validation rules. Do not retain a wrapper or deprecated `PRIS_FRONTEND_URL` fallback because there are no production invitation rows or external callers requiring it.

```ts
export function readInvitationEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.SESSION_INVITATION_ENCRYPTION_KEY?.trim() ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Invitation encryption is not configured",
    );
  }
  return key;
}

export function parseInvitationFrontendOrigin(
  value: string | null | undefined,
  nodeEnv: string | undefined,
): string {
  let url: URL;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Event invitation website is not configured",
    );
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const localHttp = nodeEnv !== "production" && localhost && url.protocol === "http:";
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new GrantError(
      503,
      "SESSION_INVITATION_CONFIG_ERROR",
      "Event invitation website must be a trusted origin",
    );
  }
  return url.origin;
}
```

- [ ] Run GREEN in Docker and then compile API in Docker.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc './node_modules/.bin/tsx --test src/modules/session-grants/invitation-token.test.ts && npm run build'
```

Expected: token tests pass; API build may remain RED until Tasks 2–3 replace old imports. If so, record `DEFERRED_DEPENDENCY` for compile only, continue directly to Tasks 2–3, and rerun this compile before starting Task 4.

## Task 2 — Snapshot the Event website atomically when creating invitations

**Files:**

- Modify: `src/modules/session-grants/email-template.ts`
- Modify: `src/modules/session-grants/service.ts`
- Modify: `src/modules/session-grants/invitations.integration.test.ts`

**Consumes:** Task 1 helpers. **Produces:** every newly created invited item contains immutable validated `responseOrigin`.

- [ ] Extend the email snapshot types exactly as shown in Stable interfaces. Do not add a database column or modify the immediate-grant snapshot.

- [ ] Add failing integration cases using separate synthetic Events:

  - gated Event A has `website_url='http://localhost:3004/'`; creation succeeds and stores `responseOrigin='http://localhost:3004'`;
  - gated Event with null or invalid/non-root website rejects atomically with `SESSION_INVITATION_CONFIG_ERROR`; batch/item/invitation/reservation counts remain unchanged;
  - ungated immediate grant with null website still succeeds;
  - replaying an existing idempotency key returns its existing batch after Event URL changes and creates no new snapshot/invitation;
  - a later new invitation after Event A changes to another valid origin snapshots the new origin.

Use JSON extraction to prove the persisted value without printing tokens:

```sql
SELECT notification_snapshot->>'responseOrigin' AS response_origin
FROM registration_session_grant_items
WHERE id = $1;
```

- [ ] Run focused RED in Docker. Expected: creation ignores `events.website_url` and snapshot has no `responseOrigin`.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc './node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitations.integration.test.ts'
```

- [ ] Extend the existing locked session/Event query in `createGrant()` with `eventWebsiteUrl: events.websiteUrl`. Do not add another query.

```ts
eventWebsiteUrl: events.websiteUrl,
```

- [ ] Replace the combined config local with two locals whose values exist only for the gated branch. Validate URL and key before capacity and before inserts.

```ts
let invitationKey: Buffer | null = null;
let invitationFrontendOrigin: string | null = null;
if (session.adminGrantRequiresConfirmation) {
  invitationKey = readInvitationEncryptionKey(process.env);
  invitationFrontendOrigin = parseInvitationFrontendOrigin(
    session.eventWebsiteUrl,
    process.env.NODE_ENV,
  );
  configuredCapacity = await readInvitationCapacity(tx, session.id, now);
  // existing capacity rejection remains unchanged
}
```

- [ ] In the invited branch, issue the token with `invitationKey`. Construct a typed invitation snapshot before the insert so TypeScript guarantees `responseOrigin` is written.

```ts
const notificationSnapshot: InvitationNotificationSnapshot = {
  registrationId,
  regCode: registration.regCode,
  personName: nameSnapshot,
  eventId: session.eventId,
  eventName: eventEmailContext.eventName,
  eventShortName: eventEmailContext.shortName,
  eventDates: eventEmailContext.dates,
  eventVenue: eventEmailContext.venue,
  sessionId: session.id,
  sessionName: session.sessionName,
  sessionType: session.sessionType,
  startTime: session.startTime.toISOString(),
  endTime: session.endTime.toISOString(),
  room: session.room,
  participantUrl: null,
  responseOrigin: invitationFrontendOrigin,
};
```

The local application object currently contains additional `registrationId`, `eventId`, and `sessionId` audit fields beyond `GrantNotificationSnapshot`. Preserve them by declaring the type as an intersection if TypeScript excess-property checking requires it:

```ts
const notificationSnapshot: InvitationNotificationSnapshot & {
  registrationId: number;
  eventId: number;
  sessionId: number;
} = { /* complete object above */ };
```

- [ ] Keep `buildEventEmailContext({ websiteUrl: null })` unchanged in this delta because its website fallback is unrelated to the response link and its returned website is not persisted here. Do not route invitation origin through that fallback helper.

- [ ] Run focused GREEN and the legacy service suite in Docker.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc './node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitations.integration.test.ts src/modules/session-grants/service.integration.test.ts'
```

Expected: gated cases prove DB origin and atomic rejection; ungated immediate-grant cases remain green.

## Task 3 — Make worker first-send and retry use the immutable snapshot origin

**Files:**

- Modify: `src/modules/session-grants/email-jobs.ts`
- Modify: `src/modules/session-grants/invitation-email.integration.test.ts`

**Consumes:** Task 1 key/origin helpers and Task 2 snapshot. **Produces:** worker no longer reads current Event URL or `PRIS_FRONTEND_URL`.

- [ ] Add failing integration assertions for this exact sequence:

  1. Create invitation while Event website is `http://localhost:3004`.
  2. Change Event website to `http://127.0.0.1:3004` before first worker claim.
  3. First mail link still uses `http://localhost:3004`.
  4. Fail before send, retry after another Event URL change, and prove link/token/deadline/origin remain identical.
  5. Create a new invitation after the change and prove it uses the new Event origin.

- [ ] Add failing worker cases for missing, non-string, and invalid/non-root `notification_snapshot.responseOrigin`. Expected: item becomes `failed`, transport send count stays zero, error/log text contains no rejected URL, and token hash/ciphertext/deadline remain unchanged.

- [ ] Preserve existing wrong-key, unknown-delivery, restart, accepted/declined/expired suppression, and no-entitlement-before-acceptance assertions.

- [ ] Run focused RED in Docker. Expected: links still follow `PRIS_FRONTEND_URL` or invited snapshot validation is absent.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc './node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitation-email.integration.test.ts'
```

- [ ] In the invited mail branch, read the encryption key independently and validate the untrusted snapshot origin before decrypting/rendering. Do not join `events` and do not add Event URL to the worker query.

```ts
const invitationSnapshot =
  snapshot as InvitationNotificationSnapshot;
const responseOrigin = parseInvitationFrontendOrigin(
  invitationSnapshot.responseOrigin,
  process.env.NODE_ENV,
);
const key = readInvitationEncryptionKey(process.env);
const rawToken = decryptInvitationToken(
  invitation.id,
  invitation.tokenCiphertext as TokenEnvelope,
  key,
);
rendered = renderInvitationEmail(
  snapshot,
  buildInvitationUrl(rawToken, responseOrigin),
  effectiveDeadline(expiresAt, startTime).toISOString(),
);
```

- [ ] Keep the existing catch/audit path. It must record a safe error code/message and release the claim without logging snapshot content or raw URL/token. Do not change retry state transitions.

- [ ] Run focused GREEN, Task 1 compile recheck, and invitation unit suites in Docker.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc './node_modules/.bin/tsx --test --test-concurrency=1 src/modules/session-grants/invitation-email.integration.test.ts && npm run test:session-invitations && npm run build'
```

Expected: integration and unit suites pass; `rg` finds no `readInvitationConfig` import/call.

## Task 4 — Remove obsolete test ENV, update fixtures, and verify the whole delta

**Files:**

- Modify: `review/session-invitations-review-fixture.ts`
- Modify: `review/session-invitations-e2e-accept-latest.mjs`
- Modify: `docker-compose.session-invitations-test.yml`
- Modify after runtime proof: `docs/superpowers/verification/admin-session-invitations/final-readiness.md`
- Modify after runtime proof: `docs/superpowers/verification/admin-session-invitations/gates.json`

**Consumes:** Tasks 1–3. **Produces:** reproducible Docker proof with no invitation frontend ENV.

- [ ] Change review Events to store explicit local website roots. Use `http://localhost:3004` for links captured outside the Docker network; browser harness may continue replacing only the origin with `http://pris-server:3004` in memory as the completed verification design requires.

```sql
INSERT INTO events (
  event_code,event_name,event_type,start_date,end_date,max_capacity,status,website_url
) VALUES (
  $1,$2,'multi_session',$3,$4,1000,'published','http://localhost:3004'
);
```

- [ ] Replace fixture `readInvitationConfig(process.env)` with `readInvitationEncryptionKey(process.env)`. Every fixture-created invited item that the worker can claim must store a complete snapshot including `responseOrigin`; terminal/suppressed rows may use the same valid shape to keep fixture behavior realistic.

- [ ] Remove `PRIS_FRONTEND_URL` from `api-tools`, `api-server`, and `worker` in `docker-compose.session-invitations-test.yml`. Keep `SESSION_INVITATION_ENCRYPTION_KEY`, `NEXT_PUBLIC_API_URL`, browser `BASE_URL_PRIS`, and explicit `CORS_ORIGIN` unchanged.

- [ ] In `session-invitations-e2e-accept-latest.mjs`, assert the captured public link uses the Event snapshot origin before extracting the token and replacing only the origin for private Docker navigation.

```js
const mailed = new URL(href);
assert.equal(mailed.origin, "http://localhost:3004");
assert.equal(mailed.pathname, "/th/sessions/confirm");
const token = mailed.searchParams.get("token");
```

- [ ] Prove obsolete runtime coupling is gone with a host source inspection. Expected: no application/test/Compose reference; historical plans/evidence may retain old text until updated in the final step.

```powershell
rg -n "PRIS_FRONTEND_URL|readInvitationConfig" src review docker-compose.session-invitations-test.yml
```

Expected: no matches.

- [ ] Recreate only the isolated Docker test project resources needed for this run, apply the existing guarded test-harness schema prerequisites, and seed fresh fixtures. Verify database identity before reset/provision. Do not use `db:push`, a host runner, production credentials, or a shared database.

- [ ] Run complete API invitation regression in Docker:

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools sh -lc 'npm run test:session-invitations && npm run test:session-invitations:integration && npm run test:session-grants && npm run build'
```

Expected: all commands exit 0. Existing lifecycle/capacity/security/mail/writer/check-in/payment compatibility tests remain green.

- [ ] Refresh the ignored browser-token file from the current guarded fixture without printing or copying tokens into tracked evidence. Run this after the runtime schema clone and fixture cleanup described above, before creating the browser container so Compose reads the new file.

```powershell
$fixtureResult = docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools ./node_modules/.bin/tsx review/session-invitations-review-fixture.ts setup | ConvertFrom-Json
$tokenFile = Join-Path (Get-Location).Path 'review/session-invitations-review-tokens.env'
$tokenLines = @(
  "INV_TOKEN_ACCEPT=$($fixtureResult.invitationTokens.responseAccept)",
  "INV_TOKEN_DECLINE=$($fixtureResult.invitationTokens.responseDecline)",
  "INV_TOKEN_UNCERTAIN=$($fixtureResult.invitationTokens.responseUncertain)"
)
[System.IO.File]::WriteAllLines($tokenFile, $tokenLines, (New-Object System.Text.UTF8Encoding($false)))
Remove-Variable fixtureResult, tokenLines
git check-ignore --quiet -- review/session-invitations-review-tokens.env
if ($LASTEXITCODE -ne 0) { throw 'Review token file is not ignored by Git' }
```

Expected: the final command exits 0. Do not display the file or include it in `git add`.

- [ ] Start the isolated runtime stack and use the completed review harness sequence: run the full browser review, which creates the `INV-CAND-2` invitation; run the worker once through fake transport; then run the focused captured-mail acceptance check. All processes stay inside Docker.

```powershell
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml up -d postgres fake-mail api-server worker backoffice-server pris-server browser
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml exec -T browser node /workspace/conference-api/review/session-invitations-review-e2e.mjs
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm worker sh -lc 'ADMIN_SESSION_GRANTS_ENABLED=true ./node_modules/.bin/tsx src/modules/session-grants/jobs-runner.ts --once'
docker compose -p session-invitations-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml exec -T browser node /workspace/conference-api/review/session-invitations-e2e-accept-latest.mjs
```

Expected: fake link origin equals the Event snapshot origin, PRIS confirmation page loads, acceptance creates exactly one entitlement, and no raw link/token is written to tracked evidence.

- [ ] Update only stale origin/config statements in `final-readiness.md` and `gates.json` with actual commands/revisions/results. State that production now requires:

  - valid `events.website_url` for the target Event;
  - the authoritative migration/provisioning gap for `events.website_url` to be resolved before deployment;
  - stable `SESSION_INVITATION_ENCRYPTION_KEY` in API/worker;
  - `CORS_ORIGIN` containing the Event website origin;
  - Pris2026 `NEXT_PUBLIC_API_URL` pointing to the deployed API.

  Remove the obsolete action to configure `PRIS_FRONTEND_URL`. Do not alter historical facts about tests run against the previous revision; add a dated focused-delta verification entry instead.

- [ ] Run final source/evidence inspection. Confirm no schema/migration/Backoffice/Pris2026/conference-web files changed, no raw token/mail capture was staged, and the pre-existing untracked continuation prompt remains untouched.

```powershell
git diff --check
git status --short
git diff --stat
rg -n "PRIS_FRONTEND_URL|readInvitationConfig" src review docker-compose.session-invitations-test.yml
```

- [ ] Explicitly stage only files in this plan. Review staged diff, then create one commit after every check above passes. Do not push.

```powershell
git add -- src/modules/session-grants/invitation-token.ts src/modules/session-grants/invitation-token.test.ts src/modules/session-grants/email-template.ts src/modules/session-grants/service.ts src/modules/session-grants/invitations.integration.test.ts src/modules/session-grants/email-jobs.ts src/modules/session-grants/invitation-email.integration.test.ts review/session-invitations-review-fixture.ts review/session-invitations-e2e-accept-latest.mjs docker-compose.session-invitations-test.yml docs/superpowers/verification/admin-session-invitations/final-readiness.md docs/superpowers/verification/admin-session-invitations/gates.json
git diff --cached --check
git diff --cached --stat
```

Suggested commit title and body:

```text
fix(session-invitations): snapshot event response origin

Build invitation links from the invited Event website and persist the
validated origin with each durable mail item so retries keep their original
destination. Remove the obsolete PRIS frontend environment dependency while
preserving server-side token encryption and existing invitation behavior.

Verification: list the actual Docker unit, integration, build, fake-mail and
browser commands plus results. No production operation or push performed.
```

## Acceptance checklist

- [ ] Gated invitation creation requires a valid `events.website_url` and fails atomically otherwise.
- [ ] Ungated immediate grant behavior does not require an Event website.
- [ ] Snapshot contains normalized `responseOrigin`; raw token remains only encrypted/hash-protected as before.
- [ ] First send and every retry use snapshot origin, even after Event website changes.
- [ ] New invitation after Event website changes uses the new origin.
- [ ] Worker never rereads current Event website and never falls back to `PRIS_FRONTEND_URL` or `CONFER_URL`.
- [ ] Missing/invalid snapshot origin sends no email and does not rotate token/deadline.
- [ ] `SESSION_INVITATION_ENCRYPTION_KEY` remains mandatory and stable.
- [ ] `CORS_ORIGIN` remains an explicit trusted-origin deployment setting.
- [ ] No application/test/Compose dependency on `PRIS_FRONTEND_URL` remains.
- [ ] No database schema/migration, Backoffice, Pris2026, conference-web, payment, registration, or check-in change is included.
- [ ] Focused and full Docker verification pass at the final source revision.
- [ ] One explicit-file commit is created; nothing is pushed.

## Deployment preflight after implementation

This plan does not authorize deployment. Before separately authorized production enablement, inspect without mutating:

```sql
SELECT
  e.event_code,
  e.website_url,
  s.session_code,
  s.admin_grant_requires_confirmation
FROM events e
JOIN sessions s ON s.event_id = e.id
WHERE e.event_code = 'PRIS-2026'
  AND s.session_code = 'POLICY-INNOVATION';
```

Required result: exactly one row, `website_url` is the canonical HTTPS Pris2026 root origin, and the origin is present in API `CORS_ORIGIN`. Resolve the already documented authoritative migration gap for `events.website_url` before relying on this value in production.
