import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type postgres from "postgres";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";

type Sql = ReturnType<typeof postgres>;

async function migrationSql(): Promise<string> {
  return readFile(resolve(process.cwd(), "drizzle", "0033_pris_daily_attendance.sql"), "utf8");
}

async function applyMigration(sql: Sql): Promise<void> {
  try {
    await sql.unsafe(await migrationSql());
  } catch (error) {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function resetAttendanceTables(sql: Sql): Promise<void> {
  await sql.unsafe(`
    DROP TABLE IF EXISTS session_daily_checkins;
    DROP TABLE IF EXISTS session_attendance_policies;
  `);
}

async function relationExists(sql: Sql, name: string): Promise<boolean> {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT to_regclass(current_schema() || '.' || ${name}) IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
}

async function indexExists(sql: Sql, name: string): Promise<boolean> {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT to_regclass(current_schema() || '.' || ${name}) IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
}

async function seedFixture(sql: Sql) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
    VALUES (${`LW-T01-${suffix}`},'Lucky Wheel T01','multi_session',
      '2026-10-29 00:00:00','2026-10-31 23:59:59','published')
    RETURNING id
  `;
  const [session] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (
      event_id,session_code,session_name,start_time,end_time,is_main_session,is_active
    ) VALUES (
      ${event.id},${`LW-MAIN-${suffix}`},'Lucky Wheel Main Session',
      '2026-10-29 02:00:00','2026-10-30 10:00:00',true,true
    ) RETURNING id
  `;
  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
    VALUES (${event.id},'primary','regular','Lucky Wheel T01 Ticket',0,'THB',1000)
    RETURNING id
  `;
  const [registration] = await sql<Array<{ id: number }>>`
    INSERT INTO registrations (
      reg_code,event_id,ticket_type_id,email,first_name,last_name,status
    ) VALUES (
      ${`LW-T01-REG-${suffix}`},${event.id},${ticket.id},
      ${`lw-t01-${suffix}@example.invalid`},'Lucky','Wheel','confirmed'
    ) RETURNING id
  `;
  const [entitlement] = await sql<Array<{ id: number }>>`
    INSERT INTO registration_sessions (
      registration_id,session_id,ticket_type_id,source
    ) VALUES (${registration.id},${session.id},${ticket.id},'purchase')
    RETURNING id
  `;
  const [staff] = await sql<Array<{ id: number }>>`
    INSERT INTO backoffice_users (
      email,password_hash,role,first_name,last_name,is_active
    ) VALUES (
      ${`lw-t01-admin-${suffix}@example.invalid`},'test-only-hash','admin',
      'Lucky','Admin',true
    ) RETURNING id
  `;
  return {
    eventId: event.id,
    sessionId: session.id,
    registrationSessionId: entitlement.id,
    staffId: staff.id,
  };
}

test(
  "0033 daily attendance migration preserves history and enforces one active row per Bangkok day",
  { timeout: 60_000 },
  async (t) => {
    assert.doesNotThrow(() =>
      validateSessionGrantTestDatabaseUrl({
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    );
    assert.throws(
      () =>
        validateSessionGrantTestDatabaseUrl({
          TEST_DATABASE_URL: process.env.DATABASE_URL,
          DATABASE_URL: process.env.DATABASE_URL,
        }),
      { code: "TEST_DATABASE_SHARED" },
    );

    const sql = openSessionGrantTestDatabase();
    const concurrentSql = openSessionGrantTestDatabase();
    t.after(async () => {
      await sql.end({ timeout: 2 });
      await concurrentSql.end({ timeout: 2 });
    });

    await resetAttendanceTables(sql);
    const fixture = await seedFixture(sql);
    const [{ entitlement_count: beforeCount }] = await sql<Array<{ entitlement_count: number }>>`
      SELECT count(*)::int AS entitlement_count FROM registration_sessions
    `;

    await applyMigration(sql);

    assert.equal(await relationExists(sql, "session_attendance_policies"), true);
    assert.equal(await relationExists(sql, "session_daily_checkins"), true);
    assert.equal(await indexExists(sql, "session_daily_checkins_active_day_unique"), true);
    assert.equal(await indexExists(sql, "session_daily_checkins_legacy_source_unique"), true);

    const [{ policy_count: policyCountBeforeExplicitSetup }] = await sql<
      Array<{ policy_count: number }>
    >`
      SELECT count(*)::int AS policy_count FROM session_attendance_policies
    `;
    assert.equal(policyCountBeforeExplicitSetup, 0);

    await sql`
      INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
      VALUES (${fixture.eventId},${fixture.sessionId},'daily',true)
    `;
    await assert.rejects(
      () => sql`
        UPDATE session_attendance_policies
        SET mode='single'
        WHERE event_id=${fixture.eventId} AND session_id=${fixture.sessionId}
      `,
      /check constraint/i,
    );

    const day = "2026-10-30";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const results = await Promise.allSettled([
      sql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO session_daily_checkins (
            id,registration_session_id,attendance_date,checked_in_at,checked_in_by
          ) VALUES ($1,$2,$3,'2026-10-30T02:00:00Z',$4)`,
          [firstId, fixture.registrationSessionId, day, fixture.staffId],
        );
      }),
      concurrentSql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO session_daily_checkins (
            id,registration_session_id,attendance_date,checked_in_at,checked_in_by
          ) VALUES ($1,$2,$3,'2026-10-30T02:00:01Z',$4)`,
          [secondId, fixture.registrationSessionId, day, fixture.staffId],
        );
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const [{ active_count: activeAfterRace }] = await sql<Array<{ active_count: number }>>`
      SELECT count(*)::int AS active_count
      FROM session_daily_checkins
      WHERE registration_session_id=${fixture.registrationSessionId}
        AND attendance_date=${day}
        AND cancelled_at IS NULL
    `;
    assert.equal(activeAfterRace, 1);

    const [activeRow] = await sql<Array<{ id: string }>>`
      SELECT id
      FROM session_daily_checkins
      WHERE registration_session_id=${fixture.registrationSessionId}
        AND attendance_date=${day}
        AND cancelled_at IS NULL
    `;

    await assert.rejects(
      () => sql`
        UPDATE session_daily_checkins
        SET cancelled_at=now(),cancelled_by=${fixture.staffId},cancellation_reason=NULL
        WHERE id=${activeRow.id}
      `,
      /check constraint/i,
    );
    await assert.rejects(
      () => sql`
        UPDATE session_daily_checkins
        SET cancelled_at=now(),cancelled_by=${fixture.staffId},cancellation_reason='   '
        WHERE id=${activeRow.id}
      `,
      /check constraint/i,
    );

    await sql`
      UPDATE session_daily_checkins
      SET cancelled_at=now(),cancelled_by=${fixture.staffId},cancellation_reason='operator correction'
      WHERE id=${activeRow.id}
    `;

    const replacementId = crypto.randomUUID();
    await sql`
      INSERT INTO session_daily_checkins (
        id,registration_session_id,attendance_date,checked_in_at,checked_in_by,
        legacy_source_key
      ) VALUES (
        ${replacementId},${fixture.registrationSessionId},${day},
        '2026-10-30T03:00:00Z',${fixture.staffId},
        ${`registration_sessions:${fixture.registrationSessionId}`}
      )
    `;

    await assert.rejects(
      () => sql`
        DELETE FROM registration_sessions
        WHERE id=${fixture.registrationSessionId}
      `,
      /foreign key constraint/i,
    );

    const [{ total_count: totalBeforeRerun, active_count: activeBeforeRerun }] =
      await sql<Array<{ total_count: number; active_count: number }>>`
        SELECT count(*)::int AS total_count,
          count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active_count
        FROM session_daily_checkins
        WHERE registration_session_id=${fixture.registrationSessionId}
          AND attendance_date=${day}
      `;
    assert.deepEqual(
      { total: totalBeforeRerun, active: activeBeforeRerun },
      { total: 2, active: 1 },
    );

    await assert.rejects(
      () => sql`
        INSERT INTO session_daily_checkins (
          id,registration_session_id,attendance_date,checked_in_at,checked_in_by,
          cancelled_at,cancelled_by,cancellation_reason,legacy_source_key
        ) VALUES (
          ${crypto.randomUUID()},${fixture.registrationSessionId},'2026-10-29',
          '2026-10-29T03:00:00Z',${fixture.staffId},
          now(),${fixture.staffId},'historical cancellation',
          ${`registration_sessions:${fixture.registrationSessionId}`}
        )
      `,
      /duplicate key/i,
    );

    await applyMigration(sql);

    const [{ total_count: totalAfterRerun, active_count: activeAfterRerun }] =
      await sql<Array<{ total_count: number; active_count: number }>>`
        SELECT count(*)::int AS total_count,
          count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active_count
        FROM session_daily_checkins
        WHERE registration_session_id=${fixture.registrationSessionId}
          AND attendance_date=${day}
      `;
    assert.deepEqual(
      { total: totalAfterRerun, active: activeAfterRerun },
      { total: 2, active: 1 },
    );

    const [{ entitlement_count: afterCount }] = await sql<Array<{ entitlement_count: number }>>`
      SELECT count(*)::int AS entitlement_count FROM registration_sessions
    `;
    assert.equal(afterCount, beforeCount);
  },
);
