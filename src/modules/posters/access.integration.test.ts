import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql as statement } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { requirePosterOwner, requirePosterStaff, dbNow, rows } from "./access.js";
import { adminOperation, audit } from "./operations.js";
import { openPosterTestDatabase, resetPosterTestDatabase, seedPosterScenario } from "./test-support.js";

test("poster guards use current account family, role, ownership and PRIS assignment", async (t) => {
  const sql = openPosterTestDatabase();
  t.after(() => sql.end({ timeout: 2 }));
  await resetPosterTestDatabase(sql);
  const f = await seedPosterScenario(sql);
  const db = drizzle(sql, { schema });
  assert.equal(f.ownerId, f.adminId); // Separate account tables can have the same numeric ID.
  assert.equal((await requirePosterOwner(db, f.owner, f.abstractId)).abstractId, f.abstractId);
  await db.transaction(async tx => assert.equal((await requirePosterOwner(tx, f.owner, f.abstractId, true)).userId, f.ownerId));
  await assert.rejects(requirePosterOwner(db, f.admin, f.abstractId), { code: "POSTER_OWNER_REQUIRED", statusCode: 403 });
  await assert.rejects(requirePosterStaff(db, f.owner, f.eventId, true), { code: "POSTER_ACCESS_DENIED" });
  await requirePosterStaff(db, f.admin, f.eventId, true);
  await assert.rejects(requirePosterStaff(db, { ...f.admin, email: f.owner.email }, f.eventId, true), { code: "POSTER_ACCESS_DENIED" });
  await sql`UPDATE backoffice_users SET is_active=false WHERE id=${f.adminId}`;
  await assert.rejects(requirePosterStaff(db, f.admin, f.eventId, false), { code: "POSTER_ACCESS_DENIED" });
  await sql`UPDATE backoffice_users SET is_active=true,role='reviewer' WHERE id=${f.adminId}`;
  await assert.rejects(requirePosterStaff(db, f.admin, f.eventId, true), { code: "POSTER_ACCESS_DENIED" });
  for (const role of ["reviewer", "organizer"]) {
    await sql`UPDATE backoffice_users SET role=${role} WHERE id=${f.adminId}`;
    const actor = { ...f.admin, role };
    await assert.rejects(requirePosterStaff(db, actor, f.eventId, false), { code: "POSTER_ACCESS_DENIED" });
    await sql`INSERT INTO staff_event_assignments(staff_id,event_id) VALUES (${f.adminId},${f.eventId})`;
    await requirePosterStaff(db, actor, f.eventId, false);
    await assert.rejects(requirePosterStaff(db, actor, f.eventId, true), { code: "POSTER_ACCESS_DENIED" });
    await sql`DELETE FROM staff_event_assignments WHERE staff_id=${f.adminId}`;
  }
  const [otherEvent] = await sql`INSERT INTO events(event_code) VALUES ('OTHER') RETURNING id`;
  await sql`UPDATE backoffice_users SET role='admin' WHERE id=${f.adminId}`;
  await assert.rejects(requirePosterStaff(db, f.admin, otherEvent.id, true), { code: "POSTER_EVENT_NOT_FOUND", statusCode: 404 });
  await assert.rejects(requirePosterStaff(db, f.admin, 2147483000, false), { code: "POSTER_EVENT_NOT_FOUND" });
  const [other] = await sql`INSERT INTO users(email,first_name,last_name) VALUES (${f.owner.email},'Other','Owner') RETURNING id`;
  await assert.rejects(requirePosterOwner(db, { ...f.owner, id: other.id }, f.abstractId), error => {
    assert.equal((error as { code: string }).code, "POSTER_OWNER_REQUIRED");
    assert.ok(!JSON.stringify(error).includes(f.owner.email));
    return true;
  });
  await sql`UPDATE users SET role='student' WHERE id=${f.ownerId}`;
  await assert.rejects(requirePosterOwner(db, f.owner, f.abstractId), { code: "POSTER_OWNER_REQUIRED" });
  await requirePosterOwner(db, { ...f.owner, role: "student" }, f.abstractId);
  await sql`UPDATE users SET status='disabled' WHERE id=${f.ownerId}`;
  await assert.rejects(requirePosterOwner(db, { ...f.owner, role: "student" }, f.abstractId), { code: "POSTER_OWNER_REQUIRED" });
  await sql`UPDATE users SET status='active',role='pharmacist' WHERE id=${f.ownerId}`;
  await sql`UPDATE abstracts SET event_id=${otherEvent.id} WHERE id=${f.abstractId}`;
  await assert.rejects(requirePosterOwner(db, f.owner, f.abstractId), { code: "POSTER_OWNER_REQUIRED" });
});

test("poster Admin operations serialize replay, conflict and audit rollback", async (t) => {
  const sql = openPosterTestDatabase();
  t.after(() => sql.end({ timeout: 2 }));
  await resetPosterTestDatabase(sql);
  const f = await seedPosterScenario(sql);
  await sql.unsafe(await readFile("drizzle/0038_pris2026_posters.sql", "utf8"));
  const db = drizzle(sql, { schema });
  let calls = 0;
  const peers = [openPosterTestDatabase(), openPosterTestDatabase()];
  for (const peer of peers) t.after(() => peer.end({ timeout: 2 }));
  const run = (key: string = f.operationKey, input = { deadline: "2026-10-20" }, database = db) => adminOperation(database, f.admin, f.eventId, "test", key, input, async tx => {
    calls++;
    await tx.execute(statement`SELECT pg_sleep(0.05)`);
    await audit(tx, f.eventId, f.abstractId, f.adminId, "test", "test reason", null, input);
    return { id: randomUUID(), deadline: input.deadline };
  });
  const results = await Promise.all([run(), ...peers.map(peer => run(f.operationKey, undefined, drizzle(peer, { schema })))]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(calls, 1);
  assert.deepEqual(await run(f.operationKey.toUpperCase()), results[0]);
  await assert.rejects(run("invalid-key"), { code: "POSTER_IDEMPOTENCY_KEY_INVALID", statusCode: 400 });
  await assert.rejects(run(f.operationKey, { deadline: "different" }), { code: "POSTER_IDEMPOTENCY_CONFLICT", statusCode: 409 });
  assert.equal((await sql`SELECT count(*)::integer AS count FROM poster_audit_events`)[0].count, 1);
  assert.equal((await sql`SELECT count(*)::integer AS count FROM poster_operations`)[0].count, 1);
  const failedKey = randomUUID();
  await assert.rejects(adminOperation(db, f.admin, f.eventId, "test", failedKey, {}, async tx => {
    await audit(tx, f.eventId, f.abstractId, f.adminId, "rollback", null, {}, {});
    throw new Error("fail work");
  }), /fail work/);
  assert.equal((await sql`SELECT count(*)::integer AS count FROM poster_audit_events`)[0].count, 1);
  assert.equal((await sql`SELECT count(*)::integer AS count FROM poster_operations`)[0].count, 1);
  await run(failedKey);
  assert.equal((await sql`SELECT count(*)::integer AS count FROM poster_operations`)[0].count, 2);
  await assert.rejects(adminOperation(db, f.owner, f.eventId, "test", randomUUID(), {}, async () => ({})), { code: "POSTER_ACCESS_DENIED" });
  await sql`UPDATE backoffice_users SET role='reviewer' WHERE id=${f.adminId}`;
  await assert.rejects(run(), { code: "POSTER_ACCESS_DENIED" }); // Replay still requires current permissions.
});

test("poster operation rechecks Admin permission after waiting for its key lock", async (t) => {
  const sql = openPosterTestDatabase();
  const peer = openPosterTestDatabase();
  t.after(() => sql.end({ timeout: 2 }));
  t.after(() => peer.end({ timeout: 2 }));
  await resetPosterTestDatabase(sql);
  const f = await seedPosterScenario(sql);
  await sql.unsafe(await readFile("drizzle/0038_pris2026_posters.sql", "utf8"));
  const db = drizzle(peer, { schema });
  let calls = 0;
  let operation: Promise<unknown>;
  await sql.begin(async tx => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${f.eventId}:${f.adminId}:waiting:${f.operationKey}`]);
    operation = assert.rejects(adminOperation(db, f.admin, f.eventId, "waiting", f.operationKey, {}, async () => {
      calls++;
      return {};
    }), { code: "POSTER_ACCESS_DENIED" });
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const [state] = await tx.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND pid<>pg_backend_pid()
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`);
      waiting = state.waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waiting, "operation must reach the held advisory lock");
    await tx.unsafe("UPDATE backoffice_users SET role='reviewer' WHERE id=$1", [f.adminId]);
  });
  await operation!;
  assert.equal(calls, 0);
  assert.equal((await sql`SELECT count(*)::integer AS count FROM poster_operations`)[0].count, 0);
});

test("poster clock advances within a transaction after the required lock", async (t) => {
  const sql = openPosterTestDatabase();
  t.after(() => sql.end({ timeout: 2 }));
  const db = drizzle(sql, { schema });
  await db.transaction(async tx => {
    const [start] = await rows<{ now: Date }>(tx, statement`SELECT now() AS now`);
    await tx.execute(statement`SELECT pg_advisory_xact_lock(70904004),pg_sleep(0.08)`);
    const current = await dbNow(tx);
    assert.ok(current.getTime() - new Date(start.now).getTime() >= 60);
  });
});
