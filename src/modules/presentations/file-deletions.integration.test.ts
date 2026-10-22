import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { drizzle } from 'drizzle-orm/postgres-js';
import { preparePresentationScenario, openPresentationTestDatabase } from './test-support.js';
import { submitPresentationUpload } from './uploads.js';
import { readUploadDto, type PresentationStorage } from './storage.js';
import { buildMailPayload } from './email-jobs.js';
import { readOwnerPresentation, readPresentationDetail } from './readers.js';
import { claimReplacedFileDeletion, finishReplacedFileDeletion, runReplacedFileDeletionOnce } from './file-deletions.js';
import { runPresentationWorkerIteration } from './jobs-runner.js';
import { initializePresentations, presentationReadiness } from './startup.js';

async function scenario(t: Parameters<typeof preparePresentationScenario>[0], type: 'poster' | 'oral' = 'poster') {
  const s = await preparePresentationScenario(t, { type });
  const objects = new Map<string, Buffer>(), deleted: string[] = [];
  let failure = false;
  const remove = async (id: string, signal?: AbortSignal) => {
    if (signal) assert.ok(signal instanceof AbortSignal);
    if (failure) throw Error('synthetic provider denied');
    deleted.push(id); objects.delete(id);
  };
  const storage: PresentationStorage = { r2: () => ({ publicBaseUrl: 'https://synthetic.r2.dev',
    putObject: async ({ key, body }) => { objects.set(key, body); }, deleteObject: remove }), drive: {
    rootFolderId: () => 'root', generateId: async () => randomUUID(), folder: async (parent, name) => `${parent}/${name}`,
    write: async input => { objects.set(input.fileId, input.buffer); return {
      fileId: input.fileId, fileUrl: `https://drive.google.com/file/d/${input.fileId}/view`, storedFileName: input.fileName }; },
    delete: remove,
  } };
  const document = await PDFDocument.create(); document.addPage(); if (type === 'oral') document.addPage();
  const file = { buffer: Buffer.from(await document.save()), filename: 'same.pdf', mimetype: 'application/pdf' };
  const submit = (requestId: string | null, key = randomUUID()) =>
    submitPresentationUpload(s.database, s.fixture.owner, s.fixture.abstractId, key, requestId, file, storage);
  const revise = async () => {
    const [r] = await s.client`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
      SELECT id,'Change figure',clock_timestamp()+interval '1 hour',${s.fixture.adminId}
      FROM presentation_targets WHERE abstract_id=${s.fixture.abstractId} RETURNING id`;
    return r.id as string;
  };
  return { ...s, objects, deleted, storage, submit, revise, file, fail: (value: boolean) => { failure = value; } };
}

for (const type of ['poster', 'oral'] as const) test(`${type}: replacement queues only old file, preserves history and hides all old links`, async t => {
  const s = await scenario(t, type), first = await s.submit(null);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 0);
  const request = await s.revise(), key = randomUUID(), second = await s.submit(request, key);
  assert.equal(s.objects.size, 2); assert.deepEqual(s.deleted, []);
  assert.equal((await s.submit(request, key)).replayed, true);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 1);
  const pending = await readUploadDto(s.database, first.upload.id);
  assert.equal(pending?.fileStatus, 'deletion_pending'); assert.equal(pending.fileUrl, null);
  assert.equal(pending.deletedAt, null);
  assert.equal(second.upload.fileStatus, 'available'); assert.ok(second.upload.fileUrl);
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.equal(s.objects.size, 1); assert.equal(s.deleted.length, 1);
  const [current] = await s.client`SELECT u.* FROM presentation_targets t JOIN presentation_uploads u ON u.id=t.current_upload_id`;
  assert.equal(current.id, second.upload.id);
  assert.deepEqual(s.objects.get(current.object_key ?? current.drive_file_id), s.file.buffer);
  const gone = (await readUploadDto(s.database, first.upload.id))!;
  assert.equal(gone.fileStatus, 'deleted'); assert.equal(gone.fileUrl, null); assert.ok(gone.deletedAt);
  assert.equal(gone.fileName, first.upload.fileName); assert.equal(gone.receivedAt, first.upload.receivedAt);
  const owner = await readOwnerPresentation(s.database, s.fixture.owner, s.fixture.abstractId);
  const detail = await readPresentationDetail(s.database, s.fixture.admin, s.fixture.eventId, s.fixture.abstractId);
  for (const history of [owner.uploads, detail.uploads]) {
    assert.deepEqual(history.map(u => u.version), [2, 1]);
    assert.equal(history[1].fileStatus, 'deleted'); assert.equal(history[1].fileUrl, null);
  }
  const receipt = await buildMailPayload(s.database, current.target_id, 'receipt', undefined, first.upload.id);
  assert.equal(receipt.upload?.fileStatus, 'deleted'); assert.equal(receipt.upload.fileUrl, null);
  const [snapshot] = await s.client`SELECT payload FROM presentation_email_jobs WHERE automatic_receipt_for=${first.upload.id}`;
  assert.equal(snapshot.payload.upload.fileUrl, first.upload.fileUrl, 'queued receipt snapshot remains immutable');
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_audit_events WHERE action='file_deleted'`)[0].n, 1);
  assert.equal(await runReplacedFileDeletionOnce(s.database, s.storage), false);
});

test('PNG replacement and failed acceptance keep current bytes until commit; lost response does not duplicate deletion', async t => {
  const s = await scenario(t), first = await s.submit(null), request = await s.revise();
  const png = { buffer: await sharp({ create: { width: 12, height: 16, channels: 3, background: 'white' } }).png().toBuffer(),
    filename: 'same.png', mimetype: 'image/png' };
  await s.client.unsafe(`CREATE FUNCTION fail_delete_queue() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'queue unavailable'; END $$;
    CREATE TRIGGER fail_delete_queue BEFORE INSERT ON presentation_file_deletions FOR EACH ROW EXECUTE FUNCTION fail_delete_queue();`);
  await assert.rejects(submitPresentationUpload(s.database, s.fixture.owner, s.fixture.abstractId, randomUUID(), request, png, s.storage), /queue unavailable/);
  assert.equal((await s.client`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, first.upload.id);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 0);
  assert.equal((await readUploadDto(s.database, first.upload.id))?.fileStatus, 'available');
  await s.client.unsafe('DROP TRIGGER fail_delete_queue ON presentation_file_deletions');
  let transactions = 0;
  const lost = { execute: s.database.execute.bind(s.database), transaction: async (work: Parameters<typeof s.database.transaction>[0]) => {
    const result = await s.database.transaction(work);
    if (++transactions === 2) throw Error('lost commit response');
    return result;
  } } as typeof s.database;
  const accepted = await submitPresentationUpload(lost, s.fixture.owner, s.fixture.abstractId, randomUUID(), request, png, s.storage);
  assert.equal(accepted.replayed, true); assert.equal(accepted.upload.version, 2);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 1);
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.deepEqual([...s.objects.values()], [png.buffer]);
});

test('validation, provider failure, cancellation and expiry never queue deletion of the accepted file', async t => {
  const s = await scenario(t), first = await s.submit(null), request = await s.revise();
  await assert.rejects(submitPresentationUpload(s.database, s.fixture.owner, s.fixture.abstractId, randomUUID(), request,
    { ...s.file, buffer: Buffer.from('invalid') }, s.storage));
  await assert.rejects(submitPresentationUpload(s.database, s.fixture.owner, s.fixture.abstractId, randomUUID(), request,
    s.file, { ...s.storage, r2: () => ({ ...s.storage.r2(), putObject: async () => { throw Error('write failed'); } }) }));
  await s.client`UPDATE presentation_revision_requests SET status='cancelled',cancelled_at=clock_timestamp(),
    cancelled_by=${s.fixture.adminId},cancellation_reason='cancelled' WHERE id=${request}`;
  await assert.rejects(s.submit(request), { code: 'PRESENTATION_REQUEST_CANCELLED' });
  const expired = await s.revise();
  // Immutable request terms cannot be changed; create an already expired request instead.
  await s.client`UPDATE presentation_revision_requests SET status='expired' WHERE id=${expired}`;
  const [late] = await s.client`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
    SELECT id,'Too late',clock_timestamp()-interval '1 second',${s.fixture.adminId} FROM presentation_targets RETURNING id`;
  await assert.rejects(s.submit(late.id), { code: 'PRESENTATION_REQUEST_EXPIRED' });
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 0);
  assert.equal((await s.client`SELECT current_upload_id FROM presentation_targets`)[0].current_upload_id, first.upload.id);
  assert.equal(s.objects.size, 1);
});

test('provider failure retries without blocking worker mail; crashed/stale claims and missing objects recover', async t => {
  const s = await scenario(t), first = await s.submit(null);
  await s.submit(await s.revise()); s.fail(true);
  await runPresentationWorkerIteration(s.database, { send: async () => ({}) }, s.storage);
  const [failed] = await s.client`SELECT *,next_attempt_at>clock_timestamp() AS delayed FROM presentation_file_deletions`;
  assert.equal(failed.state, 'pending'); assert.equal(failed.error_code, 'PRESENTATION_DELETE_FAILED'); assert.equal(failed.delayed, true);
  assert.equal(s.objects.size, 2);
  assert.equal(await runReplacedFileDeletionOnce(s.database, s.storage), false);
  s.fail(false); await s.client`UPDATE presentation_file_deletions SET next_attempt_at=clock_timestamp()`;
  const stale = (await claimReplacedFileDeletion(s.database))!;
  assert.equal(await claimReplacedFileDeletion(s.database), null);
  s.objects.delete(stale.object_key!); // Provider deletion succeeded; worker died before acknowledgement.
  await s.client`UPDATE presentation_file_deletions SET lease_until=clock_timestamp()-interval '1 second'`;
  const recovered = (await claimReplacedFileDeletion(s.database))!;
  assert.notEqual(stale.claim_token, recovered.claim_token);
  await finishReplacedFileDeletion(s.database, stale);
  assert.equal((await readUploadDto(s.database, first.upload.id))?.fileStatus, 'deletion_pending');
  await s.client`UPDATE presentation_file_deletions SET lease_until=clock_timestamp()-interval '1 second'`;
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.equal((await readUploadDto(s.database, first.upload.id))?.fileStatus, 'deleted');
  assert.equal(s.objects.size, 1);
});

test('current references fail closed and audit failure retries after provider deletion', async t => {
  const s = await scenario(t), first = await s.submit(null), second = await s.submit(await s.revise());
  await s.client`UPDATE presentation_targets SET current_upload_id=${first.upload.id}`;
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.deepEqual(s.deleted, []);
  assert.equal((await s.client`SELECT error_code FROM presentation_file_deletions`)[0].error_code, 'PRESENTATION_DELETE_UNSAFE');
  await s.client`UPDATE presentation_targets SET current_upload_id=${second.upload.id}`;
  await s.client`UPDATE presentation_file_deletions SET next_attempt_at=clock_timestamp()`;
  await s.client.unsafe(`CREATE FUNCTION fail_deletion_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='file_deleted' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_deletion_audit BEFORE INSERT ON presentation_audit_events FOR EACH ROW EXECUTE FUNCTION fail_deletion_audit();`);
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.equal(s.objects.size, 1);
  assert.equal((await readUploadDto(s.database, first.upload.id))?.fileStatus, 'deletion_pending');
  await s.client.unsafe('DROP TRIGGER fail_deletion_audit ON presentation_audit_events');
  await s.client`UPDATE presentation_file_deletions SET next_attempt_at=clock_timestamp()`;
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.equal((await readUploadDto(s.database, first.upload.id))?.fileStatus, 'deleted');
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_audit_events WHERE action='file_deleted'`)[0].n, 1);
});

test('unknown claim COMMIT never calls storage; the expired committed claim recovers', async t => {
  const s = await scenario(t); await s.submit(null); await s.submit(await s.revise());
  const unknown = { execute: s.database.execute.bind(s.database), transaction: async (work: Parameters<typeof s.database.transaction>[0]) => {
    await s.database.transaction(work); throw Error('unknown claim commit');
  } } as unknown as typeof s.database;
  await assert.rejects(runReplacedFileDeletionOnce(unknown, s.storage), /unknown claim commit/);
  assert.equal(s.objects.size, 2); assert.deepEqual(s.deleted, []);
  await s.client`UPDATE presentation_file_deletions SET lease_until=clock_timestamp()-interval '1 second'`;
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.equal(s.objects.size, 1);
});

test('worker uses a 15-second provider signal and retries an aborted deletion', async t => {
  const s = await scenario(t); await s.submit(null); await s.submit(await s.revise());
  const controller = new AbortController(); controller.abort();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 15_000); return controller.signal; });
  const storage = { ...s.storage, r2: () => ({ ...s.storage.r2(), deleteObject: async (_key: string, signal?: AbortSignal) => {
    assert.strictEqual(signal, controller.signal); signal!.throwIfAborted();
  } }) };
  await runReplacedFileDeletionOnce(s.database, storage);
  assert.equal(s.objects.size, 2);
  const [job] = await s.client`SELECT state,error_code FROM presentation_file_deletions`;
  assert.equal(job.state, 'pending'); assert.equal(job.error_code, 'PRESENTATION_DELETE_FAILED');
});

test('migration preserves historical versions, rejects invalid links, and queues them only on a later accepted revision', async t => {
  const s = await scenario(t); await s.submit(null); await s.submit(await s.revise());
  const before = await s.client`SELECT * FROM presentation_uploads ORDER BY version`;
  await s.client.unsafe('DROP VIEW presentation_upload_files; DROP TABLE presentation_file_deletions');
  const previousFlag = process.env.PRESENTATION_SUBMISSIONS_ENABLED;
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true';
  try {
    await assert.rejects(initializePresentations(s.database), { code: 'PRESENTATION_SCHEMA_NOT_READY' });
    assert.equal(await presentationReadiness(s.database), 'unavailable');
  } finally { if (previousFlag === undefined) delete process.env.PRESENTATION_SUBMISSIONS_ENABLED;
    else process.env.PRESENTATION_SUBMISSIONS_ENABLED = previousFlag; }
  await s.client.unsafe(await readFile(new URL('../../../drizzle/0047_presentation_file_deletions.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await s.client`SELECT * FROM presentation_uploads ORDER BY version`, before);
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 0);
  await assert.rejects(s.client`INSERT INTO presentation_file_deletions(upload_id,target_id,replacement_upload_id)
    VALUES(${before[0].id},${before[0].target_id},${before[0].id})`);
  await assert.rejects(s.client`INSERT INTO presentation_file_deletions(upload_id,target_id,replacement_upload_id)
    VALUES(${before[0].id},${before[0].target_id},${randomUUID()})`);
  await s.submit(await s.revise());
  assert.equal((await s.client`SELECT count(*)::int AS n FROM presentation_file_deletions`)[0].n, 2);
  const peer = openPresentationTestDatabase(); t.after(() => peer.end({ timeout: 2 }));
  const claims = await Promise.all([claimReplacedFileDeletion(s.database), claimReplacedFileDeletion(drizzle(peer))]);
  const claimed = claims.filter(x => x !== null);
  assert.ok(claimed.length>=1); assert.equal(new Set(claimed.map(x => x.upload_id)).size, claimed.length);
  await s.client`UPDATE presentation_file_deletions SET lease_until=clock_timestamp()-interval '1 second' WHERE state='deleting'`;
  await runReplacedFileDeletionOnce(s.database, s.storage);
  await runReplacedFileDeletionOnce(s.database, s.storage);
  assert.equal(s.objects.size, 1);
});
