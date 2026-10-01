# Admin Session Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is an execution handoff for a future authorized implementation turn, not permission to start now. Do not spawn implementation agents or edit application code while preparing these documents.

**Goal:** Admin invites existing PRIS-2026 registrants to Policy Innovation Workshop, reserves at most 50 seats, emails a scoped token link to Pris2026, and grants access only after explicit acceptance before the session starts.

**Architecture:** Add one invitation table and a per-session confirmation flag to the existing PostgreSQL grant module. Existing grant items remain the durable mail queue; invitations reserve seats without creating access rows. A public lookup/response API and localized Pris2026 page complete the flow, while the existing Backoffice shows invitation and mail states separately.

**Tech Stack:** TypeScript, Node 20, Fastify 5, Drizzle/postgres-js, PostgreSQL 16, Zod 3, Next.js 16, React 19, next-intl, node:test/tsx, existing Docker test stack and Chromium/CDP review harness. Use installed dependencies only.

**Approved design:** [2026-10-01-admin-session-invitations-design.md](../specs/2026-10-01-admin-session-invitations-design.md)

**Independent review/verification:** [2026-10-01-admin-session-invitations-review-verification.md](2026-10-01-admin-session-invitations-review-verification.md)

**Status:** Planning only, approved design and deadline; no application source, migration, test setup, runtime configuration, production data, or email has been changed/executed by this plan. Checkboxes below describe future work. Engineering code blocks are implementation instructions, not code already applied or test results.

## Global Constraints

- Initially enable this behavior only for PRIS-2026 / POLICY-INNOVATION (Policy Innovation Workshop). Resolve the configured session by event/session codes, never assume production numeric IDs exist in every environment.
- Reserve a seat when Admin creates an invitation. Convert that reservation into a real entitlement on acceptance. Decline, expiry, or invalidated registration releases the reservation.
- Responses are permitted strictly before the session start. At server time equal to startTime, an unanswered invitation is expired. There is no seven-day TTL.
- The initial session has maxCapacity 50. Enforce its stored capacity, without changing other sessions' existing unrestricted Admin grant behavior.
- Invite only confirmed registrations belonging to the session's event.
- Existing session entitlements remain valid. Do not silently convert old grants into pending invitations or send retrospective invitations.
- No purchase, add-on ticket, order, payment, invoice, new registration, or new registration code is created.
- No login or OTP: the token authorizes one invitation only; a response is final. GET is read-only.
- Keep source=admin_grant, ticketTypeId=null, original inviting Admin, and existing regCode on new accepted entitlements.
- Separate immutable grant outcome, current invitation state, email state, and actual entitlement count.
- Reuse current mail transport/leases/retry auditing and frontend components; no dependency or general notification framework.
- Tests/build/lint/E2E run only in isolated Docker test containers, following the existing grant-verification baseline. Git/source inspection may run on host. Do not use real mail/payment endpoints or production credentials.
- This plan authorizes neither production deployment/migration nor real mail sending. Rehearsal and readiness evidence only until the user explicitly authorizes deployment.
- Respect current checkout/user edits. Do not create worktrees, reset files, or import old unrelated commit/skill requirements merely because older plans mention them.

## 0. Repository roots, verified facts, and dependency map

Host roots:

| Root | Host absolute path | Test-container root |
| --- | --- | --- |
| API | D:/confer/confer/conference/conference-api | /workspace/conference-api |
| BO | D:/confer/confer/conference/conference-backoffice | /workspace/conference-backoffice |
| PRIS | D:/confer/confer/conference/Pris2026 | /workspace/Pris2026 |
| WEB (regression only) | D:/confer/confer/conference/conference-web | /workspace/conference-web |

Existing facts that constrain implementation:

1. Last migration is currently drizzle/0031_admin_session_grants.sql; the Drizzle journal stops much earlier. The existing migration integration test has a deliberate prior-migration manifest and abstract-tracking prerequisites. Do not concatenate every SQL file or assume drizzle-kit migrate applies manual files.
2. The previous Compose stack mounts API, BO, and WEB but not PRIS. BO has no test script/tsx dependency; it already uses API's tsx for pure helper tests.
3. The previous browser harness runs bundled Chromium directly through CDP; Playwright npm is not required. Reuse the approach, not its hardcoded legacy fixture IDs.
4. Existing fake-mail service returns success and logs payload byte counts only. Capturing links/failure injection for this feature needs a test-only recorder, not production email changes.
5. Existing worker factory still calls sendNipaMailHtml; setting SESSION_GRANTS_FAKE_MAIL_URL alone does not prove the worker is using a fake. Wire an explicit test-only transport during T00/T07 and reject non-test use.
6. Normal API logger currently starts with logger:true; token-bearing request/error data must be redacted before public response routes ship.
7. Session dates are legacy timestamp without timezone. The supplied UTC start/end intend Bangkok 13:00–17:00 on 2026-10-29. Validate the actual driver mapping; do not rewrite dates to compensate twice.
8. Existing list UI uses outcome === added ? added : skipped, so deploying invited API rows before updating UI is unsafe.

Sequence: T00 -> T01 -> T02 -> T03 -> T04 -> T05 -> T06 -> T07 -> T08 -> T09 -> T10 -> T11 -> T12. T07 consumes T04–T06, T09 consumes T06/T08, T10 consumes T05/T02. Do not use an incomplete dependency as a reason to silently skip a final gate.

Each task contains an independently reviewable deliverable. Implement steps in small edits, prove the local RED then GREEN behavior, record gate IDs from the review file, and commit the completed deliverable in the repository that changed. A docs-only turn must not run these task commands.

## 1. File map and ownership

All paths below use a root from section 0; the root plus relative path is the exact absolute file target.

| ID | Root/path | Responsibility |
| --- | --- | --- |
| A01 | API/src/database/schema.ts | flag, invitation table, grant outcome/count checks |
| A02 | API/drizzle/0032_admin_session_invitations.sql | additive transactional migration; confirm number at execution |
| A03 | API/src/modules/session-grants/types.ts | wire/domain contracts |
| A04 | API/src/modules/session-grants/schemas.ts | strict decision validation |
| A05 | API/src/modules/session-grants/invitation-policy.ts (new) | pure effective deadline/state/identity |
| A06 | API/src/modules/session-grants/invitation-token.ts (new) | scoped token/hash/AES envelope/config |
| A07 | API/src/modules/session-grants/invitations.ts (new) | capacity/lookup/response/normalization transactions |
| A08 | API/src/modules/session-grants/service.ts | create invitation branch and existing batch reader |
| A09 | API/src/modules/session-grants/routes.ts | existing Admin DTO/error/retry contracts |
| A10 | API/src/modules/session-grants/invitation-routes.ts (new) | public scoped routes |
| A11 | API/src/modules/session-grants/email-template.ts | second template, old template untouched |
| A12 | API/src/modules/session-grants/email-jobs.ts | invitation-aware claim/send/retry |
| A13 | API/src/modules/session-grants/jobs-runner.ts | existing runner cleanup/fake selection |
| A14 | API/src/index.ts | public registration, safe logger/CORS |
| A15 | API/src/routes/backoffice/registrations.ts | eligibility/details + legacy/manual bypass guard |
| A16 | API/src/routes/backoffice/events.ts | session selector + capacity/metadata |
| A17 | API/src/routes/backoffice/sessions.ts | separate actual and reserved attendee statistics |
| A18 | API/src/utils/sessionEnrollment.ts | central public-selection guard/actual count |
| A19 | API/src/routes/public/events.ts | remove configured session from purchasable choices |
| A20 | API/src/routes/registrations/free.ts | reachable automatic/optional linking guard |
| A21 | API/src/routes/registrations/quick.ts | reachable automatic/explicit linking guard |
| A22 | API/src/modules/payments/registration-settlement.service.ts | inspect snapshot compatibility, do not redesign payments |
| A23 | API/src/database/migrate-sessions.ts | inspect historical writer; no direct invitation bypass |
| A24 | API/package.json | focused test script lists |
| A25 | API/docker-compose.session-invitations-test.yml (new) | test overlay, PRIS services and mounts |
| A26 | API/review/session-invitations-fake-mail.mjs (new) | test-only recorder/failure modes |
| A27 | API/review/session-invitations-review-fixture.ts (new) | guarded synthetic fixture/cleanup |
| A28 | API/review/session-invitations-review-e2e.mjs (new) | CDP recipient and BO walkthrough |
| A29 | API/src/modules/session-grants/test-database.ts | reuse guard; no bypass option |
| A30 | API/src/modules/session-grants/migration.integration.test.ts | preserve pre-0031 rehearsal and prepare latest test schema |
| B01 | BO/src/types/session-grants.ts | matching outcomes/counts/status types |
| B02 | BO/src/lib/api.ts | structured create errors and invitation detail DTO |
| B03 | BO/src/components/registrations/AddSessionDialog.tsx | gated session deadline/capacity |
| B04 | BO/src/components/registrations/SessionGrantResults.tsx | three outcomes and response state |
| B05 | BO/src/app/registrations/page.tsx | bulk reservation and selection recovery |
| B06 | BO/src/app/registrations/[id]/page.tsx | separate invitation history/access |
| P01 | PRIS/src/lib/sessionInvitation.ts (new) | scoped fetch and response contract |
| P02 | PRIS/src/lib/refreshRedirect.ts (new) | small route exemption predicate |
| P03 | PRIS/src/components/layout/GlobalRefreshRedirect.tsx | use predicate |
| P04 | PRIS/src/app/[locale]/sessions/confirm/page.tsx (new) | server metadata + client response page boundary |
| P05 | PRIS/src/app/[locale]/sessions/confirm/SessionInvitationResponse.tsx (new) | token read, safe lookup, two buttons |
| P06 | PRIS/messages/th.json and PRIS/messages/en.json | new translations namespace |
| P07 | PRIS/next.config.ts | response page referrer/no-store headers |
| P08 | PRIS/src/components/layout/Header.tsx | preserve query on this route's locale switch and use readable header colors |

New test files: API/src/modules/session-grants/invitation-policy.test.ts, invitation-token.test.ts, invitations.integration.test.ts, invitation-routes.test.ts, invitation-email.integration.test.ts, invitation-writer-compatibility.integration.test.ts, invitation-migration.integration.test.ts; PRIS/src/lib/sessionInvitation.test.ts and refreshRedirect.test.ts. Extend existing email-template/routes/service/readers tests only where their contracts changed. Do not duplicate old grant suites.

## 2. Stable interfaces and wire definitions

Define in A03 and use the same field names in B01/P01:

```ts
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';
export type InvitationDecision = 'accepted' | 'declined';
export type GrantOutcome = 'added' | 'invited' | 'skipped';
export interface TokenEnvelope {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}
export interface InvitationMetadata {
  invitationId: string;
  invitationStatus: InvitationStatus;
  expiresAt: string;
  effectiveDeadline: string;
  respondedAt: string | null;
}
export interface InvitationCapacity {
  currentEnrollmentCount: number;
  reservedCount: number;
  occupiedCount: number;
  seatsRemaining: number;
}
export interface PublicInvitationDto {
  invitationId: string;
  status: InvitationStatus;
  respondedAt: string | null;
  effectiveDeadline: string;
  recipientFirstName: string | null;
  session: {
    sessionName: string;
    sessionType: string | null;
    startTime: string;
    endTime: string;
    room: string | null;
  };
}
export interface InvitationErrorDto {
  error: string;
  code: string;
  invitation?: PublicInvitationDto;
  capacity?: InvitationCapacity;
}
```

Extend existing GrantItemDto with outcome:GrantOutcome and invitation:InvitationMetadata|null. Extend GrantBatchDto with invitedCount:number, reservedCount:number, occupiedCount:number, seatsRemaining:number|null; keep currentEnrollmentCount and historical fields. InvitationCapacity above is the configured-session helper/error shape and has a non-null remaining count. Add ALREADY_INVITED and DUPLICATE_PARTICIPANT to SkipCode. ALREADY_REGISTERED remains actual access. Duplicate participant in the same request yields DUPLICATE_PARTICIPANT only for candidates otherwise eligible.

For unconfigured sessions: invitedCount=0, reservedCount=0, occupiedCount=currentEnrollmentCount, invitation=null, seatsRemaining=null; never invoke the configured-session capacity validator or block the old grant. Keep history counters immutable: requestedCount = addedCount + invitedCount + skippedCount.

Domain signatures used by tasks:

```ts
// A05: pure; exact implementation in T02.
effectiveDeadline(expiresAt: Date, currentStartTime: Date): Date;
effectiveInvitationStatus(input: InvitationPolicyInput, now: Date): InvitationStatus;
participantKey(registration: {id: number; userId: number | null}): string;
// A06: pure crypto/config; exact implementation in T02.
readInvitationConfig(env: NodeJS.ProcessEnv): {key: Buffer; frontendOrigin: string};
issueInvitationToken(invitationId: string, key: Buffer): {rawToken: string; tokenHash: string; envelope: TokenEnvelope};
decryptInvitationToken(invitationId: string, envelope: TokenEnvelope, key: Buffer): string;
hashInvitationToken(rawToken: string): string;
buildInvitationUrl(rawToken: string, frontendOrigin: string): string;
// A07: database explicitly passed; no implicit global fallback.
readInvitationCapacity(database: GrantDatabase | GrantTransaction, sessionId: number, now: Date): Promise<InvitationCapacity>;
lookupInvitation(database: GrantDatabase, rawToken: string): Promise<PublicInvitationDto>;
respondToInvitation(database: GrantDatabase, rawToken: string, decision: InvitationDecision): Promise<PublicInvitationDto>;
closeInactiveInvitations(database: GrantDatabase, sessionId: number): Promise<number>;
// A10 route seam, matching current injectable route testing pattern.
interface InvitationRouteOptions {
  database?: GrantDatabase;
  lookupInvitationFn?: typeof lookupInvitation;
  respondToInvitationFn?: typeof respondToInvitation;
}
```

Every function above is assigned to a task, not an unspecified helper. Existing GrantError carries statusCode/code; extend it with optional safe invitation/capacity details rather than create another error hierarchy.

The backward-compatible error extension and serializer must have this concrete shape (retain the existing name/status/code assignments):

```ts
export class GrantError extends Error {
  constructor(
    readonly statusCode:number,
    readonly code:string,
    message:string,
    readonly details?:{invitation?:PublicInvitationDto;capacity?:InvitationCapacity},
  ) {
    super(message);
    this.name='GrantError';
  }
}
// In the existing Admin serializer and the new public serializer:
// return reply.status(error.statusCode).send({error:error.message,code:error.code,...error.details});
```

Three-argument existing callers remain valid. details contains only declared safe DTOs, never database rows, stack/error causes, token/envelope, or headers.

## T00 — Establish isolated verification and source baseline

**Files:** A25–A29; inspect A01/A08/A12/A15–A23; no feature behavior yet.

**Consumes:** Existing docker-compose.session-grants-test.yml, guarded test-database.ts, migration manifest, browser CDP implementation.

**Produces:** Test project session-invitations-test, mounted PRIS runtime/tools, deterministic fake mail contract, baseline/writer inventory evidence. Gate ENV-01..05/BASE-01..03.

- [ ] Capture git revision/status for API/BO/PRIS/WEB on host; inventory writers with rg. Read current migration/test scripts and compare to sections 0/1 before making any source edit.
- [ ] Create A25 as an overlay of the existing Compose file. Use a separate project name session-invitations-test so every named volume/network is distinct; do not attach to the earlier test project's persistent databases.
- [ ] Override api-tools, BO tools, worker, browser to mount PRIS and its Docker node_modules volume. Add pris-tools and pris-server (node:20-alpine, /workspace/Pris2026, Next on port 3004), keep BO on 3001/API on 3002/WEB on 3003. Use existing dependency lockfiles; never mount host node_modules.
- [ ] Add synthetic invitation environment to API/worker: PRIS_FRONTEND_URL=http://localhost:3004, test-only encryption key for 32 bytes, ADMIN_SESSION_GRANTS_ENABLED as current suite requires. Add http://pris-server:3004 to test CORS. Keep production origin validation intact.
- [ ] Use this complete service body for PRIS; common mounts use the exact roots in section 0:

```yaml
  pris-tools:
    image: node:20-alpine
    working_dir: /workspace/Pris2026
    environment:
      NODE_ENV: test
      NEXT_PUBLIC_API_URL: http://api-server:3002
    volumes:
      - ../Pris2026:/workspace/Pris2026
      - pris_node_modules:/workspace/Pris2026/node_modules
  pris-server:
    image: node:20-alpine
    working_dir: /workspace/Pris2026
    environment:
      NODE_ENV: test
      NEXT_PUBLIC_API_URL: http://api-server:3002
    command: ["sh", "-lc", "./node_modules/.bin/next dev -H 0.0.0.0 -p 3004 --webpack"]
    volumes:
      - ../Pris2026:/workspace/Pris2026
      - pris_node_modules:/workspace/Pris2026/node_modules
    depends_on:
      - api-server
    expose:
      - "3004"
```

- [ ] A26 fake recorder contract: POST /messages stores synthetic recipient/subject/html in memory; GET /messages returns them to the private test network; POST /reset clears; PUT /mode accepts success/fail-before-send/unknown-after-capture/block-until-release; POST /release unblocks. Never log HTML, token, or recipient; report only mode/call count/bytes. Use node:http and node:assert; no dependency. Reject non-test startup and network outside the Compose test network.

Use this complete recorder body in the test-only file; it keeps deliberate uncertain-delivery responses open until client timeout and closes held connections on reset/stop:

```js
import http from 'node:http';
if(process.env.NODE_ENV!=='test') throw new Error('Fake mail requires NODE_ENV=test');
const modes=new Set(['success','fail-before-send','unknown-after-capture','block-until-release']);
let mode='success';
const messages=[];
const held=new Set();
function json(res,status,body){
  res.writeHead(status,{'content-type':'application/json'});
  res.end(JSON.stringify(body));
}
async function body(req){
  const chunks=[];let length=0;
  for await(const chunk of req){
    length+=chunk.length;
    if(length>262144) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/messages') return json(res,200,{messages});
    if(req.method==='POST'&&req.url==='/reset'){
      messages.length=0;mode='success';
      for(const response of held) response.destroy();
      held.clear();return json(res,200,{ok:true});
    }
    if(req.method==='PUT'&&req.url==='/mode'){
      const input=await body(req);
      if(!modes.has(input.mode)) return json(res,400,{code:'INVALID_MODE'});
      mode=input.mode;return json(res,200,{ok:true,mode});
    }
    if(req.method==='POST'&&req.url==='/release'){
      for(const response of held) if(!response.destroyed) json(response,200,{messageId:'synthetic-released'});
      held.clear();return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&req.url==='/messages'){
      const input=await body(req);
      if(typeof input.recipient!=='string'||!/@example\.(test|invalid)$/.test(input.recipient)
        ||typeof input.subject!=='string'||typeof input.html!=='string'){
        return json(res,400,{code:'SYNTHETIC_RECIPIENT_REQUIRED'});
      }
      if(mode==='fail-before-send') return json(res,422,{code:'FAKE_PRE_SEND_FAILED'});
      messages.push({recipient:input.recipient,subject:input.subject,html:input.html});
      process.stdout.write(JSON.stringify({calls:messages.length,bytes:Buffer.byteLength(input.html)})+'\n');
      if(mode==='unknown-after-capture'||mode==='block-until-release'){
        held.add(res);res.once('close',()=>held.delete(res));return;
      }
      return json(res,200,{messageId:`synthetic-${messages.length}`});
    }
    return json(res,404,{code:'NOT_FOUND'});
  }catch{
    if(!res.headersSent) json(res,400,{code:'INVALID_REQUEST'});
    else res.destroy();
  }
});
server.listen(8025,'0.0.0.0');
process.once('SIGTERM',()=>{
  for(const response of held) response.destroy();
  server.close(()=>process.exit(0));
});
```

Recorder has no host port/public authentication: the isolation boundary is the dedicated Docker test network. The overlay mounts the new file and overrides fake-mail command to node /workspace/conference-api/review/session-invitations-fake-mail.mjs with NODE_ENV=test. The fake factory uses fetch/AbortSignal.timeout with current transport timeout; 422 maps to deliveryState=failed, a timeout after request dispatch maps to unknown. Do not expose recorder routes on the real API.
- [ ] Add test-only fake transport selection to A12 factory when NODE_ENV=test and SESSION_GRANTS_FAKE_MAIL_URL points to the Compose fake-mail origin. Normal production branch remains sendNipaMailHtml. Reject a fake URL in non-test environment. The fake transport must classify pre-send rejection as failed and after-capture timeout as unknown using the existing failure contract.
- [ ] Create/reuse migration bootstrap through the current guarded manifest. Existing migration suite's pre-0031 tests must continue to apply exactly their prior schema. Bootstrap the dedicated integration database, then clone it to the distinct runtime test database for browser fixtures after all migrations apply. Do not substitute db:push for migration rehearsal.
- [ ] Run ENV commands from verification section 3, install locked dependencies in containers, compile baseline, and run existing grant tests. Record old errors rather than expand scope to fix unrelated failures.
- [ ] Commit test-only setup after ENV/BASE gates pass. Suggested title: test: prepare isolated session invitation verification.

**Boundary:** Until later tasks add tests, these containers are only infrastructure. Real NipaMail credentials are absent and the fake transport is proven active with a captured synthetic message.

## T01 — Add migration, schema, and grant-count contracts

**Files:** A01–A04/A24/A30; new invitation-migration.integration.test.ts.

**Consumes:** Guarded pre-0031/0031 schema from T00. **Produces:** latest test schema, invitation table, stable outcomes/DTOs. Gates MIG-01..07/DTO-01.

- [ ] Write migration tests that insert a historical completed added/skipped batch before applying 0032; assert it still validates afterward. Tests must fail because flag/table/count/outcome are absent.
- [ ] Rehearse catalog constraint names using pg_constraint. Manual 0031's unnamed compound checks can differ from schema.ts named checks. Drop only the three identified outcome/completion checks, never all checks on these tables.
- [ ] Write A02 using BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; and the DDL below. Confirm no migration number collision first. Do not enable the production session flag in structural migration.

```sql
ALTER TABLE sessions ADD COLUMN admin_grant_requires_confirmation boolean NOT NULL DEFAULT false;
ALTER TABLE registration_session_grant_batches ADD COLUMN invited_count integer NOT NULL DEFAULT 0;
ALTER TABLE registration_session_grant_batches ADD CONSTRAINT session_grant_batches_invited_nonnegative CHECK (invited_count >= 0);

ALTER TABLE registration_session_grant_batches DROP CONSTRAINT IF EXISTS registration_session_grant_batches_check;
ALTER TABLE registration_session_grant_batches DROP CONSTRAINT IF EXISTS registration_session_grant_batches_completion_count_check;
ALTER TABLE registration_session_grant_batches ADD CONSTRAINT registration_session_grant_batches_completion_count_check
  CHECK (completed_at IS NULL OR requested_count = added_count + invited_count + skipped_count);

ALTER TABLE registration_session_grant_items DROP CONSTRAINT IF EXISTS registration_session_grant_items_outcome_check;
ALTER TABLE registration_session_grant_items ADD CONSTRAINT registration_session_grant_items_outcome_check
  CHECK (outcome IN ('added','invited','skipped'));
ALTER TABLE registration_session_grant_items DROP CONSTRAINT IF EXISTS registration_session_grant_items_check;
ALTER TABLE registration_session_grant_items DROP CONSTRAINT IF EXISTS registration_session_grant_items_outcome_email_check;
ALTER TABLE registration_session_grant_items ADD CONSTRAINT registration_session_grant_items_outcome_email_check
  CHECK ((outcome='skipped' AND email_status='not_applicable' AND reason_code IS NOT NULL)
    OR (outcome IN ('added','invited') AND email_status<>'not_applicable' AND reason_code IS NULL));

CREATE TABLE session_invitations (
  id uuid PRIMARY KEY,
  registration_id integer NOT NULL REFERENCES registrations(id),
  session_id integer NOT NULL REFERENCES sessions(id),
  grant_item_id uuid NOT NULL UNIQUE REFERENCES registration_session_grant_items(id),
  status varchar(16) NOT NULL CHECK (status IN ('pending','accepted','declined','expired','revoked')),
  token_hash varchar(64) NOT NULL UNIQUE,
  token_ciphertext jsonb,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  closed_at timestamptz,
  close_reason varchar(64),
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_invitations_lifecycle_check CHECK (
    (status='pending' AND responded_at IS NULL AND closed_at IS NULL AND token_ciphertext IS NOT NULL)
    OR (status IN ('accepted','declined') AND responded_at IS NOT NULL AND closed_at IS NOT NULL AND token_ciphertext IS NULL)
    OR (status IN ('expired','revoked') AND responded_at IS NULL AND closed_at IS NOT NULL AND token_ciphertext IS NULL)
  )
);
CREATE UNIQUE INDEX session_invitations_pending_pair_unique
  ON session_invitations(registration_id,session_id) WHERE status='pending';
CREATE INDEX session_invitations_pending_capacity_idx
  ON session_invitations(session_id,expires_at,registration_id) WHERE status='pending';
```

- [ ] In A01 mirror every column/index/check with Drizzle; keep createdBy an audit integer like existing batch.actorId, so Admin deletion never destroys history. Registration/session/item FKs use NO ACTION to preserve audit, not cascading deletion.
- [ ] Add complete section 2 types, update existing test DTO factories with invitedCount=0 and invitation=null, and define decision body with z.object({decision:z.enum(['accepted','declined'])}).strict(). Do not broaden existing create input.
- [ ] Extend A30 to leave the latest schema ready only after its original migration checks complete, or expose its existing manifest functions for new migration tests. New migration suite must support lock-timeout rollback, FK/check rejection, legacy preservation, and catalog parity. Run it before service suites, with test-concurrency=1.
- [ ] Add focused scripts with explicit filenames; the full new suite list is in verification section 3. Do not rely on a Windows shell expanding ** globs.
- [ ] Run migration/contract RED then GREEN and API compile in containers. Commit: feat: add session invitation schema and contracts.

**Review rule:** DDL above is the concrete target; if catalog inspection finds an unexpected old compound check name, identify it by its expression and add a narrowly named drop to this migration. Do not mask mismatch with blanket IF NOT EXISTS or dynamic dropping of unrelated checks.

## T02 — Implement pure deadline policy and token/config utilities

**Files:** A05/A06 and their two new test files. **Consumes:** section 2 types. **Produces:** named pure functions. Gates POL-01..06/SEC-01..05.

- [ ] Create policy tests using this complete boundary case:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveDeadline, effectiveInvitationStatus, participantKey } from './invitation-policy.js';
test('pending expires exactly at the earlier session deadline', () => {
  const snapshot = new Date('2026-10-29T06:00:00.000Z');
  const earlier = new Date('2026-10-29T05:00:00.000Z');
  const input = {status:'pending' as const, expiresAt:snapshot, startTime:earlier,
    isActive:true, registrationConfirmed:true, eventMatches:true};
  assert.equal(effectiveDeadline(snapshot, earlier).toISOString(), earlier.toISOString());
  assert.equal(effectiveInvitationStatus(input,new Date('2026-10-29T04:59:59.999Z')),'pending');
  assert.equal(effectiveInvitationStatus(input,earlier),'expired');
  assert.equal(participantKey({id:2,userId:7}),'user:7');
  assert.equal(participantKey({id:2,userId:null}),'registration:2');
});
```

- [ ] Run this new test alone and observe missing implementation. Then implement A05:

```ts
import type { InvitationStatus } from './types.js';
export interface InvitationPolicyInput {
  status: InvitationStatus;
  expiresAt: Date;
  startTime: Date;
  isActive: boolean;
  registrationConfirmed: boolean;
  eventMatches: boolean;
}
export function effectiveDeadline(expiresAt: Date, currentStartTime: Date): Date {
  return new Date(Math.min(expiresAt.getTime(),currentStartTime.getTime()));
}
export function effectiveInvitationStatus(input: InvitationPolicyInput, now: Date): InvitationStatus {
  if (input.status !== 'pending') return input.status;
  if (!input.isActive || !input.registrationConfirmed || !input.eventMatches) return 'revoked';
  const deadline = effectiveDeadline(input.expiresAt,input.startTime).getTime();
  return !Number.isFinite(deadline) || now.getTime() >= deadline ? 'expired' : 'pending';
}
export function participantKey(row: {id:number;userId:number|null}): string {
  return row.userId === null ? `registration:${row.id}` : `user:${row.userId}`;
}
```

- [ ] Add tests for accepted/declined after deadline, inactive/cancelled before deadline, later session start never extending snapshot, and absent/malformed dates. Assert policy inputs are server-owned; client cannot submit now.
- [ ] Define A06 encryption core exactly as follows; validate configuration once per invitation operation, not at module import, so a missing invitation secret does not break old grants:

```ts
import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto';
import type {TokenEnvelope} from './types.js';
import {GrantError} from './types.js';
const tokenPattern = /^[a-f0-9]{64}$/;
export function hashInvitationToken(rawToken:string):string {
  if (!tokenPattern.test(rawToken)) throw new GrantError(401,'INVALID_INVITATION_TOKEN','Invalid invitation token');
  return createHash('sha256').update(rawToken,'utf8').digest('hex');
}
export function readInvitationConfig(env:NodeJS.ProcessEnv):{key:Buffer;frontendOrigin:string} {
  const encoded = env.SESSION_INVITATION_ENCRYPTION_KEY?.trim() ?? '';
  const key = Buffer.from(encoded,'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new GrantError(503,'SESSION_INVITATION_CONFIG_ERROR','Invitation encryption is not configured');
  }
  let url:URL;
  try {url = new URL(env.PRIS_FRONTEND_URL ?? '');}
  catch {throw new GrantError(503,'SESSION_INVITATION_CONFIG_ERROR','Invitation frontend is not configured');}
  const localhost = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const localHttp = env.NODE_ENV !== 'production' && localhost && url.protocol === 'http:';
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new GrantError(503,'SESSION_INVITATION_CONFIG_ERROR','Invitation frontend must be a trusted origin');
  }
  return {key,frontendOrigin:url.origin};
}
export function issueInvitationToken(invitationId:string,key:Buffer) {
  const rawToken = randomBytes(32).toString('hex');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(invitationId,'utf8'));
  const ciphertext = Buffer.concat([cipher.update(rawToken,'utf8'),cipher.final()]);
  const envelope:TokenEnvelope = {version:1,nonce:nonce.toString('base64'),
    tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  return {rawToken,tokenHash:hashInvitationToken(rawToken),envelope};
}
export function decryptInvitationToken(invitationId:string,envelope:TokenEnvelope,key:Buffer):string {
  try {
    if (envelope.version !== 1) throw new Error('version');
    const nonce=Buffer.from(envelope.nonce,'base64'),tag=Buffer.from(envelope.tag,'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('envelope');
    const decipher=createDecipheriv('aes-256-gcm',key,nonce);
    decipher.setAAD(Buffer.from(invitationId,'utf8'));
    decipher.setAuthTag(tag);
    const token=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8');
    hashInvitationToken(token);
    return token;
  } catch {
    throw new GrantError(503,'INVITATION_PAYLOAD_INVALID','Invitation email payload is unavailable');
  }
}
export function buildInvitationUrl(rawToken:string,frontendOrigin:string):string {
  hashInvitationToken(rawToken);
  const url=new URL('/th/sessions/confirm',frontendOrigin);
  url.searchParams.set('token',rawToken);
  return url.toString();
}
```

- [ ] Token tests use a synthetic Buffer.alloc(32,7), verify decrypt round trip, different nonces for identical calls, SHA digest distinct from raw token, tampered tag/version/ciphertext/wrong key/other invitation ID rejection, invalid credential format, and HTTPS/local-origin rules. Assert errors contain no input secret/token.
- [ ] GREEN both unit files and compile, then commit: feat: add scoped invitation token and deadline policy.

## T03 — Add capacity and read-only invitation reader

**Files:** A07; new invitations.integration.test.ts; extend readers.integration.test.ts where DTOs change.

**Consumes:** A01/A03/A05/A06 and GrantDatabase/GrantTransaction. **Produces:** readInvitationCapacity and lookupInvitation, safe public DTO. Gates READ-01..06/CAP-01..03/SEC-06.

- [ ] Build fixtures in the guarded integration database for confirmed/invalid/foreign registrations, user-owned sibling registrations, existing entitlements, and pending/closed invitations. Use future dates relative to DB time for integration; fixed UTC dates only for pure tests.
- [ ] Write failing assertions for 30 entitlements +15 valid reservations -> occupied45/remaining5, expired pending -> no reservation, same-user existing entitlement -> no double count, and legacy over-capacity -> remaining0 without deletion.
- [ ] Implement the read SQL using tx/database.execute and explicit numeric conversion of bigint counts. This query defines reservation semantics, with $1=sessionId and $2=database now as timestamptz; use bound Drizzle parameters, never string interpolation:

```sql
WITH actual AS (
  SELECT rs.id FROM registration_sessions rs
  JOIN registrations r ON r.id=rs.registration_id
  JOIN sessions s ON s.id=rs.session_id
  WHERE rs.session_id=$1 AND r.status='confirmed' AND r.event_id=s.event_id
), pending AS (
  SELECT i.id FROM session_invitations i
  JOIN registrations r ON r.id=i.registration_id
  JOIN sessions s ON s.id=i.session_id
  WHERE i.session_id=$1 AND i.status='pending'
    AND r.status='confirmed' AND r.event_id=s.event_id AND s.is_active
    AND i.expires_at>$2 AND (s.start_time AT TIME ZONE 'UTC')>$2
    AND NOT EXISTS (
      SELECT 1 FROM registration_sessions rs2
      JOIN registrations r2 ON r2.id=rs2.registration_id
      WHERE rs2.session_id=i.session_id AND r2.status='confirmed' AND r2.event_id=r.event_id
        AND (r2.id=r.id OR (r.user_id IS NOT NULL AND r2.user_id=r.user_id))
    )
)
SELECT (SELECT count(*) FROM actual) AS entitled,
       (SELECT count(*) FROM pending) AS reserved,
       s.max_capacity AS capacity
FROM sessions s WHERE s.id=$1;
```

- [ ] Verify the AT TIME ZONE 'UTC' conversion matches the legacy convention with the timestamp gate. Reuse this convention consistently; do not apply it to new timestamptz expires_at. If the driver proves a different established convention, fix the narrow conversion and document evidence before running deadline gates.
- [ ] readInvitationCapacity is called only for configured invitation sessions; it throws SESSION_NOT_FOUND for no session and SESSION_INVITATION_CONFIG_ERROR for invalid positive capacity. Use number conversion and safe integer checks before arithmetic. Ungated batch/selector readers use the explicit section 2 null-remaining mapping instead of this validator.
- [ ] lookupInvitation hashes the credential, selects invitation/registration/session by unique token_hash, obtains current DB clock, computes effective state, and maps only fields in PublicInvitationDto. It performs no UPDATE and never falls back to user login. Return fixed GrantErrors for unavailable/expired states with safe DTO for expired display.
- [ ] Compare database rows before/after repeated GET-style lookups to prove no usedAt/status/ciphertext/count changes. Accept/decline terminal states remain readable after deadline.
- [ ] GREEN focused reader/capacity tests, existing grant reader regressions, compile. Commit: feat: add invitation lookup and reservation counts.

## T04 — Branch Admin grant creation into atomic invitations

**Files:** A08/A03/A09; invitations.integration.test.ts and service.integration.test.ts.

**Consumes:** pure token/policy, capacity reader, existing canonicalRequest/requestHash/registrationBlock. **Produces:** invitation-aware createGrant with immutable batch outcomes; gate CREATE-01..12/CAP-04..07.

- [ ] Add RED cases: configured session yields invited item, pending mail and invitation but zero entitlement; unconfigured session still yields added; missing config aborts all writes; insufficient capacity aborts whole batch.
- [ ] Keep actor/idempotency advisory lock and replay check first. Validate actor, then lock the session FOR UPDATE for configured behavior. Do not upgrade a held SHARE lock later: use one deterministic lock acquisition. Preserve old sessionBlock end rule only for unconfigured sessions; configured sessions require now < start.
- [ ] Lock all selected registrations plus same-user/event siblings needed for duplicate detection in ascending registration ID order, then invitations in deterministic ID order. Use database clock_timestamp() after waiting. Never accept frontend now/deadline.
- [ ] Before immediate-grant fallback, check for outstanding invitations on that session. A cleared flag must not turn an existing invitation session into an access bypass; fail closed with SESSION_INVITATION_REQUIRED when outstanding pending invitations exist.
- [ ] Normalize stale pending invitations for locked participants: pending->expired/revoked, clear token_ciphertext, closed_at=DB now, close_reason fixed code. Leave responded_at null. Do not update accepted/declined.
- [ ] Compute eligibility using existing reasons, actual ownership across confirmed same-user/event registrations, active invitation across those registrations, and canonical participantKey. Existing invitation is ALREADY_INVITED; an otherwise eligible same-user duplicate in this batch is DUPLICATE_PARTICIPANT. For missing userId use exact registration only.
- [ ] Read capacity under session lock. If eligible new invitations exceed remaining, throw GrantError409 SESSION_CAPACITY_EXCEEDED with safe counts. Do not persist batch/items before deciding capacity; rollback also covers any normalization in this rejected transaction.
- [ ] For configured session, insert batch, then each item before invitation (required FK order). Generate UUIDs before token issuance, store envelope only on invitation, and keep snapshot token-free. Required values:

```ts
const itemValues = {
  id:itemId,batchId,requestedRegistrationId:registration.id,
  registrationSessionId:null,regCodeSnapshot:registration.regCode,nameSnapshot,
  outcome:'invited',reasonCode:null,recipientEmailSnapshot:registration.email,
  notificationSnapshot:notificationMetadata,emailStatus:'pending',
};
const invitationValues = {
  id:invitationId,registrationId:registration.id,sessionId:session.id,
  grantItemId:itemId,status:'pending',tokenHash:issued.tokenHash,
  tokenCiphertext:issued.envelope,expiresAt:session.startTime,
  respondedAt:null,closedAt:null,closeReason:null,createdBy:input.actorId,
};
```

Here itemId/invitationId are randomUUID(), issued is issueInvitationToken(invitationId,config.key), notificationMetadata is the existing recipient/event/session snapshot without a token-bearing participantUrl, and nameSnapshot is the existing firstName/lastName format. These variables must be computed in the same create transaction, not accepted from the request.

- [ ] Skipped items retain existing not_applicable semantics. Store invitedCount separately; completedAt is DB time; enforce requested=added+invited+skipped. Do not modify immutable invited outcome on later acceptance.
- [ ] readBatch joins invitations by grant_item_id and attaches computed metadata. Keep actual count global across pagination; capacity is global for session. History readers get the same state mapping and no credentials.
- [ ] Concurrency tests use multiple independent guarded DB connections: two Admins/keys same participant -> one pending; two disjoint requests with one seat -> one winner; same key/payload -> same batch and same ciphertext/token hash; mismatch ->409. No duplicate initial mail job.
- [ ] GREEN all CREATE/CAP gates and old immediate-grant tests; commit: feat: reserve seats with atomic admin session invitations.

## T05 — Implement acceptance, decline, expiry normalization

**Files:** A07; invitations.integration.test.ts.

**Consumes:** lookup/policy/capacity/schema. **Produces:** respondToInvitation and closeInactiveInvitations; gate RESP-01..12/POL-05..06.

- [ ] RED tests for accept/decline, same-decision replay, opposite response409, exact deadline expiry, registration cancellation, and forced failure after entitlement insert.
- [ ] Find invitation by hash without locking only to discover IDs. In transaction lock session, registrations/same-user siblings ascending, invitation ascending, then grant item as needed. Re-read token hash and all state under locks; obtain DB time last. Don't authorize from the discovery snapshot.
- [ ] For already accepted/declined: same choice returns safe DTO200 even after deadline if the resources remain available; opposite choice throws409. Revoked/expired pending cannot mutate. If decision could succeed only by restoring cancellation, fail409 instead.
- [ ] For pending exact same-registration entitlement discovered concurrently, use the existing row without modifying source/ticket/check-in; update item link only if the existing grant-item unique linkage permits it. If another audit item already owns that entitlement linkage, leave this invitation's item linkage null and retain accepted audit through invitation, rather than violating the unique index. No second entitlement is inserted. Surface this reconciliation in integration evidence.
- [ ] For actual access held by a different registration of the same known user, return PARTICIPANT_ALREADY_REGISTERED409 and normalize the redundant invitation to revoked to release its reservation. Commit the normalization before surfacing the conflict: return a result/error descriptor from the transaction, then throw outside it. Do not throw inside and accidentally roll back seat release.
- [ ] Acceptance inserts values below with onConflictDoNothing on the exact pair and resolves only that exact conflict. Never hide unrelated uniqueness/FK errors:

```ts
const entitlementValues = {
  registrationId:invitation.registrationId,
  sessionId:invitation.sessionId,
  ticketTypeId:null,
  source:'admin_grant',
  addedBy:invitation.createdBy,
};
```

- [ ] Atomically set status=accepted or declined, respondedAt=now, closedAt=now, tokenCiphertext=null, closeReason=null. Accepted stores item.registrationSessionId for newly created entitlement; declined leaves null. If an update affects zero rows after re-read, return current terminal answer or rollback with a fixed conflict.
- [ ] closeInactiveInvitations uses the same lock order, updates only effectively inactive pending rows for one session, clears ciphertext, and returns changed count. Worker invokes bounded batches outside its mail-claim transaction; capacity already excludes these rows without cleanup.
- [ ] Normalize expired/invalid response attempts through a committed closed transition if desired, then return error after commit. Do not persist partial acceptance/decline on any failure. GET remains read-only.
- [ ] Run controlled accept-vs-decline race, double-accept, accept-vs-expiry/registration cancel, and transaction failure assertions. Confirm pending count falls by one while actual rises by one on acceptance, occupied remains constant.
- [ ] GREEN RESP gates and compile; commit: feat: finalize invitation responses atomically.

## T06 — Expose scoped public API and sanitize request logging

**Files:** A10/A14/A04/A09; invitation-routes.test.ts, existing routes.test.ts factories.

**Consumes:** lookupInvitation/respondToInvitation. **Produces:** public lookup/PUT contracts and safe errors/rate limit. Gates HTTP-01..10/SEC-06..10.

- [ ] Build Fastify.inject tests with injectable functions and a fake database. Missing/malformed normal JWT/token cannot reach domain functions; valid 64-hex invitation credential reaches them. Mock service errors contain safe DTO only.
- [ ] Implement strict bearer parsing in A10; reject array/missing/wrong-scheme/extra-token headers. A token is validated using hashInvitationToken; no fastify.authenticate or jwtVerify.

```ts
function invitationCredential(header:string|string[]|undefined):string {
  if (typeof header !== 'string') throw new GrantError(401,'INVALID_INVITATION_TOKEN','Invitation token required');
  const match=/^Bearer ([a-f0-9]{64})$/.exec(header);
  if (!match) throw new GrantError(401,'INVALID_INVITATION_TOKEN','Invalid invitation token');
  return match[1];
}
```

- [ ] Register GET /current and PUT /current/response in public plugin at /api/session-invitations. GET never calls mutation; PUT accepts only strict decision. Set no-store on success/error and reuse structured GrantError serialization; unknown error logs code/invitation ID only and returns generic500.
- [ ] Route rateLimit max=30/timeWindow='1 minute'/groupId='session-invitations', matching the installed @fastify/rate-limit groupId option and public confirmation baseline. GET/PUT share the same per-IP budget. Set bodyLimit=1024 bytes on PUT so oversized input fails before parsing/domain work.
- [ ] Add logger redaction of req.headers.authorization and request serializers that redact token query parameter values for token-bearing routes without exposing alternate raw URL fields. Never log err objects that can contain axios config/headers/html. Preserve useful method/path/status/error-code logging.
- [ ] Verify CORS accepts Pris2026 configured origin and Authorization header/PUT preflight through existing allowed-origin configuration. Do not enable wildcard CORS or credentials globally for this feature.
- [ ] Assert POST is unsupported for response (404/405 according to Fastify registration), GET safe, PUT correct200/400/401/409/410/429/500, public accessible when ADMIN_SESSION_GRANTS_ENABLED=false, and no ordinary user session is created.
- [ ] GREEN HTTP/SEC suites and compile; commit: feat: expose secure public session invitation responses.

## T07 — Extend email template, worker, and retry without duplicate seats

**Files:** A11–A13; invitation-email.integration.test.ts, existing email-template.test.ts/email-jobs.test.ts.

**Consumes:** token decrypt/build, effective policy, invitation relation. **Produces:** session-invitation-v1 mail and recoverable sending/retry. Gates MAIL-01..13/SEC-11.

- [ ] RED tests: invited item has null registrationSessionId yet is sendable; added historical item keeps old template; token never persisted plaintext; closed invitation suppresses; failed/unknown retry reuses hash/deadline/seat.
- [ ] Add renderInvitationEmail(snapshot, responseUrl, deadline) alongside existing renderGrantEmail. Reuse safe URL/html escaping and Bangkok formatter, keep names exactly as stored. Subject: คำเชิญเข้าร่วมเซสชัน: <session> — <event>. Body says access follows acceptance, includes deadline/session/time/room, and uses one link ตอบรับคำเชิญเข้าร่วม Session. No GET accept/decline URL.
- [ ] claimOne keeps existing item SKIP LOCKED/lease/attempt semantics. Select outcome and read invitation non-lockingly for rendering; do not acquire a session lock while holding an item lock, because response transactions acquire session before item. Decrypt only effectively pending invitation, verify hash of decrypted token equals stored token_hash, build URL, render HTML in memory only.
- [ ] Extend ClaimedMail with invitationId and kind added/invited. relationStillActive branches by kind: old entitlement confirmed check for added, effective pending registration/session check for invited. Recheck before transport; never recreate ciphertext if a response cleared it.
- [ ] Existing finalization updates only queue item/attempt; it must not lock invitation/session or change invitation status. Inactive cleanup runs separately with business lock order. Successful send sets email sent only, never invitation accepted.
- [ ] Preserve unknown recovery when provider outcome is uncertain, pending recovery before transport, failed manual retry, unknown acknowledgement, no auto-retry unknown, and existing attempt numbering/provider metadata.
- [ ] retryGrantEmails reads invitation effective state for invited items, uses same ciphertext/token/deadline and rejects closed invitations with INVITATION_NOT_PENDING. Existing added retry continues checking active entitlement. No mail retry writes new batch/invitation/entitlement.
- [ ] Worker runner invokes closeInactiveInvitations on sessions with stale pending invitations in bounded batches even if new grants are disabled; don't busy-loop cleanup. Keep 5s idle poll/700ms mail gap/180s lease/30s configured transport timeout from existing runner. No separate worker/scheduler.
- [ ] Fake transport tests cover crash before send vs after capture/finalize, invitation answer while send is blocked, key missing/wrong after queue creation, and expired ciphertext removal. Assert no secrets in thrown errors or persisted attempt messages.
- [ ] Inspect provider request schema/settings for link tracking. If no application setting is supported, record provider-controlled state and make confirmation-page token protection a readiness requirement; don't invent undocumented NipaMail fields.
- [ ] GREEN MAIL/legacy grant-email suites, runtime worker --once and health gate; commit: feat: deliver and retry durable invitation emails.

## T08 — Add Admin readers and prevent reachable entitlement bypasses

**Files:** A15–A23/A09; invitation-writer-compatibility.integration.test.ts, existing reader/writer compatibility suites.

**Consumes:** invitation lookup/capacity/policy. **Produces:** consistent selector/list/details and Admin-only guarded writers. Gates BOAPI-01..05/BYPASS-01..08/REG-01..07.

- [ ] Re-run rg inventory; map each registration_sessions insert to endpoint/caller. No new generic writer abstraction is needed.
- [ ] For session selector, return adminGrantRequiresConfirmation, effective deadline, actual enrollmentCount, reserved/occupied/remaining, and SESSION_RESPONSE_CLOSED after start; preserve old endTime rule for other sessions. Eligibility must reflect pending invitations and known-user sibling access, not just exact hasSession.
- [ ] Registration Details/history return invitations separately from sessions, with current response/mail state; no token/ciphertext. Extend existing session grants history rather than issue a separate browser request per item.
- [ ] Legacy add-session route rejects any requested configured session before inserting any member of the request. Validate the entire list first; return 409 SESSION_INVITATION_REQUIRED. Manual registration similarly rejects explicit configured selections before creating a Registration or soldCount mutation.
- [ ] Filter configured sessions from free/quick/manual automatic linking and public primary/optional choices; reject explicit public optional/session selections at their shared validation boundary. Use the flag, not workshop type or numeric ID:

```ts
const automaticallyLinked = linkedSessions.filter(
  row => !row.requiresOptIn && !row.adminGrantRequiresConfirmation,
);
```

- [ ] Add adminGrantRequiresConfirmation to the relevant select projection so the filter does not operate on undefined. Any explicit list containing a forbidden session must produce a defined rejection instead of silently dropping part of user intent.
- [ ] Inspect settlement prior snapshots and ticket links. If preflight proves no configured-session paid path exists, preserve settlement code outside automatic-link filtering. If legacy paid snapshot exists, report it as a readiness conflict without losing financial state/access; do not suppress/throw away gateway reconciliation just to satisfy new flow.
- [ ] Historical migration script must not create new configured-session entitlement when run after rollout; direct attempt gets clear failure before row writes. Preserve old historical entries.
- [ ] Test every check-in mode pending denied/accepted allowed with normal time window, ticketTypeId nullable, original regCode and source. Actual count/export remains actual, pending count separately labeled. Do not count invitations in actual enrollment helper.
- [ ] GREEN BYPASS/REG/current readers/payment compatibility test set; commit: fix: enforce invitation acceptance across session access paths.

## T09 — Update Backoffice invitation UI and recovery

**Files:** B01–B06; pure helper tests only if extracted non-trivial logic; A28 BO cases.

**Consumes:** T06/T08 DTOs/errors. **Produces:** both Admin entry points, response history, preserved selection. Gates BOUI-01..12.

- [ ] Extend B01 wire types exactly from section 2; update outcome unions in history as well as results. Make existing API client preserve structured code/capacity from create errors for this operation, without breaking other fetch callers.
- [ ] Add session-choice fields and gated disabled reason. Show มีสิทธิ์แล้ว X · รอตอบรับ Y · รวม Z/50 · เหลือ N and deadline. Unconfigured sessions retain old copy/behavior.
- [ ] Before submit show invitation intent and deadline; keep selection across pagination/search. On SESSION_CAPACITY_EXCEEDED show refreshed seatsRemaining, preserve selected recipients/idempotency operation state, and allow deliberate revise/resubmit with a fresh key if payload changes. Retry same ambiguous request must keep the existing key.
- [ ] Replace binary outcome display with explicit exhaustive mapping:

```ts
const outcomeLabels:Record<GrantOutcome,string> = {
  added:'เพิ่มสิทธิ์แล้ว',invited:'สร้างคำเชิญแล้ว',skipped:'ข้าม',
};
const invitationLabels:Record<InvitationStatus,string> = {
  pending:'รอตอบรับ',accepted:'ยืนยันเข้าร่วม',declined:'ปฏิเสธ',expired:'หมดเวลา',revoked:'ใช้คำเชิญไม่ได้',
};
```

- [ ] Results show addedCount/invitedCount/skippedCount, current invitation state/deadline/respondedAt, then email status/attempts separately. Closed invitations have no retry button even if old email status failed. Keep unknown acknowledgement for effectively pending invitations.
- [ ] Details has a separate invitation history section; pending/declined/expired aren't inserted into accessible sessions UI. After manual refresh, accepted entitlement appears in existing Admin-added group.
- [ ] Poll only while mail pending/sending; awaiting human answer alone does not keep a timer running. Add manual refresh using existing button. Do not create websockets/background polling.
- [ ] Use Thai/Bangkok timeZone explicitly in new date labels; preserve dialog focus, row checkbox labels, visible disabled reasons, and accessible table headings/colSpan updates.
- [ ] Run BO build/lint and API-tsx existing selection test in Docker, then CDP BO walkthrough. Commit in BO only: feat: show session invitation capacity and responses.

## T10 — Add Pris2026 response page and safe navigation

**Files:** P01–P08; PRIS two helper tests; A28 PRIS cases.

**Consumes:** public API DTO/methods from T06. **Produces:** /th|en/sessions/confirm route, safe reload/localization, two decisions. Gates PRIS-01..14/SEC-12.

- [ ] P01 uses the section 2 public contract. Implement fetch helpers with API origin from NEXT_PUBLIC_API_URL, Accept JSON, cache:no-store, scoped Authorization, strict PUT JSON, and AbortSignal for lookup. Errors preserve code and safe invitation summary. Do not call login/SSO/storage helpers.

```ts
export async function requestInvitation(
  apiOrigin:string,token:string,decision:'accepted'|'declined'|null,signal?:AbortSignal,
):Promise<{httpStatus:number;body:PublicInvitationDto|InvitationErrorDto}> {
  const response=await fetch(`${apiOrigin}/api/session-invitations/current${decision ? '/response' : ''}`,{
    method:decision ? 'PUT' : 'GET',cache:'no-store',signal,
    headers:{Accept:'application/json',Authorization:`Bearer ${token}`,
      ...(decision ? {'Content-Type':'application/json'} : {})},
    ...(decision ? {body:JSON.stringify({decision})} : {}),
  });
  return {httpStatus:response.status,body:await response.json()};
}
```

- [ ] Write pure fetch tests with temporary global fetch fake restored in test cleanup. Assert GET has no body, PUT only decision, no credential in URL/body, 410 preserves safe DTO, abort/network error propagates without token logging. Do not replace real API tests with this mock.
- [ ] P04 stays a server page exporting metadata robots:noindex/nofollow and referrer:no-referrer, wrapping the client P05 in Suspense. Keep metadata out of a use-client page. Use existing site layout rather than a new app shell.
- [ ] P05 reads searchParams token and locale, displays loading then pending/terminal/error. Validate missing credential before fetch; AbortController cancels stale lookup on token change/unmount. Buttons call only PUT. Disable both while submitting, success follows API response, duplicate opposite 409 refreshes final state. For uncertain/network submission, perform GET to discover saved state before enabling another decision.
- [ ] JSX body requirements: session title, recipient first name, date/time/room/deadline; two type=button actions; visible final-answer notice; role=status/aria-live for result and role=alert for errors; retry button for read/network failure. Never autoplay acceptance or turn an email link query decision into a mutation.
- [ ] P06 adds sessionInvitations namespace with these exact core Thai values and corresponding English values: ยืนยันเข้าร่วม / Confirm attendance; ปฏิเสธการเข้าร่วม / Decline invitation; รอตอบรับ / Awaiting response; คุณยืนยันเข้าร่วมแล้ว / Your attendance is confirmed; คุณปฏิเสธคำเชิญแล้ว / You declined this invitation; หมดเวลาตอบรับแล้ว / The response deadline has passed; คำเชิญนี้ใช้ไม่ได้ / This invitation is unavailable; คำตอบที่ส่งแล้วเปลี่ยนไม่ได้ กรุณาติดต่อผู้จัดงานหากต้องการแก้ไข / Your submitted response is final. Contact the organizer if a correction is needed. Include all HTTP/network/retry/deadline/room labels; preserve API names.

The exact new namespace content is below. Merge the language-specific object under sessionInvitations into each existing messages file; do not replace unrelated namespaces:

```json
{
  "th": {
    "title": "ตอบรับคำเชิญเข้าร่วม Session",
    "greeting": "เรียน {name}",
    "loading": "กำลังตรวจสอบคำเชิญ…",
    "pending": "รอตอบรับ",
    "session": "Session",
    "dateTime": "วันและเวลา",
    "room": "ห้อง",
    "roomNotSpecified": "ไม่ระบุ",
    "deadline": "ตอบรับได้ก่อน {dateTime}",
    "timeZone": "เวลาไทย (Asia/Bangkok)",
    "accept": "ยืนยันเข้าร่วม",
    "decline": "ปฏิเสธการเข้าร่วม",
    "submitting": "กำลังบันทึกคำตอบ…",
    "accepted": "คุณยืนยันเข้าร่วมแล้ว",
    "declined": "คุณปฏิเสธคำเชิญแล้ว",
    "expired": "หมดเวลาตอบรับแล้ว",
    "unavailable": "คำเชิญนี้ใช้ไม่ได้ กรุณาติดต่อผู้จัดงาน",
    "invalid": "ลิงก์คำเชิญไม่ถูกต้องหรือไม่มีโทเคน",
    "recordedAt": "บันทึกคำตอบเมื่อ {dateTime}",
    "finalNotice": "คำตอบที่ส่งแล้วเปลี่ยนไม่ได้ กรุณาติดต่อผู้จัดงานหากต้องการแก้ไข",
    "networkError": "ไม่สามารถเชื่อมต่อระบบได้ กรุณาตรวจสอบสถานะอีกครั้ง",
    "serverError": "ระบบยังไม่สามารถดำเนินการได้ กรุณาลองตรวจสอบสถานะอีกครั้ง",
    "rateLimited": "มีคำขอมากเกินไป กรุณารอสักครู่แล้วตรวจสอบสถานะอีกครั้ง",
    "answerConflict": "คำเชิญนี้มีคำตอบที่บันทึกแล้ว กำลังตรวจสอบผลล่าสุด",
    "retry": "ตรวจสอบสถานะอีกครั้ง",
    "home": "กลับหน้าแรก"
  },
  "en": {
    "title": "Respond to your session invitation",
    "greeting": "Dear {name}",
    "loading": "Checking your invitation…",
    "pending": "Awaiting response",
    "session": "Session",
    "dateTime": "Date and time",
    "room": "Room",
    "roomNotSpecified": "Not specified",
    "deadline": "Respond before {dateTime}",
    "timeZone": "Thailand time (Asia/Bangkok)",
    "accept": "Confirm attendance",
    "decline": "Decline invitation",
    "submitting": "Saving your response…",
    "accepted": "Your attendance is confirmed",
    "declined": "You declined this invitation",
    "expired": "The response deadline has passed",
    "unavailable": "This invitation is unavailable. Please contact the organizer.",
    "invalid": "The invitation link is invalid or its token is missing.",
    "recordedAt": "Response recorded at {dateTime}",
    "finalNotice": "Your submitted response is final. Contact the organizer if a correction is needed.",
    "networkError": "Unable to connect. Please check your response status again.",
    "serverError": "The system is unavailable. Please check your response status again.",
    "rateLimited": "Too many requests. Please wait before checking your response status again.",
    "answerConflict": "A response has already been recorded. Checking the latest result.",
    "retry": "Check status again",
    "home": "Back to home"
  }
}
```

Use optional greeting only if recipientFirstName exists. Network/server/rate-limit errors display the specified message without raw server stack or token. Home navigation strips the token. Both locales display session names from API verbatim.
- [ ] Add P02 complete predicate and use it only at GlobalRefreshRedirect reload condition; do not alter home animation behavior:

```ts
export function shouldRedirectReload(pathname:string):boolean {
  const normalized=pathname.replace(/^\/(th|en)(?=\/|$)/,'').replace(/\/$/,'') || '/';
  return normalized !== '/' && normalized !== '/sessions/confirm';
}
```

- [ ] Predicate tests cover /, /th, /en/, both localized confirmation paths and trailing slash -> false; ordinary profile route -> true. P08 currently calls router.replace(pathname,{locale:newLocale}) and drops the query. Add a narrow /sessions/confirm branch that carries the existing search query through locale replacement; leave normal links unchanged. Include /sessions/confirm in its existing isLightPage predicate so controls remain readable on the page background. Do not propagate invitation tokens to other destinations.
- [ ] Merge next.config.ts headers() returning response route pattern /:locale(th|en)/sessions/confirm with Referrer-Policy:no-referrer and Cache-Control:no-store; retain current withNextIntl wrapper. Avoid widening route matcher to every page.
- [ ] Ensure existing REGISTRATION_OPEN or auth gates never hide this page. No token in localStorage/AuthContext/error telemetry; remove token from outgoing links and browser-generated referrers by header policy.
- [ ] GREEN helper tests, PRIS build/lint, then full browser verification direct link/reload/language switch/mobile/keyboard/network interruption. Commit in PRIS: feat: add session invitation response page.

## T11 — Complete regression, configuration rehearsal, and operator instructions

**Files:** A25/A27/A28/A24; add test-only target configuration script only if existing fixture setup cannot cover it. Evidence under docs/superpowers/verification/admin-session-invitations/ when execution occurs.

**Consumes:** every preceding deliverable. **Produces:** green combined suites, target session enable rehearsal and fail-closed rollback evidence. Gates OPS-01..07/E2E-01..06.

- [ ] Update fake fixtures with future-start gated session capacity 50, unconfigured legacy session, boundary/inactive cases, known-user sibling registrations, 49/50/over-capacity cases, and synthetic Admin/organizer. Snapshot baseline counts and original ticket/check-in metadata.
- [ ] Add scripts test:session-invitations (explicit unit/routes/template files) and test:session-invitations:integration (explicit migration preparation then serialized integration files), retaining old test scripts and their execution order.
- [ ] Within Docker rehearse target activation using event_code/session_code resolution with a DO block that requires exactly one session. Check stored maxCapacity 50/date interpretation/current counts first. Do not update room/date/capacity through this feature. Do not run this SQL on production in implementation work.

Use the following complete activation statement against the dedicated synthetic runtime database only after timestamp, configuration, and writer gates pass. The synthetic fixture for this rehearsal deliberately uses PRIS-2026/POLICY-INNOVATION codes while all names/recipients are synthetic:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$
DECLARE target_id integer; target_count integer; configured_capacity integer; actual_count integer;
BEGIN
  SELECT count(*),min(s.id) INTO target_count,target_id
  FROM sessions s JOIN events e ON e.id=s.event_id
  WHERE e.event_code='PRIS-2026' AND s.session_code='POLICY-INNOVATION';
  IF target_count<>1 THEN RAISE EXCEPTION 'Expected exactly one invitation session'; END IF;
  SELECT max_capacity INTO configured_capacity FROM sessions WHERE id=target_id FOR UPDATE;
  IF configured_capacity<>50 OR configured_capacity IS NULL THEN
    RAISE EXCEPTION 'Invitation session capacity must remain 50';
  END IF;
  SELECT count(*) INTO actual_count FROM registration_sessions rs
  JOIN registrations r ON r.id=rs.registration_id
  WHERE rs.session_id=target_id AND r.status='confirmed';
  IF actual_count>configured_capacity THEN RAISE EXCEPTION 'Existing access exceeds capacity'; END IF;
  UPDATE sessions SET admin_grant_requires_confirmation=true WHERE id=target_id;
END $$;
COMMIT;
```

This SQL intentionally does not decide whether a paid reference is acceptable, validate network settings, or reinterpret timestamps; those are explicit readiness prerequisites. It is not a production command to run during plan execution.
- [ ] Disable new creation through existing ADMIN_SESSION_GRANTS_ENABLED=false; prove already-issued links still GET/PUT. Do not clear adminGrantRequiresConfirmation as rollback: old immediate grant fallback must fail closed with outstanding invitations.
- [ ] Prove config key continuity across process restart, missing key produces safe mail failure without losing invitation, frontend origin/CORS ready, encryption key never enters Next public env, and old queued session-grant-v1 mail still renders.
- [ ] Verify after acceptance conference-web existing actual entitlement reader sees Admin access; no WEB feature/UI change. Paid ticket amounts/Orders/Payments baseline unchanged.
- [ ] Run final comprehensive verification command sequence from paired file once after the last feature change. Earlier per-task passes alone do not constitute final readiness.
- [ ] Record issues as FAILED/BLOCKED with gate/task and exact revision, not skipped/pass. Resolve in owning task and rerun the smallest impacted set, plus comprehensive set if code changed after final run.
- [ ] Commit execution evidence/test harness updates per changed repo, using descriptive title/body. No push or production rollout.

## T12 — Independent final review and handoff

**Files:** review document and generated verification evidence; inspect all feature diffs. **Consumes:** T11 outputs. **Produces:** final readiness report and explicit remaining actions. Gates REVIEW-01..05.

- [ ] Reviewer applies the second file's migration/transaction/security/UI/worker checklists before reading summarized test results.
- [ ] Cross-reference every approved design section using section 15's traceability in the review file. Verify implemented behavior, not only test names.
- [ ] Inspect source and untracked files for secrets/temporary token captures/unrelated changes. Confirm docs don't falsely report production migration or email delivery.
- [ ] Report passed gates, failures/blockers, residual provider tracking/deployment constraints, revisions, and evidence links. Include exact target activation/rollback readiness and expiry boundary.
- [ ] Stop after the verified feature is ready for authorized deployment. No automatic production flag activation, mail to real people, payment calls, PR creation, or push is implied.

## 3. Execution stop conditions and task checkpoints

| Condition | Required handling |
| --- | --- |
| User still requests documents only | Write/review the two plan files; do not run task code/tests/setup |
| Docker unavailable / dependency download denied | Record blocked verification; obtain required tool permission; never silently use host runners |
| Production URL/credential detected in test env | Stop before opening connections/sending anything, correct test configuration |
| Unknown migration/check name or timestamp mapping | Inspect existing schema/convention and resolve narrowly with evidence before advancing |
| Existing paid snapshot references target session | Preserve financial reconciliation and surface a readiness conflict; do not change payment policy silently |
| Inconsistent same-user history or entitlement audit linkage | Do not overwrite source/ticket/check-in; reconcile exact pair as T05 specifies, flag different-registration conflict |
| Key loss/rotation while outstanding invitations exist | Keep hashes/reservations/history; don't replace key or reset deadlines; recover key or perform reviewed payload migration |
| Failed gate after feature edit | Fix smallest responsible layer; repeat affected gates; no pass based on earlier revision |
| Scope changes into cancellation/reminders/payment redesign | Keep out of this plan unless user authorizes changed requirements |

Each task checkpoint records task ID, changed files, command, exact commit(s), gate IDs, pass/fail/blocker and evidence. Tasks are not complete based only on lint or screenshots.

## 4. Planning self-review record

- Approved architecture A, reservation timing, and deadline-to-session-start are carried into T03/T04/T05/T10.
- One table, existing queue, no extra runtime/framework dependencies; standalone helpers are limited to policy/crypto/frontend API/navigation.
- Every named interface has an owner task; public/body/wire names match across API/BO/PRIS.
- Deferred production activity and later-created test files are explicitly distinguished from work already done.
- Independent verification covers all design acceptance cases, including races, unknown mail outcomes, deadline boundary, bypasses, existing metadata, and refresh/locale behavior.
- Two design details are made concrete without changing the goal: exact-pair audit-link reconciliation does not violate the existing unique item link; error normalization commits before surfacing a conflict so seat release is not rolled back.
- The implementation task checkboxes remain unchecked until separately authorized execution.
