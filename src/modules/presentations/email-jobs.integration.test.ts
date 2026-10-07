import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as statement } from 'drizzle-orm';
import * as schema from '../../database/schema.js';
import { preparePresentationScenario, openPresentationTestDatabase } from './test-support.js';
import { previewPresentationMail, createNotificationBatch } from './operations.js';
import { createPresentationRevision, cancelPresentationRevision } from './revisions.js';
import { runPresentationMailOnce, recoverPresentationJobs, resendPresentationMail, buildMailPayload, enqueuePresentationMail, type PresentationMailTransport } from './email-jobs.js';
import { digest } from './policy.js';
import { submitPresentationUpload } from './uploads.js';
import { reconcilePresentations } from './reconcile.js';
import { initializePresentations, presentationReadiness } from './startup.js';
import { runPresentationWorkerIteration, presentationWorkerHealthy, presentationHeartbeatPath } from './jobs-runner.js';
import type { PresentationDatabase } from './access.js';
import type { PresentationStorage } from './storage.js';

type Scenario = Awaited<ReturnType<typeof preparePresentationScenario>>;
const sent: { recipient: string; subject: string; html: string }[] = [];
const transport: PresentationMailTransport = { async send(input) { sent.push(input); return { providerMessageId: 'synthetic-accepted' }; } };
const deleted: string[] = [];
const storage: PresentationStorage = { publicBaseUrl: 'https://synthetic.r2.dev', async putObject() {},
  async deleteObject(key) { deleted.push(key); } };

test.beforeEach(() => { sent.length = 0; deleted.length = 0; process.env.PRESENTATION_EMAILS_ENABLED = 'true'; process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true'; });
test.afterEach(() => { process.env.PRESENTATION_EMAILS_ENABLED = 'false'; process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'false'; });

async function notice(s: Scenario, kind: 'initial' | 'reminder' = 'initial') {
  const selection = { kind, abstractIds: [s.fixture.abstractId] };
  const p = await previewPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, selection);
  return (await createNotificationBatch(s.database, s.fixture.admin, s.fixture.eventId, randomUUID(),
    { ...selection, previewFingerprint: p.fingerprint })).jobIds[0];
}
async function file() {
  const pdf = await PDFDocument.create(); pdf.addPage([120, 160]);
  return { buffer: Buffer.from(await pdf.save()), filename: 'synthetic.pdf', mimetype: 'application/pdf' };
}
async function accept(s: Scenario) {
  return submitPresentationUpload(s.database, s.fixture.owner, s.fixture.abstractId, randomUUID(), null, await file(), storage);
}
async function revision(s: Scenario) {
  const [clock] = await s.client`SELECT clock_timestamp()+interval '1 hour' AS deadline`;
  const selection = { kind: 'revision' as const, abstractId: s.fixture.abstractId, details: 'Synthetic revision',
    closesAt: new Date(clock.deadline).toISOString() };
  const p = await previewPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, selection);
  return createPresentationRevision(s.database, s.fixture.admin, s.fixture.eventId, s.fixture.abstractId, randomUUID(),
    { requestId: p.requestId!, details: selection.details, closesAt: p.closesAt!, previewFingerprint: p.fingerprint });
}
function peer(t: Parameters<typeof preparePresentationScenario>[0]) {
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  return { client, database: drizzle(client, { schema }) };
}

test('independent claimers send one per abstract, retain immutable body and provider acceptance audit', async t => {
  const s = await preparePresentationScenario(t), other = peer(t), jobId = await notice(s);
  const [before] = await s.client`SELECT payload,subject,html,template_version FROM presentation_email_jobs WHERE id=${jobId}`;
  const results = await Promise.all([runPresentationMailOnce(s.database, transport), runPresentationMailOnce(other.database, transport)]);
  assert.deepEqual(results.sort(), [false, true]); assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { recipient: before.payload.recipient, subject: before.subject, html: before.html });
  const [job] = await s.client`SELECT state,provider_message_id,request_started_at FROM presentation_email_jobs WHERE id=${jobId}`;
  assert.equal(job.state, 'sent'); assert.equal(job.provider_message_id, 'synthetic-accepted'); assert.ok(job.request_started_at);
  const [attempt] = await s.client`SELECT * FROM presentation_email_attempts WHERE job_id=${jobId}`;
  assert.equal(attempt.result, 'sent'); assert.equal(attempt.recipient, before.payload.recipient);
  assert.equal(attempt.html, before.html); assert.equal(attempt.template_version, before.template_version);
  assert.ok(attempt.finished_at); assert.ok(attempt.request_started_at);
  // A second work with the same owner/email stays a separate job.
  const [a] = await s.client`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES(${s.fixture.eventId},${s.fixture.ownerId},'PRIS-2026-P002','Second work','poster') RETURNING id`;
  await reconcilePresentations(s.database, [s.announcement, { ...s.announcement, id: 2, sequence: 2, trackingId: 'PRIS-2026-P002', title: 'Second work' }]);
  const selection = { kind: 'initial' as const, abstractIds: [s.fixture.abstractId, a.id] };
  const p = await previewPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, selection);
  await createNotificationBatch(s.database, s.fixture.admin, s.fixture.eventId, randomUUID(), { ...selection, previewFingerprint: p.fingerprint });
  await Promise.all([runPresentationMailOnce(s.database, transport), runPresentationMailOnce(other.database, transport)]);
  assert.equal(sent.length, 3);
});

test('unknown never retries; definite configuration failure supports explicit fresh resend', async t => {
  const s = await preparePresentationScenario(t), id = await notice(s);
  await runPresentationMailOnce(s.database, { async send() { throw Object.assign(new Error('timeout'), { deliveryState: 'unknown', code: 'SYNTHETIC_TIMEOUT' }); } });
  await recoverPresentationJobs(s.database); assert.equal(await runPresentationMailOnce(s.database, transport), false);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${id}`)[0].state, 'unknown');
  const p = await previewPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, { kind: 'resend', jobId: id });
  const next = await resendPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, id, randomUUID(), p.fingerprint);
  await runPresentationMailOnce(s.database, { async send() { throw Object.assign(new Error('config'), { deliveryState: 'failed', code: 'NIPAMAIL_PRE_SEND_FAILED' }); } });
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${next.jobId}`)[0].state, 'failed');
  assert.equal(await runPresentationMailOnce(s.database, transport), false);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_email_attempts`)[0].n, 2);
});

test('two recovery clients race: before-provider returns pending; after-provider becomes terminal unknown', async t => {
  const s = await preparePresentationScenario(t), other = peer(t), before = await notice(s), after = await notice(s);
  await s.client`UPDATE presentation_email_jobs SET state='sending',claim_token=gen_random_uuid(),lease_until=clock_timestamp()-interval '1 second',
    request_started_at=CASE WHEN id=${after} THEN clock_timestamp() ELSE NULL END`;
  await s.client`INSERT INTO presentation_email_attempts(job_id,claim_token,result,recipient,subject,html,template_version,request_started_at)
    SELECT id,claim_token,'sending',payload->>'recipient',subject,html,template_version,request_started_at FROM presentation_email_jobs`;
  await Promise.all([recoverPresentationJobs(s.database), recoverPresentationJobs(other.database)]);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${before}`)[0].state, 'pending');
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${after}`)[0].state, 'unknown');
  assert.deepEqual((await s.client`SELECT result FROM presentation_email_attempts ORDER BY job_id`).map(r => r.result).sort(), ['failed', 'unknown']);
  await Promise.all([runPresentationMailOnce(s.database, transport), runPresentationMailOnce(other.database, transport)]);
  assert.equal(sent.length, 1); assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_email_attempts`)[0].n, 3);
});

test('provider accepted then DB finish fails: restart never calls provider twice', async t => {
  const s = await preparePresentationScenario(t), id = await notice(s);
  await s.client.unsafe(`CREATE FUNCTION reject_mail_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='sent' THEN RAISE EXCEPTION 'synthetic commit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_mail_finish BEFORE UPDATE ON presentation_email_jobs FOR EACH ROW EXECUTE FUNCTION reject_mail_finish()`);
  await assert.rejects(runPresentationMailOnce(s.database, transport)); assert.equal(sent.length, 1);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${id}`)[0].state, 'sending');
  await s.client`UPDATE presentation_email_jobs SET lease_until=clock_timestamp()-interval '1 second'`;
  await runPresentationWorkerIteration(s.database, transport, storage);
  assert.equal(sent.length, 1); assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${id}`)[0].state, 'unknown');
});

test('flags, stale roster/owner/permission/deadline and used rights suppress queued notices before transport', async t => {
  const s = await preparePresentationScenario(t);
  const id = await notice(s); process.env.PRESENTATION_EMAILS_ENABLED = 'false';
  assert.equal(await runPresentationMailOnce(s.database, transport), false);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${id}`)[0].state, 'pending');
  process.env.PRESENTATION_EMAILS_ENABLED = 'true'; process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'false';
  await runPresentationMailOnce(s.database, transport); assert.equal(sent.length, 1);
  for (const change of ['owner', 'account', 'title', 'readiness', 'permission', 'deadline', 'roster'] as const) {
    const job = await notice(s);
    if (change === 'owner') await s.client`UPDATE users SET email='changed@example.invalid'`;
    if (change === 'account') {
      const [owner] = await s.client`INSERT INTO users(email,first_name,last_name)
        VALUES(${s.fixture.owner.email},'ชื่อ','นามสกุล') RETURNING id`;
      await s.client`UPDATE abstracts SET user_id=${owner.id}`;
    }
    if (change === 'title') await s.client`UPDATE abstracts SET title='Changed work'`;
    if (change === 'readiness') await s.client`UPDATE presentation_settings SET reconcile_ready=false`;
    if (change === 'permission') await s.client`UPDATE backoffice_users SET is_active=false`;
    if (change === 'deadline') await s.client`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
    if (change === 'roster') await reconcilePresentations(s.database, []);
    await runPresentationMailOnce(s.database, transport);
    assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${job}`)[0].state, 'suppressed');
    await s.client`UPDATE users SET email=${s.fixture.owner.email} WHERE id=${s.fixture.ownerId}`;
    await s.client`UPDATE abstracts SET title=${s.announcement.title},user_id=${s.fixture.ownerId}`;
    await s.client`UPDATE backoffice_users SET is_active=true`;
    await s.client`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '1 hour'`;
    await reconcilePresentations(s.database, [s.announcement]);
  }
  const used = await notice(s); process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true'; await accept(s);
  await runPresentationMailOnce(s.database, transport);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${used}`)[0].state, 'suppressed');
  assert.equal(sent.length, 1);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_email_attempts WHERE result='suppressed' AND request_started_at IS NULL`)[0].n, 8);
});

test('cancelled, expired and stale revision queues suppress; accepted receipt survives closed deadline/source withdrawal', async t => {
  const s = await preparePresentationScenario(t); await accept(s);
  await s.client`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
  await reconcilePresentations(s.database, []); await runPresentationMailOnce(s.database, transport); assert.equal(sent.length, 1);
  const cancelled = await revision(s);
  await cancelPresentationRevision(s.database, s.fixture.admin, s.fixture.eventId, cancelled.request.id, randomUUID(), { reason: 'Synthetic cancel' });
  await runPresentationMailOnce(s.database, transport);
  assert.equal((await s.client`SELECT state,error_code FROM presentation_email_jobs WHERE id=${cancelled.emailJobId}`)[0].error_code, 'PRESENTATION_REQUEST_CLOSED');
  const stale = await revision(s); await s.client`UPDATE users SET email='changed@example.invalid'`;
  await runPresentationMailOnce(s.database, transport);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${stale.emailJobId}`)[0].state, 'suppressed');
  await cancelPresentationRevision(s.database, s.fixture.admin, s.fixture.eventId, stale.request.id, randomUUID(), { reason: 'close' });
  const expired = await revision(s);
  await s.client`UPDATE presentation_revision_requests SET status='expired' WHERE id=${expired.request.id}`;
  await runPresentationMailOnce(s.database, transport); assert.equal(sent.length, 1);
});

test('receipt config failure remains accepted and can be refreshed/resubmitted; cleanup preserves accepted history', async t => {
  const s = await preparePresentationScenario(t); await s.client`UPDATE events SET website_url='invalid'`;
  const accepted = await accept(s);
  const [failed] = await s.client`SELECT id,state,error_code FROM presentation_email_jobs`;
  assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, 'PRESENTATION_RECEIPT_CONFIG_FAILED');
  await s.client`UPDATE events SET website_url='https://example.invalid'`;
  const p = await previewPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, { kind: 'resend', jobId: failed.id });
  const fresh = await resendPresentationMail(s.database, s.fixture.admin, s.fixture.eventId, failed.id, randomUUID(), p.fingerprint);
  await s.client`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
  await s.client`UPDATE presentation_upload_attempts SET lease_until=clock_timestamp()-interval '1 second',state='cleanup_pending'`;
  await runPresentationWorkerIteration(s.database, transport, storage); assert.equal(deleted.length, 0); assert.equal(sent.length, 1);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs WHERE id=${fresh.jobId}`)[0].state, 'sent');
  assert.equal((await s.client`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, accepted.upload.id);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, 1);
  // Failed/reserved orphan cleanup is still active while sending is paused.
  await s.client`UPDATE presentation_targets SET initial_enabled=true`;
  await s.client`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '1 hour'`;
  const orphanId = randomUUID();
  await s.client`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token)
    SELECT ${orphanId},id,${s.fixture.ownerId},${randomUUID()},${'a'.repeat(64)},'synthetic/orphan.pdf','orphan.pdf','application/pdf',1,${'a'.repeat(64)},
      clock_timestamp()-interval '1 second',${randomUUID()} FROM presentation_targets`;
  process.env.PRESENTATION_EMAILS_ENABLED = 'false'; await runPresentationWorkerIteration(s.database, transport, storage);
  assert.deepEqual(deleted, ['synthetic/orphan.pdf']);
  assert.equal((await s.client`SELECT state FROM presentation_upload_attempts WHERE id=${orphanId}`)[0].state, 'cleaned');
});

test('startup reconciles on both instances while paused, preserves settings and exposes enabled readiness/schema gate', async t => {
  const s = await preparePresentationScenario(t), other = peer(t); process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'false';
  const [before] = await s.client`SELECT closes_at FROM presentation_settings`;
  await Promise.all([initializePresentations(s.database), initializePresentations(other.database)]);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_targets`)[0].n, 1);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
  assert.equal(new Date((await s.client`SELECT closes_at FROM presentation_settings`)[0].closes_at).toISOString(), new Date(before.closes_at).toISOString());
  const [setting] = await s.client`SELECT manifest_digest,last_reconciled_at FROM presentation_settings`;
  await initializePresentations(s.database);
  assert.equal((await s.client`SELECT manifest_digest FROM presentation_settings`)[0].manifest_digest, setting.manifest_digest);
  assert.equal(await presentationReadiness(s.database), 'paused'); process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true';
  assert.equal(await presentationReadiness(s.database), 'ok');
  await s.client`UPDATE presentation_settings SET reconcile_ready=false`; assert.equal(await presentationReadiness(s.database), 'unavailable');
  // Mock only the missing-schema read, without dropping any schema.
  const missing = { async execute() { return [{ name: null }]; } } as unknown as PresentationDatabase;
  await assert.rejects(initializePresentations(missing), { code: 'PRESENTATION_SCHEMA_NOT_READY' });
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'false'; await initializePresentations(missing);
  await s.client.unsafe(`CREATE FUNCTION reject_startup_roster() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'synthetic startup roster failure'; END $$;
    CREATE TRIGGER reject_startup_roster BEFORE INSERT ON presentation_announcements FOR EACH ROW EXECUTE FUNCTION reject_startup_roster()`);
  await assert.rejects(initializePresentations(s.database));
  assert.equal((await s.client`SELECT reconcile_ready FROM presentation_settings`)[0].reconcile_ready, false);
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true'; assert.equal(await presentationReadiness(s.database), 'unavailable');
});

test('lost lease never reaches provider; heartbeat accepts only recent timestamp', async t => {
  const s = await preparePresentationScenario(t), other = peer(t), observer = peer(t); await notice(s);
  // A held workflow lock forces the precheck to wait after the independently committed claim.
  let unlock!: () => void, locked!: () => void;
  const held = new Promise<void>(resolve => { unlock = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const lock = other.database.transaction(async tx => {
    await tx.execute(statement`SELECT id FROM presentation_targets FOR UPDATE`); locked(); await held;
  });
  await ready; const worker = runPresentationMailOnce(s.database, transport);
  try {
    for (let i = 0; i < 100; i++) {
      if ((await observer.client`SELECT state FROM presentation_email_jobs`)[0].state === 'sending') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await observer.client`SELECT state FROM presentation_email_jobs`)[0].state, 'sending');
    await recoverPresentationJobs(observer.database);
    assert.equal((await observer.client`SELECT state FROM presentation_email_jobs`)[0].state, 'sending');
    await observer.client`UPDATE presentation_email_jobs SET lease_until=clock_timestamp()-interval '1 second'`;
    await recoverPresentationJobs(observer.database);
  } finally { unlock(); await lock; }
  await worker; assert.equal(sent.length, 0);
  assert.equal((await s.client`SELECT state FROM presentation_email_jobs`)[0].state, 'pending');
  await runPresentationMailOnce(s.database, transport); assert.equal(sent.length, 1);
  await writeFile(presentationHeartbeatPath, String(Date.now())); assert.equal(await presentationWorkerHealthy(), true);
  const healthy = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/modules/presentations/jobs-runner.ts', '--healthcheck'], {
      env: { ...process.env, DATABASE_URL: 'synthetic-invalid-runtime-url',
        DOTENV_CONFIG_PATH: 'synthetic-no-dotenv-file', NIPAMAIL_CLIENT_ID: '', NIPAMAIL_CLIENT_SECRET: '' },
    });
  assert.equal(healthy.stderr, ''); assert.equal(healthy.stdout, '');
  await writeFile(presentationHeartbeatPath, String(Date.now() - 60_001)); assert.equal(await presentationWorkerHealthy(), false);
  await writeFile(presentationHeartbeatPath, 'NaN'); assert.equal(await presentationWorkerHealthy(), false);
  await rm(presentationHeartbeatPath, { force: true }); assert.equal(await presentationWorkerHealthy(), false);
});

test('manual batch queues once per selected work, never per recipient, with replay and fresh preview', async t => {
  const { client: sql, database, fixture: f, announcement } = await preparePresentationScenario(t);
  const [second] = await sql`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES (${f.eventId},${f.ownerId},'PRIS-2026-P002','Second work','poster') RETURNING id`;
  await reconcilePresentations(database, [announcement, { ...announcement, id: 2, trackingId: 'PRIS-2026-P002', title: 'Second work', presentationType: 'highlighted-poster' }]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
  const input = { kind: 'initial' as const, abstractIds: [second.id, f.abstractId, f.abstractId] };
  const preview = await previewPresentationMail(database, f.admin, f.eventId, input);
  assert.equal(preview.messages.length, 2);
  const batchInput = { ...input, previewFingerprint: preview.fingerprint }, key = randomUUID();
  const batch = await createNotificationBatch(database, f.admin, f.eventId, key, batchInput);
  assert.equal(batch.queued, 2);
  assert.deepEqual(await createNotificationBatch(database, f.admin, f.eventId, key, batchInput), batch);
  const jobs = await sql`SELECT payload->>'recipient' AS recipient,payload->>'abstractId' AS abstract_id FROM presentation_email_jobs`;
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map(j => j.abstract_id)).size, 2);
  assert.equal(new Set(jobs.map(j => j.recipient)).size, 1);
  await sql`UPDATE users SET email='changed@example.invalid' WHERE id=${f.ownerId}`;
  await assert.rejects(createNotificationBatch(database, f.admin, f.eventId, randomUUID(), batchInput), { statusCode: 409 });
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 2);
});

test('preview schemas reject browser recipients; changed source, title or deadline reject whole batch', async t => {
  const { client: sql, database, fixture: f, announcement } = await preparePresentationScenario(t);
  const input = { kind: 'reminder' as const, abstractIds: [f.abstractId] };
  await assert.rejects(previewPresentationMail(database, f.admin, f.eventId, { ...input, recipient: 'intruder@example.invalid' } as typeof input));
  for (const field of ['source', 'title', 'deadline']) {
    const preview = await previewPresentationMail(database, f.admin, f.eventId, input);
    if (field === 'source') await reconcilePresentations(database, [{ ...announcement, affiliation: 'New affiliation' }]);
    if (field === 'title') await sql`UPDATE abstracts SET title='Changed after preview' WHERE id=${f.abstractId}`;
    if (field === 'deadline') await sql`UPDATE presentation_settings SET closes_at=closes_at+interval '1 hour'`;
    await assert.rejects(createNotificationBatch(database, f.admin, f.eventId, randomUUID(), { ...input, previewFingerprint: preview.fingerprint }), { statusCode: 409 });
    if (field === 'title') await sql`UPDATE abstracts SET title=${announcement.title} WHERE id=${f.abstractId}`;
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_operations`)[0].n, 0);
});

test('separate clients replay a manual batch once; audit failure rolls back all jobs', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const peer = openPresentationTestDatabase();
  t.after(() => peer.end({ timeout: 2 }));
  const other = drizzle(peer, { schema });
  const selection = { kind: 'initial' as const, abstractIds: [f.abstractId] };
  const preview = await previewPresentationMail(database, f.admin, f.eventId, selection);
  const input = { ...selection, previewFingerprint: preview.fingerprint }, key = randomUUID();
  const [a, b] = await Promise.all([createNotificationBatch(database, f.admin, f.eventId, key, input), createNotificationBatch(other, f.admin, f.eventId, key, input)]);
  assert.deepEqual(a, b);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 1);
  await sql.unsafe(`CREATE FUNCTION reject_batch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='notification_batch' THEN RAISE EXCEPTION 'synthetic batch audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_batch_audit BEFORE INSERT ON presentation_audit_events FOR EACH ROW EXECUTE FUNCTION reject_batch_audit()`);
  await assert.rejects(createNotificationBatch(database, f.admin, f.eventId, randomUUID(), input));
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 1);
});

test('revision and receipt previews are read-only, scoped and immutable; resend checks terminal state', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const [target] = await sql`SELECT id FROM presentation_targets`;
  const uploadId = randomUUID(), attemptId = randomUUID();
  await sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token)
    VALUES (${attemptId},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},'synthetic/poster.png','poster.png','image/png',1,${'a'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()})`;
  await sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,version,user_id,object_key,public_url,filename,mime_type,size_bytes,digest,received_at)
    VALUES (${uploadId},${target.id},${attemptId},1,${f.ownerId},'synthetic/poster.png','https://example.invalid/poster.png','poster.png','image/png',1,${'a'.repeat(64)},clock_timestamp())`;
  await sql`UPDATE presentation_targets SET current_upload_id=${uploadId},initial_enabled=false`;
  const closesAt = new Date(Date.now()+3600000).toISOString();
  const draft = { kind: 'revision' as const, abstractId: f.abstractId, details: 'Please update caption', closesAt };
  const preview = await previewPresentationMail(database, f.admin, f.eventId, draft);
  assert.ok(preview.requestId);
  assert.equal(preview.closesAt, closesAt);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_revision_requests`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
  const base = await buildMailPayload(database, target.id, 'revision');
  assert.equal(preview.fingerprint, digest([{ ...base, revisionRequestId: preview.requestId, revisionDetails: draft.details, closesAt }]));
  await sql`INSERT INTO presentation_revision_requests(id,target_id,details,closes_at,requested_by)
    VALUES (${preview.requestId!},${target.id},${draft.details},${closesAt},${f.adminId})`;
  const existing = await previewPresentationMail(database, f.admin, f.eventId, { ...draft, requestId: preview.requestId });
  assert.equal(existing.fingerprint, preview.fingerprint);
  await assert.rejects(previewPresentationMail(database, f.admin, f.eventId, { ...draft, requestId: preview.requestId, details: 'Different' }), { code: 'PRESENTATION_REQUEST_IMMUTABLE' });
  await assert.rejects(previewPresentationMail(database, f.admin, f.eventId, draft), { code: 'PRESENTATION_ACTIVE_REQUEST_EXISTS' });
  const receipt = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'receipt', abstractId: f.abstractId, uploadId });
  assert.equal(receipt.messages[0].recipient, f.owner.email);
  await assert.rejects(previewPresentationMail(database, f.admin, f.eventId, { kind: 'receipt', abstractId: f.abstractId, uploadId: randomUUID() }), { code: 'PRESENTATION_UPLOAD_NOT_FOUND' });
  const jobId = await database.transaction(async tx => enqueuePresentationMail(tx, target.id,
    await buildMailPayload(tx, target.id, 'revision', preview.requestId), f.adminId, { requestId: preview.requestId }));
  await assert.rejects(previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId }), { code: 'PRESENTATION_MAIL_IN_PROGRESS' });
  await sql`UPDATE presentation_email_jobs SET state='failed' WHERE id=${jobId}`;
  assert.equal((await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId })).fingerprint, preview.fingerprint);
  await sql`UPDATE presentation_revision_requests SET status='expired' WHERE id=${preview.requestId!}`;
  await assert.rejects(previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId }), { code: 'PRESENTATION_REQUEST_CLOSED' });
});
