import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type postgres from "postgres";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";

type Sql = ReturnType<typeof postgres>;

async function migrationSql(): Promise<string> {
  return readFile(
    resolve(process.cwd(), "drizzle", "0032_admin_session_invitations.sql"),
    "utf8",
  );
}

async function applyInvitationMigration(sql: Sql): Promise<void> {
  try {
    await sql.unsafe(await migrationSql());
  } catch (error) {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function columnExists(sql: Sql, tableName: string, columnName: string) {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name=${tableName}
        AND column_name=${columnName}
    ) AS exists
  `;
  return row?.exists ?? false;
}

async function tableExists(sql: Sql, tableName: string) {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT to_regclass(current_schema() || '.' || ${tableName}) IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
}

async function resetTo0031(sql: Sql): Promise<void> {
  await sql.unsafe(`
    DROP TABLE IF EXISTS session_invitations;
    DELETE FROM registration_session_grant_items WHERE outcome='invited';
    ALTER TABLE sessions DROP COLUMN IF EXISTS admin_grant_requires_confirmation;
    ALTER TABLE registration_session_grant_batches
      DROP CONSTRAINT IF EXISTS session_grant_batches_invited_nonnegative,
      DROP CONSTRAINT IF EXISTS registration_session_grant_batches_completion_count_check,
      DROP COLUMN IF EXISTS invited_count;
    ALTER TABLE registration_session_grant_batches
      ADD CONSTRAINT registration_session_grant_batches_completion_count_check
      CHECK (completed_at IS NULL OR requested_count = added_count + skipped_count);
    ALTER TABLE registration_session_grant_items
      DROP CONSTRAINT IF EXISTS registration_session_grant_items_outcome_check,
      DROP CONSTRAINT IF EXISTS registration_session_grant_items_outcome_email_check;
    ALTER TABLE registration_session_grant_items
      ADD CONSTRAINT registration_session_grant_items_outcome_check
      CHECK (outcome IN ('added','skipped'));
    ALTER TABLE registration_session_grant_items
      ADD CONSTRAINT registration_session_grant_items_outcome_email_check
      CHECK (
        (outcome='skipped' AND email_status='not_applicable' AND reason_code IS NOT NULL)
        OR (outcome='added' AND email_status<>'not_applicable' AND reason_code IS NULL)
      );
  `);
}

async function seedLegacyCompletedBatch(sql: Sql) {
  const suffix = Date.now().toString(36);
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
    VALUES (${`INV-MIG-${suffix}`},'Invitation Migration','multi_session',
      '2026-10-20 00:00:00','2026-10-31 23:59:59','published')
    RETURNING id
  `;
  const [session] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id,session_code,session_name,start_time,end_time,is_active,max_capacity)
    VALUES (${event.id},${`INV-SESSION-${suffix}`},'Invitation Session',
      '2026-10-29 05:00:00','2026-10-29 06:00:00',true,50)
    RETURNING id
  `;
  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
    VALUES (${event.id},'primary','regular','Invitation Migration Ticket',100,'THB',100)
    RETURNING id
  `;
  const [registration] = await sql<Array<{ id: number }>>`
    INSERT INTO registrations (
      reg_code,event_id,ticket_type_id,email,first_name,last_name,status
    ) VALUES (
      ${`INV-MIG-REG-${suffix}`},${event.id},${ticket.id},
      'invitation-migration@example.invalid','Invitation','Migration','confirmed'
    ) RETURNING id
  `;
  const [entitlement] = await sql<Array<{ id: number }>>`
    INSERT INTO registration_sessions (
      registration_id,session_id,ticket_type_id,source
    ) VALUES (${registration.id},${session.id},${ticket.id},'purchase')
    RETURNING id
  `;
  const batchId = crypto.randomUUID();
  const addedId = crypto.randomUUID();
  const skippedId = crypto.randomUUID();
  await sql`
    INSERT INTO registration_session_grant_batches (
      id,actor_id,actor_name_snapshot,idempotency_key,request_hash,
      session_id,event_id,session_name_snapshot,requested_count,
      added_count,skipped_count,completed_at
    ) VALUES (
      ${batchId},9001,'Historical Admin',${crypto.randomUUID()},${"a".repeat(64)},
      ${session.id},${event.id},'Invitation Session',2,1,1,now()
    )
  `;
  await sql`
    INSERT INTO registration_session_grant_items (
      id,batch_id,requested_registration_id,registration_session_id,
      reg_code_snapshot,name_snapshot,outcome,reason_code,
      email_status,attempt_count,next_trigger
    ) VALUES
      (${addedId},${batchId},${registration.id},${entitlement.id},
        ${`INV-MIG-REG-${suffix}`},'Invitation Migration','added',NULL,
        'sent',1,'system'),
      (${skippedId},${batchId},2147483000,NULL,
        NULL,NULL,'skipped','REGISTRATION_NOT_FOUND',
        'not_applicable',0,'system')
  `;
  return { eventId:event.id, sessionId:session.id, registrationId:registration.id, batchId };
}

test(
  "admin session invitation migration upgrades 0031 safely",
  { timeout: 60_000 },
  async (t) => {
    assert.doesNotThrow(() =>
      validateSessionGrantTestDatabaseUrl({
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    );
    const sql = openSessionGrantTestDatabase();
    t.after(async () => sql.end({ timeout: 2 }));

    await resetTo0031(sql);
    assert.equal(await columnExists(sql, "sessions", "admin_grant_requires_confirmation"), false);
    assert.equal(await tableExists(sql, "session_invitations"), false);

    const fixture = await seedLegacyCompletedBatch(sql);
    const oldChecks = await sql<Array<{ table_name: string; conname: string; expression: string }>>`
      SELECT c.relname AS table_name, con.conname,
        pg_get_constraintdef(con.oid) AS expression
      FROM pg_constraint con
      JOIN pg_class c ON c.oid=con.conrelid
      WHERE c.relname IN ('registration_session_grant_batches','registration_session_grant_items')
        AND con.contype='c'
      ORDER BY c.relname,con.conname
    `;
    assert.ok(oldChecks.some((row) => row.expression.includes("added_count") && row.expression.includes("skipped_count")));
    assert.ok(oldChecks.some((row) => row.expression.includes("'added'") && row.expression.includes("'skipped'")));

    await applyInvitationMigration(sql);

    assert.equal(await columnExists(sql, "sessions", "admin_grant_requires_confirmation"), true);
    assert.equal(await columnExists(sql, "registration_session_grant_batches", "invited_count"), true);
    assert.equal(await tableExists(sql, "session_invitations"), true);
    const [session] = await sql<Array<{ flag: boolean }>>`
      SELECT admin_grant_requires_confirmation AS flag FROM sessions WHERE id=${fixture.sessionId}
    `;
    assert.equal(session.flag, false);

    const [historical] = await sql<Array<{ requested: number; added: number; invited: number; skipped: number }>>`
      SELECT requested_count AS requested,added_count AS added,invited_count AS invited,skipped_count AS skipped
      FROM registration_session_grant_batches WHERE id=${fixture.batchId}
    `;
    assert.deepEqual(historical, { requested:2, added:1, invited:0, skipped:1 });

    await assert.rejects(
      () => sql`
        INSERT INTO registration_session_grant_items (
          id,batch_id,requested_registration_id,outcome,email_status,attempt_count,next_trigger
        ) VALUES (
          ${crypto.randomUUID()},${fixture.batchId},2147482999,
          'invited','not_applicable',0,'system'
        )
      `,
      /violates check constraint/i,
    );

    const invitedItemId = crypto.randomUUID();
    await sql`
      INSERT INTO registration_session_grant_items (
        id,batch_id,requested_registration_id,outcome,email_status,attempt_count,next_trigger
      ) VALUES (
        ${invitedItemId},${fixture.batchId},2147482998,
        'invited','pending',0,'system'
      )
    `;
    await assert.rejects(
      () => sql`
        INSERT INTO session_invitations (
          id,registration_id,session_id,grant_item_id,status,token_hash,
          token_ciphertext,expires_at,created_by
        ) VALUES (
          ${crypto.randomUUID()},2147483000,${fixture.sessionId},${invitedItemId},'pending',
          ${"b".repeat(64)},${JSON.stringify({version:1})}::jsonb,now()+interval '1 hour',9001
        )
      `,
      /foreign key/i,
    );
  },
);

test(
  "0032 lock timeout leaves no partial invitation DDL",
  { timeout: 30_000 },
  async (t) => {
    const sql = openSessionGrantTestDatabase();
    const lockSql = openSessionGrantTestDatabase();
    t.after(async () => {
      await sql.end({ timeout: 2 });
      await lockSql.end({ timeout: 2 });
    });

    await resetTo0031(sql);
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const lockTask = lockSql.begin(async (tx) => {
      await tx.unsafe("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE");
      acquired();
      await releasePromise;
    });
    await acquiredPromise;

    await assert.rejects(() => applyInvitationMigration(sql), /lock timeout|canceling statement/i);
    assert.equal(await columnExists(sql, "sessions", "admin_grant_requires_confirmation"), false);
    assert.equal(await columnExists(sql, "registration_session_grant_batches", "invited_count"), false);
    assert.equal(await tableExists(sql, "session_invitations"), false);

    release();
    await lockTask;
    await applyInvitationMigration(sql);
    assert.equal(await tableExists(sql, "session_invitations"), true);
  },
);
