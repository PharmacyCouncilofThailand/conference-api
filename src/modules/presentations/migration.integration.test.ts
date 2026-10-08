import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { validateSessionGrantTestDatabaseUrl } from "../session-grants/test-database.js";
import { openPresentationTestDatabase, resetPresentationTestDatabase, seedPresentationScenario } from "./test-support.js";

test("poster database guards reject shared and unapproved targets before connecting", () => {
  assert.throws(() => validateSessionGrantTestDatabaseUrl({
    TEST_DATABASE_URL: "postgres://x:x@localhost/app", DATABASE_URL: "postgres://x:x@localhost/app",
  }), { code: "TEST_DATABASE_MARKER_REQUIRED" });
  assert.throws(() => validateSessionGrantTestDatabaseUrl({
    TEST_DATABASE_URL: "postgres://x:x@localhost/app_test", DATABASE_URL: "postgres://x:x@localhost/app_test",
  }), { code: "TEST_DATABASE_SHARED" });
  for (const url of [
    "postgres://x:x@localhost:55073/confer_posters_integration_test",
    "postgres://x:x@127.0.0.1:5432/confer_posters_integration_test",
    "postgres://x:x@127.0.0.1:55073/confer_posters_runtime_test",
    "postgres://x:x@127.0.0.1:55073/confer_posters_integration_test?options=-csearch_path%3Dtest",
  ]) {
    assert.throws(() => openPresentationTestDatabase({ TEST_DATABASE_URL: url }), /unapproved Presentation test database/);
  }
});

test("poster migration preserves original data and enforces lifecycle constraints", async (t) => {
  const sql = openPresentationTestDatabase();
  t.after(() => sql.end({ timeout: 2 }));
  await resetPresentationTestDatabase(sql);
  const f = await seedPresentationScenario(sql);
  await sql`INSERT INTO abstract_tracking_identifiers VALUES ('PRIS-2026-P001',${f.abstractId},${f.eventId})`;
  const originalTables = ["events", "users", "backoffice_users", "staff_event_assignments", "abstract_categories", "abstracts", "abstract_tracking_identifiers"];
  const snapshot = async () => Promise.all(originalTables.map(async (table) => ({
    table, rows: await sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`),
    columns: await sql`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`,
    constraints: await sql`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=${table}::regclass ORDER BY conname`,
    indexes: await sql`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=${table} AND indexname NOT LIKE 'presentation_%' ORDER BY indexname`,
    triggers: await sql`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=${table}::regclass AND NOT tgisinternal ORDER BY tgname`,
  })));
  const before = await snapshot();
  const enums = await sql`SELECT enumtypid,enumlabel,enumsortorder FROM pg_enum ORDER BY enumtypid,enumsortorder`;
  await sql.unsafe(await readFile("drizzle/0039_pris2026_presentations.sql", "utf8"));
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await sql`SELECT enumtypid,enumlabel,enumsortorder FROM pg_enum ORDER BY enumtypid,enumsortorder`, enums);
  await sql`INSERT INTO presentation_settings(event_id) VALUES (${f.eventId})`;
  const [settings] = await sql`SELECT closes_at,version,reconcile_ready FROM presentation_settings WHERE event_id=${f.eventId}`;
  assert.equal(settings.closes_at.toISOString(), "2026-10-20T17:00:00.000Z");
  assert.equal(settings.version, 1);
  assert.equal(settings.reconcile_ready, false);
  await assert.rejects(() => sql`UPDATE presentation_settings SET closes_at='infinity' WHERE event_id=${f.eventId}`, { code: "23514" });

  const [target] = await sql`INSERT INTO presentation_targets(event_id,abstract_id) VALUES (${f.eventId},${f.abstractId}) RETURNING id`;
  await assert.rejects(() => sql`INSERT INTO presentation_targets(event_id,abstract_id) VALUES (${f.eventId},${f.abstractId})`, { code: "23505" });
  const [otherEvent] = await sql`INSERT INTO events(event_code) VALUES ('OTHER') RETURNING id`;
  await assert.rejects(() => sql`INSERT INTO presentation_targets(event_id,abstract_id) VALUES (${otherEvent.id},${f.abstractId})`, { code: "23503" });
  const [otherAbstract] = await sql`INSERT INTO abstracts(event_id,user_id,title,presentation_type) VALUES (${f.eventId},${f.ownerId},'Other','poster') RETURNING id`;
  const [other] = await sql`INSERT INTO presentation_targets(event_id,abstract_id) VALUES (${f.eventId},${otherAbstract.id}) RETURNING id`;
  const request = async (targetId: string) => (await sql`INSERT INTO presentation_revision_requests(target_id,details,closes_at,requested_by) VALUES (${targetId},'แก้คำอธิบาย',clock_timestamp()+interval '1 hour',${f.adminId}) RETURNING id`)[0].id as string;
  const requestId = await request(target.id);
  const otherRequestId = await request(other.id);
  await assert.rejects(() => request(target.id), { code: "23505" });
  for (const update of [
    sql`UPDATE presentation_revision_requests SET details='changed' WHERE id=${requestId}`,
    sql`UPDATE presentation_revision_requests SET closes_at=closes_at+interval '1 hour' WHERE id=${requestId}`,
    sql`UPDATE presentation_revision_requests SET target_id=${other.id} WHERE id=${requestId}`,
  ]) await assert.rejects(() => update, /Presentation request terms are immutable/);
  await assert.rejects(() => sql`UPDATE presentation_revision_requests SET status='cancelled' WHERE id=${requestId}`, { code: "23514" });
  await assert.rejects(() => sql`UPDATE presentation_revision_requests SET status='cancelled',cancelled_by=${f.adminId},cancelled_at=clock_timestamp() WHERE id=${requestId}`, { code: "23514" });
  await assert.rejects(() => sql`INSERT INTO presentation_announcements(event_id,source_key,source_row,source_digest,verified_by,verified_at) VALUES (${f.eventId},'missing-reason','{}',${'a'.repeat(64)},${f.adminId},clock_timestamp())`, { code: "23514" });

  const attempt = async (targetId: string, requestId: string | null = null) => {
    const id = randomUUID();
    await sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,request_id,operation_key,fingerprint,storage_provider,object_key,original_filename,stored_filename,mime_type,size_bytes,digest,lease_until,claim_token)
      VALUES (${id},${targetId},${f.ownerId},${requestId},${randomUUID()},${'a'.repeat(64)},'r2',${id},'poster.pdf','poster.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()})`;
    return id;
  };
  const upload = async (targetId: string, attemptId: string, requestId: string | null, version: number) => {
    const id = randomUUID();
    await sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,request_id,version,user_id,storage_provider,object_key,file_url,original_filename,stored_filename,mime_type,size_bytes,digest,received_at)
      VALUES (${id},${targetId},${attemptId},${requestId},${version},${f.ownerId},'r2',${id},'https://example.invalid/poster.pdf','poster.pdf','poster.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp())`;
    return id;
  };
  await assert.rejects(() => attempt(target.id, otherRequestId), { code: "23503" });
  const initial = await upload(target.id, await attempt(target.id), null, 1);
  const duplicateInitialAttempt = await attempt(target.id);
  await assert.rejects(() => upload(target.id, duplicateInitialAttempt, null, 2), { code: "23505" });
  const revisionAttempt = await attempt(target.id, requestId);
  await assert.rejects(() => upload(target.id, revisionAttempt, requestId, 1), { code: "23505" });
  const otherAttempt = await attempt(other.id);
  await assert.rejects(() => upload(target.id, otherAttempt, requestId, 3), { code: "23503" });
  await assert.rejects(() => upload(other.id, otherAttempt, requestId, 1), { code: "23503" });
  const revision = await upload(target.id, revisionAttempt, requestId, 2);
  const duplicateRevisionAttempt = await attempt(target.id, requestId);
  await assert.rejects(() => upload(target.id, duplicateRevisionAttempt, requestId, 3), { code: "23505" });
  await assert.rejects(() => sql`UPDATE presentation_targets SET current_upload_id=${initial} WHERE id=${other.id}`, { code: "23503" });
  await sql`UPDATE presentation_targets SET current_upload_id=${revision} WHERE id=${target.id}`;
  for (const field of ["request_id", "upload_id", "automatic_receipt_for"] as const) {
    await assert.rejects(() => sql.unsafe(`INSERT INTO presentation_email_jobs(target_id,kind,${field},payload,subject,html,template_version) VALUES ($1,'initial',$2,'{}','test','test','1')`, [other.id, field === "request_id" ? requestId : initial]), { code: "23503" });
  }
  await assert.rejects(() => sql`INSERT INTO presentation_announcements(event_id,source_key,source_row,source_digest,target_id) VALUES (${otherEvent.id},'test','{}',${'a'.repeat(64)},${target.id})`, { code: "23503" });

  await sql`UPDATE presentation_revision_requests SET status='submitted',submitted_at=clock_timestamp() WHERE id=${requestId}`;
  await assert.rejects(() => sql`UPDATE presentation_revision_requests SET status='open',submitted_at=NULL WHERE id=${requestId}`, /Terminal presentation requests/);
  const cancelled = await request(target.id);
  await sql`UPDATE presentation_revision_requests SET status='cancelled',cancelled_by=${f.adminId},cancelled_at=clock_timestamp(),cancellation_reason='test cancellation' WHERE id=${cancelled}`;
  await assert.rejects(() => sql`UPDATE presentation_revision_requests SET status='open',cancelled_at=NULL WHERE id=${cancelled}`, /Terminal presentation requests/);
  const expired = await request(target.id);
  await sql`UPDATE presentation_revision_requests SET status='expired' WHERE id=${expired}`;
  await assert.rejects(() => sql`UPDATE presentation_revision_requests SET status='open' WHERE id=${expired}`, /Terminal presentation requests/);

  const indexes = await sql`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'presentation_%'`;
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'presentation_%' ORDER BY tablename`;
  assert.deepEqual(tables.map(row => row.tablename), ["presentation_announcements", "presentation_audit_events", "presentation_email_attempts", "presentation_email_jobs", "presentation_operations", "presentation_revision_requests", "presentation_settings", "presentation_targets", "presentation_upload_attempts", "presentation_uploads"]);
  for (const name of ["presentation_one_open_request", "presentation_one_initial_upload", "presentation_one_revision_upload"])
    assert.ok(indexes.some(index => index.indexname === name && index.indexdef.includes("UNIQUE") && index.indexdef.includes("WHERE")));
  const triggers = await sql`SELECT tgname FROM pg_trigger WHERE tgrelid='presentation_revision_requests'::regclass AND NOT tgisinternal`;
  assert.ok(triggers.some(trigger => trigger.tgname === "presentation_request_immutable_guard"));
  const [abstract] = await sql`SELECT status,presentation_type FROM abstracts WHERE id=${f.abstractId}`;
  assert.deepEqual(abstract, { status: "pending", presentation_type: "poster" });
  assert.equal((await sql`SELECT count(*)::integer AS count FROM presentation_uploads WHERE target_id=${target.id}`)[0].count, 2);
});

test("pdf-lib parses a generated one-page PDF and rejects malformed input", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  const parsed = await PDFDocument.load(await document.save());
  assert.equal(parsed.getPageCount(), 1);
  assert.equal(parsed.isEncrypted, false);
  await assert.rejects(() => PDFDocument.load(Buffer.from("not a PDF")));
});

test('replacement deletes all ten legacy test tables, preserves other systems and rolls back a late failure', async t => {
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  await resetPresentationTestDatabase(client);
  const f = await seedPresentationScenario(client);
  await client`INSERT INTO abstract_tracking_identifiers VALUES ('PRIS-2026-P001',${f.abstractId},${f.eventId})`;
  await client`INSERT INTO staff_event_assignments VALUES (${f.adminId},${f.eventId})`;
  await client.unsafe(`CREATE TABLE unrelated_sentinel(id integer PRIMARY KEY,value text NOT NULL);
    CREATE INDEX unrelated_value_index ON unrelated_sentinel(value);
    INSERT INTO unrelated_sentinel VALUES (1,'must remain');`);
  await client.unsafe(await readFile('drizzle/0038_pris2026_posters.sql', 'utf8'));
  await client`INSERT INTO poster_settings(event_id) VALUES (${f.eventId})`;
  const [target] = await client`INSERT INTO poster_targets(event_id,abstract_id) VALUES (${f.eventId},${f.abstractId}) RETURNING id`;
  await client`INSERT INTO poster_announcements(event_id,source_key,source_row,source_digest,target_id)
    VALUES (${f.eventId},'legacy','{}',${'a'.repeat(64)},${target.id})`;
  const [request] = await client`INSERT INTO poster_revision_requests(target_id,details,closes_at,requested_by)
    VALUES (${target.id},'old request',clock_timestamp()+interval '1 hour',${f.adminId}) RETURNING id`;
  const attempt = randomUUID();
  await client`INSERT INTO poster_upload_attempts(id,target_id,user_id,operation_key,fingerprint,object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token)
    VALUES (${attempt},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},'old-object','old.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()})`;
  await client`INSERT INTO poster_uploads(id,target_id,attempt_id,version,user_id,object_key,public_url,filename,mime_type,size_bytes,digest,received_at)
    VALUES (${attempt},${target.id},${attempt},1,${f.ownerId},'old-object','https://test.r2.dev/old-object','old.pdf','application/pdf',1,${'b'.repeat(64)},clock_timestamp())`;
  await client`UPDATE poster_targets SET current_upload_id=${attempt} WHERE id=${target.id}`;
  await client`INSERT INTO poster_operations(event_id,actor_id,action,operation_key,fingerprint,result)
    VALUES (${f.eventId},${f.adminId},'legacy',${randomUUID()},${'a'.repeat(64)},'{}')`;
  const [job] = await client`INSERT INTO poster_email_jobs(target_id,kind,request_id,upload_id,payload,subject,html,template_version)
    VALUES (${target.id},'revision',${request.id},${attempt},'{}','old','old','old') RETURNING id`;
  await client`INSERT INTO poster_email_attempts(job_id,claim_token,result,subject,html,template_version)
    VALUES (${job.id},${randomUUID()},'sending','old','old','old')`;
  await client`INSERT INTO poster_audit_events(event_id,abstract_id,actor_id,action) VALUES (${f.eventId},${f.abstractId},${f.adminId},'legacy')`;
  const suffixes = ['settings','targets','announcements','revision_requests','upload_attempts','uploads','operations','email_jobs','email_attempts','audit_events'];
  const preserved = ['users','backoffice_users','events','abstract_categories','abstracts','abstract_tracking_identifiers','staff_event_assignments','unrelated_sentinel'];
  const rowsOf = async (names: string[]) => Promise.all(names.map(async table => ({ table, rows: await client.unsafe(`SELECT * FROM ${table} ORDER BY 1`) })));
  const before = await rowsOf(preserved);
  const oldBefore = await rowsOf(suffixes.map(name => `poster_${name}`));
  assert.ok(oldBefore.every(item => item.rows.length === 1));
  const sentinelIndexes = await client`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='unrelated_sentinel' ORDER BY indexname`;
  const migration = await readFile('drizzle/0039_pris2026_presentations.sql', 'utf8');
  await assert.rejects(client.unsafe(migration.replace(/COMMIT;\s*$/, 'SELECT 1/0; COMMIT;')), { code: '22012' });
  await client`ROLLBACK`;
  assert.deepEqual(await rowsOf(preserved), before);
  assert.deepEqual(await rowsOf(suffixes.map(name => `poster_${name}`)), oldBefore);
  await client.unsafe(migration);
  assert.deepEqual(await rowsOf(preserved), before);
  assert.deepEqual(await client`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='unrelated_sentinel' ORDER BY indexname`, sentinelIndexes);
  for (const suffix of suffixes) {
    assert.equal((await client`SELECT to_regclass(${'public.poster_' + suffix}) AS name`)[0].name, null);
    assert.notEqual((await client`SELECT to_regclass(${'public.presentation_' + suffix}) AS name`)[0].name, null);
    assert.equal((await client.unsafe(`SELECT count(*)::int AS count FROM presentation_${suffix}`))[0].count, 0);
  }
  await client`INSERT INTO presentation_settings(event_id,version) VALUES (${f.eventId},2)`;
  const current = await client`SELECT * FROM presentation_settings`;
  await assert.rejects(client.unsafe(migration), /Presentation schema already exists/);
  await client`ROLLBACK`;
  assert.deepEqual(await client`SELECT * FROM presentation_settings`, current);
});

test('provider identities, PDF MIME and inclusive provider sizes are enforced by the database', async t => {
  const client = openPresentationTestDatabase(); t.after(() => client.end({ timeout: 2 }));
  await resetPresentationTestDatabase(client);
  const f = await seedPresentationScenario(client);
  await client.unsafe(await readFile('drizzle/0039_pris2026_presentations.sql', 'utf8'));
  const [target] = await client`INSERT INTO presentation_targets(event_id,abstract_id) VALUES (${f.eventId},${f.abstractId}) RETURNING id`;
  const insert = async (provider: string, size: number, objectKey: string | null, fileId: string | null, folderId: string | null,
    state = 'reserved', mime = 'application/pdf') => {
    const id = randomUUID();
    await client`INSERT INTO presentation_upload_attempts(id,target_id,user_id,operation_key,fingerprint,storage_provider,
      object_key,drive_file_id,drive_folder_id,original_filename,stored_filename,mime_type,size_bytes,digest,lease_until,claim_token,state)
      VALUES (${id},${target.id},${f.ownerId},${randomUUID()},${'a'.repeat(64)},${provider},${objectKey},${fileId},${folderId},
        'slides.pdf','PRIS-2026-O001_slides.pdf',${mime},${size},${'b'.repeat(64)},clock_timestamp()+interval '1 hour',${randomUUID()},${state})`;
    return id;
  };
  await insert('r2',31_457_280,'r2-limit',null,null);
  await insert('drive',52_428_800,null,'drive-limit','folder','stored');
  const unallocated = await insert('drive',1,null,null,null);
  for (const input of [
    ['r2',31_457_281,'too-big',null,null], ['drive',52_428_801,null,'too-big','folder'],
    ['drive',1,'object','file','folder'], ['r2',1,'object','file','folder'],
    ['drive',1,null,'file',null], ['drive',1,null,null,null,'stored'],
    ['r2',1,'png',null,null,'reserved','image/png'], ['other',1,'object',null,null],
  ] as Array<[string,number,string|null,string|null,string|null,string?,string?]>) {
    await assert.rejects(insert(...input), { code: '23514' });
  }
  await assert.rejects(client`UPDATE presentation_upload_attempts SET state='accepted' WHERE id=${unallocated}`, { code: '23514' });
  await assert.rejects(client`INSERT INTO presentation_uploads(id,target_id,attempt_id,version,user_id,storage_provider,original_filename,stored_filename,
    file_url,mime_type,size_bytes,digest,received_at) VALUES (${randomUUID()},${target.id},${unallocated},1,${f.ownerId},'drive',
      'slides.pdf','slides.pdf','https://drive.google.com/file/d/missing/view','application/pdf',1,${'b'.repeat(64)},clock_timestamp())`, { code: '23514' });
});

test("poster harness rejects runtime reset and bootstraps linked integration fixtures", async (t) => {
  const sql = openPresentationTestDatabase();
  t.after(() => sql.end({ timeout: 2 }));
  // A synthetic connection identity proves the guard without touching a runtime DB.
  const runtimeSql = (() => Promise.resolve([{ database: 'confer_runtime', schema: 'public' }])) as unknown as typeof sql;
  await assert.rejects(() => resetPresentationTestDatabase(runtimeSql), /outside the authorized integration database/);
  await resetPresentationTestDatabase(sql);
  const fixture = await seedPresentationScenario(sql);
  const [row] = await sql`
    SELECT a.event_id, a.user_id, a.status, a.presentation_type, u.email, e.event_code
    FROM abstracts a JOIN users u ON u.id = a.user_id JOIN events e ON e.id = a.event_id
    WHERE a.id = ${fixture.abstractId}
  `;
  assert.deepEqual(row, {
    event_id: fixture.eventId, user_id: fixture.ownerId, status: "pending",
    presentation_type: "poster", email: fixture.owner.email, event_code: "PRIS-2026",
  });
  assert.match(fixture.operationKey, /^[0-9a-f-]{36}$/);
  await assert.rejects(() => sql`
    INSERT INTO abstract_tracking_identifiers(tracking_id,abstract_id,event_id)
    VALUES ('missing',2147483000,${fixture.eventId})
  `, /foreign key constraint/);
});
