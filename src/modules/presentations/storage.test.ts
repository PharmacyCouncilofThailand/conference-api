import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { cleanupFailedAttempt, createPresentationStorage, storePresentationAttempt, readUploadDto, type PresentationStorage } from './storage.js';
import { createR2ImageStorage } from '../lucky-wheel/images.js';
import type { PresentationDatabase } from './access.js';
import type { AttemptReservation, ValidatedFile } from './uploads.js';

const attempt: AttemptReservation = { kind: 'reserved', attemptId: '11111111-1111-4111-8111-111111111111',
  claimToken: '22222222-2222-4222-8222-222222222222', objectKey: 'events/1/presentations/2/11111111-1111-4111-8111-111111111111.pdf', upload: null };
const file: ValidatedFile = { buffer: Buffer.from('original bytes'), filename: 'owner-name.pdf', mimeType: 'application/pdf',
  extension: 'pdf', sizeBytes: 14, digest: 'd'.repeat(64) };
const database = (execute: (...args: any[]) => Promise<unknown>) => ({ execute } as unknown as PresentationDatabase);

test('poster Put preserves original bytes and metadata with bounded abort signal', async () => {
  const objects = new Map<string, Buffer>();
  let marked = false;
  const storage: PresentationStorage = { publicBaseUrl: 'https://test.r2.dev', async putObject(input) {
    assert.strictEqual(input.body, file.buffer);
    assert.equal(input.contentType, 'application/pdf');
    assert.equal(input.cacheControl, 'public, max-age=31536000, immutable');
    assert.ok(input.signal instanceof AbortSignal);
    objects.set(input.key, input.body);
  }, async deleteObject() { assert.fail('Put must never delete an object'); } };
  await storePresentationAttempt(database(async () => { marked = true; return [{ id: attempt.attemptId }]; }), attempt, file, storage);
  assert.deepEqual(objects.get(attempt.objectKey), file.buffer);
  assert.equal(marked, true);
  assert.equal(attempt.objectKey.includes(file.filename), false);
});

test('failed Put cannot mark stored; lost mark cannot delete object', async () => {
  let writes = 0;
  const storage: PresentationStorage = { publicBaseUrl: 'https://test.r2.dev', async putObject() { throw new Error('transport'); },
    async deleteObject() { assert.fail('Storage failure must not delete blindly'); } };
  await assert.rejects(storePresentationAttempt(database(async () => { writes++; return []; }), attempt, file, storage),
    { code: 'PRESENTATION_STORAGE_FAILED', statusCode: 503 });
  assert.equal(writes, 0);
  storage.putObject = async () => {};
  await assert.rejects(storePresentationAttempt(database(async () => []), attempt, file, storage), { code: 'PRESENTATION_UPLOAD_RETRY_REQUIRED' });
  await assert.rejects(storePresentationAttempt(database(async () => { throw new Error('unknown DB outcome'); }), attempt, file, storage),
    /unknown DB outcome/);
});

test('read DTO uses server timestamp and returns null for missing upload', async () => {
  assert.equal(await readUploadDto(database(async () => []), attempt.attemptId), null);
  const dto = { id: attempt.attemptId, version: 1, fileName: file.filename, mimeType: file.mimeType,
    sizeBytes: file.sizeBytes, publicUrl: 'https://test.r2.dev/file.pdf', receivedAt: new Date('2026-10-07T00:00:00Z'), revisionRequestId: null };
  assert.deepEqual(await readUploadDto(database(async () => [dto]), attempt.attemptId),
    { ...dto, receivedAt: '2026-10-07T00:00:00.000Z' });
});

test('cleanup never deletes when its database claim outcome is unknown', async () => {
  const db = { transaction: async () => { throw new Error('unknown claim commit'); } } as unknown as PresentationDatabase;
  const storage: PresentationStorage = { publicBaseUrl: 'https://test.r2.dev', async putObject() {},
    async deleteObject() { assert.fail('Unknown database outcome must preserve object'); } };
  await assert.rejects(cleanupFailedAttempt(db, attempt.attemptId, storage), /unknown claim commit/);
});

test('R2 config uses existing helper, fails closed outside r2.dev, no network', () => {
  const names = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BASE_URL'];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = 'synthetic-test-only';
    for (const url of ['https://example.invalid', 'https://r2.dev.example.invalid', 'https://test.r2.dev/path']) {
      process.env.R2_PUBLIC_BASE_URL = url;
      assert.throws(() => createPresentationStorage(), { code: 'PRESENTATION_STORAGE_CONFIG', statusCode: 503 });
    }
    process.env.R2_PUBLIC_BASE_URL = 'https://test.r2.dev';
    assert.equal(createPresentationStorage().publicBaseUrl, 'https://test.r2.dev');
    delete process.env.R2_BUCKET;
    assert.throws(() => createPresentationStorage(), { code: 'PRESENTATION_STORAGE_CONFIG', statusCode: 503 });
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
  await storage.putObject({ key: attempt.objectKey, body: file.buffer, contentType: file.mimeType, cacheControl: 'immutable', signal });
});
