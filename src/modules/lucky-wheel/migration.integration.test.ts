import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type postgres from "postgres";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";

type Sql = ReturnType<typeof postgres>;

async function migrationSql(fileName: string): Promise<string> {
  return (await readFile(resolve(process.cwd(), "drizzle", fileName), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
}

async function applyMigration(sql: Sql): Promise<void> {
  await sql.unsafe(await migrationSql("0034_lucky_wheel.sql"));
}

async function applyCreditMigration(sql: Sql): Promise<void> {
  await sql.unsafe(await migrationSql("0035_lucky_wheel_qr_credits.sql"));
}

async function bootstrapDependencies(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE events (
      id serial PRIMARY KEY,
      event_code varchar(50) NOT NULL UNIQUE
    );
    CREATE TABLE sessions (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,
      start_time timestamptz NOT NULL,
      end_time timestamptz NOT NULL
    );
    CREATE TABLE users (id serial PRIMARY KEY);
    CREATE TABLE backoffice_users (id serial PRIMARY KEY);
    CREATE TABLE session_daily_checkins (id uuid PRIMARY KEY);
  `);
}

test("lucky wheel migration enforces stock, identity, idempotency and historical invariants", { timeout: 120_000 }, async (t) => {
  assert.doesNotThrow(() => validateSessionGrantTestDatabaseUrl({
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  }));
  const sql = openSessionGrantTestDatabase();
  t.after(async () => sql.end({ timeout: 2 }));

  await resetSessionGrantIntegrationSchema(sql);
  await bootstrapDependencies(sql);
  await applyMigration(sql);

  const requiredTables = [
    "lucky_wheels",
    "lucky_wheel_images",
    "lucky_wheel_segments",
    "lucky_wheel_spins",
    "lucky_wheel_audit_events",
    "lucky_wheel_redemptions",
    "lucky_wheel_redemption_corrections",
  ];
  for (const tableName of requiredTables) {
    const [{ exists }] = await sql<Array<{ exists: boolean }>>`
      SELECT to_regclass(current_schema() || '.' || ${tableName}) IS NOT NULL AS exists
    `;
    assert.equal(exists, true, `missing ${tableName}`);
  }

  const [eventA] = await sql<Array<{ id: number }>>`INSERT INTO events (event_code) VALUES ('LW-A') RETURNING id`;
  const [eventB] = await sql<Array<{ id: number }>>`INSERT INTO events (event_code) VALUES ('LW-B') RETURNING id`;
  const [mainA] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${eventA.id}, true, '2026-10-29T02:00:00Z', '2026-10-30T10:00:00Z') RETURNING id
  `;
  const [nonMainA] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${eventA.id}, false, '2026-10-29T02:00:00Z', '2026-10-30T10:00:00Z') RETURNING id
  `;
  const [mainB] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${eventB.id}, true, '2026-10-29T02:00:00Z', '2026-10-30T10:00:00Z') RETURNING id
  `;
  const [invalidTimeMainA] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${eventA.id}, true, '2026-10-29T02:00:00Z', '2026-10-29T02:00:00Z') RETURNING id
  `;

  await assert.rejects(
    sql`INSERT INTO lucky_wheels (event_id, main_session_id, enabled) VALUES (${eventA.id}, ${mainA.id}, true)`,
  );
  await assert.rejects(
    sql`INSERT INTO lucky_wheels (
      event_id, main_session_id, enabled, published_configuration, collection_instructions, collection_deadline
    ) VALUES (
      ${eventA.id}, ${invalidTimeMainA.id}, true, '{}'::jsonb, '{"th":"จุดรับ","en":"Desk"}'::jsonb, '2026-10-30T11:00:00Z'
    )`,
  );
  await assert.rejects(
    sql`INSERT INTO lucky_wheels (event_id, main_session_id, enabled) VALUES (${eventA.id}, ${nonMainA.id}, true)`,
  );
  await assert.rejects(
    sql`INSERT INTO lucky_wheels (
      event_id, main_session_id, enabled, published_configuration, collection_instructions, collection_deadline
    ) VALUES (
      ${eventA.id}, ${mainB.id}, true, '{}'::jsonb, '{"th":"จุดรับ","en":"Desk"}'::jsonb, '2026-10-30T11:00:00Z'
    )`,
  );

  const [wheel] = await sql<Array<{ id: string }>>`
    INSERT INTO lucky_wheels (
      event_id, main_session_id, enabled, paused, published_configuration, collection_instructions, collection_deadline
    ) VALUES (
      ${eventA.id}, ${mainA.id}, true, false,
      '{"segments":[]}'::jsonb, '{"th":"จุดรับ","en":"Desk"}'::jsonb, '2026-10-30T11:00:00Z'
    ) RETURNING id
  `;

  const prizeId = "00000000-0000-4000-8000-000000000061";
  const loseId = "00000000-0000-4000-8000-000000000062";
  await sql`
    INSERT INTO lucky_wheel_segments (id, wheel_id, kind, name_th, name_en, enabled, position, remaining)
    VALUES
      (${prizeId}, ${wheel.id}, 'prize', 'ปากกา', 'Pen', true, 0, 1),
      (${loseId}, ${wheel.id}, 'no_prize', 'เสียใจด้วย', 'No prize', true, 1, NULL)
  `;
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_segments (id, wheel_id, kind, name_th, name_en, enabled, position, remaining)
    VALUES ('00000000-0000-4000-8000-000000000063', ${wheel.id}, 'no_prize', 'x', 'x', true, 2, 1)
  `);
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_segments (id, wheel_id, kind, name_th, name_en, enabled, position, remaining)
    VALUES ('00000000-0000-4000-8000-000000000064', ${wheel.id}, 'prize', 'x', 'x', true, 2, -1)
  `);

  const [user] = await sql<Array<{ id: number }>>`INSERT INTO users DEFAULT VALUES RETURNING id`;
  const attendanceId = "00000000-0000-4000-8000-000000000065";
  await sql`INSERT INTO session_daily_checkins (id) VALUES (${attendanceId})`;
  const requestId = "00000000-0000-4000-8000-000000000066";
  await sql`
    INSERT INTO lucky_wheel_spins (
      wheel_id, event_id, user_id, play_date, attendance_id, attendance_checked_in_at,
      segment_id, outcome_kind, awarded_name_th, awarded_name_en,
      configuration_version, pool_revision, configuration_snapshot, outcome_snapshot,
      idempotency_key, request_hash
    ) VALUES (
      ${wheel.id}, ${eventA.id}, ${user.id}, '2026-10-29', ${attendanceId}, '2026-10-29T03:00:00Z',
      ${prizeId}, 'prize', 'ปากกา', 'Pen',
      1, 1, '{}'::jsonb, '{}'::jsonb, ${requestId}, repeat('a', 64)
    )
  `;
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_spins (
      wheel_id, event_id, user_id, play_date, attendance_id, attendance_checked_in_at,
      segment_id, outcome_kind, awarded_name_th, awarded_name_en,
      configuration_version, pool_revision, configuration_snapshot, outcome_snapshot,
      idempotency_key, request_hash
    ) VALUES (
      ${wheel.id}, ${eventA.id}, ${user.id}, '2026-10-29', ${attendanceId}, '2026-10-29T03:01:00Z',
      ${loseId}, 'no_prize', 'เสียใจด้วย', 'No prize',
      1, 1, '{}'::jsonb, '{}'::jsonb, '00000000-0000-4000-8000-000000000067', repeat('b', 64)
    )
  `);
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_spins (
      wheel_id, event_id, user_id, play_date, attendance_id, attendance_checked_in_at,
      segment_id, outcome_kind, awarded_name_th, awarded_name_en,
      configuration_version, pool_revision, configuration_snapshot, outcome_snapshot,
      idempotency_key, request_hash
    ) VALUES (
      ${wheel.id}, ${eventA.id}, ${user.id}, '2026-10-30', ${attendanceId}, '2026-10-30T03:01:00Z',
      ${loseId}, 'no_prize', 'เสียใจด้วย', 'No prize',
      1, 1, '{}'::jsonb, '{}'::jsonb, ${requestId}, repeat('c', 64)
    )
  `);

  const [admin] = await sql<Array<{ id: number }>>`INSERT INTO backoffice_users DEFAULT VALUES RETURNING id`;
  const adminRequest = "00000000-0000-4000-8000-000000000068";
  await sql`
    INSERT INTO lucky_wheel_audit_events (
      wheel_id, event_id, actor_backoffice_user_id, operation, idempotency_key, reason
    ) VALUES (${wheel.id}, ${eventA.id}, ${admin.id}, 'stock_adjust', ${adminRequest}, 'เติมสต็อก')
  `;
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_audit_events (
      wheel_id, event_id, actor_backoffice_user_id, operation, idempotency_key, reason
    ) VALUES (${wheel.id}, ${eventA.id}, ${admin.id}, 'stock_adjust', ${adminRequest}, 'retry')
  `);

  await assert.rejects(sql`DELETE FROM session_daily_checkins WHERE id = ${attendanceId}`);

  await applyMigration(sql);
  const [{ spinCount }] = await sql<Array<{ spinCount: number }>>`
    SELECT count(*)::int AS "spinCount" FROM lucky_wheel_spins
  `;
  assert.equal(spinCount, 1);

  const [legacySpin] = await sql<Array<{ id: string }>>`
    SELECT id FROM lucky_wheel_spins WHERE idempotency_key = ${requestId}
  `;
  await sql`
    INSERT INTO lucky_wheel_redemptions (spin_id, event_id)
    VALUES (${legacySpin.id}, ${eventA.id})
  `;

  await applyCreditMigration(sql);
  await applyCreditMigration(sql);
  const [legacy] = await sql<Array<{ creditClaimId: string | null; redemptionCount: number }>>`
    SELECT s.credit_claim_id AS "creditClaimId", count(r.id)::int AS "redemptionCount"
    FROM lucky_wheel_spins s
    LEFT JOIN lucky_wheel_redemptions r ON r.spin_id = s.id
    WHERE s.id = ${legacySpin.id}
    GROUP BY s.id
  `;
  assert.equal(legacy.creditClaimId, null);
  assert.equal(legacy.redemptionCount, 1);

  const [day] = await sql<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
    VALUES (${wheel.id}, ${eventA.id}, '2026-10-29', '2026-10-29T02:00:00Z', '2026-10-29T12:00:00Z') RETURNING id
  `;
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
    VALUES (${wheel.id}, ${eventB.id}, '2026-10-30', '2026-10-30T02:00:00Z', '2026-10-30T12:00:00Z')
  `);
  const [qrA] = await sql<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
    VALUES (${day.id}, ${eventA.id}, '2026-10-29', 'Morning', ${admin.id}) RETURNING id
  `;
  const [qrB] = await sql<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
    VALUES (${day.id}, ${eventA.id}, '2026-10-29', 'Afternoon', ${admin.id}) RETURNING id
  `;
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
    VALUES (${day.id}, ${eventB.id}, '2026-10-29', 'Wrong event', ${admin.id})
  `);
  const [creditA] = await sql<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_credit_claims (qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at)
    VALUES (${qrA.id}, ${eventA.id}, '2026-10-29', ${user.id}, ${attendanceId}, '2026-10-29T12:00:00Z') RETURNING id
  `;
  const [creditB] = await sql<Array<{ id: string }>>`
    INSERT INTO lucky_wheel_credit_claims (qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at)
    VALUES (${qrB.id}, ${eventA.id}, '2026-10-29', ${user.id}, ${attendanceId}, '2026-10-29T12:00:00Z') RETURNING id
  `;
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_credit_claims (qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at)
    VALUES (${qrA.id}, ${eventA.id}, '2026-10-29', ${user.id}, ${attendanceId}, '2026-10-29T12:00:00Z')
  `);
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_credit_claims (qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at)
    VALUES (${qrA.id}, ${eventA.id}, '2026-10-30', ${user.id}, ${attendanceId}, '2026-10-29T12:00:00Z')
  `);

  for (const [creditId, key] of [
    [creditA.id, '00000000-0000-4000-8000-000000000071'],
    [creditB.id, '00000000-0000-4000-8000-000000000072'],
  ]) {
    await sql`
      INSERT INTO lucky_wheel_spins (
        wheel_id, event_id, user_id, play_date, attendance_id, attendance_checked_in_at,
        segment_id, outcome_kind, awarded_name_th, awarded_name_en,
        configuration_version, pool_revision, configuration_snapshot, outcome_snapshot,
        idempotency_key, request_hash, credit_claim_id
      ) VALUES (
        ${wheel.id}, ${eventA.id}, ${user.id}, '2026-10-29', ${attendanceId}, '2026-10-29T03:10:00Z',
        ${loseId}, 'no_prize', 'เสียใจด้วย', 'No prize',
        1, 1, '{}'::jsonb, '{}'::jsonb, ${key}, repeat('d', 64), ${creditId}
      )
    `;
  }
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_spins (
      wheel_id, event_id, user_id, play_date, attendance_id, attendance_checked_in_at,
      segment_id, outcome_kind, awarded_name_th, awarded_name_en,
      configuration_version, pool_revision, configuration_snapshot, outcome_snapshot,
      idempotency_key, request_hash, credit_claim_id
    ) VALUES (
      ${wheel.id}, ${eventA.id}, ${user.id}, '2026-10-29', ${attendanceId}, '2026-10-29T03:11:00Z',
      ${loseId}, 'no_prize', 'เสียใจด้วย', 'No prize',
      1, 1, '{}'::jsonb, '{}'::jsonb, '00000000-0000-4000-8000-000000000073', repeat('e', 64), ${creditA.id}
    )
  `);
  await assert.rejects(sql`
    INSERT INTO lucky_wheel_spins (
      wheel_id, event_id, user_id, play_date, attendance_id, attendance_checked_in_at,
      segment_id, outcome_kind, awarded_name_th, awarded_name_en,
      configuration_version, pool_revision, configuration_snapshot, outcome_snapshot,
      idempotency_key, request_hash
    ) VALUES (
      ${wheel.id}, ${eventA.id}, ${user.id}, '2026-10-29', ${attendanceId}, '2026-10-29T03:12:00Z',
      ${loseId}, 'no_prize', 'เสียใจด้วย', 'No prize',
      1, 1, '{}'::jsonb, '{}'::jsonb, '00000000-0000-4000-8000-000000000074', repeat('f', 64)
    )
  `);
  const [{ finalSpinCount }] = await sql<Array<{ finalSpinCount: number }>>`
    SELECT count(*)::int AS "finalSpinCount" FROM lucky_wheel_spins
  `;
  assert.equal(finalSpinCount, 3);
  await sql.unsafe(await migrationSql("0036_lucky_wheel_setup_simplification.sql"));
  await sql`
    UPDATE lucky_wheels
    SET collection_instructions = NULL, collection_deadline = NULL
    WHERE id = ${wheel.id}
  `;
  await sql`
    UPDATE lucky_wheel_qr_codes
    SET status = 'open', opened_by = ${admin.id}, opened_at = clock_timestamp(), opened_reason = NULL
    WHERE id = ${qrA.id}
  `;
  await sql`
    UPDATE lucky_wheel_qr_codes
    SET status = 'closed', closed_by = ${admin.id}, closed_at = clock_timestamp(), closed_reason = NULL
    WHERE id = ${qrA.id}
  `;
  await assert.rejects(sql`
    UPDATE lucky_wheel_qr_codes SET closed_reason = '   ' WHERE id = ${qrA.id}
  `);
});
