# Admin Session Grant Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Admin a searchable tracking page for recorded immediate session grants and invitations, with independent response/mail states and safe per-item email retry.

**Architecture:** Add a read-only endpoint in the existing session-grants module. A focused Drizzle reader filters effective invitation states and computes rows/counts in a read-only repeatable-read transaction. Backoffice uses existing auth, layout, pagination, attempts, retry, and feature-status APIs.

**Tech Stack:** Existing TypeScript, Fastify, Zod, Drizzle/PostgreSQL, node:test/assert, Next.js/React and Tailwind; no new dependencies.

## Global Constraints

- Approved spec: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-09-admin-session-grant-tracking-design.md`, approved on 2026-10-09 (Asia/Bangkok).
- Use the existing grant batches, grant items, invitations, entitlements, and email attempts.
- No new tables, dependencies, queue, worker, provider integration, or participant response page are required.
- One row represents one `registration_session_grant_items.id`.
- Counts represent operation records, not unique people or occupied seats.
- Reading the tracking page must not normalize invitation records, release seats through writes, queue email, or otherwise mutate data.
- Filtering and summary counts use effective status, not only the stored pending/expired value.
- Determine whether a historical operation required acceptance from its `outcome`, not the session's current `adminGrantRequiresConfirmation` setting.
- Tracking remains readable when the switch is off, while retry is disabled.
- Retry queues the same item's email. It does not create access, another invitation, a new token, or a new deadline.
- Integration checks use fake mail, never live recipients or production data.
- Do not modify unrelated local changes in either repository.
- API root: `D:/confer/confer/conference/conference-api`; Backoffice root: `D:/confer/confer/conference/conference-backoffice`. These are separate Git repositories. Commit only task files in their own repository.
- Initial API working tree contains an unrelated modification to `src/modules/presentations/data/approvedRound2Abstracts.ts`; preserve it.

## Execution boundary and file map

This document contains implementation instructions and code; application files have not been changed. Execute Tasks 1 through 4 in order. The current skill catalog does not list the two superpowers execution skills in the required header; check for them at execution time and follow the user's selected execution method and available tools. Do not silently spawn agents before the user selects delegation.

| Task | Files | Purpose |
| --- | --- | --- |
| 1 | API `schemas.ts`, `types.ts`, new `tracking.ts`, new `tracking-schemas.test.ts`, new `tracking.integration.test.ts` | Validated contract and consistent database reader |
| 2 | API `routes.ts`, `package.json`, new `tracking-routes.test.ts` | Additive Admin-only HTTP reader and focused test script coverage |
| 3 | Backoffice `types/session-grants.ts`, `lib/api.ts`, new `lib/session-grant-tracking.ts`, new matching test, new `app/session-grants/page.tsx`, `components/layout/Sidebar.tsx` | Tracking view and existing email actions |
| 4 | API verification document | Focused regression and browser evidence, rollout |

All API module paths below are under `src/modules/session-grants/`. All commands explicitly set the relevant working directory. Run commands individually and inspect each exit status; stop on an unexpected failure rather than relying on the last command's exit code. Initial red-test failures are intentional only where identified. No feature flag is enabled on a live deployment by this plan.

## Task 1: Tracking query, DTO and read-only reader

**Files:**
- Modify: `D:/confer/confer/conference/conference-api/src/modules/session-grants/schemas.ts`
- Modify: `D:/confer/confer/conference/conference-api/src/modules/session-grants/types.ts`
- Create: `D:/confer/confer/conference/conference-api/src/modules/session-grants/tracking.ts`
- Create: `D:/confer/confer/conference/conference-api/src/modules/session-grants/tracking-schemas.test.ts`
- Create: `D:/confer/confer/conference/conference-api/src/modules/session-grants/tracking.integration.test.ts`

**Interfaces:**
- Consumes: existing database schema, `GrantDatabase`, `GrantItemDto`, `GrantBatchDto`, `GrantOutcome`, `EmailStatus`, `InvitationStatus`, `effectiveInvitationStatus`, and `effectiveDeadline`.
- Produces: `trackingQuerySchema`, `GrantTrackingQuery`, `GrantTrackingItemDto`, `GrantTrackingDto`, and `getGrantTracking(database: GrantDatabase, query: GrantTrackingQuery): Promise<GrantTrackingDto>`.
- `GrantTrackingItemDto` reuses the item fields other than the internal entitlement link. The existing item/batch/history DTOs do not change.

- [ ] **Step 1: Create the query contract test before adding the exports.**

`tracking-schemas.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { trackingQuerySchema } from "./schemas.js";

test("tracking query defaults, coercion, trimming and strict boundaries", () => {
  assert.deepEqual(trackingQuerySchema.parse({}), { page: 1, limit: 50 });
  assert.deepEqual(trackingQuerySchema.parse({
    eventId: "4", sessionId: "8", page: "2", limit: "100",
    outcome: "invited", responseStatus: "pending", emailStatus: "unknown",
    search: "  คน A  ",
  }), {
    eventId: 4, sessionId: 8, page: 2, limit: 100,
    outcome: "invited", responseStatus: "pending", emailStatus: "unknown",
    search: "คน A",
  });
  for (const query of [
    { eventId: 0 }, { sessionId: -1 }, { eventId: 1.5 },
    { page: 0 }, { page: 1.5 }, { limit: 101 },
    { outcome: "accepted" }, { responseStatus: "sent" },
    { emailStatus: "delivered" }, { search: "x".repeat(201) },
    { token: "must-not-be-a-query-option" },
  ]) assert.equal(trackingQuerySchema.safeParse(query).success, false);
  assert.equal(trackingQuerySchema.parse({ responseStatus: "not_required" }).responseStatus, "not_required");
});
```

- [ ] **Step 2: Verify the focused test fails because the export does not exist.**

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
& .\node_modules\.bin\tsx.cmd --test src/modules/session-grants/tracking-schemas.test.ts
```

Expected: missing `trackingQuerySchema` export. Do not treat missing installed tools as a valid red test.

- [ ] **Step 3: Append the query schema and additive DTOs.**

Append to `schemas.ts`:

```ts
export const trackingQuerySchema = resultQuerySchema.extend({
  eventId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  sessionId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  outcome: z.enum(["added", "invited", "skipped"]).optional(),
  responseStatus: z.enum([
    "not_required", "pending", "accepted", "declined", "expired", "revoked",
  ]).optional(),
  emailStatus: z.enum([
    "not_applicable", "pending", "sending", "sent", "failed", "unknown", "suppressed",
  ]).optional(),
  search: z.string().trim().max(200).optional(),
}).strict();
```

Append to `types.ts`:

```ts
export interface GrantTrackingQuery {
  page: number;
  limit: number;
  eventId?: number;
  sessionId?: number;
  outcome?: GrantOutcome;
  responseStatus?: "not_required" | InvitationStatus;
  emailStatus?: EmailStatus;
  search?: string;
}

export interface GrantTrackingItemDto extends Omit<GrantItemDto, "registrationSessionId"> {
  batchId: string;
  eventId: number;
  sessionId: number;
  sessionName: string;
  actorName: string;
  createdAt: string;
  recipientEmail: string | null;
  sentAt: string | null;
  lastAttemptAt: string | null;
}

export interface GrantTrackingDto {
  items: GrantTrackingItemDto[];
  pagination: GrantBatchDto["pagination"];
  summary: {
    total: number;
    outcomeCounts: Record<GrantOutcome, number>;
    invitationCounts: Record<InvitationStatus, number>;
    emailCounts: Record<EmailStatus, number>;
  };
}
```

- [ ] **Step 4: Create the isolated database test shown after the reader below, then run it red with the harness commands in Step 6.**

Expected before implementation: missing `tracking.ts`. The test deliberately uses direct fixtures and never invokes a mail transport.

- [ ] **Step 5: Create `src/modules/session-grants/tracking.ts` with the following complete reader.**

```ts
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  registrationSessionGrantBatches as batches,
  registrationSessionGrantItems as items,
  registrations,
  sessionInvitations as invitations,
  sessions,
} from "../../database/schema.js";
import { effectiveDeadline, effectiveInvitationStatus } from "./invitation-policy.js";
import type {
  EmailStatus, GrantDatabase, GrantOutcome, GrantTrackingDto,
  GrantTrackingQuery, InvitationStatus,
} from "./types.js";

export async function getGrantTracking(
  database: GrantDatabase,
  query: GrantTrackingQuery,
): Promise<GrantTrackingDto> {
  return database.transaction(async (tx) => {
    const [clock] = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
    const now = clock.now instanceof Date ? clock.now : new Date(clock.now);
    const start = sql<Date>`(${sessions.startTime} AT TIME ZONE 'UTC')`
      .mapWith((value: string) => new Date(value));
    // SQL filtering mirrors invitation-policy; the integration test checks their parity.
    const effectiveStatus = sql<InvitationStatus | null>`CASE
      WHEN ${invitations.id} IS NULL THEN NULL
      WHEN ${invitations.status} <> 'pending' THEN ${invitations.status}
      WHEN ${sessions.isActive} IS NOT TRUE
        OR ${registrations.status} IS DISTINCT FROM 'confirmed'
        OR ${registrations.eventId} IS DISTINCT FROM ${sessions.eventId} THEN 'revoked'
      WHEN ${now.toISOString()}::timestamptz >= LEAST(${invitations.expiresAt}, ${start}) THEN 'expired'
      ELSE 'pending' END`;
    const source = tx.$with("grant_tracking_source").as(tx.select({
      id: items.id, batchId: items.batchId,
      registrationId: items.requestedRegistrationId,
      regCode: items.regCodeSnapshot, name: items.nameSnapshot,
      recipientEmail: items.recipientEmailSnapshot,
      eventId: batches.eventId, sessionId: batches.sessionId,
      sessionName: batches.sessionNameSnapshot, actorName: batches.actorNameSnapshot,
      createdAt: batches.createdAt,
      outcome: items.outcome, reasonCode: items.reasonCode,
      emailStatus: items.emailStatus, attemptCount: items.attemptCount,
      lastErrorCode: items.lastErrorCode, sentAt: items.sentAt,
      lastAttemptAt: items.lastAttemptAt,
      invitationId: sql<string | null>`${invitations.id}`.as("invitation_id"),
      invitationStoredStatus: sql<InvitationStatus | null>`${invitations.status}`.as("invitation_stored_status"),
      invitationExpiresAt: invitations.expiresAt,
      invitationRespondedAt: invitations.respondedAt,
      invitationEffectiveStatus: effectiveStatus.as("invitation_effective_status"),
      sessionStartTime: start.as("session_start_time"),
      sessionIsActive: sessions.isActive,
      sessionEventId: sql<number>`${sessions.eventId}`.as("session_event_id"),
      registrationStatus: sql<string | null>`${registrations.status}`.as("registration_status"),
      registrationEventId: sql<number | null>`${registrations.eventId}`.as("registration_event_id"),
    }).from(items)
      .innerJoin(batches, eq(items.batchId, batches.id))
      .innerJoin(sessions, eq(batches.sessionId, sessions.id))
      .leftJoin(invitations, eq(invitations.grantItemId, items.id))
      .leftJoin(registrations, eq(invitations.registrationId, registrations.id)));

    const filters: SQL[] = [];
    if (query.eventId !== undefined) filters.push(eq(source.eventId, query.eventId));
    if (query.sessionId !== undefined) filters.push(eq(source.sessionId, query.sessionId));
    if (query.outcome) filters.push(eq(source.outcome, query.outcome));
    if (query.emailStatus) filters.push(eq(source.emailStatus, query.emailStatus));
    if (query.responseStatus === "not_required") filters.push(eq(source.outcome, "added"));
    else if (query.responseStatus) filters.push(eq(source.invitationEffectiveStatus, query.responseStatus));
    if (query.search) {
      const pattern = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      filters.push(or(ilike(source.name, pattern), ilike(source.regCode, pattern), ilike(source.recipientEmail, pattern))!);
    }
    const where = and(...filters);
    const groups = await tx.with(source).select({
      outcome: source.outcome,
      emailStatus: source.emailStatus,
      invitationStatus: source.invitationEffectiveStatus,
      total: count(),
    }).from(source).where(where)
      .groupBy(source.outcome, source.emailStatus, source.invitationEffectiveStatus);
    const rows = await tx.with(source).select().from(source).where(where)
      .orderBy(desc(source.createdAt), desc(source.id))
      .limit(query.limit).offset((query.page - 1) * query.limit);
    const summary: GrantTrackingDto["summary"] = {
      total: 0,
      outcomeCounts: { added: 0, invited: 0, skipped: 0 },
      invitationCounts: { pending: 0, accepted: 0, declined: 0, expired: 0, revoked: 0 },
      emailCounts: { not_applicable: 0, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 },
    };
    for (const group of groups) {
      summary.total += group.total;
      summary.outcomeCounts[group.outcome as GrantOutcome] += group.total;
      summary.emailCounts[group.emailStatus as EmailStatus] += group.total;
      if (group.invitationStatus) summary.invitationCounts[group.invitationStatus] += group.total;
    }
    return {
      items: rows.map((row) => ({
        id: row.id, batchId: row.batchId, registrationId: row.registrationId,
        regCode: row.regCode, name: row.name, recipientEmail: row.recipientEmail,
        eventId: row.eventId, sessionId: row.sessionId, sessionName: row.sessionName,
        actorName: row.actorName, createdAt: row.createdAt.toISOString(),
        outcome: row.outcome as GrantOutcome,
        reasonCode: row.reasonCode as GrantTrackingDto["items"][number]["reasonCode"],
        emailStatus: row.emailStatus as EmailStatus, attemptCount: row.attemptCount,
        lastErrorCode: row.lastErrorCode,
        sentAt: row.sentAt?.toISOString() ?? null,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        invitation: row.invitationId && row.invitationStoredStatus && row.invitationExpiresAt ? {
          invitationId: row.invitationId,
          invitationStatus: effectiveInvitationStatus({
            status: row.invitationStoredStatus as InvitationStatus,
            expiresAt: row.invitationExpiresAt, startTime: row.sessionStartTime,
            isActive: row.sessionIsActive === true,
            registrationConfirmed: row.registrationStatus === "confirmed",
            eventMatches: row.registrationEventId === row.sessionEventId,
          }, now),
          expiresAt: row.invitationExpiresAt.toISOString(),
          effectiveDeadline: effectiveDeadline(row.invitationExpiresAt, row.sessionStartTime).toISOString(),
          respondedAt: row.invitationRespondedAt?.toISOString() ?? null,
        } : null,
      })),
      summary,
      pagination: {
        page: query.page, limit: query.limit, total: summary.total,
        totalPages: summary.total === 0 ? 0 : Math.ceil(summary.total / query.limit),
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
```

`tracking.integration.test.ts`:

```ts
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { getGrantTracking } from "./tracking.js";
import { retryGrantEmails } from "./email-jobs.js";
import { openSessionGrantTestDatabase } from "./test-database.js";
import type { EmailStatus, GrantDatabase, GrantOutcome, GrantTrackingQuery } from "./types.js";

test("tracking filters effective states, preserves history and never writes on GET", { timeout: 90_000 }, async (t) => {
  const client = openSessionGrantTestDatabase();
  const database = drizzle(client, { schema }) as GrantDatabase;
  const suffix = randomUUID().slice(0, 8);
  let eventId: number | undefined;
  let actorId: number | undefined;
  t.after(async () => {
    try {
      if (eventId !== undefined) {
        await client`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN
          (SELECT i.id FROM registration_session_grant_items i JOIN registration_session_grant_batches b ON b.id=i.batch_id WHERE b.event_id=${eventId})`;
        await client`DELETE FROM session_invitations WHERE session_id IN (SELECT id FROM sessions WHERE event_id=${eventId})`;
        await client`DELETE FROM registration_session_grant_items WHERE batch_id IN (SELECT id FROM registration_session_grant_batches WHERE event_id=${eventId})`;
        await client`DELETE FROM registration_session_grant_batches WHERE event_id=${eventId}`;
        await client`DELETE FROM registration_sessions WHERE registration_id IN (SELECT id FROM registrations WHERE event_id=${eventId})`;
        await client`DELETE FROM registrations WHERE event_id=${eventId}`;
        await client`DELETE FROM ticket_types WHERE event_id=${eventId}`;
        await client`DELETE FROM sessions WHERE event_id=${eventId}`;
        await client`DELETE FROM events WHERE id=${eventId}`;
      }
      if (actorId !== undefined) await client`DELETE FROM backoffice_users WHERE id=${actorId}`;
    } finally { await client.end({ timeout: 2 }); }
  });
  const [actor] = await client`INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
    VALUES (${`tracking-${suffix}@example.invalid`},'test-hash','admin','Tracking','Admin') RETURNING id`;
  actorId = actor.id;
  const [event] = await client`INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
    VALUES (${`TRACK-${suffix}`},'Tracking Test','multi_session','2026-01-01','2099-12-31','published') RETURNING id`;
  eventId = event.id;
  const [session] = await client`INSERT INTO sessions (event_id,session_code,session_name,start_time,end_time,is_active)
    VALUES (${event.id},${`S-${suffix}`},'Saved Session','2099-01-01','2099-01-02',true) RETURNING id`;
  const [ticket] = await client`INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
    VALUES (${event.id},'primary','regular','Test Ticket',0,'THB',200) RETURNING id`;
  const [registration] = await client`INSERT INTO registrations (reg_code,event_id,ticket_type_id,email,first_name,last_name,status)
    VALUES (${`REG-${suffix}`},${event.id},${ticket.id},'edited@example.invalid','Live','Name','confirmed') RETURNING id`;
  const [entitlement] = await client`INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source,added_by)
    VALUES (${registration.id},${session.id},NULL,'admin_grant',${actor.id}) RETURNING id`;
  const batchId = randomUUID();
  await client`INSERT INTO registration_session_grant_batches
    (id,actor_id,actor_name_snapshot,idempotency_key,request_hash,session_id,event_id,session_name_snapshot,requested_count)
    VALUES (${batchId},${actor.id},'Saved Admin',${randomUUID()},${'a'.repeat(64)},${session.id},${event.id},'Saved Session',109)`;
  const insertItem = async (index: number, outcome: GrantOutcome, emailStatus: EmailStatus, name = `Person ${index}`) => {
    const id = randomUUID();
    await client`INSERT INTO registration_session_grant_items
      (id,batch_id,requested_registration_id,reg_code_snapshot,name_snapshot,outcome,reason_code,recipient_email_snapshot,email_status,sent_at)
      VALUES (${id},${batchId},${index === 0 ? registration.id : 1_900_000_000 + index},${`CODE-${index}`},${name},${outcome},
        ${outcome === 'skipped' ? 'REGISTRATION_NOT_FOUND' : null},'saved@example.invalid',${emailStatus},
        CASE WHEN ${emailStatus}='sent' THEN clock_timestamp() ELSE NULL END)`;
    return id;
  };
  const immediate = await insertItem(0, 'added', 'failed', "Only Snapshot %_\\ O'Connor");
  await client`UPDATE registration_session_grant_items SET registration_session_id=${entitlement.id},attempt_count=2 WHERE id=${immediate}`;
  for (let index = 1; index < 105; index++) await insertItem(index, 'added', 'sent');
  const pending = await insertItem(105, 'invited', 'unknown');
  const closed = await insertItem(106, 'invited', 'failed');
  await insertItem(107, 'skipped', 'not_applicable');
  const missingInvitation = await insertItem(108, 'invited', 'failed');
  const envelope = JSON.stringify({ version: 1, nonce: 'test-nonce', tag: 'test-tag', ciphertext: 'test-ciphertext' });
  await client`INSERT INTO session_invitations
    (id,registration_id,session_id,grant_item_id,status,token_hash,token_ciphertext,expires_at,created_by)
    VALUES (${randomUUID()},${registration.id},${session.id},${pending},'pending',${createHash('sha256').update(randomUUID()).digest('hex')},${envelope}::jsonb,'2099-01-01',${actor.id})`;
  await client`INSERT INTO session_invitations
    (id,registration_id,session_id,grant_item_id,status,token_hash,expires_at,responded_at,closed_at,created_by)
    VALUES (${randomUUID()},${registration.id},${session.id},${closed},'declined',${createHash('sha256').update(randomUUID()).digest('hex')},'2099-01-01',clock_timestamp(),clock_timestamp(),${actor.id})`;
  for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
    await client`INSERT INTO registration_session_grant_email_attempts
      (id,item_id,attempt_no,claim_token,trigger,recipient_email,template_version,subject_snapshot,result)
      VALUES (${randomUUID()},${immediate},${attemptNo},${randomUUID()},'system','saved@example.invalid','session-grant-v1','Saved Subject','failed')`;
  }
  const read = (extra: Partial<GrantTrackingQuery> = {}) =>
    getGrantTracking(database, { page: 1, limit: 100, eventId: event.id, ...extra });
  const audit = async () => JSON.stringify(await client`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM registration_session_grant_items i WHERE i.batch_id=${batchId}) AS items,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM session_invitations v WHERE v.session_id=${session.id}) AS invitations`);
  const before = await audit();
  const first = await read();
  const second = await read({ page: 2 });
  assert.equal(first.summary.total, 109);
  assert.deepEqual(first.summary.outcomeCounts, { added: 105, invited: 3, skipped: 1 });
  assert.deepEqual(first.summary.invitationCounts, { pending: 1, accepted: 0, declined: 1, expired: 0, revoked: 0 });
  assert.equal(first.items.length, 100);
  assert.equal(second.items.length, 9);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 109);
  assert.deepEqual(first.summary, second.summary);
  const snapshot = await read({ search: 'only snapshot' });
  assert.equal(snapshot.items[0]?.recipientEmail, 'saved@example.invalid');
  assert.equal(snapshot.items[0]?.actorName, 'Saved Admin');
  assert.equal(snapshot.summary.total, 1);
  for (const search of ['%', '_', '\\', "O'Connor"]) assert.equal((await read({ search })).summary.total, 1);
  assert.equal((await read({ search: 'edited@example.invalid' })).summary.total, 0);
  assert.equal((await read({ responseStatus: 'not_required' })).summary.total, 105);
  assert.equal((await read({ sessionId: session.id, responseStatus: 'pending', emailStatus: 'unknown' })).summary.total, 1);
  assert.equal((await read({ sessionId: 2_147_483_647 })).pagination.totalPages, 0);
  assert.equal((await read({ eventId: 2_147_483_647, sessionId: session.id })).summary.total, 0);
  assert.equal((await read({ outcome: 'invited' })).items.find(row => row.id === missingInvitation)?.invitation, null);
  assert.equal(await audit(), before);
  const encoded = JSON.stringify(first);
  for (const secret of ['tokenHash', 'tokenCiphertext', 'notificationSnapshot', 'test-ciphertext']) assert.equal(encoded.includes(secret), false);

  await client`UPDATE sessions SET start_time=clock_timestamp() AT TIME ZONE 'UTC' WHERE id=${session.id}`;
  assert.equal((await read({ responseStatus: 'pending' })).summary.total, 0);
  assert.equal((await read({ responseStatus: 'expired' })).items[0]?.invitation?.invitationStatus, 'expired');
  const [stored] = await client`SELECT status FROM session_invitations WHERE grant_item_id=${pending}`;
  assert.equal(stored.status, 'pending');
  await client`UPDATE sessions SET start_time='2099-01-01',is_active=false WHERE id=${session.id}`;
  assert.equal((await read({ responseStatus: 'revoked' })).summary.total, 1);
  await client`UPDATE sessions SET is_active=true WHERE id=${session.id}`;
  await client`UPDATE registrations SET status='cancelled' WHERE id=${registration.id}`;
  assert.equal((await read({ responseStatus: 'revoked' })).summary.total, 1);
  await client`UPDATE registrations SET status='confirmed' WHERE id=${registration.id}`;
  await client`UPDATE session_invitations SET status='accepted' WHERE grant_item_id=${closed}`;
  assert.equal((await read({ responseStatus: 'accepted' })).items[0]?.outcome, 'invited');
  await client`UPDATE session_invitations SET expires_at=clock_timestamp() WHERE grant_item_id=${pending}`;
  assert.equal((await read({ responseStatus: 'expired' })).summary.total, 1);
  await client`UPDATE session_invitations SET expires_at='2099-01-01' WHERE grant_item_id=${pending}`;
  const invitationAudit = JSON.stringify(await client`SELECT * FROM session_invitations WHERE session_id=${session.id} ORDER BY id`);
  assert.deepEqual((await retryGrantEmails(database, { actorId: actor.id, batchId, itemIds: [pending], acknowledgeUnknown: false })).skipped,
    [{ itemId: pending, reasonCode: 'UNKNOWN_ACK_REQUIRED' }]);
  const retried = await retryGrantEmails(database, { actorId: actor.id, batchId, itemIds: [immediate, pending], acknowledgeUnknown: true });
  assert.deepEqual(new Set(retried.queued), new Set([immediate, pending]));
  assert.equal(JSON.stringify(await client`SELECT * FROM session_invitations WHERE session_id=${session.id} ORDER BY id`), invitationAudit);
  assert.equal((await client`SELECT count(*)::int AS count FROM registration_sessions WHERE registration_id=${registration.id}`)[0].count, 1);
  assert.deepEqual((await retryGrantEmails(database, { actorId: actor.id, batchId, itemIds: [closed], acknowledgeUnknown: true })).skipped,
    [{ itemId: closed, reasonCode: 'INVITATION_NOT_PENDING' }]);
});
```

- [ ] **Step 6: Run contract and reader tests against a dedicated Compose project.**

The integration harness can reset its guarded test schema. Create a separate project/volume for this feature, and never point these migration tests at the live database. Compose URLs already distinguish runtime and integration databases. The first `createdb` command is for initial setup; if the database exists, verify its exact name and use it without dropping the volume.

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
& .\node_modules\.bin\tsx.cmd --test src/modules/session-grants/tracking-schemas.test.ts
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml up -d --wait postgres
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml exec -T postgres createdb -U session_grants_test confer_session_grants_integration_test
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml run --rm api-tools npm ci
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml run --rm api-tools npx tsx --test src/modules/session-grants/migration.integration.test.ts
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml run --rm api-tools npx tsx --test --test-concurrency=1 src/modules/session-grants/invitation-migration.integration.test.ts
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml run --rm api-tools npx tsx --test src/modules/session-grants/tracking.integration.test.ts
npm run build
```

Expected: all focused tests pass; 109 unique tracking rows; aggregate totals are independent of page; no live mail is sent. If Docker is unavailable, report the integration check as unrun and do not replace the DB guard with a live URL.

- [ ] **Step 7: Commit only the Task 1 files in the API repository.**

```powershell
git add -- src/modules/session-grants/schemas.ts src/modules/session-grants/types.ts src/modules/session-grants/tracking.ts src/modules/session-grants/tracking-schemas.test.ts src/modules/session-grants/tracking.integration.test.ts
git diff --cached --check
git commit --only -m "feat(session-grants): add read-only tracking reader" -- src/modules/session-grants/schemas.ts src/modules/session-grants/types.ts src/modules/session-grants/tracking.ts src/modules/session-grants/tracking-schemas.test.ts src/modules/session-grants/tracking.integration.test.ts
```

## Task 2: Admin-only tracking route

**Files:**
- Modify: `D:/confer/confer/conference/conference-api/src/modules/session-grants/routes.ts`
- Modify: `D:/confer/confer/conference/conference-api/package.json`
- Create: `D:/confer/confer/conference/conference-api/src/modules/session-grants/tracking-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 exports `trackingQuerySchema`, `getGrantTracking` and `GrantTrackingDto`.
- Produces: `GET /api/backoffice/session-grants/tracking`, returning `GrantTrackingDto`, and optional `SessionGrantRouteOptions.getGrantTrackingFn` for the existing route testing pattern.
- Reuses: existing `adminActor`, protected route registration, feature status endpoint and retry route. Do not replace the existing registration history reader.

- [ ] **Step 1: Create this complete route contract test and run it red.**

`tracking-routes.test.ts`:

```ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { closeDatabase } from "../../database/index.js";
import sessionGrantRoutes from "./routes.js";
import type { GrantDatabase, GrantTrackingDto, GrantTrackingQuery } from "./types.js";

test("tracking requires Admin, validates before reading, and remains readable with grants disabled", async (t) => {
  const original = process.env.ADMIN_SESSION_GRANTS_ENABLED;
  process.env.ADMIN_SESSION_GRANTS_ENABLED = "false";
  let calls = 0;
  let failure = false;
  let received: GrantTrackingQuery | undefined;
  const result: GrantTrackingDto = {
    items: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    summary: {
      total: 0, outcomeCounts: { added: 0, invited: 0, skipped: 0 },
      invitationCounts: { pending: 0, accepted: 0, declined: 0, expired: 0, revoked: 0 },
      emailCounts: { not_applicable: 0, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 },
    },
  };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    const role = request.headers["x-test-role"];
    if (typeof role === "string") (request as any).user = { id: 7, role };
  });
  await app.register(sessionGrantRoutes, {
    database: {} as GrantDatabase,
    getGrantTrackingFn: async (_database, query) => {
      calls++; received = query;
      if (failure) throw new Error("must-not-leak-internal-details");
      return result;
    },
  });
  t.after(async () => {
    if (original === undefined) delete process.env.ADMIN_SESSION_GRANTS_ENABLED;
    else process.env.ADMIN_SESSION_GRANTS_ENABLED = original;
    await app.close();
    await closeDatabase();
  });
  assert.equal((await app.inject({ method: "GET", url: "/tracking" })).statusCode, 401);
  for (const role of ["organizer", "reviewer", "staff", "verifier", "team_registration_viewer"]) {
    assert.equal((await app.inject({ method: "GET", url: "/tracking", headers: { "x-test-role": role } })).statusCode, 403);
  }
  assert.equal(calls, 0);
  for (const query of ["limit=101", "responseStatus=sent", "eventId=-1", "sessionId=1.5", "emailStatus=delivered"]) {
    const invalid = await app.inject({ method: "GET", url: `/tracking?${query}`, headers: { "x-test-role": "admin" } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, "INVALID_QUERY");
  }
  assert.equal(calls, 0);
  const response = await app.inject({ method: "GET", url: "/tracking?eventId=4&responseStatus=not_required", headers: { "x-test-role": "admin" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), result);
  assert.deepEqual(received, { page: 1, limit: 50, eventId: 4, responseStatus: "not_required" });
  assert.equal((await app.inject({ method: "POST", url: `/${randomUUID()}/retry`, headers: { "x-test-role": "admin" },
    payload: { itemIds: [randomUUID()], acknowledgeUnknown: true } })).statusCode, 503);
  failure = true;
  const failed = await app.inject({ method: "GET", url: "/tracking", headers: { "x-test-role": "admin" } });
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().code, "SESSION_GRANT_TRACKING_FAILED");
  assert.equal(failed.body.includes("must-not-leak"), false);
});
```

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
$taskOriginalDatabaseUrl = $env:DATABASE_URL
$env:DATABASE_URL = 'postgres://tracking_unit:tracking_unit@127.0.0.1:1/tracking_unit_runtime_test'
& .\node_modules\.bin\tsx.cmd --test src/modules/session-grants/tracking-routes.test.ts
```

Expected before route integration: compile error for missing injectable option or `/tracking` resolves to the UUID reader and returns the wrong status. No DB connection is needed for this stubbed contract test. Restore the original environment value after testing if one existed.

- [ ] **Step 2: Add the route with this exact integration code.**

Add imports to `routes.ts`:

```ts
import { trackingQuerySchema } from "./schemas.js";
import { getGrantTracking } from "./tracking.js";
```

Add this property to `SessionGrantRouteOptions`:

```ts
getGrantTrackingFn?: typeof getGrantTracking;
```

Inside `sessionGrantRoutes`, immediately after the existing dependency assignments, add:

```ts
const getGrantTrackingFn = options.getGrantTrackingFn ?? getGrantTracking;

fastify.get("/tracking", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (!adminActor(request, reply)) return;
  const parsed = trackingQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.status(400).send({ error: "Invalid query", code: "INVALID_QUERY" });
  }
  try {
    return reply.send(await getGrantTrackingFn(database, parsed.data));
  } catch {
    fastify.log.error({ err: "SESSION_GRANT_TRACKING_FAILED" });
    return reply.status(500).send({ error: "Failed to read session grant tracking", code: "SESSION_GRANT_TRACKING_FAILED" });
  }
});
```

Keep this static route explicit before the dynamic `/:batchId` declaration for readability. Existing route prefixes in `src/index.ts` already mount the module; no new router mount is needed.

Replace the following two existing `package.json` script values so the module's focused test commands continue to cover its new behavior. No dependency or lockfile change is needed:

```json
"test:session-grants": "tsx --test src/modules/session-grants/policy.test.ts src/modules/session-grants/schemas.test.ts src/modules/session-grants/routes.test.ts src/modules/session-grants/tracking-schemas.test.ts src/modules/session-grants/tracking-routes.test.ts src/modules/session-grants/email-template.test.ts src/modules/session-grants/email-jobs.test.ts",
"test:session-grants:integration": "tsx --test src/modules/session-grants/migration.integration.test.ts && tsx --test --test-concurrency=1 src/modules/session-grants/invitation-migration.integration.test.ts src/modules/session-grants/invitations.integration.test.ts && tsx --test --test-concurrency=1 src/modules/session-grants/tracking.integration.test.ts src/modules/session-grants/readers.integration.test.ts src/modules/session-grants/service.integration.test.ts src/modules/session-grants/writer-compatibility.integration.test.ts src/modules/session-grants/email-jobs.integration.test.ts"
```

- [ ] **Step 3: Run the new contract test and existing grant/invitation unit suites once.**

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
& .\node_modules\.bin\tsx.cmd --test src/modules/session-grants/tracking-schemas.test.ts src/modules/session-grants/tracking-routes.test.ts
npm run test:session-grants
npm run test:session-invitations
npm run build
$env:DATABASE_URL = $taskOriginalDatabaseUrl
```

Expected: authenticated Admin reads work with the flag off, non-Admins cannot read, invalid parameters never reach the reader, internal failures return the fixed code, and existing UUID batch/retry contracts still pass. The updated module scripts include the new tests in future runs; no new test framework or separate script is introduced.

- [ ] **Step 4: Commit only route work.**

```powershell
git add -- src/modules/session-grants/routes.ts src/modules/session-grants/tracking-routes.test.ts package.json
git diff --cached --check
git commit --only -m "feat(session-grants): expose Admin tracking endpoint" -- src/modules/session-grants/routes.ts src/modules/session-grants/tracking-routes.test.ts package.json
```

## Task 3: Backoffice page and existing email actions

**Files:**
- Modify: `D:/confer/confer/conference/conference-backoffice/src/types/session-grants.ts`
- Modify: `D:/confer/confer/conference/conference-backoffice/src/lib/api.ts`
- Create: `D:/confer/confer/conference/conference-backoffice/src/lib/session-grant-tracking.ts`
- Create: `D:/confer/confer/conference/conference-backoffice/src/lib/session-grant-tracking.test.ts`
- Create: `D:/confer/confer/conference/conference-backoffice/src/app/session-grants/page.tsx`
- Modify: `D:/confer/confer/conference/conference-backoffice/src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: Task 2 `GET /api/backoffice/session-grants/tracking`; existing `api.sessionGrants.status`, `.retry`, `.emailAttempts`; `api.backofficeEvents.list`, `api.sessions.list`; `useAuth`, `AdminLayout`, `Pagination` and AuthGuard.
- Produces: mirrored `GrantTrackingItemDto`/`GrantTrackingDto`, `api.sessionGrants.tracking(token: string, query: string): Promise<GrantTrackingDto>`, and the Admin-only `/session-grants` page.
- Local `sessionGrantRetryDisabledReason(item: GrantTrackingItemDto, enabled: boolean): string | null` handles display eligibility. It never replaces the authoritative retry service's checks.

- [ ] **Step 1: Add the failing frontend boundary/client test.**

`src/lib/session-grant-tracking.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';
import { sessionGrantRetryDisabledReason } from './session-grant-tracking';
import type { GrantTrackingItemDto } from '../types/session-grants';

function row(overrides: Partial<GrantTrackingItemDto> = {}): GrantTrackingItemDto {
  return {
    id: '123e4567-e89b-42d3-a456-426614174001', batchId: '123e4567-e89b-42d3-a456-426614174002',
    registrationId: 3, regCode: 'REG-3', name: 'Test', recipientEmail: 'saved@example.invalid',
    eventId: 4, sessionId: 5, sessionName: 'Session', actorName: 'Admin',
    createdAt: '2026-10-09T00:00:00.000Z', outcome: 'added', reasonCode: null,
    emailStatus: 'failed', attemptCount: 1, lastErrorCode: null, sentAt: null,
    lastAttemptAt: null, invitation: null, ...overrides,
  };
}

test('retry is limited by feature switch, mail state, and invitation state', () => {
  assert.equal(sessionGrantRetryDisabledReason(row(), true), null);
  assert.notEqual(sessionGrantRetryDisabledReason(row(), false), null);
  for (const emailStatus of ['sent', 'pending', 'sending', 'suppressed', 'not_applicable'] as const) {
    assert.notEqual(sessionGrantRetryDisabledReason(row({ emailStatus }), true), null);
  }
  assert.notEqual(sessionGrantRetryDisabledReason(row({ outcome: 'skipped' }), true), null);
  assert.notEqual(sessionGrantRetryDisabledReason(row({ outcome: 'invited' }), true), null);
  for (const invitationStatus of ['pending', 'accepted', 'declined', 'expired', 'revoked'] as const) {
    const item = row({ outcome: 'invited', emailStatus: 'unknown', invitation: {
      invitationId: 'test-invitation', invitationStatus, expiresAt: '2099-01-01T00:00:00.000Z',
      effectiveDeadline: '2099-01-01T00:00:00.000Z', respondedAt: null,
    } });
    assert.equal(sessionGrantRetryDisabledReason(item, true) === null, invitationStatus === 'pending');
  }
});

test('tracking, attempts and retry preserve the existing HTTP contracts', async (t) => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input); requests.push({ url, options });
    const body = url.includes('/retry') ? { queued: ['item'], skipped: [] }
      : url.includes('/email-attempts') ? { attempts: [], pagination: { page: 2, limit: 50, total: 0, totalPages: 0 } }
      : { items: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }, summary: {
        total: 0, outcomeCounts: { added: 0, invited: 0, skipped: 0 },
        invitationCounts: { pending: 0, accepted: 0, declined: 0, expired: 0, revoked: 0 },
        emailCounts: { not_applicable: 0, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 },
      } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  await api.sessionGrants.tracking('test-token', 'eventId=4&responseStatus=pending');
  await api.sessionGrants.retry('test-token', 'batch', ['item'], true);
  await api.sessionGrants.emailAttempts('test-token', 'batch', 'item', 2, 50);
  assert.ok(requests[0].url.endsWith('/api/backoffice/session-grants/tracking?eventId=4&responseStatus=pending'));
  assert.equal(new Headers(requests[0].options?.headers).get('Authorization'), 'Bearer test-token');
  assert.equal(requests[1].options?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1].options?.body)), { itemIds: ['item'], acknowledgeUnknown: true });
  assert.ok(requests[2].url.endsWith('/batch/items/item/email-attempts?page=2&limit=50'));
});
```

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-backoffice'
& ..\conference-api\node_modules\.bin\tsx.cmd --test src/lib/session-grant-tracking.test.ts
```

Expected before implementation: missing helper/client export. Use the installed sibling API's tsx binary; no test dependency is added to Backoffice.

- [ ] **Step 2: Add mirrored types and one API client method.**

Append to `src/types/session-grants.ts`:

```ts
export interface GrantTrackingItemDto extends Omit<SessionGrantItemDto, 'registrationSessionId'> {
  batchId: string;
  eventId: number;
  sessionId: number;
  sessionName: string;
  actorName: string;
  createdAt: string;
  recipientEmail: string | null;
  sentAt: string | null;
  lastAttemptAt: string | null;
}

export interface GrantTrackingDto {
  items: GrantTrackingItemDto[];
  pagination: SessionGrantPagination;
  summary: {
    total: number;
    outcomeCounts: Record<GrantOutcome, number>;
    invitationCounts: Record<InvitationStatus, number>;
    emailCounts: Record<SessionGrantEmailStatus, number>;
  };
}
```

Add `GrantTrackingDto` to the existing type import from `@/types/session-grants` in `src/lib/api.ts`. Add this method inside the existing `sessionGrants` object, leaving its other methods intact:

```ts
tracking: (token: string, query: string) =>
  fetchAPI<GrantTrackingDto>(
    `/api/backoffice/session-grants/tracking${query ? `?${query}` : ''}`,
    { token },
  ),
```

- [ ] **Step 3: Create the page's small state/label helper.**

`src/lib/session-grant-tracking.ts`:

```ts
import type { GrantOutcome, GrantTrackingItemDto, InvitationStatus, SessionGrantEmailStatus } from '../types/session-grants';

export const outcomeLabels: Record<GrantOutcome, string> = { added: 'เพิ่มสิทธิ์แล้ว', invited: 'สร้างคำเชิญแล้ว', skipped: 'ข้าม' };
export const invitationLabels: Record<InvitationStatus, string> = {
  pending: 'รอตอบรับ', accepted: 'ยืนยันเข้าร่วม', declined: 'ปฏิเสธ', expired: 'หมดเวลา', revoked: 'ใช้คำเชิญไม่ได้',
};
export const emailLabels: Record<SessionGrantEmailStatus, string> = {
  not_applicable: 'ไม่เกี่ยวข้อง', pending: 'รอส่ง', sending: 'กำลังส่ง', sent: 'ส่งแล้ว',
  failed: 'ส่งไม่สำเร็จ', unknown: 'ไม่ทราบผล', suppressed: 'ระงับการส่ง',
};

export function sessionGrantRetryDisabledReason(item: GrantTrackingItemDto, enabled: boolean): string | null {
  if (!enabled) return 'ระบบปิดการส่งอีเมลซ้ำ';
  if (item.outcome === 'skipped') return 'รายการนี้ถูกข้าม';
  if (item.emailStatus !== 'failed' && item.emailStatus !== 'unknown') return 'ส่งซ้ำได้เฉพาะเมลที่ส่งไม่สำเร็จหรือไม่ทราบผล';
  if (item.outcome === 'invited' && !item.invitation) return 'ไม่มีข้อมูลคำเชิญ';
  if (item.outcome === 'invited' && item.invitation?.invitationStatus !== 'pending') return 'คำเชิญไม่ได้อยู่ระหว่างรอตอบรับ';
  return null;
}
```

- [ ] **Step 4: Create the complete page below.**

The Suspense boundary is intentional: URL search state is read using Next.js `useSearchParams`. Keep the page's auth gate as well as the existing root AuthGuard; `AdminLayout` itself is only a layout component.

`src/app/session-grants/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pagination } from '@/components/common';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { emailLabels, invitationLabels, outcomeLabels, sessionGrantRetryDisabledReason } from '@/lib/session-grant-tracking';
import type { Session } from '@/types/api';
import type { GrantTrackingDto, GrantTrackingItemDto, SessionGrantEmailAttemptsDto } from '@/types/session-grants';

const queryKeys = ['eventId', 'sessionId', 'outcome', 'responseStatus', 'emailStatus', 'search', 'page', 'limit'] as const;
const thaiTime = (value?: string | null) => value ? new Date(value).toLocaleString('th-TH', {
  timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short',
}) : '—';

function TrackingPage() {
  const { token, isAdmin, isLoading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const query = new URLSearchParams();
  for (const key of queryKeys) { const value = params.get(key); if (value) query.set(key, value); }
  const scope = query.toString();
  const page = Number(query.get('page') || '1');
  const limit = Number(query.get('limit') || '50');
  const eventId = query.get('eventId') || '';
  const [events, setEvents] = useState<Array<{ id: number; name: string }>>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ scope: string; data: GrantTrackingDto } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [historyRequest, setHistoryRequest] = useState<{ scope: string; item: GrantTrackingItemDto; page: number } | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState<{ id: string; page: number; data: SessionGrantEmailAttemptsDto } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const listBusy = useRef(false);
  const retryBusy = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const data = loaded?.scope === scope ? loaded.data : null;
  const activeHistory = historyRequest?.scope === scope ? historyRequest : null;
  const history = historyLoaded?.id === activeHistory?.item.id && historyLoaded?.page === activeHistory?.page ? historyLoaded?.data : null;
  const refreshData = useCallback(() => { if (!listBusy.current) setRefresh(value => value + 1); }, []);

  useEffect(() => {
    if (!isAdmin || !token) return;
    let current = true;
    setChoicesError(null);
    async function loadChoices() {
      const allEvents: Array<{ id: number; name: string }> = [];
      let eventPage = 1;
      let eventPages = 1;
      do {
        const result = await api.backofficeEvents.list(token!, `page=${eventPage}&limit=100`);
        for (const record of result.events) {
          if (typeof record.id !== 'number' || typeof record.eventName !== 'string') throw new Error('ข้อมูล Event ไม่ครบ');
          allEvents.push({ id: record.id, name: record.eventName });
        }
        eventPages = result.pagination.totalPages; eventPage++;
      } while (current && eventPage <= eventPages);
      if (!current) return;
      const allSessions: Session[] = [];
      let sessionPage = 1;
      let sessionPages = 1;
      do {
        const result = await api.sessions.list(token!, `page=${sessionPage}&limit=1000`);
        allSessions.push(...result.sessions);
        sessionPages = result.pagination.totalPages; sessionPage++;
      } while (current && sessionPage <= sessionPages);
      if (current) { setEvents(allEvents); setSessions(allSessions); }
    }
    void loadChoices().catch(err => { if (current) setChoicesError(err instanceof Error ? err.message : 'โหลดตัวเลือกไม่สำเร็จ'); });
    return () => { current = false; };
  }, [isAdmin, token]);

  useEffect(() => {
    if (!isAdmin || !token) { listBusy.current = false; return; }
    let current = true;
    listBusy.current = true; setLoading(true); setError(null);
    api.sessionGrants.tracking(token, scope)
      .then(result => { if (current) setLoaded({ scope, data: result }); })
      .catch(err => { if (current) setError(err instanceof Error ? err.message : 'โหลดรายการไม่สำเร็จ'); })
      .finally(() => { if (current) { listBusy.current = false; setLoading(false); } });
    return () => { current = false; };
  }, [isAdmin, token, scope, refresh]);

  useEffect(() => {
    if (!isAdmin || !token) { setEnabled(null); return; }
    let current = true;
    api.sessionGrants.status(token).then(result => {
      if (current) { setEnabled(result.enabled); setFlagError(null); }
    }).catch(() => {
      if (current) { setEnabled(false); setFlagError('โหลดสถานะระบบไม่สำเร็จ จึงปิดปุ่มส่งซ้ำไว้ชั่วคราว'); }
    });
    return () => { current = false; };
  }, [isAdmin, token, refresh]);

  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') refreshData(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshData]);

  const shouldPoll = !!data && data.summary.emailCounts.pending + data.summary.emailCounts.sending > 0;
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refreshData(); }, 3000);
    return () => window.clearInterval(timer);
  }, [shouldPoll, refreshData]);

  useEffect(() => {
    const requested = historyRequest;
    if (!isAdmin || !token || !requested || requested.scope !== scope) return;
    let current = true;
    setHistoryLoading(true); setHistoryError(null);
    api.sessionGrants.emailAttempts(token, requested.item.batchId, requested.item.id, requested.page, 50)
      .then(result => { if (current) setHistoryLoaded({ id: requested.item.id, page: requested.page, data: result }); })
      .catch(err => { if (current) setHistoryError(err instanceof Error ? err.message : 'โหลดประวัติอีเมลไม่สำเร็จ'); })
      .finally(() => { if (current) setHistoryLoading(false); });
    return () => { current = false; };
  }, [isAdmin, token, historyRequest, scope, refresh]);

  const changeQuery = (key: typeof queryKeys[number], value: string) => {
    const next = new URLSearchParams(scope);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    if (key === 'eventId') next.delete('sessionId');
    setNotice(null); setHistoryRequest(null);
    router.replace(`/session-grants${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const retry = async (item: GrantTrackingItemDto) => {
    if (!token || !isAdmin || retryBusy.current || sessionGrantRetryDisabledReason(item, enabled === true)) return;
    const acknowledgeUnknown = item.emailStatus === 'unknown';
    if (acknowledgeUnknown && !window.confirm('อีเมลเดิมอาจส่งไปแล้ว การส่งซ้ำอาจทำให้ผู้รับได้รับอีเมลซ้ำ ต้องการส่งซ้ำหรือไม่?')) return;
    const requestedScope = scope;
    retryBusy.current = true; setRetrying(item.id); setNotice(null);
    try {
      const result = await api.sessionGrants.retry(token, item.batchId, [item.id], acknowledgeUnknown);
      if (scopeRef.current === requestedScope) {
        setNotice(result.queued.includes(item.id) ? 'เข้าคิวส่งอีเมลซ้ำแล้ว' : `ส่งซ้ำไม่ได้: ${result.skipped.find(row => row.itemId === item.id)?.reasonCode || 'ข้อมูลเปลี่ยนแล้ว'}`);
      }
      setRefresh(value => value + 1);
    } catch (err) {
      if (scopeRef.current === requestedScope) setError(err instanceof Error ? err.message : 'ส่งคำขอส่งซ้ำไม่สำเร็จ');
    } finally { retryBusy.current = false; setRetrying(null); }
  };

  return <AdminLayout title="ติดตามสิทธิ์ Session"><div className="space-y-6">
    {isLoading ? <p role="status">กำลังโหลดสิทธิ์…</p> : !isAdmin || !token ? <p role="alert">หน้านี้ใช้ได้เฉพาะ Admin</p> : <>
      <p className="text-sm text-zinc-500">แสดงเฉพาะรายการเพิ่มสิทธิ์ที่มีประวัติในระบบ ไม่มีข้อมูลสถานะอีเมลของสิทธิ์เก่าที่ไม่มีประวัติ</p>
      <section className="card space-y-4" aria-label="ตัวกรองรายการ">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label>Event<select className="input-field w-full" value={eventId} onChange={event => changeQuery('eventId', event.target.value)}>
            <option value="">ทุก Event</option>{events.map(event => <option key={event.id} value={event.id}>{event.name}</option>)}
          </select></label>
          <label>Session<select className="input-field w-full" value={query.get('sessionId') || ''} onChange={event => changeQuery('sessionId', event.target.value)}>
            <option value="">ทุก Session</option>{sessions.filter(session => !eventId || session.eventId === Number(eventId)).map(session => <option key={session.id} value={session.id}>{session.sessionName}</option>)}
          </select></label>
          <label>ผลการเพิ่มสิทธิ์<select className="input-field w-full" value={query.get('outcome') || ''} onChange={event => changeQuery('outcome', event.target.value)}>
            <option value="">ทุกผล</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>คำตอบ<select className="input-field w-full" value={query.get('responseStatus') || ''} onChange={event => changeQuery('responseStatus', event.target.value)}>
            <option value="">ทุกคำตอบ</option><option value="not_required">ไม่ต้องตอบรับ</option>{Object.entries(invitationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>สถานะอีเมล<select className="input-field w-full" value={query.get('emailStatus') || ''} onChange={event => changeQuery('emailStatus', event.target.value)}>
            <option value="">ทุกสถานะ</option>{Object.entries(emailLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>ค้นหาชื่อ / อีเมล / รหัสลงทะเบียน<input className="input-field w-full" maxLength={200} value={query.get('search') || ''} onChange={event => changeQuery('search', event.target.value)} /></label>
        </div>
        <button type="button" className="btn-secondary" disabled={loading} onClick={refreshData}>รีเฟรช</button>
      </section>
      {choicesError && <p role="alert" className="text-red-700">{choicesError}</p>}
      {flagError && <p role="alert" className="text-amber-800">{flagError}</p>}
      {enabled === false && !flagError && <p role="status">ระบบปิดการส่งอีเมลซ้ำ สามารถดูประวัติได้</p>}
      {notice && <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900">{notice}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">{error}{data ? ' · ข้อมูลที่แสดงอาจไม่ใช่ข้อมูลล่าสุด' : ''}</p>}
      {loading && <p role="status">กำลังโหลดรายการ…</p>}
      {data && <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[['จำนวนรายการ', data.summary.total], ['เพิ่มสิทธิ์ทันที', data.summary.outcomeCounts.added], ['สร้างคำเชิญ', data.summary.outcomeCounts.invited], ['ข้าม', data.summary.outcomeCounts.skipped]].map(([label, value]) =>
            <div key={label} className="card"><p className="text-sm text-zinc-500">{label}</p><p className="text-2xl font-semibold">{value}</p></div>)}
        </div>
        <div className="space-y-2 text-sm">
          <p>คำตอบ: {Object.entries(invitationLabels).map(([key, label]) => `${label} ${data.summary.invitationCounts[key as keyof typeof invitationLabels]}`).join(' · ')}</p>
          <p>อีเมล: {Object.entries(emailLabels).map(([key, label]) => `${label} ${data.summary.emailCounts[key as keyof typeof emailLabels]}`).join(' · ')}</p>
          <p className="text-zinc-500">ส่งแล้วหมายถึงผู้ให้บริการรับคำขอส่งสำเร็จ ยังไม่ยืนยันว่าอีเมลถึงกล่องขาเข้าหรือถูกเปิดอ่าน</p>
          <p className="text-zinc-500">ยอดสรุปนับรายการตามตัวกรอง ครอบคลุมทุกหน้า ผลการเพิ่มสิทธิ์เป็นประวัติของครั้งนั้น</p>
        </div>
        <section className="card overflow-hidden p-0" aria-label="รายการเพิ่มสิทธิ์">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-zinc-500"><tr>
                {['ผู้รับ', 'Session', 'ผลการเพิ่มสิทธิ์', 'คำตอบ', 'อีเมล', 'เพิ่มเมื่อ / โดย', 'การจัดการ'].map(label => <th key={label} scope="col" className="px-4 py-3">{label}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-zinc-100">
                {data.items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-500">ไม่พบรายการตามตัวกรอง</td></tr>}
                {data.items.map(item => {
                  const reason = sessionGrantRetryDisabledReason(item, enabled === true);
                  return <tr key={item.id}>
                    <td className="px-4 py-3"><Link className="text-emerald-700 underline" href={`/registrations/${item.registrationId}`}>{item.name || '—'}</Link><div>{item.regCode || item.registrationId}</div><div className="text-xs text-zinc-500">{item.recipientEmail || '—'}</div></td>
                    <td className="px-4 py-3">{item.sessionName}<div className="text-xs text-zinc-500">{events.find(event => event.id === item.eventId)?.name || `Event ${item.eventId}`}</div></td>
                    <td className="px-4 py-3">{outcomeLabels[item.outcome]}{item.reasonCode && <div className="text-xs text-zinc-500">{item.reasonCode}</div>}</td>
                    <td className="px-4 py-3">{item.outcome === 'added' ? 'ไม่ต้องตอบรับ' : item.outcome === 'skipped' ? 'ไม่เกี่ยวข้อง' : item.invitation ? <>
                      <div>{invitationLabels[item.invitation.invitationStatus]}</div>
                      <div className="text-xs text-zinc-500">ก่อน {thaiTime(item.invitation.effectiveDeadline)} เวลาไทย</div>
                      {item.invitation.respondedAt && <div className="text-xs text-zinc-500">ตอบเมื่อ {thaiTime(item.invitation.respondedAt)}</div>}
                    </> : 'ไม่มีข้อมูลคำเชิญ'}</td>
                    <td className="px-4 py-3">{emailLabels[item.emailStatus]}<div className="text-xs text-zinc-500">ส่งเมื่อ {thaiTime(item.sentAt)}</div><div className="text-xs text-zinc-500">ลองส่งล่าสุด {thaiTime(item.lastAttemptAt)}</div>{item.lastErrorCode && <div className="text-xs text-red-700">{item.lastErrorCode}</div>}
                      <button type="button" className="text-emerald-700 underline" aria-expanded={activeHistory?.item.id === item.id} aria-controls="session-grant-email-history" onClick={() => setHistoryRequest(activeHistory?.item.id === item.id ? null : { scope, item, page: 1 })}>ประวัติอีเมล {item.attemptCount} ครั้ง</button>
                    </td>
                    <td className="px-4 py-3">{thaiTime(item.createdAt)}<div className="text-xs text-zinc-500">{item.actorName}</div></td>
                    <td className="px-4 py-3"><Link className="text-emerald-700 underline" href={`/registrations?grantBatchId=${encodeURIComponent(item.batchId)}`}>ผลการเพิ่มครั้งนี้</Link>
                      {(item.emailStatus === 'failed' || item.emailStatus === 'unknown') && <div className="mt-2">
                        <button type="button" className="btn-secondary" disabled={!!reason || retrying !== null} aria-describedby={reason ? `retry-reason-${item.id}` : undefined} onClick={() => void retry(item)}>{retrying === item.id ? 'กำลังเข้าคิว…' : 'ส่งอีเมลซ้ำ'}</button>
                        {reason && <p id={`retry-reason-${item.id}`} className="mt-1 text-xs text-zinc-500">{reason}</p>}
                      </div>}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <Pagination currentPage={page} totalPages={data.pagination.totalPages} totalCount={data.pagination.total} pageSize={limit} itemName="รายการ" onPageChange={value => changeQuery('page', String(value))} onPageSizeChange={value => changeQuery('limit', String(value))} />
        </section>
      </>}
      {activeHistory && <section id="session-grant-email-history" className="card space-y-3" aria-label="ประวัติอีเมล" aria-busy={historyLoading}>
        <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">ประวัติอีเมล · {activeHistory.item.name || activeHistory.item.registrationId}</h2><button type="button" className="btn-secondary" onClick={() => setHistoryRequest(null)}>ปิดประวัติ</button></div>
        {historyLoading && <p role="status">กำลังโหลดประวัติ…</p>}
        {historyError && <p role="alert" className="text-red-700">{historyError}</p>}
        {history && <>
          {history.attempts.length === 0 ? <p>ยังไม่มีประวัติการส่ง</p> : <ol className="space-y-2">{history.attempts.map(attempt => <li key={attempt.id} className="rounded-lg border border-zinc-200 p-3">
            <p>#{attempt.attemptNo} · {emailLabels[attempt.result]} · {attempt.recipientEmail}</p>
            <p className="text-xs text-zinc-500">เริ่ม {thaiTime(attempt.startedAt)} · สิ้นสุด {thaiTime(attempt.finishedAt)}</p>
            {attempt.errorCode && <p className="text-xs text-red-700">{attempt.errorCode}</p>}{attempt.errorMessage && <p className="text-xs text-red-700">{attempt.errorMessage}</p>}
          </li>)}</ol>}
          <Pagination currentPage={activeHistory.page} totalPages={history.pagination.totalPages} totalCount={history.pagination.total} pageSize={50} itemName="ครั้ง" onPageChange={value => setHistoryRequest({ ...activeHistory, page: value })} />
        </>}
      </section>}
    </>}
  </div></AdminLayout>;
}

export default function SessionGrantTrackingPage() {
  return <Suspense fallback={<p role="status">กำลังโหลด…</p>}><TrackingPage /></Suspense>;
}
```

- [ ] **Step 5: Add the navigation link and keep it Admin-only.**

In the `Registrations` submenu's `children` array in `Sidebar.tsx`, insert:

```ts
{ href: '/session-grants', label: 'ติดตามสิทธิ์ Session' },
```

In the menu filtering function, immediately after the existing `if (isAdmin) return item;`, add:

```ts
if (item.children) item = { ...item, children: item.children.filter(child => child.href !== '/session-grants') };
```

The existing AuthContext allows `admin: ['*']` and has no `/session-grants` entry for any other role. Leave its role lists intact. Existing role-specific submenu filters still run after this exclusion.

- [ ] **Step 6: Run the helper/client test, Backoffice type check, targeted lint and build.**

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-backoffice'
& ..\conference-api\node_modules\.bin\tsx.cmd --test src/lib/session-grant-tracking.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit --incremental false
& .\node_modules\.bin\eslint.cmd src/app/session-grants/page.tsx src/lib/session-grant-tracking.ts src/lib/session-grant-tracking.test.ts
npm run build
```

Expected: new tests and page pass. If the installed ESLint configuration flags an effect pattern already used by existing pages, fix new-page issues with the existing project conventions; do not silence the entire file or refactor unrelated pages. A failure in an unchanged file is reported separately with its exact file/command. Google font/network failures during a build do not prove the page compiles; retain the standalone type check evidence and report the build limitation.

- [ ] **Step 7: Commit only Backoffice feature files after the focused checks pass.**

```powershell
git add -- src/types/session-grants.ts src/lib/api.ts src/lib/session-grant-tracking.ts src/lib/session-grant-tracking.test.ts src/app/session-grants/page.tsx src/components/layout/Sidebar.tsx
git diff --cached --check
git commit --only -m "feat(backoffice): track session grants and email retries" -- src/types/session-grants.ts src/lib/api.ts src/lib/session-grant-tracking.ts src/lib/session-grant-tracking.test.ts src/app/session-grants/page.tsx src/components/layout/Sidebar.tsx
```

## Task 4: Focused runtime verification and handoff

**Files:**
- Create: `D:/confer/confer/conference/conference-api/docs/superpowers/verification/2026-10-09-admin-session-grant-tracking.md`
- Read/reuse: `D:/confer/confer/conference/conference-api/review/session-invitations-review-fixture.ts`, `review/session-grants-review-fixture.ts`, `docker-compose.session-grants-test.yml`, `docker-compose.session-invitations-test.yml`, and the existing grant/invitation retry integration tests.

**Interfaces:**
- Consumes: the API reader, page, existing safe test fixtures, and the user's authorized execution method.
- Produces: actual verification evidence and a ready-to-review diff; no new runtime service or release action.

- [ ] **Step 1: Confirm API and Backoffice diffs contain only the approved feature.**

```powershell
git -C 'D:\confer\confer\conference\conference-api' status --short
git -C 'D:\confer\confer\conference\conference-api' diff --check
git -C 'D:\confer\confer\conference\conference-backoffice' status --short
git -C 'D:\confer\confer\conference\conference-backoffice' diff --check
```

Do not stage the unrelated presentation data change. Confirm the new endpoint has no token/notification payload fields and the UI calls the existing retry endpoint rather than a transport.

- [ ] **Step 2: Run the unchanged retry/worker integration checks against the already prepared isolated integration DB.**

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml up -d fake-mail
Get-Content -LiteralPath 'review/session-invitations-test-harness-prerequisites.sql' -Raw | docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U session_grants_test -d confer_session_grants_integration_test
docker compose -p session-grant-tracking-test -f docker-compose.session-grants-test.yml -f docker-compose.session-invitations-test.yml run --rm api-tools npx tsx --test --test-concurrency=1 src/modules/session-grants/email-jobs.integration.test.ts src/modules/session-grants/invitation-email.integration.test.ts
```

Expected: existing transport tests preserve failed/unknown recovery, suppression and terminal invitation rules. These files use test/fake transports; the new tracking test itself does not send mail. Do not run schema reset/migration rehearsals concurrently with these tests.

- [ ] **Step 3: Inspect the new page in a local review environment using test accounts and synthetic records.**

Reuse an already suitable local review environment if one is available. For a fresh review environment, use the already migrated, dedicated Compose project from Task 1. The temporary override below is outside the repositories and exposes review ports on loopback only. Confirm ports 3001, 3002, 3004 and 18025 are free; do not stop another user's service to claim these ports. If an existing project/service already owns the correct review port, reuse it.

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
$taskReviewOverride = Join-Path $env:TEMP 'session-grant-tracking-review-20261009.yml'
@'
services:
  api-server:
    ports:
      - "127.0.0.1:3002:3002"
    environment:
      CORS_ORIGIN: http://localhost:3001,http://localhost:3004
      PRIS_FRONTEND_URL: http://localhost:3004
  backoffice-server:
    ports:
      - "127.0.0.1:3001:3001"
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:3002
  pris-server:
    ports:
      - "127.0.0.1:3004:3004"
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:3002
  fake-mail:
    ports:
      - "127.0.0.1:18025:8025"
'@ | Set-Content -LiteralPath $taskReviewOverride -Encoding utf8
$taskComposeArgs = @('compose', '-p', 'session-grant-tracking-test', '-f', 'docker-compose.session-grants-test.yml', '-f', 'docker-compose.session-invitations-test.yml', '-f', $taskReviewOverride)
docker @taskComposeArgs exec -T postgres psql -U session_grants_test -d confer_session_grants_runtime_test -c 'SELECT current_database(), current_schema();'
$taskRuntimeTableCount = docker @taskComposeArgs exec -T postgres psql -U session_grants_test -d confer_session_grants_runtime_test -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
if ([int]$taskRuntimeTableCount -eq 0) {
  docker @taskComposeArgs exec -T postgres pg_dump -U session_grants_test -d confer_session_grants_integration_test --schema-only --no-owner -Fc -f /tmp/session-grant-tracking-schema.dump
  if ($LASTEXITCODE -ne 0) { throw 'Review schema dump failed' }
  docker @taskComposeArgs exec -T postgres pg_restore -U session_grants_test -d confer_session_grants_runtime_test --no-owner --exit-on-error /tmp/session-grant-tracking-schema.dump
  if ($LASTEXITCODE -ne 0) { throw 'Review schema restore failed' }
} else {
  $taskInvitationReady = docker @taskComposeArgs exec -T postgres psql -U session_grants_test -d confer_session_grants_runtime_test -tAc "SELECT to_regclass('public.session_invitations') IS NOT NULL"
  if ($taskInvitationReady.Trim() -ne 't') { throw 'Existing review schema is incompatible; prepare a fresh owned test project without dropping this database' }
}
Get-Content -LiteralPath 'review/session-invitations-test-harness-prerequisites.sql' -Raw | docker @taskComposeArgs exec -T postgres psql -v ON_ERROR_STOP=1 -U session_grants_test -d confer_session_grants_runtime_test
if ($LASTEXITCODE -ne 0) { throw 'Guarded review prerequisites failed' }
docker @taskComposeArgs run --rm api-tools npx tsx review/session-invitations-review-fixture.ts setup
if ($LASTEXITCODE -ne 0) { throw 'Guarded review fixture failed' }
docker @taskComposeArgs run --rm backoffice-tools npm ci
docker @taskComposeArgs run --rm pris-tools npm ci
docker @taskComposeArgs up -d --build api-server
docker @taskComposeArgs up -d backoffice-server pris-server fake-mail
```

Expected: the schema copy stays inside the owned test project's postgres container; no PowerShell binary redirection or destructive restore is used. The prerequisite SQL and fixture enforce the exact runtime test DB name. The SQL supplies historical test-only columns used by existing readers; do not treat it as a production migration. The existing fixture creates synthetic Admin/Organizer/Staff accounts; use its documented test credentials (Admin `inv-review-20261001-admin@example.test`, password `InvitationReview!2026`) at `http://localhost:3001/login`, then open `http://localhost:3001/session-grants`.

The fixture's private token-bearing test links may be needed for the existing response flow at localhost:3004; never paste them into the verification report. The review mail provider at localhost:18025 is fake. To process a pending runtime test message, run the existing worker once with the owned runtime URL and its test flag enabled:

```powershell
docker @taskComposeArgs run --rm -e ADMIN_SESSION_GRANTS_ENABLED=true api-tools npm run jobs:session-grants:once
```

No live URL or recipient is used. Read each fixture's identity/cleanup guard before running it. If a real environment issue remains after diagnosis, record the browser check as unrun with that issue; do not weaken guards or substitute production data. Preserve test volumes for recoverable verification evidence; no volume deletion is required.

Perform these concrete browser checks at `/session-grants` and record each outcome:

| Check | Action | Expected result |
| --- | --- | --- |
| Admin scope | Log in as Admin; open menu and direct page | Menu visible, tracking endpoint requested, all three original outcomes available |
| Other roles | Use Organizer/Reviewer/Staff accounts; navigate directly | No tracking data fetched/rendered; menu link absent; direct API reader returns 403 |
| Filters/URL | Select event/session, email failed and search saved recipient; reload | Same filters/page in URL and table; summaries describe only matching operation records |
| Event change | Select a session, then another event | Session cleared, page reset to 1, no old-event rows displayed |
| Three dimensions | Inspect added, pending invitation, accepted invitation, and skipped rows | Added says ไม่ต้องตอบรับ; accepted retains สร้างคำเชิญแล้ว; skipped says ไม่เกี่ยวข้อง; email state remains independent |
| Stale fetch | Throttle requests; type one search and immediately replace it | First response cannot overwrite the second filter's rows/counts |
| Refresh error | Load data, then block the tracking request and refresh | Existing same-scope data retained with an error/stale indication |
| Pagination | Use >100 recorded items and select the next page | All pages reachable; no missing/duplicated IDs; summary stays the same across pages |
| History | Open a zero-attempt record and a multi-attempt record; change attempt page | Correct row/batch recipient and timestamps; zero case says ยังไม่มีประวัติการส่ง; no results from a previously selected item |
| Retry failed | Click retry on an eligible failed immediate grant | One POST with the same batch/item; toast/status says queued, then list refreshes |
| Retry unknown cancel | Click an unknown pending invitation and cancel confirmation | No POST occurs |
| Retry unknown accept | Accept that confirmation | Existing endpoint receives `acknowledgeUnknown: true`; token/deadline/entitlement count unchanged |
| Concurrent answer | Let an invitation become answered/expired before retrying its stale row | Existing backend rejects/skips with a displayed reason; list refreshes |
| Feature disabled | Disable the review environment's grants flag and refresh | Read/history remain available; retry button disabled; server rejects direct retry |
| Mail polling | Observe pending/sending mail, then make it terminal through fake transport | Polls roughly every 3 seconds while visible; stops on terminal mail; hidden document produces no interval requests |
| Human response refresh | After mail is sent, respond through the existing test invitation flow and refocus Backoffice | Response refreshes on focus without continuous polling for human answers |
| Keyboard/mobile | Tab through filters/actions/history; inspect narrow viewport | Controls are labelled and focus is visible; table scrolls; disabled retry has an explanation |

- [ ] **Step 4: Write actual verification evidence and commit only that evidence document.**

Use this exact structure; populate it with observed results, never invent passing commands:

```markdown
# Admin session grant tracking verification

Date: 2026-10-09 (Asia/Bangkok)

## Tested revisions and environment

Record API and Backoffice commit IDs, test database name/project, frontend/API review origins, and whether mail used a fake transport. Exclude credentials and token-bearing URLs.

## Automated checks

Record each command, exit code, pass/fail count, and any unchanged-file failure separately.

## Browser checks

Record the observed outcome for every row of Task 4's browser matrix. Mark checks not performed as unrun and state the actual blocking condition.

## Limits and rollout

Record delivery/open tracking as unavailable, state that old unrecorded grants are outside this list, and confirm the additive API must precede the Backoffice release. Record any other observed limitation.
```

This is a verification report structure, not a prefilled assertion of success. Only create/fill it after implementation and checks.

```powershell
Set-Location -LiteralPath 'D:\confer\confer\conference\conference-api'
git add -- docs/superpowers/verification/2026-10-09-admin-session-grant-tracking.md
git diff --cached --check
git commit --only -m "docs: verify admin session grant tracking" -- docs/superpowers/verification/2026-10-09-admin-session-grant-tracking.md
```

- [ ] **Step 5: Hand back the completed change for review.**

Report what changed, focused tests/browser checks actually run, and material limitations. Deployment order is API first, Backoffice second. Reverting these additive readers/page changes rolls back the feature without reversing business data. Do not deploy, send to live recipients, push branches, or create a PR solely because this planning document exists; follow the user's later instructions.

## Plan self-review and acceptance coverage

| Approved spec requirement | Implementing task / proof |
| --- | --- |
| One row per historical operation; snapshots; missing records preserved | Task 1 reader and 109-row integration test; Task 3 scope note |
| Independent grant/response/mail states | Task 1 DTO/policy; Task 3 labels and table; browser dimension check |
| Effective expiry/revocation before normalization; read-only GET | Task 1 transaction, effective filtering tests, stored pending/read audit assertions |
| Same filters/counts/read snapshot; literal search; full pagination | Task 1 common predicate/CTE/repeatable-read transaction and search/pagination tests |
| Admin auth, no sensitive fields, safe errors, reads while disabled | Task 2 contract tests and Task 1 DTO allow-list |
| Existing history/retry contracts, unknown acknowledgement, no new access/token/deadline | Task 1 retry preservation assertions, Task 2 disabled retry, Task 3 helper/client tests and browser actions |
| URL, reset, stale results, focus, visibility-aware bounded polling | Task 3 page effects; Task 4 browser matrix |
| Loading, empty, refresh failures, accessible labels/focus and responsive table | Task 3 UI; Task 4 keyboard/mobile and error checks |
| Safe test DB, unchanged worker lifecycle, compatibility and rollback | Task 1 guard/Compose project; Task 2 existing unit suites; Task 4 existing fake-mail checks and rollout |

The plan has been checked for missing implementation code, unresolved decisions, DTO/function name consistency, source-column aliases, exact paths, and scope creep. Its 16 TypeScript/TSX code blocks passed syntax transpilation with the installed TypeScript compiler; this is not a type check or execution of those examples. Runtime outcomes are not claimed by this planning artifact. Execute the focused checks once at their task boundary; repeat or broaden only after a new change or failure warrants it.
