import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openPresentationTestDatabase, resetPresentationTestDatabase, seedPresentationScenario } from './test-support.js';

test('100 MB expansion is repeatable, preserves history, and changes only the Drive ceiling in both tables', async t => {
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  await resetPresentationTestDatabase(client);
  const f = await seedPresentationScenario(client);
  for (const name of ['0039_pris2026_presentations.sql', '0041_pris2026_poster_png.sql'])
    await client.unsafe(await readFile(new URL('../../../drizzle/' + name, import.meta.url), 'utf8'));
  let version = 0;
  const attempt = async (provider: 'drive' | 'r2', size: number, mime = 'application/pdf') => {
    const id = randomUUID();
    const [abstract] = await client`INSERT INTO abstracts(event_id,category_id,user_id,title,presentation_type,tracking_id)
      VALUES (${f.eventId},${f.categoryId},${f.ownerId},'Size boundary',${provider === 'drive' ? 'oral' : 'poster'},${id}) RETURNING id`;
    const [target] = await client`INSERT INTO presentation_targets(event_id,abstract_id) VALUES (${f.eventId},${abstract.id}) RETURNING id`;
    await client`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,storage_provider,
      object_key,drive_file_id,drive_folder_id,original_filename,stored_filename,mime_type,size_bytes,digest,lease_until,claim_token,state)
      VALUES (${id},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},${provider},
        ${provider === 'r2' ? id : null},${provider === 'drive' ? id : null},${provider === 'drive' ? 'folder' : null},
        'file.pdf','stored.pdf',${mime},${size},${'b'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()},'stored')`;
    return id;
  };
  const upload = async (id: string, size: number) => {
    await client`INSERT INTO presentation_uploads(id,target_id,attempt_id,version,user_id,storage_provider,object_key,drive_file_id,drive_folder_id,
      file_url,original_filename,stored_filename,mime_type,size_bytes,digest,received_at)
      SELECT ${randomUUID()},target_id,id,${++version},user_id,storage_provider,object_key,drive_file_id,drive_folder_id,
        'https://example.invalid/file.pdf',original_filename,stored_filename,mime_type,${size},digest,clock_timestamp()
      FROM presentation_upload_attempts WHERE id=${id}`;
  };
  const legacy = await attempt('drive', 52_428_800); await upload(legacy, 52_428_800);
  const oldRows = await client`SELECT * FROM presentation_uploads`;
  await assert.rejects(attempt('drive', 52_428_801), { code: '23514' });
  const migration = await readFile(new URL('../../../drizzle/0045_pris2026_oral_100mb.sql', import.meta.url), 'utf8');
  await client.unsafe(migration); await client.unsafe(migration);
  assert.deepEqual(await client`SELECT * FROM presentation_uploads`, oldRows);
  const rollback = await readFile(new URL('../../../sql/presentations-setup/03_oral_100mb_rollback.sql', import.meta.url), 'utf8');
  await client.unsafe(rollback);
  await assert.rejects(attempt('drive', 52_428_801), { code: '23514' });
  await client.unsafe(migration);
  const ceiling = await attempt('drive', 104_857_600); await upload(ceiling, 104_857_600);
  await assert.rejects(attempt('drive', 104_857_601), { code: '23514' });
  await assert.rejects(upload(ceiling, 104_857_601), { code: '23514' });
  const poster = await attempt('r2', 31_457_280, 'image/png'); await upload(poster, 31_457_280);
  await assert.rejects(attempt('r2', 31_457_281), { code: '23514' });
  await assert.rejects(upload(poster, 31_457_281), { code: '23514' });
  await assert.rejects(attempt('drive', 1, 'image/png'), { code: '23514' });
  assert.equal((await client`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, 3);
  await assert.rejects(client.unsafe(rollback), /larger Oral files exist/);
  await client`ROLLBACK`;
  assert.equal((await client`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n, 3);
});
