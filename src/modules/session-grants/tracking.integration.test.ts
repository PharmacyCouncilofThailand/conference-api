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
