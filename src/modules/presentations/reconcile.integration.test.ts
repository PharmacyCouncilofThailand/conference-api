import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema.js';
import { assertInitialReady, readCandidates, reconcilePresentations } from './reconcile.js';
import { openPresentationTestDatabase, preparePresentationScenario } from './test-support.js';

test('reconciliation is idempotent, preserves settings and reads fresh DB even with unchanged source', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePresentationScenario(t);
  const [target] = await sql`SELECT * FROM presentation_targets`;
  assert.equal((await reconcilePresentations(database, [row])).counts.ready, 1);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_targets`)[0].n, 1);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_audit_events`)[0].n, 1);
  await sql`UPDATE presentation_settings SET closes_at='2026-10-19T17:00:00Z',version=5 WHERE event_id=${f.eventId}`;
  await reconcilePresentations(database, [row]);
  const [setting] = await sql`SELECT * FROM presentation_settings`;
  assert.equal(new Date(setting.closes_at).toISOString(), '2026-10-19T17:00:00.000Z');
  assert.equal(setting.version, 5);
  await assertInitialReady(database, target.id);
  await sql`UPDATE abstracts SET title='ขัดกันหลัง deploy' WHERE id=${f.abstractId}`;
  await assertInitialReady(database, target.id);
  assert.equal((await reconcilePresentations(database, [row])).counts.ready, 1);
  const [announced] = await sql`SELECT source_row,match_snapshot FROM presentation_announcements`;
  assert.equal(announced.source_row.title, row.title);
  assert.equal(announced.match_snapshot.candidates[0].title, 'ขัดกันหลัง deploy');
  await sql`UPDATE abstracts SET presentation_type='oral' WHERE id=${f.abstractId}`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'PRESENTATION_ROSTER_CONFLICT' });
  assert.equal((await reconcilePresentations(database, [row])).counts.conflict, 1);
  assert.equal((await sql`SELECT initial_enabled FROM presentation_targets`)[0].initial_enabled, false);
  assert.equal((await sql`SELECT match_state FROM presentation_announcements`)[0].match_state, 'conflict');
  assert.equal((await sql`SELECT status FROM abstracts`)[0].status, 'pending');
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_email_jobs`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM users`)[0].n, 1);
});

test('reconciliation reopens an old title conflict without rewriting either title or notifying the owner', async t => {
  const { client: sql, database, announcement: row } = await preparePresentationScenario(t);
  const [target] = await sql`SELECT id FROM presentation_targets`;
  await sql`UPDATE abstracts SET title='ชื่อบทคัดย่อในฐานข้อมูล'`;
  await sql`UPDATE presentation_announcements SET match_state='conflict',
    match_snapshot=jsonb_set(match_snapshot,'{match,problems}','["TITLE_MISMATCH"]'::jsonb)`;
  await sql`UPDATE presentation_targets SET initial_enabled=false`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'PRESENTATION_NOT_ELIGIBLE' });
  assert.deepEqual((await reconcilePresentations(database, [row])).counts, { ready: 1 });
  await assertInitialReady(database, target.id);
  const [announced] = await sql`SELECT source_row,match_snapshot FROM presentation_announcements`;
  assert.equal(announced.source_row.title, row.title);
  assert.equal(announced.match_snapshot.candidates[0].title, 'ชื่อบทคัดย่อในฐานข้อมูล');
  assert.deepEqual(announced.match_snapshot.match.problems, []);
  assert.equal((await sql`SELECT initial_enabled FROM presentation_targets`)[0].initial_enabled, true);
  assert.equal((await sql`SELECT title FROM abstracts`)[0].title, 'ชื่อบทคัดย่อในฐานข้อมูล');
  assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n, 0);
});

test('invalid manifest fails closed without committing partial roster; missing/incomplete rows remain visible', async t => {
  const { client: sql, database, announcement: row } = await preparePresentationScenario(t);
  await assert.rejects(reconcilePresentations(database, [row, row]), { code: 'PRESENTATION_DUPLICATE_SOURCE_KEY' });
  assert.equal((await sql`SELECT reconcile_ready FROM presentation_settings`)[0].reconcile_ready, false);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_announcements`)[0].n, 1);
  const [target] = await sql`SELECT id FROM presentation_targets`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'PRESENTATION_RECONCILE_REQUIRED' });
  await assert.rejects(reconcilePresentations(database, [{ ...row, id: 0 }]), { code: 'PRESENTATION_SOURCE_INVALID' });
  const result = await reconcilePresentations(database, [row, { ...row, id: 2, trackingId: 'missing' }, { ...row, id: 3, trackingId: null }]);
  assert.deepEqual(result.counts, { ready: 1, missing: 1, incomplete: 1 });
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_announcements WHERE present`)[0].n, 3);
  // Force a late write failure, after earlier rows have been processed.
  await sql.unsafe(`CREATE FUNCTION reject_test_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_key='1:4' THEN RAISE EXCEPTION 'synthetic late failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_row BEFORE INSERT ON presentation_announcements FOR EACH ROW EXECUTE FUNCTION reject_test_row()`);
  await assert.rejects(reconcilePresentations(database, [{ ...row, title: 'changed' }, { ...row, id: 4 }]));
  assert.equal((await sql`SELECT match_state FROM presentation_announcements WHERE source_key='1:1'`)[0].match_state, 'ready');
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_audit_events`)[0].n, 3);
  assert.equal((await sql`SELECT reconcile_ready FROM presentation_settings`)[0].reconcile_ready, false);
});

test('duplicate abstracts/tracking and remaps conflict without moving a bound target', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePresentationScenario(t);
  const [target] = await sql`SELECT id FROM presentation_targets`;
  assert.equal((await reconcilePresentations(database, [row, { ...row, id: 2 }])).counts.conflict, 2);
  assert.equal((await sql`SELECT initial_enabled FROM presentation_targets`)[0].initial_enabled, false);
  const [second] = await sql`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES(${f.eventId},${f.ownerId},'second',${row.title},'poster') RETURNING id`;
  await sql`INSERT INTO abstract_tracking_identifiers(tracking_id,abstract_id,event_id)
    VALUES(${row.trackingId},${second.id},${f.eventId})`;
  assert.equal((await reconcilePresentations(database, [row])).counts.conflict, 1);
  const [ambiguous] = await sql`SELECT match_snapshot FROM presentation_announcements WHERE source_key='1:1'`;
  assert.ok(ambiguous.match_snapshot.match.problems.includes('TRACKING_AMBIGUOUS'));
  await sql`UPDATE abstracts SET tracking_id='original-now' WHERE id=${f.abstractId}`;
  assert.equal((await reconcilePresentations(database, [row])).counts.conflict, 1);
  const [remapped] = await sql`SELECT target_id,match_snapshot FROM presentation_announcements WHERE source_key='1:1'`;
  assert.equal(remapped.target_id, target.id);
  assert.ok(remapped.match_snapshot.match.problems.includes('SOURCE_REMAP'));
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_targets`)[0].n, 1);
  await reconcilePresentations(database, []);
  await reconcilePresentations(database, [row]);
  assert.equal((await sql`SELECT target_id FROM presentation_announcements WHERE source_key='1:1'`)[0].target_id, target.id);
});

test('aliases require a matching verification fingerprint; fresh changes invalidate approval; Oral receives matching rights', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePresentationScenario(t);
  await sql`UPDATE abstracts SET tracking_id='canonical-new' WHERE id=${f.abstractId}`;
  await sql`INSERT INTO abstract_tracking_identifiers(tracking_id,abstract_id,event_id) VALUES(${row.trackingId},${f.abstractId},${f.eventId})`;
  assert.equal((await readCandidates(database, f.eventId))[0].aliases[0], row.trackingId);
  assert.equal((await reconcilePresentations(database, [row])).counts.alias_pending, 1);
  await sql`UPDATE presentation_announcements SET verified_fingerprint=match_fingerprint,verified_by=${f.adminId},
    verified_at=clock_timestamp(),verification_reason='test'`;
  assert.equal((await reconcilePresentations(database, [row])).counts.ready, 1);
  const [target] = await sql`SELECT id FROM presentation_targets`;
  await assertInitialReady(database, target.id);
  await sql`UPDATE users SET email='changed@example.invalid' WHERE id=${f.ownerId}`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'PRESENTATION_ROSTER_CONFLICT' });
  assert.equal((await reconcilePresentations(database, [row])).counts.alias_pending, 1);
  await sql`UPDATE abstracts SET presentation_type='oral',tracking_id=${row.trackingId} WHERE id=${f.abstractId}`;
  assert.equal((await reconcilePresentations(database, [{ ...row, presentationType: 'oral' }])).counts.ready, 1);
  assert.equal((await sql`SELECT initial_enabled FROM presentation_targets`)[0].initial_enabled, true);
  await assertInitialReady(database, target.id);
});

test('withdraw/re-add preserves used initial right, current file, requests, mail and history', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePresentationScenario(t);
  const [target] = await sql`SELECT id FROM presentation_targets`;
  const uploadId = randomUUID();
  await sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,storage_provider,object_key,original_filename,stored_filename,mime_type,
    size_bytes,digest,lease_until,claim_token,state) VALUES(${uploadId},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},'r2',
    'synthetic/key','test.pdf','test.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp(),${randomUUID()},'accepted')`;
  await sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,version,user_id,storage_provider,object_key,file_url,original_filename,stored_filename,mime_type,size_bytes,digest,received_at)
    VALUES(${uploadId},${target.id},${uploadId},1,${f.ownerId},'r2','synthetic/key','https://example.invalid/test','test.pdf','test.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp())`;
  await sql`UPDATE presentation_targets SET current_upload_id=${uploadId} WHERE id=${target.id}`;
  await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by)
    VALUES(${target.id},'test request',clock_timestamp()+interval '1 hour',${f.adminId})`;
  await sql`INSERT INTO presentation_email_jobs(target_id,kind,payload,subject,html,template_version)
    VALUES(${target.id},'initial','{}','test','test','test')`;
  await reconcilePresentations(database, []);
  const audits = (await sql`SELECT count(*)::integer AS n FROM presentation_audit_events`)[0].n;
  await reconcilePresentations(database, []);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_audit_events`)[0].n, audits);
  await reconcilePresentations(database, [row]);
  const [restored] = await sql`SELECT * FROM presentation_targets`;
  assert.equal(restored.id, target.id);
  assert.equal(restored.current_upload_id, uploadId);
  assert.equal(restored.initial_enabled, false);
  assert.equal((await sql`SELECT status FROM presentation_revision_requests`)[0].status, 'open');
  for (const table of ['presentation_uploads', 'presentation_email_jobs', 'presentation_revision_requests'])
    assert.equal((await sql.unsafe(`SELECT count(*)::integer AS n FROM ${table}`))[0].n, 1);
});

test('distinct database clients serialize reconciliation and retain their captured manifest', async t => {
  const { client: sql, fixture: f, announcement: row } = await preparePresentationScenario(t);
  const peers = [openPresentationTestDatabase(), openPresentationTestDatabase()];
  for (const peer of peers) t.after(() => peer.end({ timeout: 2 }));
  const databases = peers.map(peer => drizzle(peer, { schema }));
  assert.notEqual((await peers[0]`SELECT pg_backend_pid() AS pid`)[0].pid, (await peers[1]`SELECT pg_backend_pid() AS pid`)[0].pid);
  await Promise.all(databases.map(database => reconcilePresentations(database, [row])));
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_audit_events`)[0].n, 1);
  let runs: Promise<unknown>[] = [];
  const mutable = [{ ...row, presentationType: 'highlighted-poster' as const }];
  await sql.begin(async lock => {
    await lock.unsafe('SELECT pg_advisory_xact_lock(20261006,$1)', [f.eventId]);
    runs = [reconcilePresentations(databases[0], [row]), reconcilePresentations(databases[1], mutable)];
    let waiters = 0;
    for (let i = 0; i < 100 && waiters < 2; i++) {
      waiters = (await lock.unsafe(`SELECT count(*)::integer AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`))[0].n;
      if (waiters < 2) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiters, 2, 'both separate sessions must reach the held lock');
    mutable[0].title = 'mutated after invocation';
  });
  await Promise.all(runs);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_targets`)[0].n, 1);
  const [announced] = await sql`SELECT source_row,match_state FROM presentation_announcements`;
  assert.equal(announced.source_row.title, row.title);
  assert.equal(announced.match_state, 'ready');
  const [setting] = await sql`SELECT reconcile_ready,manifest_digest FROM presentation_settings`;
  assert.equal(setting.reconcile_ready, true);
  const { digest } = await import('./policy.js');
  assert.equal(setting.manifest_digest, digest([announced.source_row]));
});

test('queued failure and success publish readiness in their lock order', async t => {
  const { client: sql, fixture: f, announcement: row } = await preparePresentationScenario(t);
  const peers = [openPresentationTestDatabase(), openPresentationTestDatabase()];
  for (const peer of peers) t.after(() => peer.end({ timeout: 2 }));
  const databases = peers.map(peer => drizzle(peer, { schema }));
  for (const failureFirst of [true, false]) {
    let jobs: Promise<unknown>[] = [];
    await sql.begin(async lock => {
      await lock.unsafe('SELECT pg_advisory_xact_lock(20261006,$1)', [f.eventId]);
      for (const [index, failing] of [failureFirst, !failureFirst].entries()) {
        jobs.push(failing ? assert.rejects(reconcilePresentations(databases[index], [row, row]), { code: 'PRESENTATION_DUPLICATE_SOURCE_KEY' })
          : reconcilePresentations(databases[index], [row]));
        let waiters = 0;
        for (let i = 0; i < 100 && waiters < index + 1; i++) {
          waiters = (await lock.unsafe(`SELECT count(*)::integer AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`))[0].n;
          if (waiters < index + 1) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiters, index + 1);
      }
    });
    await Promise.all(jobs);
    assert.equal((await sql`SELECT reconcile_ready FROM presentation_settings`)[0].reconcile_ready, failureFirst);
    assert.equal((await sql`SELECT count(*)::integer AS n FROM presentation_audit_events`)[0].n, 1);
  }
});
