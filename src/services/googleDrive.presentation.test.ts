import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generatePresentationDriveFileId, getOrCreatePresentationDriveFolder, writePresentationDriveFile } from './googleDrive.js';

type Client = NonNullable<Parameters<typeof writePresentationDriveFile>[1]>;
function fakeDrive() {
  const files = new Map<string, Record<string, any>>();
  const publicIds = new Set<string>();
  const calls: string[] = [];
  let sequence = 0;
  const fake = {
    files: {
      generateIds: async () => ({ data: { ids: [`generated-${++sequence}`] } }),
      list: async () => ({ data: { files: [] as Record<string, any>[] } }),
      create: async (input: any, options: any) => {
        assert.equal(options.timeout, 60_000); calls.push('create');
        const id = input.requestBody.id;
        if (files.has(id)) throw Object.assign(Error('conflict'), { code: 409 });
        const chunks: Buffer[] = [];
        if (input.media) for await (const chunk of input.media.body) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        files.set(id, { ...input.requestBody, size: String(bytes.length), md5Checksum: createHash('md5').update(bytes).digest('hex') });
        return { data: { id } };
      },
      get: async ({ fileId }: { fileId: string }) => {
        const file = files.get(fileId);
        if (!file) throw Object.assign(Error('missing'), { code: 404 });
        return { data: file };
      },
      update: async () => assert.fail('Accepted files must never be overwritten'),
    },
    permissions: {
      list: async ({ fileId }: { fileId: string }) => ({ data: { permissions: publicIds.has(fileId) ? [{ type: 'anyone', role: 'reader' }] : [] } }),
      create: async (input: any) => {
        assert.deepEqual(input.requestBody, { type: 'anyone', role: 'reader' });
        publicIds.add(input.fileId); calls.push('share'); return { data: { id: 'public-permission' } };
      },
    },
  };
  return { fake, drive: fake as unknown as Client, files, publicIds, calls };
}
const buffer = Buffer.from('%PDF-binary-helper-fixture');
const input = { fileId: 'file-A', parentId: 'work-folder', fileName: 'PRIS-2026-O001_slides.PDF', buffer,
  digest: createHash('sha256').update(buffer).digest('hex'), md5Checksum: createHash('md5').update(buffer).digest('hex'), attemptId: 'attempt-A' };

test('same ID replays safely; same name with new ID retains both versions and public URLs', async () => {
  const { drive, files, publicIds, calls } = fakeDrive();
  const first = await writePresentationDriveFile(input, drive);
  const replay = await writePresentationDriveFile(input, drive);
  const second = await writePresentationDriveFile({ ...input, fileId: 'file-B', attemptId: 'attempt-B' }, drive);
  assert.equal(first.fileId, replay.fileId); assert.notEqual(first.fileId, second.fileId);
  assert.equal(files.size, 2); assert.equal(publicIds.size, 2);
  assert.equal(first.storedFileName, second.storedFileName);
  assert.equal(second.fileUrl, 'https://drive.google.com/file/d/file-B/view');
  assert.deepEqual(calls, ['create','share','create','create','share']);
});

test('conflicts and lost create responses require exact remote byte and attempt identity', async () => {
  for (const change of [
    { id: 'wrong' }, { name: 'wrong.pdf' }, { mimeType: 'image/png' }, { size: '999' }, { md5Checksum: 'wrong' },
    { parents: ['wrong'] }, { appProperties: { presentationAttemptId: 'wrong', sha256: input.digest } },
    { appProperties: { presentationAttemptId: input.attemptId, sha256: 'wrong' } },
  ]) {
    const { drive, files, publicIds } = fakeDrive();
    files.set(input.fileId, { id: input.fileId, name: input.fileName, mimeType: 'application/pdf', size: String(buffer.length),
      md5Checksum: input.md5Checksum, parents: [input.parentId], appProperties: { presentationAttemptId: input.attemptId, sha256: input.digest }, ...change });
    await assert.rejects(writePresentationDriveFile(input, drive), /PRESENTATION_DRIVE_FILE_MISMATCH/);
    assert.equal(publicIds.size, 0);
  }
  const { fake, drive } = fakeDrive();
  const create = fake.files.create;
  fake.files.create = async (data, options) => { await create(data, options); throw Error('lost response'); };
  assert.equal((await writePresentationDriveFile(input, drive)).fileId, input.fileId);
});

test('uninspectable create outcome stays unknown and permission failure never returns success', async () => {
  const { fake, drive } = fakeDrive();
  fake.files.create = async () => { throw Error('transport'); };
  await assert.rejects(writePresentationDriveFile(input, drive), { storageOutcome: 'unknown' });
  const shared = fakeDrive();
  shared.fake.permissions.create = async () => { throw Error('share failed'); };
  await assert.rejects(writePresentationDriveFile(input, shared.drive), /share failed/);
  assert.equal(shared.publicIds.size, 0);
  const metadata = fakeDrive();
  metadata.fake.files.get = async () => { throw Error('read failed'); };
  await assert.rejects(writePresentationDriveFile(input, metadata.drive), { storageOutcome: 'unknown' });
});

test('folder lookup escapes literals, rejects duplicates and safely recovers folder create response', async () => {
  const { fake, drive, calls } = fakeDrive();
  fake.files.list = async (data?: any) => {
    assert.ok(data.q.includes("name='O\\'Brien\\\\slides'"));
    assert.ok(data.q.includes("'parent\\'id' in parents"));
    return { data: { files: [{ id: 'existing', name: "O'Brien\\slides" }] } };
  };
  assert.equal(await getOrCreatePresentationDriveFolder("parent'id", "O'Brien\\slides", drive), 'existing');
  assert.equal(calls.length, 0);
  fake.files.list = async () => ({ data: { files: [{ id: 'first' }, { id: 'second' }] } });
  await assert.rejects(getOrCreatePresentationDriveFolder('parent', 'duplicate', drive), /PRESENTATION_DRIVE_FOLDER_AMBIGUOUS/);
  fake.files.list = async () => ({ data: { files: [] } });
  const create = fake.files.create;
  fake.files.create = async (data, options) => { await create(data, options); throw Error('lost folder response'); };
  assert.equal(await getOrCreatePresentationDriveFolder('parent', 'new', drive), 'generated-1');
  assert.equal(await generatePresentationDriveFileId(drive), 'generated-2');
});
