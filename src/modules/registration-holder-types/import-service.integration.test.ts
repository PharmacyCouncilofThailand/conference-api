import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { runImport, HOLDER_IMPORT_MIGRATION } from './import-service.js';
import { HOLDER_TYPE_KEYS } from './catalog.js';
import { runHolderTypeRollback } from './rollback.js';

// Explicit opt-in to a disposable local PostgreSQL server. Never uses DATABASE_URL.
const testUrl = process.env.HOLDER_IMPORT_TEST_DATABASE_URL;
test('holder import PostgreSQL transaction, compatibility and failure cases', { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5547');
  const sql = postgres(testUrl!, { max: 1, onnotice: () => {} });
  const directory = await mkdtemp(join(tmpdir(), 'holder-import-integration-'));
  await chmod(directory, 0o700);
  let owned = false;
  let sequence = 0;
  const hash = 'a'.repeat(64);
  const entries = Array.from({ length: 559 }, (_, i) => ({ row: i + 2, regCode: `TEST-${i + 1}`, email: `person${i + 1}@example.test`, holderType: HOLDER_TYPE_KEYS[i % 11] }));
  const parsed = { entries, skipped: [{ row: 561, reason: 'Test' }], errors: [] };
  const options = { expectedCount: 559, expectedEventId: 2 };
  const applyOptions = () => ({ ...options, apply: true, backup: join(directory, `${++sequence}.json`) });
  async function reset() {
    if (owned) await sql.unsafe('DROP TABLE public.registrations; DROP TABLE public.events');
    await sql.unsafe(`CREATE TABLE public.events(id integer PRIMARY KEY,event_code text NOT NULL);
      INSERT INTO public.events VALUES(2,'PRIS-2026'),(3,'OTHER');
      CREATE TABLE public.registrations(id integer PRIMARY KEY,reg_code text NOT NULL UNIQUE,email text NOT NULL,event_id integer REFERENCES public.events(id),status text DEFAULT 'confirmed',price numeric DEFAULT 1250)`);
    owned = true;
    await sql`INSERT INTO public.registrations(id,reg_code,email,event_id)
      SELECT id,reg_code,email,2 FROM jsonb_to_recordset(${sql.json(entries.map((e, i) => ({ id: i + 1, reg_code: e.regCode, email: e.email })))}::jsonb) AS x(id integer,reg_code text,email text)`;
    await sql`INSERT INTO public.registrations(id,reg_code,email,event_id) VALUES (999,'OTHER-999','other@example.test',3)`;
  }
  const snapshot = async () => JSON.stringify(await sql`SELECT to_jsonb(r) AS data FROM public.registrations r ORDER BY id`);
  try {
    const existing = await sql`SELECT to_regclass('public.registrations') AS registrations,to_regclass('public.events') AS events`;
    assert.equal(existing[0].registrations, null, 'test server must be empty');
    assert.equal(existing[0].events, null, 'test server must be empty');
    await reset();
    await t.test('dry-run validates 559 rows without DDL or data writes', async () => {
      const before = await snapshot();
      const result = await runImport(sql, parsed, hash, options);
      assert.equal(result.changes, 559);
      assert.equal(result.applied, false);
      assert.equal(await snapshot(), before);
    });
    await t.test('applies all eleven types, preserves every non-holder field, supports old inserts and repeat imports', async () => {
      const before = await sql`SELECT id,md5(to_jsonb(r)::text) AS fingerprint FROM public.registrations r ORDER BY id`;
      const opts = applyOptions();
      const result = await runImport(sql, parsed, hash, opts);
      assert.equal(result.changes, 559);
      const after = await sql`SELECT id,md5((to_jsonb(r)-ARRAY['holder_type','holder_type_source','holder_type_updated_at'])::text) AS fingerprint FROM public.registrations r ORDER BY id`;
      assert.deepEqual([...after], [...before]);
      const counts = await sql`SELECT count(DISTINCT holder_type)::int AS types,count(holder_type)::int AS assigned FROM public.registrations`;
      assert.deepEqual(counts[0], { types: 11, assigned: 559 });
      const backup = JSON.parse(await readFile(opts.backup, 'utf8'));
      assert.equal(backup.changes.length, 559);
      assert.equal(JSON.stringify(backup).includes('@example.test'), false);
      const stable = await snapshot();
      assert.equal((await runImport(sql, parsed, hash, applyOptions())).changes, 0);
      assert.equal(await snapshot(), stable);
      await sql`INSERT INTO public.registrations(id,reg_code,email,event_id) VALUES(1000,'OLD-INSERT','old@example.test',2)`;
      assert.equal((await sql`SELECT holder_type FROM public.registrations WHERE id=1000`)[0].holder_type, null);
      await assert.rejects(sql`UPDATE public.registrations SET holder_type='invalid' WHERE id=1000`, /check constraint/);
    });
    await t.test('wrong email, missing registration, foreign event and conflicting category abort all rows', async () => {
      await reset();
      const before = await snapshot();
      for (const changed of [
        { ...entries[0], email: 'wrong@example.test' },
        { ...entries[0], regCode: 'missing' },
        { ...entries[0], regCode: 'OTHER-999', email: 'other@example.test' },
      ]) {
        await assert.rejects(runImport(sql, { ...parsed, entries: [changed, ...entries.slice(1)] }, hash, applyOptions()), /preflight/);
        assert.equal(await snapshot(), before);
      }
      await sql.unsafe(HOLDER_IMPORT_MIGRATION);
      await sql`UPDATE public.registrations SET holder_type='vip' WHERE id=1`;
      const withConflict = await snapshot();
      await assert.rejects(runImport(sql, parsed, hash, applyOptions()), /preflight/);
      assert.equal(await snapshot(), withConflict);
    });
    await t.test('backup failure prevents schema and data mutation', async () => {
      await reset();
      const before = await snapshot();
      await assert.rejects(runImport(sql, parsed, hash, { ...options, apply: true, backup: join(directory, 'missing', 'backup.json') }));
      assert.equal(await snapshot(), before);
    });
    await t.test('a trigger changing unrelated data rolls back rows AND additive DDL', async () => {
      await reset();
      await sql.unsafe(`CREATE FUNCTION public.holder_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status='unexpected'; RETURN NEW; END $$;
        CREATE TRIGGER holder_test_trigger BEFORE UPDATE ON public.registrations FOR EACH ROW EXECUTE FUNCTION public.holder_test_trigger()`);
      const before = await snapshot();
      try {
        await assert.rejects(runImport(sql, parsed, hash, applyOptions()), /Non-holder/);
        assert.equal(await snapshot(), before);
        assert.equal((await sql`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='registrations' AND column_name='holder_type'`)[0].count, 0);
      } finally {
        await sql.unsafe('DROP TRIGGER holder_test_trigger ON public.registrations; DROP FUNCTION public.holder_test_trigger()');
      }
    });
    await t.test('guarded rollback preserves later unrelated edits and rejects changed holder metadata', async () => {
      await reset();
      const opts = applyOptions();
      await runImport(sql, parsed, hash, opts);
      const backup = JSON.parse(await readFile(opts.backup, 'utf8'));
      await sql`UPDATE public.registrations SET status='checked_in' WHERE id=1`;
      const stable = await snapshot();
      assert.deepEqual(await runHolderTypeRollback(sql, backup), { applied: false, changes: 559 });
      assert.equal(await snapshot(), stable);
      await sql`UPDATE public.registrations SET holder_type='vip' WHERE id=1`;
      const conflict = await snapshot();
      await assert.rejects(runHolderTypeRollback(sql, backup, { apply: true }), /differs from backup/);
      assert.equal(await snapshot(), conflict);
      await sql`UPDATE public.registrations SET holder_type=${entries[0].holderType} WHERE id=1`;
      assert.deepEqual(await runHolderTypeRollback(sql, backup, { apply: true }), { applied: true, changes: 559 });
      assert.equal((await sql`SELECT count(holder_type)::int AS count FROM public.registrations`)[0].count, 0);
      assert.equal((await sql`SELECT status FROM public.registrations WHERE id=1`)[0].status, 'checked_in');
      await assert.rejects(runHolderTypeRollback(sql, backup, { apply: true }), /differs from backup/);
    });
    await t.test('rejects a weakened CHECK even when it contains every allowed key', async () => {
      await reset();
      await sql.unsafe(HOLDER_IMPORT_MIGRATION);
      await sql.unsafe(`ALTER TABLE public.registrations DROP CONSTRAINT registrations_holder_type_check;
        ALTER TABLE public.registrations ADD CONSTRAINT registrations_holder_type_check CHECK (holder_type IS NULL OR holder_type IN (${HOLDER_TYPE_KEYS.map(key => `'${key}'`).join(',')}) OR TRUE)`);
      const before = await snapshot();
      await assert.rejects(runImport(sql, parsed, hash, applyOptions()), /CHECK constraint/);
      assert.equal(await snapshot(), before);
    });
  } finally {
    if (owned) await sql.unsafe('DROP TABLE public.registrations; DROP TABLE public.events');
    await sql.end();
    await rm(directory, { recursive: true, force: true });
  }
});
