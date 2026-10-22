import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { createGrant } from "./service.js";
import { queueInvitationResends } from "./resend-service.js";
import { getResendOperation, readResendCandidates } from "./resend-readers.js";
import { retryGrantEmails, runGrantEmailsOnce } from "./email-jobs.js";
import { openSessionGrantTestDatabase } from "./test-database.js";
import type { GrantDatabase } from "./types.js";

test("resend delivery shares template/link, attributes retry, and suppresses closed invitations", { timeout: 90_000 }, async t => {
  const client = openSessionGrantTestDatabase();
  const db = drizzle(client, { schema }) as GrantDatabase;
  const suffix = randomUUID();
  const [actor] = await client`INSERT INTO backoffice_users
    (email,password_hash,role,first_name,last_name)
    VALUES (${`${suffix}@example.invalid`},'synthetic','admin','Resend','Admin') RETURNING id`;
  const [event] = await client`INSERT INTO events
    (event_code,event_name,event_type,start_date,end_date,status,website_url)
    VALUES (${suffix},'PRIS 2026','multi_session',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '4 days',
      'published','https://pris.example.invalid') RETURNING id`;
  const [ticket] = await client`INSERT INTO ticket_types
    (event_id,category,priority,name,price,currency,quota)
    VALUES (${event.id},'primary','regular','Synthetic',0,'THB',5) RETURNING id`;
  const [session] = await client`INSERT INTO sessions
    (event_id,session_code,session_name,session_type,start_time,end_time,room,max_capacity,is_active,admin_grant_requires_confirmation)
    VALUES (${event.id},${suffix},'Policy Innovation Workshop','workshop',
      CURRENT_TIMESTAMP+interval '2 days',CURRENT_TIMESTAMP+interval '2 days 3 hours','Jupiter 11',1,true,true) RETURNING id`;
  const [registration] = await client`INSERT INTO registrations
    (reg_code,event_id,ticket_type_id,email,first_name,last_name,status)
    VALUES (${suffix},${event.id},${ticket.id},'resend@example.invalid','Synthetic','Recipient','confirmed') RETURNING id`;
  t.after(async () => {
    await client`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN
      (SELECT i.id FROM registration_session_grant_items i JOIN registration_session_grant_batches b ON b.id=i.batch_id WHERE b.event_id=${event.id})`;
    await client`UPDATE registration_session_grant_items SET next_email_purpose='initial',next_resend_request_id=NULL
      WHERE batch_id IN (SELECT id FROM registration_session_grant_batches WHERE event_id=${event.id})`;
    await client`DELETE FROM session_invitation_resend_requests WHERE session_id=${session.id}`;
    await client`DELETE FROM session_invitations WHERE session_id=${session.id}`;
    await client`DELETE FROM registration_session_grant_items WHERE batch_id IN
      (SELECT id FROM registration_session_grant_batches WHERE event_id=${event.id})`;
    await client`DELETE FROM registration_session_grant_batches WHERE event_id=${event.id}`;
    await client`DELETE FROM registration_sessions WHERE registration_id=${registration.id}`;
    await client`DELETE FROM registrations WHERE id=${registration.id}`;
    await client`DELETE FROM ticket_types WHERE id=${ticket.id}`;
    await client`DELETE FROM sessions WHERE id=${session.id}`;
    await client`DELETE FROM events WHERE id=${event.id}`;
    await client`DELETE FROM backoffice_users WHERE id=${actor.id}`;
    await client.end({ timeout: 2 });
  });
  const batch = await createGrant(db, { actorId: actor.id, idempotencyKey: randomUUID(), sessionId: session.id,
    registrationIds: [registration.id] });
  const itemId = batch.batch.results[0].id;
  const [invitation] = await client`SELECT id FROM session_invitations WHERE grant_item_id=${itemId}`;
  const capture: Array<{ subject: string; html: string; recipient: string }> = [];
  const transport = { async send(input: { subject: string; html: string; recipient: string }) {
    capture.push(input); return { providerMessageId: `fake-${capture.length}` };
  } };
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).sent, 1);
  const credential = async () => JSON.stringify(await client`SELECT id,token_hash,token_ciphertext,expires_at,status
    FROM session_invitations WHERE id=${invitation.id}`);
  const original = await credential();
  const saved = JSON.stringify(await client`SELECT notification_snapshot FROM registration_session_grant_items WHERE id=${itemId}`);
  const age = async () => {
    await client`UPDATE registration_session_grant_email_attempts SET finished_at=CURRENT_TIMESTAMP-interval '6 minutes'
      WHERE item_id=${itemId} AND result='sent'`;
    await client`UPDATE registration_session_grant_items SET sent_at=CURRENT_TIMESTAMP-interval '6 minutes',
      last_resend_queued_at=CURRENT_TIMESTAMP-interval '6 minutes' WHERE id=${itemId}`;
  };
  const queue = () => queueInvitationResends(db, { actorId: actor.id, idempotencyKey: randomUUID(),
    sessionId: session.id, invitationIds: [invitation.id] });
  await age();
  const first = await queue();
  assert.equal(first.result.queued.length, 1);
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).sent, 1);
  assert.deepEqual(capture[1], capture[0], "initial and resend use identical recipient, subject, body and link");
  assert.equal(await credential(), original);
  assert.equal(JSON.stringify(await client`SELECT notification_snapshot FROM registration_session_grant_items WHERE id=${itemId}`), saved);
  assert.equal(Number((await client`SELECT count(*) AS count FROM registration_sessions WHERE registration_id=${registration.id}`)[0].count), 0);
  assert.equal((await getResendOperation(db, first.result.requestId, 1, 50))?.summary.sent, 1);

  await age();
  const failed = await queue();
  const failure = { async send(): Promise<never> {
    throw Object.assign(new Error("synthetic failure"), { deliveryState: "failed", code: "SYNTHETIC_FAILURE" });
  } };
  assert.equal((await runGrantEmailsOnce(db, failure, new Date())).failed, 1);
  const candidates = await db.transaction(tx => readResendCandidates(tx, { sessionId: session.id, invitationIds: [invitation.id] }));
  assert.ok(candidates[0].lastSuccessfulSentAt, "last success survives later failure");
  const retried = await retryGrantEmails(db, { actorId: actor.id, batchId: batch.batch.batchId,
    itemIds: [itemId], acknowledgeUnknown: false });
  assert.deepEqual(retried.queued, [itemId]);
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).sent, 1);
  const [attempt] = await client`SELECT purpose,resend_request_id FROM registration_session_grant_email_attempts
    WHERE item_id=${itemId} ORDER BY attempt_no DESC LIMIT 1`;
  assert.equal(attempt.purpose, "retry");
  assert.equal(attempt.resend_request_id, failed.result.requestId);
  assert.equal((await getResendOperation(db, first.result.requestId, 1, 50))?.summary.sent, 1,
    "later attempts do not replace the earlier operation result");

  await age();
  const unknown = await queue();
  assert.equal((await runGrantEmailsOnce(db, { async send(): Promise<never> {
    throw Object.assign(new Error("synthetic timeout"), { deliveryState: "unknown", code: "SYNTHETIC_TIMEOUT" });
  } }, new Date())).unknown, 1);
  assert.equal((await retryGrantEmails(db, { actorId: actor.id, batchId: batch.batch.batchId,
    itemIds: [itemId], acknowledgeUnknown: false })).skipped[0].reasonCode, "UNKNOWN_ACK_REQUIRED");
  await retryGrantEmails(db, { actorId: actor.id, batchId: batch.batch.batchId,
    itemIds: [itemId], acknowledgeUnknown: true });
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).sent, 1);
  assert.equal((await getResendOperation(db, unknown.result.requestId, 1, 50))?.summary.sent, 1);

  const interrupted = async (afterRequest: boolean) => {
    await age();
    const result = await queue();
    const claim = randomUUID();
    const [item] = await client`UPDATE registration_session_grant_items SET email_status='sending',
      attempt_count=attempt_count+1,claim_token=${claim},claimed_until=CURRENT_TIMESTAMP-interval '1 minute'
      WHERE id=${itemId} RETURNING attempt_count`;
    await client`INSERT INTO registration_session_grant_email_attempts
      (id,item_id,attempt_no,claim_token,trigger,triggered_by,recipient_email,template_version,
      subject_snapshot,result,started_at,request_started_at,purpose,resend_request_id)
      VALUES (${randomUUID()},${itemId},${item.attempt_count},${claim},'admin',${actor.id},'resend@example.invalid',
      'session-invitation-v3','Synthetic interrupted attempt','sending',CURRENT_TIMESTAMP-interval '2 minutes',
      ${afterRequest ? new Date().toISOString() : null},'resend',${result.result.requestId})`;
    return result;
  };
  const beforeProvider = await interrupted(false);
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).sent, 1);
  assert.equal((await getResendOperation(db, beforeProvider.result.requestId, 1, 50))?.summary.sent, 1);
  const afterProvider = await interrupted(true);
  const beforeCount = capture.length;
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).unknown, 1);
  assert.equal(capture.length, beforeCount, "ambiguous interrupted requests are not automatically redelivered");
  await retryGrantEmails(db, { actorId: actor.id, batchId: batch.batch.batchId,
    itemIds: [itemId], acknowledgeUnknown: true });
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).sent, 1);
  assert.equal((await getResendOperation(db, afterProvider.result.requestId, 1, 50))?.summary.sent, 1);

  await age();
  const closed = await queue();
  const priorClosedCount = capture.length;
  await client`UPDATE session_invitations SET status='declined',responded_at=CURRENT_TIMESTAMP,
    closed_at=CURRENT_TIMESTAMP,token_ciphertext=NULL WHERE id=${invitation.id}`;
  assert.equal((await runGrantEmailsOnce(db, transport, new Date())).suppressed, 1);
  assert.equal((await getResendOperation(db, closed.result.requestId, 1, 50))?.summary.suppressed, 1);
  assert.equal(capture.length, priorClosedCount, "closed resend did not call transport");
  assert.equal(Number((await client`SELECT count(*) AS count FROM session_invitations WHERE session_id=${session.id}`)[0].count), 1);
});
