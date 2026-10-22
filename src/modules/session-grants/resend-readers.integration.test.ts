import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { openSessionGrantTestDatabase } from "./test-database.js";
import { buildResendSnapshot, getResendOperation, readResendCandidates } from "./resend-readers.js";
import { getGrantTracking } from "./tracking.js";
import { getGrantBatch } from "./service.js";
import type { GrantDatabase } from "./types.js";

test("resend reads preserve originals, successful history and operation-scoped attempts across batches", async () => {
  const client = openSessionGrantTestDatabase();
  const database = drizzle(client, { schema }) as GrantDatabase;
  const suffix = randomUUID().slice(0, 8);
  let eventId: number | undefined, actorId: number | undefined;
  try {
    const [actor] = await client`INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${`resend-reader-${suffix}@example.invalid`},'synthetic','admin','Reader','Admin') RETURNING id`;
    actorId = actor.id;
    const [event] = await client`INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status,location)
      VALUES (${`RR-${suffix}`},'Current Event','multi_session','2099-01-01','2099-01-03','published','Current Venue') RETURNING id`;
    eventId = event.id;
    const [session] = await client`INSERT INTO sessions (event_id,session_code,session_name,start_time,end_time,is_active)
      VALUES (${event.id},${`RR-${suffix}`},'Current Session','2099-01-02 01:00:00','2099-01-02 03:00:00',true) RETURNING id`;
    const [ticket] = await client`INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (${event.id},'primary','regular','Reader Ticket',0,'THB',20) RETURNING id`;
    const original = { personName: 'Saved Person', regCode: 'SAVED', eventName: 'Old Event', eventShortName: 'OLD', eventDates: 'Old Dates',
      eventVenue: 'Old Venue', sessionName: 'Old Session', sessionType: 'other', startTime: '2098-01-01T00:00:00Z', endTime: '2098-01-02T00:00:00Z',
      room: null, participantUrl: null, responseOrigin: 'https://saved.invalid' };
    const ids: { invitationId: string; itemId: string; batchId: string }[] = [];
    for (let index = 0; index < 2; index++) {
      const [registration] = await client`INSERT INTO registrations (reg_code,event_id,ticket_type_id,email,first_name,last_name,status)
        VALUES (${`RR-${suffix}-${index}`},${event.id},${ticket.id},'edited@example.invalid','Edited','Person','confirmed') RETURNING id`;
      const batchId = randomUUID(), itemId = randomUUID(), invitationId = randomUUID();
      await client`INSERT INTO registration_session_grant_batches (id,actor_id,actor_name_snapshot,idempotency_key,request_hash,session_id,event_id,session_name_snapshot,requested_count,invited_count)
        VALUES (${batchId},${actor.id},'Admin',${randomUUID()},${'a'.repeat(64)},${session.id},${event.id},'Old Session',1,1)`;
      await client`INSERT INTO registration_session_grant_items (id,batch_id,requested_registration_id,name_snapshot,recipient_email_snapshot,notification_snapshot,outcome,email_status,sent_at)
        VALUES (${itemId},${batchId},${registration.id},'Saved Person','saved@example.invalid',${JSON.stringify(original)}::jsonb,'invited','sent','2026-10-23T03:00:00Z')`;
      await client`INSERT INTO session_invitations (id,registration_id,session_id,grant_item_id,status,token_hash,token_ciphertext,expires_at,created_by)
        VALUES (${invitationId},${registration.id},${session.id},${itemId},'pending',${(index ? 'b' : 'a').repeat(64)},'{"version":1,"nonce":"private","tag":"private","ciphertext":"private"}','2099-01-03',${actor.id})`;
      ids.push({ invitationId, itemId, batchId });
    }
    const requestId = randomUUID(), olderRequestId = randomUUID();
    for (const id of [requestId, olderRequestId]) {
      const result = { requestId: id, sessionId: session.id, requestedCount: 2,
        queued: ids.map(({ invitationId, itemId }) => ({ invitationId, itemId })), skipped: [] };
      await client`INSERT INTO session_invitation_resend_requests (id,actor_id,session_id,idempotency_key,request_hash,result)
        VALUES (${id},${actor.id},${session.id},${randomUUID()},${'c'.repeat(64)},${JSON.stringify(result)}::jsonb)`;
    }
    const insertAttempt = async (attemptNo: number, result: string, request: string | null, purpose: string, finished: string) => {
      await client`INSERT INTO registration_session_grant_email_attempts (id,item_id,attempt_no,claim_token,trigger,recipient_email,template_version,subject_snapshot,result,purpose,resend_request_id,finished_at)
        VALUES (${randomUUID()},${ids[0].itemId},${attemptNo},${randomUUID()},'admin','saved@example.invalid','session-invitation-v3','Safe Subject',${result},${purpose},${request},${finished})`;
    };
    await insertAttempt(1, 'sent', null, 'initial', '2026-10-23T03:10:00Z');
    await insertAttempt(2, 'sent', olderRequestId, 'resend', '2026-10-23T03:20:00Z');
    await insertAttempt(3, 'sent', olderRequestId, 'retry', '2026-10-23T03:21:00Z');
    await insertAttempt(4, 'failed', requestId, 'resend', '2026-10-23T03:30:00Z');
    await client`UPDATE registration_session_grant_items SET email_status='failed',last_resend_queued_at='2026-10-23T03:25:00Z' WHERE id=${ids[0].itemId}`;
    const before = await client`SELECT notification_snapshot FROM registration_session_grant_items WHERE id=${ids[0].itemId}`;
    const candidates = await database.transaction(tx => readResendCandidates(tx, { sessionId: session.id, invitationIds: ids.map(item => item.invitationId) }));
    assert.equal(candidates.length, 2);
    const current = candidates.find(item => item.itemId === ids[0].itemId)!;
    const fallback = candidates.find(item => item.itemId === ids[1].itemId)!;
    assert.equal(current.lastSuccessfulSentAt?.toISOString(), '2026-10-23T03:21:00.000Z');
    assert.equal(fallback.lastSuccessfulSentAt?.toISOString(), '2026-10-23T03:00:00.000Z');
    assert.equal(current.lastResendQueuedAt?.toISOString(), '2026-10-23T03:25:00.000Z');
    assert.equal(current.recipientEmail, 'saved@example.invalid');
    const snapshot = buildResendSnapshot(current);
    assert.equal(snapshot.sessionName, 'Current Session'); assert.equal(snapshot.eventName, 'Current Event');
    assert.equal(snapshot.startTime, '2099-01-02T01:00:00.000Z'); assert.equal(snapshot.personName, 'Saved Person');
    assert.equal(snapshot.responseOrigin, 'https://saved.invalid');
    assert.deepEqual(await client`SELECT notification_snapshot FROM registration_session_grant_items WHERE id=${ids[0].itemId}`, before);
    const operation = await getResendOperation(database, requestId, 1, 1);
    assert.equal(operation?.summary.failed, 1); assert.equal(operation?.summary.waiting, 1);
    assert.equal(operation?.entries[0].attemptNo, 4); assert.equal(operation?.pagination.total, 2);
    assert.equal((await getResendOperation(database, olderRequestId, 1, 100))?.entries[0].state, 'sent');
    const tracking = await getGrantTracking(database, { page: 1, limit: 100, sessionId: session.id });
    const tracked = tracking.items.find(item => item.id === ids[0].itemId)!;
    assert.equal(tracked.successfulResendCount, 1); assert.equal(tracked.lastSuccessfulSentAt, '2026-10-23T03:21:00.000Z');
    assert.equal(tracked.resendDisabledReason, 'EMAIL_NOT_RESENDABLE');
    const batch = await getGrantBatch(database, ids[0].batchId, 1, 100);
    assert.equal(batch?.results[0].successfulResendCount, 1);
    const retryRequestId = randomUUID();
    const retryResult = { requestId: retryRequestId, sessionId: session.id, requestedCount: 1,
      queued: [{ invitationId: ids[0].invitationId, itemId: ids[0].itemId }], skipped: [] };
    await client`INSERT INTO session_invitation_resend_requests (id,actor_id,session_id,idempotency_key,request_hash,result)
      VALUES (${retryRequestId},${actor.id},${session.id},${randomUUID()},${'d'.repeat(64)},${JSON.stringify(retryResult)}::jsonb)`;
    await insertAttempt(5, 'failed', retryRequestId, 'resend', '2026-10-23T03:35:00Z');
    await client`UPDATE registration_session_grant_items SET email_status='pending',next_email_purpose='retry',next_resend_request_id=${retryRequestId} WHERE id=${ids[0].itemId}`;
    const queuedRetry = await getResendOperation(database, retryRequestId, 1, 100);
    assert.equal(queuedRetry?.summary.waiting, 1);
    assert.equal(queuedRetry?.summary.failed, 0);
    assert.equal(queuedRetry?.entries[0].state, 'waiting');
    assert.equal(queuedRetry?.entries[0].attemptNo, 5);
    const uppercaseRetry = await getResendOperation(database, retryRequestId.toUpperCase(), 1, 100);
    assert.equal(uppercaseRetry?.summary.waiting, 1);
    assert.equal(uppercaseRetry?.entries[0].state, 'waiting');
    assert.deepEqual(uppercaseRetry, queuedRetry);
    assert.equal((await getResendOperation(database, requestId, 1, 100))?.entries[0].state, 'failed',
      'a newer queued request must not replace the previous operation result');
    await client`UPDATE registration_session_grant_items SET email_status='sending' WHERE id=${ids[0].itemId}`;
    assert.equal((await getResendOperation(database, retryRequestId, 1, 100))?.summary.sending, 1);
    await client`UPDATE registration_session_grant_items SET next_resend_request_id=${olderRequestId} WHERE id=${ids[0].itemId}`;
    assert.equal((await getResendOperation(database, retryRequestId, 1, 100))?.entries[0].state, 'failed',
      'another request active on the item must not override the failed operation');
    await insertAttempt(6, 'sent', retryRequestId, 'retry', '2026-10-23T03:40:00Z');
    await client`UPDATE registration_session_grant_items SET email_status='sent',next_email_purpose='initial',next_resend_request_id=NULL WHERE id=${ids[0].itemId}`;
    const deliveredRetry = await getResendOperation(database, retryRequestId, 1, 100);
    assert.equal(deliveredRetry?.summary.sent, 1);
    assert.equal(deliveredRetry?.entries[0].attemptNo, 6);
    for (const dto of [operation, tracking, batch]) {
      const serialized = JSON.stringify(dto);
      for (const secret of ['tokenCiphertext', 'tokenHash', 'notificationSnapshot', 'https://saved.invalid', 'private']) assert.equal(serialized.includes(secret), false);
    }
    assert.equal(await getResendOperation(database, randomUUID(), 1, 10), null);
    assert.deepEqual(await database.transaction(tx => readResendCandidates(tx, { sessionId: session.id + 100000, invitationIds: ids.map(item => item.invitationId) })), []);
  } finally {
    if (eventId !== undefined) {
      await client`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (SELECT i.id FROM registration_session_grant_items i JOIN registration_session_grant_batches b ON b.id=i.batch_id WHERE b.event_id=${eventId})`;
      await client`DELETE FROM session_invitations WHERE session_id IN (SELECT id FROM sessions WHERE event_id=${eventId})`;
      await client`DELETE FROM registration_session_grant_items WHERE batch_id IN (SELECT id FROM registration_session_grant_batches WHERE event_id=${eventId})`;
      await client`DELETE FROM session_invitation_resend_requests WHERE session_id IN (SELECT id FROM sessions WHERE event_id=${eventId})`;
      await client`DELETE FROM registration_session_grant_batches WHERE event_id=${eventId}`;
      await client`DELETE FROM registrations WHERE event_id=${eventId}`;
      await client`DELETE FROM ticket_types WHERE event_id=${eventId}`;
      await client`DELETE FROM sessions WHERE event_id=${eventId}`;
      await client`DELETE FROM events WHERE id=${eventId}`;
    }
    if (actorId !== undefined) await client`DELETE FROM backoffice_users WHERE id=${actorId}`;
    await client.end({ timeout: 2 });
  }
});
