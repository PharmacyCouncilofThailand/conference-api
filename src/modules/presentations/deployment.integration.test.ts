import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { openPresentationTestDatabase, resetPresentationTestDatabase, seedPresentationScenario } from './test-support.js';
import { initializePresentations } from './startup.js';
import { loadPresentationAnnouncements } from './data/index.js';

test('operational preflight, replacement migration, paused startup and compiled reconcile CLI preserve edited deadline/history', { timeout: 30000 }, async t => {
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  await resetPresentationTestDatabase(client);
  const preflight = await readFile('sql/presentations-setup/01_preflight.sql', 'utf8');
  const verify = await readFile('sql/presentations-setup/02_verify.sql', 'utf8');
  const rejectsSql = async (script: string, message: RegExp) => {
    await assert.rejects(() => client.unsafe(script), message);
    await client`ROLLBACK`;
  };
  await rejectsSql(preflight, /Expected exactly one PRIS/);
  const fixture = await seedPresentationScenario(client);
  await client.unsafe(preflight);
  await client.unsafe(await readFile('drizzle/0039_pris2026_presentations.sql', 'utf8'));
  await rejectsSql(preflight, /Presentation schema already exists/);
  await rejectsSql(verify, /Expected exactly one PRIS/);
  const previousFlag = process.env.PRESENTATION_SUBMISSIONS_ENABLED;
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'false';
  try { await initializePresentations(drizzle(client)); } finally { process.env.PRESENTATION_SUBMISSIONS_ENABLED = previousFlag; }
  await client.unsafe(verify);
  const [setting] = await client`SELECT closes_at,reconcile_ready FROM presentation_settings WHERE event_id=${fixture.eventId}`;
  assert.equal(new Date(setting.closes_at).toISOString(), '2026-10-20T17:00:00.000Z'); assert.equal(setting.reconcile_ready, true);
  const counts = await client`SELECT source_row->>'presentationType' AS type,count(*)::int AS n FROM presentation_announcements WHERE present GROUP BY 1 ORDER BY 1`;
  assert.deepEqual(Array.from(counts), ['highlighted-poster','oral','poster'].map(type => ({ type, n: loadPresentationAnnouncements().filter(row => row.presentationType === type).length })));
  assert.equal((await client`SELECT count(*)::int AS n FROM presentation_announcements WHERE present AND source_row->>'trackingId' IS NULL`)[0].n, 2);
  assert.equal((await client`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
  const [target] = await client`INSERT INTO presentation_targets(event_id,abstract_id,initial_enabled) VALUES(${fixture.eventId},${fixture.abstractId},false) RETURNING id`;
  const attempt = randomUUID(), upload = randomUUID();
  await client`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,storage_provider,object_key,original_filename,stored_filename,mime_type,size_bytes,digest,lease_until,claim_token)
    VALUES(${attempt},${target.id},${fixture.ownerId},${randomUUID()},${'a'.repeat(64)},'r2','synthetic-history','history.pdf','history.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()})`;
  await client`INSERT INTO presentation_uploads(id,target_id,attempt_id,version,user_id,storage_provider,object_key,file_url,original_filename,stored_filename,mime_type,size_bytes,digest,received_at)
    VALUES(${upload},${target.id},${attempt},1,${fixture.ownerId},'r2','synthetic-history','https://test.r2.dev/synthetic-history','history.pdf','history.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp())`;
  await client`UPDATE presentation_targets SET current_upload_id=${upload} WHERE id=${target.id}`;
  await client`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by) VALUES(${target.id},'Immutable synthetic request','2026-12-01T17:00:00Z',${fixture.adminId})`;
  await client`UPDATE presentation_settings SET closes_at='2026-11-01T17:00:00Z',version=2 WHERE event_id=${fixture.eventId}`;
  await client`INSERT INTO presentation_audit_events(event_id,actor_id,action,reason) VALUES(${fixture.eventId},${fixture.adminId},'settings','Synthetic reviewed edit')`;
  const snapshot = async () => ({
    targets: await client`SELECT * FROM presentation_targets ORDER BY id`, uploads: await client`SELECT * FROM presentation_uploads ORDER BY id`,
    requests: await client`SELECT * FROM presentation_revision_requests ORDER BY id`, audit: await client`SELECT * FROM presentation_audit_events ORDER BY id`,
    settings: await client`SELECT closes_at,version FROM presentation_settings ORDER BY event_id`,
  });
  const before = await snapshot();
  // Explicitly direct this read/reconcile-only child to the guarded integration DB, never the runtime DB.
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL!, PRESENTATION_SUBMISSIONS_ENABLED: 'false', PRESENTATION_EMAILS_ENABLED: 'false', DOTENV_CONFIG_PATH: 'synthetic-no-dotenv-file' };
  const child = await promisify(execFile)(process.execPath, ['dist/modules/presentations/startup.js', '--reconcile'], { env, timeout: 10000 });
  assert.match(child.stdout, /Presentation reconciliation complete/); assert.equal(child.stderr, '');
  assert.deepEqual(await snapshot(), before);
  await client.unsafe(verify);
  await client`UPDATE presentation_settings SET reconcile_ready=false WHERE event_id=${fixture.eventId}`;
  await rejectsSql(verify, /not ready/);
  await client`UPDATE events SET event_code='SYNTHETIC-NO-PRIS' WHERE id=${fixture.eventId}`;
  await assert.rejects(() => promisify(execFile)(process.execPath, ['dist/modules/presentations/startup.js', '--reconcile'], { env, timeout: 10000 }), (error: unknown) => {
    const result = error as { code: number; stderr: string }; assert.equal(result.code, 1); assert.match(result.stderr, /Presentation reconciliation failed/); return true;
  });
  await client`UPDATE events SET event_code='PRIS-2026' WHERE id=${fixture.eventId}`;
  console.log('T22 read-only SQL/preflight fail-closed + composed source startup + compiled CLI exit0/1/clean close + custom deadline/used rights/file/request/audit preservation PASS');
});
