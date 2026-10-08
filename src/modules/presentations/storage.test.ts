import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { cleanupFailedAttempt, createPresentationStorage, storePresentationAttempt, readUploadDto, type PresentationStorage, type R2PresentationStorage } from './storage.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createR2ImageStorage } from '../lucky-wheel/images.js';
import type { PresentationDatabase } from './access.js';
import type { AttemptReservation, ValidatedFile } from './uploads.js';

const attempt: AttemptReservation = { kind: 'reserved', attemptId: '11111111-1111-4111-8111-111111111111',
  claimToken: '22222222-2222-4222-8222-222222222222', location: null,
  identity: {storageProvider: 'r2', objectKey: 'events/1/presentations/2/11111111-1111-4111-8111-111111111111.pdf',
    driveFileId: null, driveFolderId: null, storedFileName: 'owner-name.pdf', fileUrl: null}, upload: null };
const file: ValidatedFile = { buffer: Buffer.from('original bytes'), filename: 'owner-name.pdf', mimeType: 'application/pdf',
  extension: 'pdf', sizeBytes: 14, digest: 'd'.repeat(64), md5Checksum: 'a'.repeat(32), pageCount: 1, presentationType: 'poster' };
const database = (execute: (...args: any[]) => Promise<unknown>) => ({ execute } as unknown as PresentationDatabase);
const providers = (r2: R2PresentationStorage): PresentationStorage => ({r2: () => r2, drive: {
  rootFolderId: () => assert.fail('Poster used Drive'), generateId: async () => assert.fail('Poster used Drive'),
  folder: async () => assert.fail('Poster used Drive'), write: async () => assert.fail('Poster used Drive'), delete: async () => assert.fail('Poster used Drive'),
}});

test('poster Put preserves original bytes and metadata with bounded abort signal', async () => {
  const objects = new Map<string, Buffer>();
  let marked = false;
  const storage = providers({ publicBaseUrl: 'https://test.r2.dev', async putObject(input) {
    assert.strictEqual(input.body, file.buffer);
    assert.equal(input.contentType, 'application/pdf');
    assert.equal(input.cacheControl, 'public, max-age=31536000, immutable');
    assert.ok(input.signal instanceof AbortSignal);
    objects.set(input.key, input.body);
  }, async deleteObject() { assert.fail('Put must never delete an object'); } });
  await storePresentationAttempt(database(async () => { marked = true; return [{ id: attempt.attemptId }]; }), attempt, file, storage);
  assert.deepEqual(objects.get(attempt.identity.objectKey!), file.buffer);
  assert.equal(marked, true);
  assert.equal(attempt.identity.objectKey!.includes(file.filename), false);
});

test('failed Put cannot mark stored; lost mark cannot delete object', async () => {
  let writes = 0;
  const storage = providers({ publicBaseUrl: 'https://test.r2.dev', async putObject() { throw new Error('transport'); },
    async deleteObject() { assert.fail('Storage failure must not delete blindly'); } });
  await assert.rejects(storePresentationAttempt(database(async statement => {
    if (new PgDialect().sqlToQuery(statement).sql.startsWith('UPDATE')) writes++;
    return [{id: attempt.attemptId}];
  }), attempt, file, storage),
    { code: 'PRESENTATION_STORAGE_FAILED', statusCode: 503 });
  assert.equal(writes, 0);
  storage.r2().putObject = async () => {};
  await assert.rejects(storePresentationAttempt(database(async () => []), attempt, file, storage), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  let calls = 0;
  await assert.rejects(storePresentationAttempt(database(async () => { if (++calls === 1) return [{id: attempt.attemptId}]; throw new Error('unknown DB outcome'); }), attempt, file, storage),
    /unknown DB outcome/);
});

test('read DTO uses server timestamp and returns null for missing upload', async () => {
  assert.equal(await readUploadDto(database(async () => []), attempt.attemptId), null);
  const dto = { id: attempt.attemptId, version: 1, fileName: file.filename, mimeType: file.mimeType,
    storedFileName: file.filename, storageProvider: 'r2', driveFileId: null,
    sizeBytes: file.sizeBytes, fileUrl: 'https://test.r2.dev/file.pdf', receivedAt: new Date('2026-10-07T00:00:00Z'), revisionRequestId: null };
  assert.deepEqual(await readUploadDto(database(async () => [dto]), attempt.attemptId),
    { ...dto, receivedAt: '2026-10-07T00:00:00.000Z' });
});

test('cleanup never deletes when its database claim outcome is unknown', async () => {
  const db = { transaction: async () => { throw new Error('unknown claim commit'); } } as unknown as PresentationDatabase;
  const storage = providers({ publicBaseUrl: 'https://test.r2.dev', async putObject() {},
    async deleteObject() { assert.fail('Unknown database outcome must preserve object'); } });
  await assert.rejects(cleanupFailedAttempt(db, attempt.attemptId, storage), /unknown claim commit/);
});

test('R2 config uses existing helper, fails closed outside r2.dev, no network', () => {
  const names = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BASE_URL'];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = 'synthetic-test-only';
    for (const url of ['https://example.invalid', 'https://r2.dev.example.invalid', 'https://test.r2.dev/path']) {
      process.env.R2_PUBLIC_BASE_URL = url;
      assert.throws(() => createPresentationStorage().r2(), { code: 'PRESENTATION_STORAGE_CONFIG', statusCode: 503 });
    }
    process.env.R2_PUBLIC_BASE_URL = 'https://test.r2.dev';
    assert.equal(createPresentationStorage().r2().publicBaseUrl, 'https://test.r2.dev');
    delete process.env.R2_BUCKET;
    assert.throws(() => createPresentationStorage().r2(), { code: 'PRESENTATION_STORAGE_CONFIG', statusCode: 503 });
    assert.ok(createPresentationStorage().drive, 'Drive-only requests do not initialize R2 config');
  } finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
});

test('existing R2 helper forwards optional AbortSignal to fake SDK transport', async t => {
  const signal = new AbortController().signal;
  t.mock.method(S3Client.prototype, 'send', async (command: unknown, options: any) => {
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Body, file.buffer);
    assert.equal(command.input.ContentLength, file.buffer.length);
    assert.strictEqual(options.abortSignal, signal);
    return {};
  });
  const storage = createR2ImageStorage({ accountId: 'synthetic', bucket: 'synthetic', accessKeyId: 'synthetic',
    secretAccessKey: 'synthetic', publicBaseUrl: 'https://test.r2.dev' });
  await storage.putObject({ key: attempt.identity.objectKey!, body: file.buffer, contentType: file.mimeType, cacheControl: 'immutable', signal });
});

test('Drive persists complete identity before bytes, marks stored after sharing and reuses allocated IDs', async () => {
  const calls: string[] = [], folders: string[] = [];
  const oralAttempt: AttemptReservation = {...attempt, identity: {...attempt.identity, storageProvider: 'drive', objectKey: null,
    storedFileName: 'PRIS-2026-O001_owner-name.pdf'}, location: {eventCode: 'PRIS-2026', trackingId: 'PRIS-2026-O001', categoryName: 'สาขาตัวอย่าง'}};
  const storage: PresentationStorage = {r2: () => assert.fail('Oral used R2'), drive: {
    rootFolderId: () => 'root', folder: async (_parent, name) => {folders.push(name); return `folder-${name}`;},
    generateId: async () => {calls.push('generate'); return 'file-A';},
    write: async input => {calls.push('write'); assert.equal(input.fileId, 'file-A'); assert.equal(input.parentId, 'folder-PRIS-2026-O001');
      return {fileId: input.fileId, fileUrl: 'https://drive.google.com/file/d/file-A/view', storedFileName: input.fileName};},
    delete: async () => assert.fail('Store deleted file'),
  }};
  const db = database(async statement => {
    const query = new PgDialect().sqlToQuery(statement).sql;
    if (query.includes('SET drive_file_id')) {calls.push('persist'); return [{driveFileId: 'file-A', driveFolderId: 'folder-PRIS-2026-O001'}];}
    if (query.includes("SET state='stored'")) calls.push('stored');
    return [{id: attempt.attemptId}];
  });
  db.transaction = (async work => work(db as any)) as typeof db.transaction;
  await storePresentationAttempt(db, oralAttempt, {...file, pageCount: 2, presentationType: 'oral'}, storage);
  assert.deepEqual(calls, ['generate','persist','write','stored']);
  assert.deepEqual(folders, ['PRIS-2026','Oral','Presentation Oral','สาขาตัวอย่าง','PRIS-2026-O001']);
  calls.length = 0;
  await storePresentationAttempt(db, oralAttempt, {...file, pageCount: 2, presentationType: 'oral'}, storage);
  assert.deepEqual(calls, ['write','stored']);
  await assert.rejects(storePresentationAttempt(database(async () => []), oralAttempt, file, storage), {code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED'});
  assert.deepEqual(calls, ['write','stored'], 'lost claim never sends bytes');
});
