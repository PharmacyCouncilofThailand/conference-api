import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as statement } from 'drizzle-orm';
import { validatePresentationFile } from './file-validation.js';
import { finalizePresentationAttempt, submitPresentationUpload, readUploadGate, reserveUploadAttempt, type AttemptReservation } from './uploads.js';
import { cancelPresentationRevision } from './revisions.js';
import { previewPresentationMail } from './operations.js';
import { resendPresentationMail } from './email-jobs.js';
import type { PresentationDatabase } from './access.js';
import { cleanupFailedAttempt, storePresentationAttempt, type PresentationStorage } from './storage.js';
import { openPresentationTestDatabase, preparePresentationScenario, type TestSql } from './test-support.js';

async function validFile(filename = 'synthetic-owner.pdf') {
  const pdf = await PDFDocument.create(); pdf.addPage([120, 160]);
  return validatePresentationFile({ buffer: Buffer.from(await pdf.save()), filename, mimetype: 'application/pdf' }, 'poster');
}
function memoryStorage() {
  const objects = new Map<string, Buffer>(), deleted: string[] = [];
  const storage: PresentationStorage = {r2:()=>({ publicBaseUrl: 'https://synthetic.r2.dev',
    async putObject(input) { objects.set(input.key, input.body); },
    async deleteObject(key) { deleted.push(key); objects.delete(key); } }),drive:{rootFolderId:()=>{throw Error('Unexpected Drive');},generateId:async()=>{throw Error('Unexpected Drive');},folder:async()=>{throw Error('Unexpected Drive');},write:async()=>{throw Error('Unexpected Drive');},delete:async()=>{throw Error('Unexpected Drive');}}};
  return { storage, objects, deleted };
}

test('Highlighted Poster uploads original PNG to R2, replays once, and switches PDF/PNG on revision', async t => {
  const { client: sql, database, fixture: f, announcement } = await preparePresentationScenario(t);
  const { reconcilePresentations } = await import('./reconcile.js');
  await reconcilePresentations(database,[{...announcement,presentationType:'highlighted-poster'}]);
  const image = await sharp({create:{width:16,height:24,channels:3,background:'white'}}).png().toBuffer();
  const input = {buffer:image,filename:'poster.png',mimetype:'image/png'};
  const {storage,objects} = memoryStorage(); const contentTypes:string[]=[];
  const originalR2 = storage.r2;
  storage.r2 = () => ({...originalR2(),async putObject(value){contentTypes.push(value.contentType);await originalR2().putObject(value);}});
  const key = randomUUID();
  const first = await submitPresentationUpload(database,f.owner,f.abstractId,key,null,input,storage);
  assert.equal(first.upload.mimeType,'image/png'); assert.equal(first.upload.storageProvider,'r2');
  assert.ok(first.upload.fileUrl.endsWith('.png')); assert.equal(objects.size,1);
  assert.deepEqual([...objects.values()][0],image); assert.deepEqual(contentTypes,['image/png']);
  const replay = await submitPresentationUpload(database,f.owner,f.abstractId,key,null,input,storage);
  assert.equal(replay.upload.id,first.upload.id); assert.equal(objects.size,1);
  await assert.rejects(submitPresentationUpload(database,f.owner,f.abstractId,randomUUID(),null,input,storage),{code:'PRESENTATION_ALREADY_SUBMITTED'});
  const request = await revision(sql,f.adminId);
  const updated = await submitPresentationUpload(database,f.owner,f.abstractId,randomUUID(),request,await inputFile(),storage);
  assert.equal(updated.upload.mimeType,'application/pdf'); assert.equal(updated.upload.version,2);assert.equal(objects.size,2);
  const next = await revision(sql,f.adminId);
  const third = await submitPresentationUpload(database,f.owner,f.abstractId,randomUUID(),next,input,storage);
  assert.equal(third.upload.mimeType,'image/png');assert.equal(third.upload.version,3);assert.equal(objects.size,3);
  assert.deepEqual(contentTypes,['image/png','application/pdf','image/png']);
  await assertCounts(sql,3);
});
function oralStorage() {
  const files = new Map<string, Buffer>(), deleted: string[] = [], folders: string[] = [];
  const storage: PresentationStorage = {r2: () => assert.fail('Oral must never initialize R2'), drive: {
    rootFolderId: () => 'abstract-root', generateId: async () => randomUUID(),
    folder: async (parent, name) => {folders.push(name); return `${parent}/${name}`;},
    write: async input => {files.set(input.fileId, input.buffer);
      assert.ok(input.parentId.endsWith('/Oral/Presentation Oral/สาขาตัวอย่าง/PRIS-2026-O001'));
      return {fileId: input.fileId, fileUrl: `https://drive.google.com/file/d/${input.fileId}/view`, storedFileName: input.fileName};},
    delete: async id => {deleted.push(id); files.delete(id);},
  }};
  return {storage, files, deleted, folders};
}
async function oralFile() {
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  return {buffer: Buffer.from(await pdf.save()), filename: 'ชื่อ slides.PDF', mimetype: 'application/pdf'};
}

test('Oral rounds 1 and 2 accept initial/revision files, retain same names with distinct IDs and replay accepted rights', async t => {
  for (const round of [1, 2] as const) await t.test(`round ${round}`, async child => {
    const {client, database, fixture: f} = await preparePresentationScenario(child, {type: 'oral', round});
    const {storage, files, deleted, folders} = oralStorage(), file = await oralFile(), key = randomUUID();
    const first = await submitPresentationUpload(database, f.owner, f.abstractId, key, null, file, storage);
    assert.equal(first.upload.version, 1); assert.equal(first.upload.storageProvider, 'drive');
    assert.equal(first.upload.fileName, file.filename); assert.equal(first.upload.storedFileName, `PRIS-2026-O001_${file.filename}`);
    assert.equal(first.upload.fileUrl, `https://drive.google.com/file/d/${first.upload.driveFileId}/view`);
    const requestId = await revision(client, f.adminId);
    const second = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage);
    assert.equal(second.upload.version, 2); assert.notEqual(first.upload.driveFileId, second.upload.driveFileId);
    assert.equal(first.upload.storedFileName, second.upload.storedFileName);
    assert.equal((await client`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, second.upload.id);
    assert.equal((await client`SELECT status FROM presentation_revision_requests`)[0].status, 'submitted');
    await client`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 hour'`;
    assert.equal((await submitPresentationUpload(database, f.owner, f.abstractId, key, null, file, storage)).replayed, true);
    assert.equal(files.size, 2); assert.equal(deleted.length, 0);
    assert.deepEqual(folders.slice(0, 5), ['PRIS-2026','Oral','Presentation Oral','สาขาตัวอย่าง','PRIS-2026-O001']);
    await assertCounts(client, 2);
  });
});

test('Oral identity is committed before provider bytes; unknown provider outcome defers cleanup until lease recovery', async t => {
  const {client, database, fixture: f} = await preparePresentationScenario(t, {type: 'oral'});
  const {storage, files, deleted} = oralStorage(), file = await oralFile();
  const write = storage.drive.write;
  storage.drive.write = async input => {
    const [saved] = await client`SELECT drive_file_id,drive_folder_id,state FROM presentation_upload_attempts WHERE id=${input.attemptId}`;
    assert.equal(saved.drive_file_id, input.fileId); assert.equal(saved.drive_folder_id, input.parentId); assert.equal(saved.state, 'reserved');
    await write(input);
    throw Object.assign(Error('lost create/read outcome'), {storageOutcome: 'unknown'});
  };
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage), {storageOutcome: 'unknown'});
  const [attempt] = await client`SELECT * FROM presentation_upload_attempts`;
  assert.equal(attempt.state, 'reserved'); assert.equal(attempt.error_code, null); assert.equal(files.size, 1); assert.equal(deleted.length, 0);
  await assertCounts(client, 0);
  await cleanupFailedAttempt(database, attempt.id, storage); assert.equal(deleted.length, 0);
  await client`UPDATE presentation_upload_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${attempt.id}`;
  await cleanupFailedAttempt(database, attempt.id, storage);
  assert.deepEqual(deleted, [attempt.drive_file_id]); assert.equal(files.size, 0);
});

test('Oral permission failure never accepts a file; cleanup retains all accepted versions and rejects missing location', async t => {
  const {client, database, fixture: f} = await preparePresentationScenario(t, {type: 'oral'});
  const {storage, files, deleted} = oralStorage(), file = await oralFile(), write = storage.drive.write;
  storage.drive.write = async input => {await write(input); throw Error('public sharing failed');};
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage), {code: 'PRESENTATION_STORAGE_FAILED'});
  await assertCounts(client, 0); assert.equal(files.size, 0); assert.equal(deleted.length, 1);
  storage.drive.write = write;
  const accepted = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  await client`UPDATE presentation_upload_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${accepted.upload.id}`;
  await cleanupFailedAttempt(database, accepted.upload.id, storage); assert.equal(files.size, 1); assert.equal(deleted.length, 1);
  const requestId = await revision(client, f.adminId);
  await client`UPDATE abstracts SET category_id=NULL WHERE id=${f.abstractId}`;
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage), {code: 'PRESENTATION_STORAGE_CONTEXT_INVALID'});
  assert.equal(files.size, 1); await assertCounts(client, 1);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function inputFile(filename = 'synthetic-owner.pdf') {
  const validated = await validFile(filename);
  return { buffer: validated.buffer, filename, mimetype: validated.mimeType };
}
async function revision(sql: TestSql, adminId: number, interval = '1 hour') {
  const [request] = await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
    SELECT id,'Synthetic revision',clock_timestamp()+${interval}::interval,${adminId} FROM presentation_targets LIMIT 1 RETURNING id`;
  return request.id as string;
}
async function assertCounts(sql: TestSql, uploads: number, receipts = uploads) {
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, uploads);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs WHERE automatic_receipt_for IS NOT NULL`)[0].n, receipts);
}
// Foundation fixtures only: T11 must prove actual atomic acceptance and receipt creation.
async function acceptedFixture(sql: TestSql, attempt: AttemptReservation, version: number) {
  await sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,request_id,version,user_id,storage_provider,object_key,file_url,
    original_filename,stored_filename,mime_type,size_bytes,digest,received_at)
    SELECT id,target_id,id,request_id,${version},user_id,storage_provider,object_key,${`https://synthetic.r2.dev/${attempt.identity.objectKey!}`},
      original_filename,stored_filename,mime_type,size_bytes,digest,clock_timestamp() FROM presentation_upload_attempts WHERE id=${attempt.attemptId}`;
  await sql`UPDATE presentation_targets SET current_upload_id=${attempt.attemptId} WHERE id=(SELECT target_id FROM presentation_upload_attempts WHERE id=${attempt.attemptId})`;
  await sql`UPDATE presentation_upload_attempts SET state='accepted' WHERE id=${attempt.attemptId}`;
}

test('reservation does not consume rights; failures, fingerprints and claims remain durable', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await validFile(), key = randomUUID();
  const attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file);
  assert.equal(attempt.kind, 'reserved');
  assert.match(attempt.identity.objectKey!, new RegExp(`^events/${f.eventId}/presentations/${f.abstractId}/[0-9a-f-]+\\.pdf$`));
  assert.equal(attempt.identity.objectKey!.includes(file.filename), false);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, 0);
  await assert.rejects(reserveUploadAttempt(database, { ...f.owner, id: f.ownerId + 100 }, f.abstractId, key, null, file),
    { code: 'PRESENTATION_OWNER_REQUIRED', statusCode: 403 });
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file), { code: 'PRESENTATION_UPLOAD_IN_PROGRESS' });
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, key, null, { ...file, digest: 'a'.repeat(64) }),
    { code: 'PRESENTATION_IDEMPOTENCY_CONFLICT', statusCode: 409 });
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, key, null, { ...file, filename: 'other.pdf' }),
    { code: 'PRESENTATION_IDEMPOTENCY_CONFLICT' });
  const { storage, objects } = memoryStorage();
  await assert.rejects(storePresentationAttempt(database, attempt, file, {...storage,r2:()=>({ ...storage.r2(), async putObject() { throw new Error('R2 failure'); } })}),
    { code: 'PRESENTATION_STORAGE_FAILED' });
  assert.equal((await sql`SELECT state FROM presentation_upload_attempts WHERE id=${attempt.attemptId}`)[0].state, 'reserved');
  await assert.rejects(storePresentationAttempt(database, { ...attempt, claimToken: randomUUID() }, file, storage),
    { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  assert.equal((await sql`SELECT state FROM presentation_upload_attempts WHERE id=${attempt.attemptId}`)[0].state, 'reserved');
  await storePresentationAttempt(database, attempt, file, storage);
  assert.strictEqual(objects.get(attempt.identity.objectKey!), file.buffer);
  const retry = await reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file);
  assert.equal(retry.kind, 'stored'); assert.equal(retry.attemptId, attempt.attemptId);
  await sql`UPDATE presentation_upload_attempts SET lease_until=clock_timestamp() WHERE id=${attempt.attemptId}`;
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  const fresh = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), null, file);
  assert.notEqual(fresh.identity.objectKey!, attempt.identity.objectKey!);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, null);
});

test('accepted replay returns the original version after deadline but rechecks ownership', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await validFile(), key = randomUUID(), { storage } = memoryStorage();
  const attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file);
  await storePresentationAttempt(database, attempt, file, storage); await acceptedFixture(sql, attempt, 1);
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
  const replay = await reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file);
  assert.equal(replay.kind, 'replay'); assert.equal(replay.upload?.version, 1); assert.equal(replay.upload?.id, attempt.attemptId);
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, key, null, { ...file, digest: 'a'.repeat(64) }),
    { code: 'PRESENTATION_IDEMPOTENCY_CONFLICT' });
  await sql`UPDATE users SET status='inactive' WHERE id=${f.ownerId}`;
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, key, null, file), { code: 'PRESENTATION_OWNER_REQUIRED' });
});

test('gate rejects foreign, cancelled, terminal and expired revision requests without reservations', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await validFile();
  const [other] = await sql`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES(${f.eventId},${f.ownerId},'PRIS-2026-P002','Synthetic other','poster') RETURNING id`;
  const [target] = await sql`INSERT INTO presentation_targets(event_id,abstract_id) VALUES(${f.eventId},${other.id}) RETURNING id`;
  const [foreign] = await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
    VALUES(${target.id},'Synthetic revision',clock_timestamp()+interval '1 hour',${f.adminId}) RETURNING id`;
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), foreign.id, file),
    { code: 'PRESENTATION_REQUEST_NOT_FOUND', statusCode: 404 });
  const [own] = await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
    SELECT id,'Synthetic revision',clock_timestamp()-interval '1 second',${f.adminId} FROM presentation_targets WHERE abstract_id=${f.abstractId}
    RETURNING id`;
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), own.id, file), { code: 'PRESENTATION_REQUEST_EXPIRED' });
  await sql`UPDATE presentation_revision_requests SET status='expired' WHERE id=${own.id}`;
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), own.id, file), { code: 'PRESENTATION_REQUEST_CLOSED' });
  const [cancelled] = await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by,status,cancelled_by,cancelled_at,cancellation_reason)
    SELECT id,'Synthetic cancel',clock_timestamp()+interval '1 hour',${f.adminId},'cancelled',${f.adminId},clock_timestamp(),'Test reason'
    FROM presentation_targets WHERE abstract_id=${f.abstractId} RETURNING id`;
  await assert.rejects(reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), cancelled.id, file), { code: 'PRESENTATION_REQUEST_CANCELLED' });
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_upload_attempts`)[0].n, 0);
});

test('cleanup protects current and historical successful versions, even stored-state reference', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await validFile(), { storage, objects, deleted } = memoryStorage();
  const first = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), null, file);
  await storePresentationAttempt(database, first, file, storage); await acceptedFixture(sql, first, 1);
  const [request] = await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
    SELECT id,'Synthetic revision',clock_timestamp()+interval '1 hour',${f.adminId} FROM presentation_targets RETURNING id`;
  const second = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), request.id, file);
  await storePresentationAttempt(database, second, file, storage); await acceptedFixture(sql, second, 2);
  await sql`UPDATE presentation_upload_attempts SET state='stored',lease_until=clock_timestamp()-interval '1 second' WHERE id=${first.attemptId}`;
  await cleanupFailedAttempt(database, first.attemptId, storage);
  await cleanupFailedAttempt(database, second.attemptId, storage);
  assert.equal(deleted.length, 0); assert.equal(objects.size, 2);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, second.attemptId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, 2);
});

test('cleanup waits for live lease; terminal claim blocks stale Put mark and retries failed delete', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await validFile(), { storage, deleted } = memoryStorage();
  const attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), null, file);
  await storePresentationAttempt(database, attempt, file, storage);
  await cleanupFailedAttempt(database, attempt.attemptId, storage); assert.equal(deleted.length, 0);
  await sql`UPDATE presentation_upload_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${attempt.attemptId}`;
  await cleanupFailedAttempt(database, attempt.attemptId, {...storage,r2:()=>({ ...storage.r2(), async deleteObject() { throw new Error('synthetic delete failure'); } })});
  const [failed] = await sql`SELECT state,error_code FROM presentation_upload_attempts WHERE id=${attempt.attemptId}`;
  assert.equal(failed.state, 'cleanup_pending'); assert.equal(failed.error_code, 'PRESENTATION_CLEANUP_FAILED');
  await assert.rejects(storePresentationAttempt(database, attempt, file, storage), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  await cleanupFailedAttempt(database, attempt.attemptId, storage);
  assert.deepEqual(deleted, [attempt.identity.objectKey!]);
  assert.equal((await sql`SELECT state FROM presentation_upload_attempts WHERE id=${attempt.attemptId}`)[0].state, 'cleaned');
  await cleanupFailedAttempt(database, attempt.attemptId, storage); assert.equal(deleted.length, 1);
  await cleanupFailedAttempt(database, randomUUID(), storage); assert.equal(deleted.length, 1);
});

test('gate reads database clock after waiting on target lock', { timeout: 15_000 }, async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const locker = openPresentationTestDatabase(), clockReader = openPresentationTestDatabase();
  t.after(async () => { await locker.end({ timeout: 2 }); await clockReader.end({ timeout: 2 }); });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '400 milliseconds'`;
  const locking = locker.begin(async tx => {
    await (tx as unknown as TestSql)`SELECT id FROM presentation_targets FOR UPDATE`; entered(); await blocked;
  });
  await held;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const gate = database.transaction(async tx => {
    await tx.execute(statement`SELECT clock_timestamp()`); started();
    return readUploadGate(tx, f.owner, f.abstractId, null);
  });
  const rejection = assert.rejects(gate, { code: 'PRESENTATION_DEADLINE_PASSED' });
  try {
    await beginning;
    for (;;) {
      const [clock] = await clockReader`SELECT clock_timestamp()>=closes_at AS closed FROM presentation_settings`;
      if (clock.closed) break;
    }
  } finally { release(); }
  await locking; await rejection;
});

test('actual acceptance is atomic, replayed once, and revision retains originals and one receipt per version', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), key = randomUUID(), { storage, objects, deleted } = memoryStorage();
  const first = await submitPresentationUpload(database, f.owner, f.abstractId, key, null, file, storage);
  assert.equal(first.replayed, false); assert.equal(first.upload.version, 1);
  assert.deepEqual(await submitPresentationUpload(database, f.owner, f.abstractId, key, null, file, storage), { ...first, replayed: true });
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, key, null, { ...file, filename: 'changed.pdf' }, storage),
    { code: 'PRESENTATION_IDEMPOTENCY_CONFLICT' });
  await assertCounts(sql, 1);
  const requestId = await revision(sql, f.adminId);
  // Main close has no effect on an active revision's independent deadline.
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
  const second = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId.toUpperCase(), file, storage);
  assert.equal(second.upload.version, 2); assert.equal(second.upload.revisionRequestId, requestId);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, second.upload.id);
  assert.equal((await sql`SELECT status,submitted_at FROM presentation_revision_requests WHERE id=${requestId}`)[0].status, 'submitted');
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage), { code: 'PRESENTATION_REQUEST_CLOSED' });
  await assertCounts(sql, 2); assert.equal(objects.size, 2); assert.equal(deleted.length, 0);
  assert.equal((await sql`SELECT payload FROM presentation_email_jobs WHERE automatic_receipt_for=${first.upload.id}`)[0].payload.recipient, f.owner.email);
  await sql`UPDATE presentation_email_jobs SET state='failed' WHERE automatic_receipt_for=${first.upload.id}`;
  const [job] = await sql`SELECT id FROM presentation_email_jobs WHERE automatic_receipt_for=${first.upload.id}`;
  const preview = await previewPresentationMail(database, f.admin, f.eventId, { kind: 'resend', jobId: job.id });
  const resent = await resendPresentationMail(database, f.admin, f.eventId, job.id, randomUUID(), preview.fingerprint);
  const [linked] = await sql`SELECT upload_id,parent_job_id,automatic_receipt_for FROM presentation_email_jobs WHERE id=${resent.jobId}`;
  assert.equal(linked.upload_id, first.upload.id); assert.equal(linked.parent_job_id, job.id); assert.equal(linked.automatic_receipt_for, null);
  await assertCounts(sql, 2);
});

test('two independent clients and different initial keys accept exactly one version', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const secondClient = openPresentationTestDatabase(); t.after(() => secondClient.end({ timeout: 2 }));
  const secondDb = drizzle(secondClient) as PresentationDatabase, entered = deferred(), release = deferred();
  const { storage } = memoryStorage(), file = await inputFile();
  let puts = 0;
  const blocked: PresentationStorage = {...storage,r2:()=>({ ...storage.r2(), async putObject(input) {
    await storage.r2().putObject(input); if (++puts === 2) entered.resolve(); await release.promise;
  } })};
  const submissions = [database, secondDb].map(db => submitPresentationUpload(db, f.owner, f.abstractId, randomUUID(), null, file, blocked));
  const resultsPromise = Promise.allSettled(submissions);
  await entered.promise; release.resolve();
  const results = await resultsPromise;
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code, 'PRESENTATION_ALREADY_SUBMITTED'); await assertCounts(sql, 1);
});

test('same key in flight rejects, then replays on an independent client without another put or receipt', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  const otherDb = drizzle(client) as PresentationDatabase, entered = deferred(), release = deferred();
  const file = await inputFile(), key = randomUUID(), { storage } = memoryStorage(); let puts = 0;
  const blocked = {...storage,r2:()=>({ ...storage.r2(), async putObject(input: Parameters<ReturnType<PresentationStorage['r2']>['putObject']>[0]) {
    ++puts; entered.resolve(); await release.promise; await storage.r2().putObject(input);
  } })};
  const first = submitPresentationUpload(database, f.owner, f.abstractId, key, null, file, blocked);
  await entered.promise;
  await assert.rejects(submitPresentationUpload(otherDb, f.owner, f.abstractId, key, null, file, blocked), { code: 'PRESENTATION_UPLOAD_IN_PROGRESS' });
  release.resolve(); const accepted = await first;
  const replay = await submitPresentationUpload(otherDb, f.owner, f.abstractId, key, null, file, blocked);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.upload, accepted.upload); assert.equal(puts, 1); await assertCounts(sql, 1);
});

test('two independent revision uploads use one request once and retain the original', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  const otherDb = drizzle(client) as PresentationDatabase, entered = deferred(), release = deferred();
  const file = await inputFile(), { storage, objects } = memoryStorage();
  const original = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  const requestId = await revision(sql, f.adminId); let puts = 0;
  const blocked: PresentationStorage = {...storage,r2:()=>({ ...storage.r2(), async putObject(input) {
    await storage.r2().putObject(input); if (++puts === 2) entered.resolve(); await release.promise;
  } })};
  const resultsPromise = Promise.allSettled([database, otherDb].map(db =>
    submitPresentationUpload(db, f.owner, f.abstractId, randomUUID(), requestId, file, blocked)));
  await entered.promise; release.resolve(); const results = await resultsPromise;
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const success = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof submitPresentationUpload>>>;
  assert.equal(success.value.upload.version, 2);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'PRESENTATION_REQUEST_CLOSED');
  await assertCounts(sql, 2); assert.equal(objects.size, 2);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, success.value.upload.id);
  assert.equal((await sql`SELECT id FROM presentation_uploads WHERE version=1`)[0].id, original.upload.id);
});

test('R2 and SQL outbox failures never consume rights; fresh key succeeds', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage, deleted } = memoryStorage();
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file,
    {...storage,r2:()=>({ ...storage.r2(), async putObject() { throw Error('synthetic R2 failure'); } })}), { code: 'PRESENTATION_STORAGE_FAILED' });
  await assertCounts(sql, 0);
  await sql.unsafe(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt SQL failure'; END $$;
    CREATE TRIGGER fail_receipt_insert BEFORE INSERT ON presentation_email_jobs FOR EACH ROW EXECUTE FUNCTION fail_receipt();`);
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage), /synthetic receipt SQL failure/);
  await assertCounts(sql, 0); assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, null);
  assert.ok(deleted.length >= 1);
  await sql.unsafe('DROP TRIGGER fail_receipt_insert ON presentation_email_jobs');
  const success = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  assert.equal(success.upload.version, 1); await assertCounts(sql, 1);
  const requestId = await revision(sql, f.adminId);
  await sql.unsafe('CREATE TRIGGER fail_receipt_insert BEFORE INSERT ON presentation_email_jobs FOR EACH ROW EXECUTE FUNCTION fail_receipt()');
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage), /synthetic receipt SQL failure/);
  await assertCounts(sql, 1);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, success.upload.id);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests WHERE id=${requestId}`)[0].status, 'open');
  await sql.unsafe('DROP TRIGGER fail_receipt_insert ON presentation_email_jobs');
  assert.equal((await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage)).upload.version, 2);
  await assertCounts(sql, 2);
});

test('SQL receipt payload read error rolls back while pure website config error accepts with failed receipt', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage();
  await sql.unsafe('ALTER TABLE events RENAME COLUMN website_url TO unavailable_website');
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage), /website_url/);
  await assertCounts(sql, 0); assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, null);
  await sql.unsafe('ALTER TABLE events RENAME COLUMN unavailable_website TO website_url');
  await sql`UPDATE events SET website_url=NULL`;
  const accepted = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  await assertCounts(sql, 1);
  const [job] = await sql`SELECT state,error_code,upload_id,automatic_receipt_for FROM presentation_email_jobs`;
  assert.equal(job.state, 'failed'); assert.equal(job.error_code, 'PRESENTATION_RECEIPT_CONFIG_FAILED');
  assert.equal(job.upload_id, accepted.upload.id); assert.equal(job.automatic_receipt_for, accepted.upload.id);
  await sql`UPDATE events SET website_url='https://example.invalid'`;
  const requestId = await revision(sql, f.adminId);
  await sql`UPDATE users SET email='invalid recipient' WHERE id=${f.ownerId}`;
  const revised = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage);
  assert.equal(revised.upload.version, 2); await assertCounts(sql, 2);
  assert.equal((await sql`SELECT state,error_code FROM presentation_email_jobs WHERE automatic_receipt_for=${revised.upload.id}`)[0].error_code,
    'PRESENTATION_RECEIPT_CONFIG_FAILED');
});

test('post-R2 cancellation rejects and preserves current/history and automatic receipts', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage();
  const original = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  const requestId = await revision(sql, f.adminId), entered = deferred(), release = deferred();
  const submission = submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file,
    {...storage,r2:()=>({ ...storage.r2(), async putObject(input) { entered.resolve(); await release.promise; await storage.r2().putObject(input); } })});
  const rejection = assert.rejects(submission, { code: 'PRESENTATION_REQUEST_CANCELLED' });
  await entered.promise;
  await cancelPresentationRevision(database, f.admin, f.eventId, requestId, randomUUID(), { reason: 'Synthetic cancellation during R2' });
  release.resolve(); await rejection;
  await assertCounts(sql, 1);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, original.upload.id);
});

test('post-storage revision rechecks the current presentation type and file policy', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage();
  const original = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  const requestId = await revision(sql, f.adminId), validated = await validatePresentationFile(file, 'poster');
  const attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), requestId, validated);
  await storePresentationAttempt(database, attempt, validated, storage);
  await sql`UPDATE abstracts SET presentation_type='oral' WHERE id=${f.abstractId}`;
  await assert.rejects(finalizePresentationAttempt(database, f.owner, f.abstractId, requestId, attempt, validated, storage), { code: 'PRESENTATION_ROSTER_CONFLICT' });
  await assertCounts(sql, 1);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, original.upload.id);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests WHERE id=${requestId}`)[0].status, 'open');
});

test('post-R2 expiry uses database clock and keeps revision right unconsumed', { timeout: 30_000 }, async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage();
  const original = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  const requestId = await revision(sql, f.adminId, '1 second'), entered = deferred(), release = deferred();
  const submission = submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file,
    {...storage,r2:()=>({ ...storage.r2(), async putObject(input) { entered.resolve(); await release.promise; await storage.r2().putObject(input); } })});
  const rejection = assert.rejects(submission, { code: 'PRESENTATION_REQUEST_EXPIRED' });
  await entered.promise;
  try { for (;;) {
    if ((await sql`SELECT clock_timestamp()>=closes_at AS closed FROM presentation_revision_requests WHERE id=${requestId}`)[0].closed) break;
  } } finally { release.resolve(); }
  await rejection; await assertCounts(sql, 1);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, original.upload.id);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests WHERE id=${requestId}`)[0].status, 'open');
});

test('post-R2 owner and readiness changes reject; accepted replay binds actual abstract and request', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage(), entered = deferred(), release = deferred();
  const submission = submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file,
    {...storage,r2:()=>({ ...storage.r2(), async putObject(input) { entered.resolve(); await release.promise; await storage.r2().putObject(input); } })});
  const rejection = assert.rejects(submission, { code: 'PRESENTATION_OWNER_REQUIRED' });
  await entered.promise;
  const [newOwner] = await sql`INSERT INTO users(email,first_name,last_name) VALUES('other@example.invalid','Other','Owner') RETURNING id`;
  await sql`UPDATE abstracts SET user_id=${newOwner.id} WHERE id=${f.abstractId}`;
  release.resolve(); await rejection; await assertCounts(sql, 0);
  await sql`UPDATE abstracts SET user_id=${f.ownerId} WHERE id=${f.abstractId}`;
  const entered2 = deferred(), release2 = deferred();
  const stale = submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file,
    {...storage,r2:()=>({ ...storage.r2(), async putObject(input) { entered2.resolve(); await release2.promise; await storage.r2().putObject(input); } })});
  const staleRejection = assert.rejects(stale, { code: 'PRESENTATION_RECONCILE_REQUIRED' });
  await entered2.promise; await sql`UPDATE presentation_settings SET reconcile_ready=false WHERE event_id=${f.eventId}`;
  release2.resolve(); await staleRejection; await assertCounts(sql, 0);
  await sql`UPDATE presentation_settings SET reconcile_ready=true WHERE event_id=${f.eventId}`;
  const validated = await validatePresentationFile(file, 'poster'), attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), null, validated);
  await storePresentationAttempt(database, attempt, validated, storage);
  const accepted = await finalizePresentationAttempt(database, f.owner, f.abstractId, null, attempt, validated, storage);
  const [other] = await sql`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES(${f.eventId},${f.ownerId},'PRIS-2026-P002','Same owner other work','poster') RETURNING id`;
  await sql`INSERT INTO presentation_targets(event_id,abstract_id) VALUES(${f.eventId},${other.id})`;
  await assert.rejects(finalizePresentationAttempt(database, f.owner, other.id, null, attempt, validated, storage), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  await assert.rejects(finalizePresentationAttempt(database, f.owner, f.abstractId, randomUUID(), attempt, validated, storage), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()-interval '1 second'`;
  assert.deepEqual(await finalizePresentationAttempt(database, f.owner, f.abstractId, null, attempt, validated, storage), accepted);
  await assertCounts(sql, 1);
});

test('lost COMMIT response verifies scoped successful row and never deletes accepted object; unknown DB does not delete', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage, deleted } = memoryStorage(); let transactions = 0;
  const lostCommit = { execute: database.execute.bind(database), transaction: async (work: Parameters<PresentationDatabase['transaction']>[0]) => {
    const value = await database.transaction(work);
    if (++transactions === 2) throw Error('synthetic lost COMMIT response');
    return value;
  } } as PresentationDatabase;
  const accepted = await submitPresentationUpload(lostCommit, f.owner, f.abstractId, randomUUID(), null, file, storage);
  assert.equal(accepted.replayed, true); assert.equal(deleted.length, 0); await assertCounts(sql, 1);
  const requestId = await revision(sql, f.adminId); transactions = 0;
  const unknownDb = { execute: database.execute.bind(database), transaction: async (work: Parameters<PresentationDatabase['transaction']>[0]) => {
    if (++transactions >= 2) throw Error('synthetic database unavailable');
    return database.transaction(work);
  } } as PresentationDatabase;
  await assert.rejects(submitPresentationUpload(unknownDb, f.owner, f.abstractId, randomUUID(), requestId, file, storage), /database unavailable/);
  assert.equal(deleted.length, 0); await assertCounts(sql, 1);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests WHERE id=${requestId}`)[0].status, 'open');
});

test('finalizer checks database clock after target lock wait, rejects expired lease and stale claim', { timeout: 15_000 }, async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await validFile(), { storage } = memoryStorage();
  const attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), null, file);
  await storePresentationAttempt(database, attempt, file, storage);
  await assert.rejects(finalizePresentationAttempt(database, f.owner, f.abstractId, null, { ...attempt, claimToken: randomUUID() }, file, storage),
    { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  const locker = openPresentationTestDatabase(), clockReader = openPresentationTestDatabase();
  t.after(async () => { await locker.end({ timeout: 2 }); await clockReader.end({ timeout: 2 }); });
  const entered = deferred(), release = deferred();
  const [session] = await sql`SELECT pg_backend_pid() AS pid`;
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '1 second'`;
  const held = locker.begin(async tx => { await (tx as unknown as TestSql)`SELECT id FROM presentation_targets FOR UPDATE`;
    entered.resolve(); await release.promise; });
  await entered.promise;
  const rejection = assert.rejects(finalizePresentationAttempt(database, f.owner, f.abstractId, null, attempt, file, storage), { code: 'PRESENTATION_DEADLINE_PASSED' });
  try {
    while (!(await clockReader`SELECT cardinality(pg_blocking_pids(${session.pid}))>0 AS blocked`)[0].blocked) { /* wait for actual PostgreSQL lock contention */ }
    for (;;) {
      if ((await clockReader`SELECT clock_timestamp()>=closes_at AS closed FROM presentation_settings`)[0].closed) break;
    }
  } finally { release.resolve(); }
  await held; await rejection; await assertCounts(sql, 0);
  await sql`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '1 hour'`;
  await sql`UPDATE presentation_upload_attempts SET lease_until=clock_timestamp() WHERE id=${attempt.attemptId}`;
  await assert.rejects(finalizePresentationAttempt(database, f.owner, f.abstractId, null, attempt, file, storage), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  await assertCounts(sql, 0);
});

test('database time determines acceptance despite a skewed application clock', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage();
  t.mock.method(Date, 'now', () => Date.parse('2099-01-01T00:00:00Z'));
  const accepted = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  const [clock] = await sql`SELECT clock_timestamp() AS now`;
  assert.ok(Math.abs(Date.parse(accepted.upload.receivedAt) - new Date(clock.now).getTime()) < 5000);
  t.mock.restoreAll();
  const requestId = await revision(sql, f.adminId, '-1 second');
  t.mock.method(Date, 'now', () => Date.parse('2000-01-01T00:00:00Z'));
  await assert.rejects(submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), requestId, file, storage), { code: 'PRESENTATION_REQUEST_EXPIRED' });
  await assertCounts(sql, 1);
});

test('revision finalization reads clock after actual target lock wait across request deadline', { timeout: 15_000 }, async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  const file = await inputFile(), { storage } = memoryStorage();
  const original = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null, file, storage);
  const requestId = await revision(sql, f.adminId, '2 seconds'), validated = await validatePresentationFile(file, 'poster');
  const attempt = await reserveUploadAttempt(database, f.owner, f.abstractId, randomUUID(), requestId, validated);
  await storePresentationAttempt(database, attempt, validated, storage);
  const locker = openPresentationTestDatabase(), clockReader = openPresentationTestDatabase();
  t.after(async () => { await locker.end({ timeout: 2 }); await clockReader.end({ timeout: 2 }); });
  const entered = deferred(), release = deferred(), [session] = await sql`SELECT pg_backend_pid() AS pid`;
  const held = locker.begin(async tx => { await (tx as unknown as TestSql)`SELECT id FROM presentation_targets FOR UPDATE`;
    entered.resolve(); await release.promise; });
  await entered.promise;
  const rejection = assert.rejects(finalizePresentationAttempt(database, f.owner, f.abstractId, requestId, attempt, validated, storage), { code: 'PRESENTATION_REQUEST_EXPIRED' });
  try {
    while (!(await clockReader`SELECT cardinality(pg_blocking_pids(${session.pid}))>0 AS blocked`)[0].blocked) { /* observe actual lock wait */ }
    while (!(await clockReader`SELECT clock_timestamp()>=closes_at AS closed FROM presentation_revision_requests WHERE id=${requestId}`)[0].closed) { /* database clock only */ }
  } finally { release.resolve(); }
  await held; await rejection; await assertCounts(sql, 1);
  assert.equal((await sql`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, original.upload.id);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests WHERE id=${requestId}`)[0].status, 'open');
});
