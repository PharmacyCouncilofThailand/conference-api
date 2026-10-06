import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema.js';
import { assertInitialReady, readCandidates, reconcilePosters } from './reconcile.js';
import { openPosterTestDatabase, preparePosterScenario } from './test-support.js';

test('reconciliation is idempotent, preserves settings and reads fresh DB even with unchanged source', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePosterScenario(t);
  const [target] = await sql`SELECT * FROM poster_targets`;
  assert.equal((await reconcilePosters(database, [row])).counts.ready, 1);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_targets`)[0].n, 1);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_audit_events`)[0].n, 1);
  await sql`UPDATE poster_settings SET closes_at='2026-10-19T17:00:00Z',version=5 WHERE event_id=${f.eventId}`;
  await reconcilePosters(database, [row]);
  const [setting] = await sql`SELECT * FROM poster_settings`;
  assert.equal(new Date(setting.closes_at).toISOString(), '2026-10-19T17:00:00.000Z');
  assert.equal(setting.version, 5);
  await assertInitialReady(database, target.id);
  await sql`UPDATE abstracts SET title='ขัดกันหลัง deploy' WHERE id=${f.abstractId}`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'POSTER_ROSTER_CONFLICT' });
  assert.equal((await reconcilePosters(database, [row])).counts.conflict, 1);
  assert.equal((await sql`SELECT initial_enabled FROM poster_targets`)[0].initial_enabled, false);
  assert.equal((await sql`SELECT match_state FROM poster_announcements`)[0].match_state, 'conflict');
  assert.equal((await sql`SELECT status FROM abstracts`)[0].status, 'pending');
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_email_jobs`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM users`)[0].n, 1);
});

test('invalid manifest fails closed without committing partial roster; missing/incomplete rows remain visible', async t => {
  const { client: sql, database, announcement: row } = await preparePosterScenario(t);
  await assert.rejects(reconcilePosters(database, [row, row]), { code: 'POSTER_DUPLICATE_SOURCE_KEY' });
  assert.equal((await sql`SELECT reconcile_ready FROM poster_settings`)[0].reconcile_ready, false);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_announcements`)[0].n, 1);
  const [target] = await sql`SELECT id FROM poster_targets`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'POSTER_RECONCILE_REQUIRED' });
  await assert.rejects(reconcilePosters(database, [{ ...row, id: 0 }]), { code: 'POSTER_SOURCE_INVALID' });
  const result = await reconcilePosters(database, [row, { ...row, id: 2, trackingId: 'missing' }, { ...row, id: 3, trackingId: null }]);
  assert.deepEqual(result.counts, { ready: 1, missing: 1, incomplete: 1 });
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_announcements WHERE present`)[0].n, 3);
  // Force a late write failure, after earlier rows have been processed.
  await sql.unsafe(`CREATE FUNCTION reject_test_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_key='1:4' THEN RAISE EXCEPTION 'synthetic late failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_row BEFORE INSERT ON poster_announcements FOR EACH ROW EXECUTE FUNCTION reject_test_row()`);
  await assert.rejects(reconcilePosters(database, [{ ...row, title: 'changed' }, { ...row, id: 4 }]));
  assert.equal((await sql`SELECT match_state FROM poster_announcements WHERE source_key='1:1'`)[0].match_state, 'ready');
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_audit_events`)[0].n, 3);
  assert.equal((await sql`SELECT reconcile_ready FROM poster_settings`)[0].reconcile_ready, false);
});

test('duplicate abstracts/tracking and remaps conflict without moving a bound target', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePosterScenario(t);
  const [target] = await sql`SELECT id FROM poster_targets`;
  assert.equal((await reconcilePosters(database, [row, { ...row, id: 2 }])).counts.conflict, 2);
  assert.equal((await sql`SELECT initial_enabled FROM poster_targets`)[0].initial_enabled, false);
  const [second] = await sql`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES(${f.eventId},${f.ownerId},'second',${row.title},'poster') RETURNING id`;
  await sql`INSERT INTO abstract_tracking_identifiers(tracking_id,abstract_id,event_id)
    VALUES(${row.trackingId},${second.id},${f.eventId})`;
  assert.equal((await reconcilePosters(database, [row])).counts.conflict, 1);
  const [ambiguous] = await sql`SELECT match_snapshot FROM poster_announcements WHERE source_key='1:1'`;
  assert.ok(ambiguous.match_snapshot.match.problems.includes('TRACKING_AMBIGUOUS'));
  await sql`UPDATE abstracts SET tracking_id='original-now' WHERE id=${f.abstractId}`;
  assert.equal((await reconcilePosters(database, [row])).counts.conflict, 1);
  const [remapped] = await sql`SELECT target_id,match_snapshot FROM poster_announcements WHERE source_key='1:1'`;
  assert.equal(remapped.target_id, target.id);
  assert.ok(remapped.match_snapshot.match.problems.includes('SOURCE_REMAP'));
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_targets`)[0].n, 1);
  await reconcilePosters(database, []);
  await reconcilePosters(database, [row]);
  assert.equal((await sql`SELECT target_id FROM poster_announcements WHERE source_key='1:1'`)[0].target_id, target.id);
});

test('aliases require a matching verification fingerprint; fresh changes invalidate approval; Oral cannot upload', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePosterScenario(t);
  await sql`UPDATE abstracts SET tracking_id='canonical-new' WHERE id=${f.abstractId}`;
  await sql`INSERT INTO abstract_tracking_identifiers(tracking_id,abstract_id,event_id) VALUES(${row.trackingId},${f.abstractId},${f.eventId})`;
  assert.equal((await readCandidates(database, f.eventId))[0].aliases[0], row.trackingId);
  assert.equal((await reconcilePosters(database, [row])).counts.alias_pending, 1);
  await sql`UPDATE poster_announcements SET verified_fingerprint=match_fingerprint,verified_by=${f.adminId},
    verified_at=clock_timestamp(),verification_reason='test'`;
  assert.equal((await reconcilePosters(database, [row])).counts.ready, 1);
  const [target] = await sql`SELECT id FROM poster_targets`;
  await assertInitialReady(database, target.id);
  await sql`UPDATE users SET email='changed@example.invalid' WHERE id=${f.ownerId}`;
  await assert.rejects(assertInitialReady(database, target.id), { code: 'POSTER_ROSTER_CONFLICT' });
  assert.equal((await reconcilePosters(database, [row])).counts.alias_pending, 1);
  await sql`UPDATE abstracts SET presentation_type='oral',tracking_id=${row.trackingId} WHERE id=${f.abstractId}`;
  assert.equal((await reconcilePosters(database, [{ ...row, presentationType: 'oral' }])).counts.ready, 1);
  assert.equal((await sql`SELECT initial_enabled FROM poster_targets`)[0].initial_enabled, false);
  await assert.rejects(assertInitialReady(database, target.id), { code: 'POSTER_NOT_ELIGIBLE' });
});

test('withdraw/re-add preserves used initial right, current file, requests, mail and history', async t => {
  const { client: sql, database, fixture: f, announcement: row } = await preparePosterScenario(t);
  const [target] = await sql`SELECT id FROM poster_targets`;
  const uploadId = randomUUID();
  await sql`INSERT INTO poster_upload_attempts(id,target_id,user_id,operation_key,fingerprint,object_key,filename,mime_type,
    size_bytes,digest,lease_until,claim_token,state) VALUES(${uploadId},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},
    'synthetic/key','test.png','image/png',1,${'b'.repeat(64)},clock_timestamp(),${randomUUID()},'accepted')`;
  await sql`INSERT INTO poster_uploads(id,target_id,attempt_id,version,user_id,object_key,public_url,filename,mime_type,size_bytes,digest,received_at)
    VALUES(${uploadId},${target.id},${uploadId},1,${f.ownerId},'synthetic/key','https://example.invalid/test','test.png','image/png',1,${'b'.repeat(64)},clock_timestamp())`;
  await sql`UPDATE poster_targets SET current_upload_id=${uploadId} WHERE id=${target.id}`;
  await sql`INSERT INTO poster_revision_requests(target_id,details,closes_at,requested_by)
    VALUES(${target.id},'test request',clock_timestamp()+interval '1 hour',${f.adminId})`;
  await sql`INSERT INTO poster_email_jobs(target_id,kind,payload,subject,html,template_version)
    VALUES(${target.id},'initial','{}','test','test','test')`;
  await reconcilePosters(database, []);
  const audits = (await sql`SELECT count(*)::integer AS n FROM poster_audit_events`)[0].n;
  await reconcilePosters(database, []);
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_audit_events`)[0].n, audits);
  await reconcilePosters(database, [row]);
  const [restored] = await sql`SELECT * FROM poster_targets`;
  assert.equal(restored.id, target.id);
  assert.equal(restored.current_upload_id, uploadId);
  assert.equal(restored.initial_enabled, false);
  assert.equal((await sql`SELECT status FROM poster_revision_requests`)[0].status, 'open');
  for (const table of ['poster_uploads', 'poster_email_jobs', 'poster_revision_requests'])
    assert.equal((await sql.unsafe(`SELECT count(*)::integer AS n FROM ${table}`))[0].n, 1);
});

test('distinct database clients serialize reconciliation and retain their captured manifest', async t => {
  const { client: sql, fixture: f, announcement: row } = await preparePosterScenario(t);
  const peers = [openPosterTestDatabase(), openPosterTestDatabase()];
  for (const peer of peers) t.after(() => peer.end({ timeout: 2 }));
  const databases = peers.map(peer => drizzle(peer, { schema }));
  assert.notEqual((await peers[0]`SELECT pg_backend_pid() AS pid`)[0].pid, (await peers[1]`SELECT pg_backend_pid() AS pid`)[0].pid);
  await Promise.all(databases.map(database => reconcilePosters(database, [row])));
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_audit_events`)[0].n, 1);
  let runs: Promise<unknown>[] = [];
  const mutable = [{ ...row, presentationType: 'highlighted-poster' as const }];
  await sql.begin(async lock => {
    await lock.unsafe('SELECT pg_advisory_xact_lock(20261006,$1)', [f.eventId]);
    runs = [reconcilePosters(databases[0], [row]), reconcilePosters(databases[1], mutable)];
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
  assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_targets`)[0].n, 1);
  const [announced] = await sql`SELECT source_row,match_state FROM poster_announcements`;
  assert.equal(announced.source_row.title, row.title);
  assert.equal(announced.match_state, 'ready');
  const [setting] = await sql`SELECT reconcile_ready,manifest_digest FROM poster_settings`;
  assert.equal(setting.reconcile_ready, true);
  const { digest } = await import('./policy.js');
  assert.equal(setting.manifest_digest, digest([announced.source_row]));
});

test('queued failure and success publish readiness in their lock order', async t => {
  const { client: sql, fixture: f, announcement: row } = await preparePosterScenario(t);
  const peers = [openPosterTestDatabase(), openPosterTestDatabase()];
  for (const peer of peers) t.after(() => peer.end({ timeout: 2 }));
  const databases = peers.map(peer => drizzle(peer, { schema }));
  for (const failureFirst of [true, false]) {
    let jobs: Promise<unknown>[] = [];
    await sql.begin(async lock => {
      await lock.unsafe('SELECT pg_advisory_xact_lock(20261006,$1)', [f.eventId]);
      for (const [index, failing] of [failureFirst, !failureFirst].entries()) {
        jobs.push(failing ? assert.rejects(reconcilePosters(databases[index], [row, row]), { code: 'POSTER_DUPLICATE_SOURCE_KEY' })
          : reconcilePosters(databases[index], [row]));
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
    assert.equal((await sql`SELECT reconcile_ready FROM poster_settings`)[0].reconcile_ready, failureFirst);
    assert.equal((await sql`SELECT count(*)::integer AS n FROM poster_audit_events`)[0].n, 1);
  }
});
