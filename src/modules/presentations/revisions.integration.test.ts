import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema.js';
import { preparePresentationScenario, openPresentationTestDatabase } from './test-support.js';
import { previewPresentationMail, createNotificationBatch } from './operations.js';
import { createPresentationRevision, cancelPresentationRevision } from './revisions.js';
import { resendPresentationMail, buildMailPayload, enqueuePresentationMail } from './email-jobs.js';

async function uploaded(t: Parameters<typeof preparePresentationScenario>[0]) {
  const scenario = await preparePresentationScenario(t), { client: sql, fixture: f } = scenario;
  const [target] = await sql`SELECT id FROM presentation_targets`;
  const uploadId = randomUUID(), attemptId = randomUUID();
  await sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token,state)
    VALUES (${attemptId},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},'synthetic/poster.png','poster.png','image/png',1,${'a'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()},'accepted')`;
  await sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,version,user_id,object_key,public_url,filename,mime_type,size_bytes,digest,received_at)
    VALUES (${uploadId},${target.id},${attemptId},1,${f.ownerId},'synthetic/poster.png','https://example.invalid/poster.png','poster.png','image/png',1,${'a'.repeat(64)},clock_timestamp())`;
  await sql`UPDATE presentation_targets SET current_upload_id=${uploadId},initial_enabled=false`;
  return { ...scenario, targetId: target.id as string, uploadId };
}

async function draft(s: Awaited<ReturnType<typeof uploaded>>, minutes = 60) {
  const [clock] = await s.client`SELECT clock_timestamp()+${minutes}*interval '1 minute' AS deadline`;
  const proposed = { kind: 'revision' as const, abstractId: s.fixture.abstractId, details: 'แก้ข้อความ', closesAt: new Date(clock.deadline).toISOString() };
  const p = await previewPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, proposed);
  return { requestId: p.requestId!, details: proposed.details, closesAt: p.closesAt!, previewFingerprint: p.fingerprint };
}

test('two independent clients create one request; replay, immutable terms, cancel audit and new request', async t => {
  const s = await uploaded(t), { client: sql, database, fixture: f } = s;
  const peer = openPresentationTestDatabase(); t.after(() => peer.end({ timeout: 2 }));
  const input = await draft(s), keys = [randomUUID(), randomUUID()];
  const results = await Promise.allSettled([createPresentationRevision(database, f.admin, f.eventId, f.abstractId, keys[0], input),
    createPresentationRevision(drizzle(peer, { schema }), f.admin, f.eventId, f.abstractId, keys[1], input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'PRESENTATION_ACTIVE_REQUEST_EXISTS');
  const winner = results.findIndex(r => r.status === 'fulfilled');
  const result = (results[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof createPresentationRevision>>>).value;
  assert.deepEqual(await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, keys[winner], input), result);
  assert.equal(result.request.id, input.requestId); assert.equal(result.request.closesAt, input.closesAt);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 1);
  await assert.rejects(sql`UPDATE presentation_revision_requests SET details='changed' WHERE id=${input.requestId}`);
  await assert.rejects(sql`UPDATE presentation_revision_requests SET closes_at=closes_at+interval '1 hour' WHERE id=${input.requestId}`);
  const key = randomUUID(), cancelled = await cancelPresentationRevision(database, f.admin, f.eventId, input.requestId, key, { reason: 'เปลี่ยนเงื่อนไข' });
  assert.deepEqual(await cancelPresentationRevision(database, f.admin, f.eventId, input.requestId, key, { reason: 'เปลี่ยนเงื่อนไข' }), cancelled);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancelledBy, f.adminId); assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.cancellationReason, 'เปลี่ยนเงื่อนไข');
  await assert.rejects(sql`UPDATE presentation_revision_requests SET status='open',cancelled_at=NULL WHERE id=${input.requestId}`);
  await assert.rejects(cancelPresentationRevision(database, f.admin, f.eventId, input.requestId, randomUUID(), { reason: 'again' }), { code: 'PRESENTATION_REQUEST_CLOSED' });
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), input), { code: 'PRESENTATION_REQUEST_CLOSED' });
  const next = await draft(s); await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), next);
  assert.notEqual(next.requestId, input.requestId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_revision_requests WHERE status='open'`)[0].n, 1);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, s.uploadId);
  const audits = await sql`SELECT action,actor_id,reason,created_at FROM presentation_audit_events WHERE action IN ('revision_created','revision_cancelled') ORDER BY created_at`;
  assert.equal(audits.length, 3); assert.ok(audits.every(a => a.actor_id === f.adminId && a.created_at && a.reason));
});

test('revision creation requires upload and Admin rights', async t => {
  const s = await preparePresentationScenario(t), { client: sql, database, fixture: f } = s;
  const [clock] = await sql`SELECT clock_timestamp()+interval '1 hour' AS deadline`;
  const raw = { requestId: randomUUID(), details: 'update', closesAt: new Date(clock.deadline).toISOString(), previewFingerprint: '0'.repeat(64) };
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), raw), { code: 'PRESENTATION_REVISION_REQUIRES_UPLOAD' });
  await sql`UPDATE backoffice_users SET role='reviewer' WHERE id=${f.adminId}`;
  await assert.rejects(createPresentationRevision(database, { ...f.admin, role: 'reviewer' }, f.eventId, f.abstractId, randomUUID(), raw), { statusCode: 403 });
});

test('failed and unknown revision resends retain terms/rights and refresh owner; cancellation suppresses resend', async t => {
  const s = await uploaded(t), { client: sql, database, fixture: f } = s;
  const input = await draft(s), created = await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), input);
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, created.emailJobId, randomUUID(), input.previewFingerprint), { code: 'PRESENTATION_MAIL_IN_PROGRESS' });
  let previous = created.emailJobId;
  for (const state of ['failed', 'unknown']) {
    await sql`UPDATE presentation_email_jobs SET state=${state} WHERE id=${previous}`;
    const p = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId: previous });
    const key = randomUUID(), sent = await resendPresentationMail(database, f.admin, f.eventId, previous, key, p.fingerprint);
    assert.deepEqual(await resendPresentationMail(database, f.admin, f.eventId, previous, key, p.fingerprint), sent);
    const [job] = await sql`SELECT request_id,parent_job_id,payload,state FROM presentation_email_jobs WHERE id=${sent.jobId}`;
    assert.equal(job.request_id, input.requestId); assert.equal(job.parent_job_id, previous); assert.equal(job.state, 'pending');
    assert.equal(job.payload.closesAt, input.closesAt); assert.equal(job.payload.revisionDetails, input.details);
    assert.equal(job.payload.recipient, f.owner.email); previous = sent.jobId;
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_revision_requests`)[0].n, 1);
  assert.equal((await sql`SELECT initial_enabled,current_upload_id FROM presentation_targets`)[0].initial_enabled, false);
  await sql`UPDATE presentation_email_jobs SET state='failed' WHERE id=${previous}`;
  const p = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId: previous });
  await sql`UPDATE users SET email='new-owner@example.invalid' WHERE id=${f.ownerId}`;
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, previous, randomUUID(), p.fingerprint), { code: 'PRESENTATION_PREVIEW_STALE' });
  const fresh = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId: previous });
  await cancelPresentationRevision(database, f.admin, f.eventId, input.requestId, randomUUID(), { reason: 'cancel' });
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, previous, randomUUID(), fresh.fingerprint), { code: 'PRESENTATION_REQUEST_CLOSED' });
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 3);
});

test('expired pending request rejects resend and cancel; next create expires old request without restoring initial rights', async t => {
  const s = await uploaded(t), { client: sql, database, fixture: f } = s;
  const [clock] = await sql`SELECT clock_timestamp()-interval '1 second' AS deadline`;
  const id = randomUUID();
  await sql`INSERT INTO presentation_revision_requests(id,target_id,details,closes_at,requested_by) VALUES (${id},${s.targetId},'expired',${clock.deadline},${f.adminId})`;
  const jobId = await database.transaction(async tx => enqueuePresentationMail(tx, s.targetId, await buildMailPayload(tx, s.targetId, 'revision', id), f.adminId, { requestId: id }));
  await sql`UPDATE presentation_email_jobs SET state='failed' WHERE id=${jobId}`;
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, jobId, randomUUID(), '0'.repeat(64)), { code: 'PRESENTATION_REQUEST_CLOSED' });
  await assert.rejects(cancelPresentationRevision(database, f.admin, f.eventId, id, randomUUID(), { reason: 'late' }), { code: 'PRESENTATION_REQUEST_CLOSED' });
  const input = await draft(s); await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), input);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests WHERE id=${id}`)[0].status, 'expired');
  assert.equal((await sql`SELECT current_upload_id,initial_enabled FROM presentation_targets`)[0].current_upload_id, s.uploadId);
  await assert.rejects(sql`UPDATE presentation_revision_requests SET status='open' WHERE id=${id}`);
});

test('initial resend checks deadline', async t => {
  const s = await preparePresentationScenario(t), { client: sql, database, fixture: f } = s;
  const selection = { kind: 'initial' as const, abstractIds: [f.abstractId] };
  const p = await previewPresentationMail(database, f.admin, f.eventId, selection);
  const batch = await createNotificationBatch(database, f.admin, f.eventId, randomUUID(), { ...selection, previewFingerprint: p.fingerprint });
  await sql`UPDATE presentation_email_jobs SET state='failed'`;
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, batch.jobIds[0], randomUUID(), p.fingerprint), { code: 'PRESENTATION_DEADLINE_PASSED' });
});

test('fresh revision creation rejects stale owner/title previews and rolls back on mandatory audit failure', async t => {
  const s = await uploaded(t), { client: sql, database, fixture: f } = s;
  const input = await draft(s);
  await sql`UPDATE users SET email='changed@example.invalid' WHERE id=${f.ownerId}`;
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), input), { code: 'PRESENTATION_PREVIEW_STALE' });
  const fresh = await draft(s);
  await sql`UPDATE abstracts SET title='changed' WHERE id=${f.abstractId}`;
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), fresh), { code: 'PRESENTATION_PREVIEW_STALE' });
  const current = await draft(s);
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), { ...current, details: ' ' }));
  const [past] = await sql`SELECT clock_timestamp()-interval '1 second' AS deadline`;
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(),
    { ...current, closesAt: new Date(past.deadline).toISOString() }), { code: 'PRESENTATION_DEADLINE_PASSED' });
  await sql.unsafe(`CREATE FUNCTION reject_revision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='revision_created' THEN RAISE EXCEPTION 'synthetic revision audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_revision_audit BEFORE INSERT ON presentation_audit_events FOR EACH ROW EXECUTE FUNCTION reject_revision_audit()`);
  await assert.rejects(createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), current));
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_revision_requests`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_operations`)[0].n, 0);
});

test('cancel and resend audit failure roll back; submitted request cannot cancel or resend', async t => {
  const s = await uploaded(t), { client: sql, database, fixture: f } = s;
  const input = await draft(s), created = await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(),
    { ...input, requestId: input.requestId.toUpperCase() });
  assert.equal(created.request.id, input.requestId);
  await sql`UPDATE presentation_email_jobs SET state='unknown' WHERE id=${created.emailJobId}`;
  const p = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId: created.emailJobId });
  await sql.unsafe(`CREATE FUNCTION reject_cancel_resend_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action IN ('revision_cancelled','mail_resent') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_cancel_resend_audit BEFORE INSERT ON presentation_audit_events FOR EACH ROW EXECUTE FUNCTION reject_cancel_resend_audit()`);
  await assert.rejects(cancelPresentationRevision(database, f.admin, f.eventId, input.requestId, randomUUID(), { reason: 'cancel' }));
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, created.emailJobId, randomUUID(), p.fingerprint));
  assert.equal((await sql`SELECT status FROM presentation_revision_requests`)[0].status, 'open');
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_operations`)[0].n, 1);
  await sql`UPDATE presentation_revision_requests SET status='submitted',submitted_at=clock_timestamp() WHERE id=${input.requestId}`;
  await assert.rejects(cancelPresentationRevision(database, f.admin, f.eventId, input.requestId, randomUUID(), { reason: 'cancel' }), { code: 'PRESENTATION_REQUEST_CLOSED' });
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, created.emailJobId, randomUUID(), p.fingerprint), { code: 'PRESENTATION_REQUEST_CLOSED' });
  await assert.rejects(sql`UPDATE presentation_revision_requests SET status='open',submitted_at=NULL WHERE id=${input.requestId}`);
});

test('historical receipt resend preserves upload link and does not mint rights; initial resend rejects used right', async t => {
  const s = await uploaded(t), { client: sql, database, fixture: f } = s;
  const initial = await database.transaction(async tx => enqueuePresentationMail(tx, s.targetId,
    await buildMailPayload(tx, s.targetId, 'initial'), f.adminId));
  await sql`UPDATE presentation_email_jobs SET state='failed' WHERE id=${initial}`;
  await assert.rejects(resendPresentationMail(database, f.admin, f.eventId, initial, randomUUID(), '0'.repeat(64)), { statusCode: 409 });
  const input = await draft(s), created = await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), input);
  const secondId = randomUUID(), secondAttempt = randomUUID();
  await sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,request_id,operation_key,fingerprint,object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token,state)
    VALUES (${secondAttempt},${s.targetId},${f.ownerId},${input.requestId},${randomUUID()},${'b'.repeat(64)},'synthetic/v2.png','v2.png','image/png',1,${'b'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()},'accepted')`;
  await sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,request_id,version,user_id,object_key,public_url,filename,mime_type,size_bytes,digest,received_at)
    VALUES (${secondId},${s.targetId},${secondAttempt},${input.requestId},2,${f.ownerId},'synthetic/v2.png','https://example.invalid/v2.png','v2.png','image/png',1,${'b'.repeat(64)},clock_timestamp())`;
  await sql`UPDATE presentation_targets SET current_upload_id=${secondId}`;
  await sql`UPDATE presentation_revision_requests SET status='submitted',submitted_at=clock_timestamp() WHERE id=${created.request.id}`;
  const receipt = await database.transaction(async tx => enqueuePresentationMail(tx, s.targetId,
    await buildMailPayload(tx, s.targetId, 'receipt', undefined, s.uploadId), f.adminId, { uploadId: s.uploadId, automaticReceiptFor: s.uploadId }));
  await sql`UPDATE presentation_email_jobs SET state='failed' WHERE id=${receipt}`;
  const p = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId: receipt });
  const resent = await resendPresentationMail(database, f.admin, f.eventId, receipt, randomUUID(), p.fingerprint);
  const [job] = await sql`SELECT upload_id,automatic_receipt_for,payload FROM presentation_email_jobs WHERE id=${resent.jobId}`;
  assert.equal(job.upload_id, s.uploadId); assert.equal(job.automatic_receipt_for, null); assert.equal(job.payload.upload.version, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, 2);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, secondId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_revision_requests`)[0].n, 1);
});
