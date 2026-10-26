import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { createGrant } from "./service.js";
import { previewInvitationResends, queueInvitationResends } from "./resend-service.js";
import { getResendOperation } from "./resend-readers.js";
import { openSessionGrantTestDatabase, validateSessionGrantTestDatabaseUrl } from "./test-database.js";
import type { GrantDatabase } from "./types.js";

test("resends preserve originals at capacity, queue 500 mixed recipients, replay durably and serialize competing connections", { timeout: 120_000 }, async t => {
  validateSessionGrantTestDatabaseUrl();
  const sql = openSessionGrantTestDatabase();
  const otherSql = openSessionGrantTestDatabase();
  const database = drizzle(sql, { schema }) as GrantDatabase;
  const otherDatabase = drizzle(otherSql, { schema }) as GrantDatabase;
  const unique = randomUUID();
  const oldKey = process.env.SESSION_INVITATION_ENCRYPTION_KEY;
  process.env.SESSION_INVITATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const [actor] = await sql<{ id: number }[]>`INSERT INTO backoffice_users(email,password_hash,role,first_name,last_name) VALUES (${`${unique}@example.invalid`},'synthetic','admin','Resend','Test') RETURNING id`;
  const [event] = await sql<{ id: number }[]>`INSERT INTO events(event_code,event_name,event_type,start_date,end_date,status,website_url) VALUES (${unique},'Resend Event','multi_session',clock_timestamp(),clock_timestamp()+interval '4 days','published','http://localhost:3004') RETURNING id`;
  const [ticket] = await sql<{ id: number }[]>`INSERT INTO ticket_types(event_id,category,priority,name,price,currency,quota) VALUES (${event.id},'primary','regular','Resend Ticket',0,'THB',600) RETURNING id`;
  const [session] = await sql<{ id: number }[]>`INSERT INTO sessions(event_id,session_code,session_name,session_type,start_time,end_time,max_capacity,is_active,admin_grant_requires_confirmation) VALUES (${event.id},${unique},'Resend Workshop','workshop',clock_timestamp()+interval '2 days',clock_timestamp()+interval '3 days',600,true,true) RETURNING id`;
  t.after(async () => {
    if (oldKey === undefined) delete process.env.SESSION_INVITATION_ENCRYPTION_KEY; else process.env.SESSION_INVITATION_ENCRYPTION_KEY = oldKey;
    await sql`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (SELECT gi.id FROM registration_session_grant_items gi JOIN registration_session_grant_batches gb ON gb.id=gi.batch_id WHERE gb.event_id=${event.id})`;
    await sql`DELETE FROM session_invitations WHERE session_id=${session.id}`;
    await sql`DELETE FROM registration_session_grant_items WHERE batch_id IN (SELECT id FROM registration_session_grant_batches WHERE event_id=${event.id})`;
    await sql`DELETE FROM session_invitation_resend_requests WHERE session_id=${session.id}`;
    await sql`DELETE FROM registration_session_grant_batches WHERE event_id=${event.id}`;
    await sql`DELETE FROM registration_sessions WHERE session_id=${session.id}`;
    await sql`DELETE FROM registrations WHERE event_id=${event.id}`;
    await sql`DELETE FROM ticket_types WHERE id=${ticket.id}`;
    await sql`DELETE FROM sessions WHERE id=${session.id}`;
    await sql`DELETE FROM events WHERE id=${event.id}`;
    await sql`DELETE FROM backoffice_users WHERE id=${actor.id}`;
    await otherSql.end({ timeout: 2 }); await sql.end({ timeout: 2 });
  });
  const registrations = await sql<{ id: number }[]>`INSERT INTO registrations(reg_code,event_id,ticket_type_id,email,first_name,last_name,status)
    SELECT ${unique} || '-' || n,${event.id},${ticket.id},'resend-' || n || '@example.invalid','Resend','Recipient','confirmed' FROM generate_series(1,503) n RETURNING id`;
  await createGrant(database, { actorId: actor.id, idempotencyKey: randomUUID(), sessionId: session.id, registrationIds: registrations.slice(0,499).map(row => row.id) });
  await createGrant(database, { actorId: actor.id, idempotencyKey: randomUUID(), sessionId: session.id, registrationIds: registrations.slice(499).map(row => row.id) });
  const originals = await sql<{ id: string; grant_item_id: string }[]>`SELECT id,grant_item_id FROM session_invitations WHERE session_id=${session.id} ORDER BY registration_id`;
  assert.equal(originals.length, 503);
  await sql`UPDATE registration_session_grant_items SET email_status='sent',sent_at=clock_timestamp()-interval '10 minutes' WHERE id IN (SELECT grant_item_id FROM session_invitations WHERE session_id=${session.id})`;
  // No available seat may prevent a mail-only operation.
  await sql`UPDATE sessions SET max_capacity=1,session_name='Current Resend Name' WHERE id=${session.id}`;
  const immutable = async () => {
    const invitations = await sql`SELECT id,token_hash,token_ciphertext,expires_at,status FROM session_invitations WHERE session_id=${session.id} ORDER BY id`;
    const items = await sql`SELECT id,notification_snapshot,recipient_email_snapshot,attempt_count,sent_at FROM registration_session_grant_items WHERE id IN (SELECT grant_item_id FROM session_invitations WHERE session_id=${session.id}) ORDER BY id`;
    const [counts] = await sql`SELECT (SELECT count(*) FROM registration_sessions WHERE session_id=${session.id}) AS rights,(SELECT count(*) FROM registration_session_grant_batches WHERE session_id=${session.id}) AS batches`;
    return JSON.stringify({ invitations, items, counts });
  };
  const baseline = await immutable();
  const preview = await previewInvitationResends(database, { sessionId: session.id, invitationIds: [originals[0]!.id, originals[499]!.id] });
  assert.equal(preview.emails.length, 2);
  for (const mail of preview.emails) {
    assert.match(mail.html, /https:\/\/preview.invalid\//);
    assert.match(mail.html, /Current Resend Name/);
    assert.doesNotMatch(mail.html, /token=/);
  }
  assert.equal(await immutable(), baseline);
  assert.equal((await sql`SELECT count(*) AS n FROM session_invitation_resend_requests WHERE session_id=${session.id}`)[0]!.n, '0');
  const missing = randomUUID();
  await sql`UPDATE registration_session_grant_items SET email_status='pending' WHERE id=${originals[1]!.grant_item_id}::uuid`;
  await sql`UPDATE registration_session_grant_items SET email_status='failed' WHERE id=${originals[2]!.grant_item_id}::uuid`;
  await sql`UPDATE registration_session_grant_items SET sent_at=clock_timestamp() WHERE id=${originals[3]!.grant_item_id}::uuid`;
  await sql`UPDATE registration_session_grant_items SET notification_snapshot='{}'::jsonb WHERE id=${originals[4]!.grant_item_id}::uuid`;
  const beforeQueue = await immutable();
  const ids = [...originals.slice(0,499).map(row => row.id), missing];
  const key = randomUUID();
  const queued = await queueInvitationResends(database, { sessionId: session.id, invitationIds: ids, actorId: actor.id, idempotencyKey: key });
  assert.equal(queued.replayed, false);
  assert.equal(queued.result.requestedCount, 500);
  assert.equal(queued.result.queued.length, 495);
  assert.deepEqual(new Set(queued.result.skipped.map(row => row.reasonCode)), new Set(['INVITATION_NOT_FOUND','EMAIL_BUSY','EMAIL_NOT_RESENDABLE','RESEND_COOLDOWN','INVITATION_PAYLOAD_INVALID']));
  assert.equal(await immutable(), beforeQueue);
  await sql`UPDATE registration_session_grant_items SET email_status='sent' WHERE next_resend_request_id=${queued.result.requestId}::uuid`;
  const replay = await queueInvitationResends(database, { sessionId: session.id, invitationIds: [...ids].reverse(), actorId: actor.id, idempotencyKey: key });
  assert.deepEqual(replay, { replayed: true, result: queued.result });
  await assert.rejects(queueInvitationResends(database, { sessionId: session.id, invitationIds: [ids[0]!], actorId: actor.id, idempotencyKey: key }), { code: 'IDEMPOTENCY_KEY_MISMATCH' });
  const fresh = await queueInvitationResends(database, { sessionId: session.id, invitationIds: [ids[0]!, ids[0]!], actorId: actor.id, idempotencyKey: randomUUID() });
  assert.equal(fresh.result.requestedCount, 1);
  assert.equal(fresh.result.skipped[0]!.reasonCode, 'RESEND_COOLDOWN');
  const operation = await getResendOperation(database, queued.result.requestId, 1, 100);
  assert.equal(operation!.entries.length, 100);
  assert.equal(operation!.summary.waiting, 495);
  assert.equal(operation!.pagination.totalPages, 5);
  const racingId = originals[500]!.id;
  const raced = await Promise.all([database, otherDatabase].map(db => queueInvitationResends(db, { sessionId: session.id, invitationIds: [racingId], actorId: actor.id, idempotencyKey: randomUUID() })));
  assert.equal(raced.reduce((n, row) => n + row.result.queued.length, 0), 1);
  assert.equal(raced.reduce((n, row) => n + row.result.skipped.length, 0), 1);
  const concurrentKey = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const repeated = await Promise.all([database, otherDatabase].map((db, index) => queueInvitationResends(db, { sessionId: session.id, invitationIds: [originals[502]!.id], actorId: actor.id, idempotencyKey: index ? concurrentKey.toUpperCase() : concurrentKey })));
  assert.deepEqual(repeated[0]!.result, repeated[1]!.result);
  assert.equal(repeated[0]!.result.requestId, repeated[1]!.result.requestId);
  assert.equal((await sql`SELECT count(*) AS n FROM session_invitation_resend_requests WHERE actor_id=${actor.id} AND idempotency_key=${concurrentKey}::uuid`)[0]!.n, "1");
  assert.deepEqual(repeated.map(row => row.replayed).sort(), [false, true]);
  const constraint = `resend_test_${unique.replaceAll('-', '')}`;
  const ledgerBeforeFailure = (await sql`SELECT count(*) AS n FROM session_invitation_resend_requests WHERE session_id=${session.id}`)[0]!.n;
  await sql.unsafe(`ALTER TABLE registration_session_grant_items ADD CONSTRAINT ${constraint} CHECK (id <> '${originals[501]!.grant_item_id}'::uuid OR email_status <> 'pending') NOT VALID`);
  try {
    await assert.rejects(queueInvitationResends(database, { sessionId: session.id, invitationIds: [originals[501]!.id], actorId: actor.id, idempotencyKey: randomUUID() }));
    assert.equal((await sql`SELECT count(*) AS n FROM session_invitation_resend_requests WHERE session_id=${session.id}`)[0]!.n, ledgerBeforeFailure);
  } finally {
    await sql.unsafe(`ALTER TABLE registration_session_grant_items DROP CONSTRAINT ${constraint}`);
  }
  const beforeBadConfig = (await sql`SELECT count(*) AS n FROM session_invitation_resend_requests WHERE session_id=${session.id}`)[0]!.n;
  delete process.env.SESSION_INVITATION_ENCRYPTION_KEY;
  await assert.rejects(queueInvitationResends(database, { sessionId: session.id, invitationIds: [originals[501]!.id], actorId: actor.id, idempotencyKey: randomUUID() }), { code: 'SESSION_INVITATION_CONFIG_ERROR' });
  assert.equal((await sql`SELECT count(*) AS n FROM session_invitation_resend_requests WHERE session_id=${session.id}`)[0]!.n, beforeBadConfig);
});
