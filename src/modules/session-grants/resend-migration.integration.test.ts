import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { openSessionGrantTestDatabase } from "./test-database.js";

test("0050 preserves old rows and guards resend purposes, references and actor keys", async () => {
  const client = openSessionGrantTestDatabase();
  const namespace = `resend_migration_${randomUUID().replaceAll("-", "")}`;
  try {
    // A dedicated schema rehearses only this additive migration; shared test schema remains untouched.
    await client.unsafe(`CREATE SCHEMA ${namespace}; SET search_path TO ${namespace}`);
    await client.unsafe(`CREATE TABLE backoffice_users (id integer PRIMARY KEY);
      CREATE TABLE sessions (id integer PRIMARY KEY);
      CREATE TABLE registration_session_grant_items (id uuid PRIMARY KEY, outcome text NOT NULL, email_status text NOT NULL);
      CREATE TABLE registration_session_grant_email_attempts (id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES registration_session_grant_items(id), attempt_no integer NOT NULL, result text NOT NULL);
      INSERT INTO backoffice_users VALUES (1); INSERT INTO sessions VALUES (1)`);
    const itemId = randomUUID();
    await client`INSERT INTO registration_session_grant_items VALUES (${itemId},'invited','sent')`;
    const before = await client`SELECT id,outcome,email_status FROM registration_session_grant_items`;
    await client.unsafe(await readFile(new URL("../../../drizzle/0050_session_invitation_resends.sql", import.meta.url), "utf8"));
    assert.deepEqual(await client`SELECT id,outcome,email_status FROM registration_session_grant_items`, before);
    const [old] = await client`SELECT next_email_purpose,next_resend_request_id,last_resend_queued_at FROM registration_session_grant_items`;
    assert.equal(old.next_email_purpose, "initial"); assert.equal(old.next_resend_request_id, null); assert.equal(old.last_resend_queued_at, null);
    const requestId = randomUUID(), key = randomUUID();
    await client`INSERT INTO session_invitation_resend_requests (id,actor_id,session_id,idempotency_key,request_hash,result)
      VALUES (${requestId},1,1,${key},${"a".repeat(64)},'{}')`;
    await assert.rejects(client`INSERT INTO session_invitation_resend_requests (id,actor_id,session_id,idempotency_key,request_hash,result)
      VALUES (${randomUUID()},1,1,${key},${"b".repeat(64)},'{}')`, { code: "23505" });
    await assert.rejects(client`UPDATE registration_session_grant_items SET next_email_purpose='bad' WHERE id=${itemId}`, { code: "23514" });
    await assert.rejects(client`UPDATE registration_session_grant_items SET next_email_purpose='resend' WHERE id=${itemId}`, { code: "23514" });
    await assert.rejects(client`UPDATE registration_session_grant_items SET next_resend_request_id=${randomUUID()} WHERE id=${itemId}`, { code: "23503" });
    await client`UPDATE registration_session_grant_items SET next_email_purpose='resend',next_resend_request_id=${requestId},last_resend_queued_at=now(),email_status='pending' WHERE id=${itemId}`;
    await client`INSERT INTO registration_session_grant_email_attempts (id,item_id,attempt_no,result) VALUES (${randomUUID()},${itemId},1,'sent')`;
    const [initial] = await client`SELECT purpose,resend_request_id FROM registration_session_grant_email_attempts`;
    assert.equal(initial.purpose, "initial"); assert.equal(initial.resend_request_id, null);
    await client`INSERT INTO registration_session_grant_email_attempts (id,item_id,attempt_no,result,purpose,resend_request_id)
      VALUES (${randomUUID()},${itemId},2,'sending','resend',${requestId})`;
    await assert.rejects(client`UPDATE registration_session_grant_email_attempts SET purpose='bad'`, { code: "23514" });
    await assert.rejects(client`UPDATE registration_session_grant_email_attempts SET resend_request_id=${randomUUID()}`, { code: "23503" });
    await client`UPDATE registration_session_grant_email_attempts SET result='sent' WHERE attempt_no=2`;
    await client`UPDATE registration_session_grant_items SET email_status='sent',next_email_purpose='initial',next_resend_request_id=NULL WHERE id=${itemId}`;
    assert.equal((await client`SELECT count(*)::integer AS total FROM registration_session_grant_items`)[0].total, 1);
  } finally {
    await client.unsafe("ROLLBACK").catch(() => undefined);
    await client.unsafe(`SET search_path TO public; DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await client.end({ timeout: 2 });
  }
});
