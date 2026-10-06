import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { verifyAlias, changePosterSettings } from './operations.js';
import { reconcilePosters } from './reconcile.js';
import { preparePosterScenario, openPosterTestDatabase } from './test-support.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema.js';

test('alias approval rejects stale data and reviewer, records one audited replay', async t => {
  const { client: sql, database, fixture: f, announcement } = await preparePosterScenario(t);
  await sql`UPDATE abstracts SET tracking_id='PRIS-2026-P099' WHERE id=${f.abstractId}`;
  await sql`INSERT INTO abstract_tracking_identifiers VALUES ('PRIS-2026-P001',${f.abstractId},${f.eventId})`;
  await reconcilePosters(database, [announcement]);
  const [ann] = await sql`SELECT match_fingerprint FROM poster_announcements`;
  const input = { sourceKey: '1:1', fingerprint: ann.match_fingerprint, reason: 'Verified original tracking identifier' };
  await sql`UPDATE backoffice_users SET role='reviewer' WHERE id=${f.adminId}`;
  await assert.rejects(verifyAlias(database, { ...f.admin, role: 'reviewer' }, f.eventId, randomUUID(), input), { statusCode: 403 });
  await sql`UPDATE backoffice_users SET role='admin' WHERE id=${f.adminId}`;
  await assert.rejects(verifyAlias(database, f.admin, f.eventId, randomUUID(), { ...input, fingerprint: '0'.repeat(64) }), { statusCode: 409 });
  const key = randomUUID();
  const result = await verifyAlias(database, f.admin, f.eventId, key, input);
  assert.deepEqual(await verifyAlias(database, f.admin, f.eventId, key, input), result);
  assert.equal((await sql`SELECT count(*)::int AS n FROM poster_audit_events WHERE action='alias_verified'`)[0].n, 1);
  assert.equal((await sql`SELECT initial_enabled FROM poster_targets`)[0].initial_enabled, true);
  await reconcilePosters(database, [announcement, { ...announcement, id: 2 }]);
  await assert.rejects(verifyAlias(database, f.admin, f.eventId, randomUUID(), input), { code: 'POSTER_ROSTER_CONFLICT' });
});

test('settings replay preserves version and mandatory audit; stale versions reject', async t => {
  const { client: sql, database, fixture: f } = await preparePosterScenario(t);
  const input = { closesAt: '2026-10-20T17:00:00Z', reason: 'Extend deadline', version: 1 };
  const key = randomUUID();
  const result = await changePosterSettings(database, f.admin, f.eventId, key, input);
  assert.equal(result.version, 2);
  assert.deepEqual(await changePosterSettings(database, f.admin, f.eventId, key, input), result);
  await assert.rejects(changePosterSettings(database, f.admin, f.eventId, randomUUID(), input), { code: 'POSTER_SETTINGS_STALE' });
  assert.equal((await sql`SELECT count(*)::int AS n FROM poster_audit_events WHERE action='deadline_changed'`)[0].n, 1);
});

test('two clients racing deadline versions commit one audit; failed audit rolls back', async t => {
  const { client: sql, database, fixture: f } = await preparePosterScenario(t);
  const peer = openPosterTestDatabase();
  t.after(() => peer.end({ timeout: 2 }));
  const other = drizzle(peer, { schema });
  const input = { closesAt: '2026-10-21T17:00:00Z', reason: 'Race deadline', version: 1 };
  const results = await Promise.allSettled([changePosterSettings(database, f.admin, f.eventId, randomUUID(), input),
    changePosterSettings(other, f.admin, f.eventId, randomUUID(), input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'POSTER_SETTINGS_STALE');
  await sql.unsafe(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER reject_audit BEFORE INSERT ON poster_audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit()`);
  await assert.rejects(changePosterSettings(database, f.admin, f.eventId, randomUUID(), { ...input, version: 2 }));
  assert.equal((await sql`SELECT version FROM poster_settings`)[0].version, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM poster_operations`)[0].n, 1);
});
