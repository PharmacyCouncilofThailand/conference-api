import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type postgres from "postgres";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";

type Sql = ReturnType<typeof postgres>;

const priorMigrationFiles = [
  "0000_soft_donald_blake.sql",
  "0001_famous_maddog.sql",
  "0002_funny_banshee.sql",
  "0003_white_rockslide.sql",
  "0004_open_shooting_star.sql",
  "0005_chilly_lockjaw.sql",
  // 0007_serious_marvel_zombies.sql supersedes the duplicated 0006 SQL in
  // this repository snapshot. Applying both reproduces the known stale
  // journal conflict (duplicate user_role.general and duplicate objects).
  "0007_serious_marvel_zombies.sql",
  "0008_pay_solutions_gateway.sql",
  "0009_tax_invoice_orders.sql",
  "0010_manual_registration.sql",
  "0011_multi_event_safe_orders.sql",
  "0012_shared_auth_university.sql",
  "0013_event_email_columns.sql",
  "0014_drop_event_email_columns.sql",
  "0015_allowed_student_levels.sql",
  "0016_update_user_roles_and_columns.sql",
  "0017_student_level_alignment.sql",
  "0018_abstract_confirmation.sql",
  "0019_sponsor_module.sql",
  "0020_drop_sponsor_profile_bank_fields.sql",
  "0021_sponsor_profile_logo.sql",
  "0022_session_requires_opt_in.sql",
  "0023_ticket_priority_late_onsite.sql",
  "0024_team_registration_foundation.sql",
  "0024a_team_registration_payment_snapshots.sql",
  "0025_team_registration_viewer_role.sql",
  "0026_team_registration_payment_statuses.sql",
  "0027_team_registration_payment_retry_safety.sql",
] as const;

async function migrationSql(fileName: string): Promise<string> {
  const raw = await readFile(resolve(process.cwd(), "drizzle", fileName), "utf8");
  return raw.replaceAll("--> statement-breakpoint", "");
}

async function applyMigrationFile(sql: Sql, fileName: string): Promise<void> {
  const content = await migrationSql(fileName);
  try {
    await sql.unsafe(content);
  } catch (error) {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    throw new Error(`Failed applying ${fileName}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function setupSql(fileName: string): Promise<string> {
  const raw = await readFile(
    resolve(process.cwd(), "sql", "abstract-tracking-setup", fileName),
    "utf8",
  );
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n");
}

async function applySetupFile(sql: Sql, fileName: string): Promise<void> {
  const content = await setupSql(fileName);
  try {
    await sql.unsafe(content);
  } catch (error) {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    throw new Error(
      `Failed applying abstract-tracking setup ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function applyAbstractTrackingPrerequisites(sql: Sql): Promise<void> {
  await applySetupFile(sql, "01_stage_manifest_tables.sql");

  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (
      event_code, event_name, event_type, start_date, end_date, status
    ) VALUES (
      'SG-TRACKING-TEST', 'Synthetic Tracking Migration Test', 'multi_session',
      '2026-09-01 00:00:00', '2026-09-30 23:59:59', 'completed'
    )
    RETURNING id
  `;

  const batchId = "00000000-0000-0000-0000-000000000031";
  await sql`
    INSERT INTO abstract_tracking_migration_batches (
      migration_batch_id, expected_namespace_digest, expected_floor_digest
    ) VALUES (
      ${batchId}, 'synthetic-test-namespace-digest', 'synthetic-test-floor-digest'
    )
  `;
  await sql`
    INSERT INTO abstract_tracking_manifest_namespaces (
      migration_batch_id, event_id, prefix, padding_width,
      evidence_source, approved_by, approved_at, approval_reason
    ) VALUES (
      ${batchId}, ${event.id}, 'SGTEST', 3,
      'synthetic Docker migration fixture', 'automated-test',
      '2026-09-30T00:00:00Z', 'isolated pre-0031 representative schema'
    )
  `;
  await sql`
    INSERT INTO abstract_tracking_manifest_floors (
      migration_batch_id, event_id, presentation_type, approved_floor,
      evidence_source, approved_by, approved_at, approval_reason
    ) VALUES
      (
        ${batchId}, ${event.id}, 'oral', 0,
        'synthetic Docker migration fixture', 'automated-test',
        '2026-09-30T00:00:00Z', 'isolated pre-0031 representative schema'
      ),
      (
        ${batchId}, ${event.id}, 'poster', 0,
        'synthetic Docker migration fixture', 'automated-test',
        '2026-09-30T00:00:00Z', 'isolated pre-0031 representative schema'
      )
  `;
  await sql`SELECT freeze_abstract_tracking_manifest(${batchId}::uuid)`;

  await applyMigrationFile(sql, "0028_abstract_tracking_allocator.sql");
  // 0028 imports the latest frozen manifest floors into
  // abstract_tracking_approved_floors itself.
  await applySetupFile(sql, "02_online_backfill.sql");
  await applySetupFile(sql, "03_cutover.sql");
  await applySetupFile(sql, "07_prepare_hardening.sql");
  await applyMigrationFile(sql, "0029_abstract_tracking_hardening.sql");
}

async function applyPriorMigrations(sql: Sql): Promise<void> {
  for (const fileName of priorMigrationFiles) {
    await applyMigrationFile(sql, fileName);
  }
  await applyAbstractTrackingPrerequisites(sql);
  await applyMigrationFile(sql, "0030_promo_checkout_hardening.sql");
}

async function applyGrantMigration(sql: Sql): Promise<void> {
  await applyMigrationFile(sql, "0031_admin_session_grants.sql");
}

async function columnIsNullable(
  sql: Sql,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const [row] = await sql<Array<{ is_nullable: "YES" | "NO" }>>`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${tableName}
      AND column_name = ${columnName}
  `;
  assert.ok(row, `missing ${tableName}.${columnName}`);
  return row.is_nullable === "YES";
}

async function tableExists(sql: Sql, tableName: string): Promise<boolean> {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT to_regclass(current_schema() || '.' || ${tableName}) IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
}

async function indexExists(sql: Sql, indexName: string): Promise<boolean> {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT to_regclass(current_schema() || '.' || ${indexName}) IS NOT NULL AS exists
  `;
  return row?.exists ?? false;
}

async function seedEntitlementFixture(sql: Sql) {
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (
      event_code, event_name, event_type, start_date, end_date, status
    ) VALUES (
      'SG-MIG-EVENT', 'Session Grants Migration Test', 'multi_session',
      '2026-10-01 00:00:00', '2026-10-03 00:00:00', 'published'
    )
    RETURNING id
  `;

  const [session] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (
      event_id, session_code, session_name, start_time, end_time, is_active
    ) VALUES (
      ${event.id}, 'SG-MIG-SESSION', 'Migration Session',
      '2026-10-01 09:00:00', '2026-10-01 12:00:00', true
    )
    RETURNING id
  `;

  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (
      event_id, category, priority, name, price, currency, quota
    ) VALUES (
      ${event.id}, 'primary', 'regular', 'Migration Ticket',
      100, 'THB', 1000
    )
    RETURNING id
  `;

  const [registration] = await sql<Array<{ id: number }>>`
    INSERT INTO registrations (
      reg_code, event_id, ticket_type_id, email, first_name, last_name, status
    ) VALUES (
      'SG-MIG-REG', ${event.id}, ${ticket.id},
      'migration-test@example.invalid', 'Migration', 'Registrant', 'confirmed'
    )
    RETURNING id
  `;

  return {
    eventId: event.id,
    sessionId: session.id,
    ticketId: ticket.id,
    registrationId: registration.id,
  };
}

test(
  "session grant migration gates MIG-01/02/03/05",
  { timeout: 180_000 },
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
    t.after(async () => {
      await sql.end({ timeout: 2 });
    });

    await t.test("MIG-01 and MIG-03 clean apply preserves primary ticket and enforces entitlement uniqueness", async () => {
      await resetSessionGrantIntegrationSchema(sql);
      await applyPriorMigrations(sql);

      assert.equal(
        await columnIsNullable(sql, "registrations", "ticket_type_id"),
        false,
      );
      assert.equal(
        await columnIsNullable(sql, "registration_sessions", "ticket_type_id"),
        false,
      );

      const fixture = await seedEntitlementFixture(sql);
      await applyGrantMigration(sql);

      assert.equal(
        await columnIsNullable(sql, "registrations", "ticket_type_id"),
        false,
      );
      assert.equal(
        await columnIsNullable(sql, "registration_sessions", "ticket_type_id"),
        true,
      );
      assert.equal(
        await indexExists(sql, "registration_sessions_registration_session_unique"),
        true,
      );
      assert.equal(
        await tableExists(sql, "registration_session_grant_batches"),
        true,
      );
      assert.equal(
        await tableExists(sql, "registration_session_grant_items"),
        true,
      );
      assert.equal(
        await tableExists(sql, "registration_session_grant_email_attempts"),
        true,
      );

      await sql`
        INSERT INTO registration_sessions (
          registration_id, session_id, ticket_type_id, source
        ) VALUES (
          ${fixture.registrationId}, ${fixture.sessionId}, NULL, 'admin_grant'
        )
      `;

      await assert.rejects(
        () =>
          sql`
            INSERT INTO registration_sessions (
              registration_id, session_id, ticket_type_id, source
            ) VALUES (
              ${fixture.registrationId}, ${fixture.sessionId}, ${fixture.ticketId}, 'purchase'
            )
          `,
        /duplicate key value violates unique constraint/i,
      );

      await assert.rejects(
        () =>
          sql`
            INSERT INTO registration_sessions (
              registration_id, session_id, ticket_type_id, source
            ) VALUES (
              2147483000, ${fixture.sessionId}, NULL, 'admin_grant'
            )
          `,
        /violates foreign key constraint/i,
      );
    });

    await t.test("MIG-02 duplicate preflight aborts transaction without partial DDL", async () => {
      await resetSessionGrantIntegrationSchema(sql);
      await applyPriorMigrations(sql);
      const fixture = await seedEntitlementFixture(sql);

      await sql`
        INSERT INTO registration_sessions (
          registration_id, session_id, ticket_type_id, source
        ) VALUES
          (${fixture.registrationId}, ${fixture.sessionId}, ${fixture.ticketId}, 'purchase'),
          (${fixture.registrationId}, ${fixture.sessionId}, ${fixture.ticketId}, 'manual')
      `;

      await assert.rejects(
        () => applyGrantMigration(sql),
        /duplicate entitlement pairs require reviewed remediation/i,
      );

      const [{ duplicate_count: duplicateCount }] = await sql<
        Array<{ duplicate_count: number }>
      >`
        SELECT count(*)::int AS duplicate_count
        FROM registration_sessions
        WHERE registration_id = ${fixture.registrationId}
          AND session_id = ${fixture.sessionId}
      `;

      assert.equal(duplicateCount, 2);
      assert.equal(
        await columnIsNullable(sql, "registration_sessions", "ticket_type_id"),
        false,
      );
      assert.equal(
        await tableExists(sql, "registration_session_grant_batches"),
        false,
      );
      assert.equal(
        await indexExists(sql, "registration_sessions_registration_session_unique"),
        false,
      );
    });

    await t.test("MIG-05 lock timeout rolls back cleanly and succeeds after lock release", async () => {
      await resetSessionGrantIntegrationSchema(sql);
      await applyPriorMigrations(sql);
      await seedEntitlementFixture(sql);

      const lockSql = openSessionGrantTestDatabase();
      t.after(async () => {
        await lockSql.end({ timeout: 2 });
      });

      let releaseLock!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      let lockAcquired!: () => void;
      const acquiredPromise = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });

      const lockTask = lockSql.begin(async (tx) => {
        await tx.unsafe("LOCK TABLE registration_sessions IN ACCESS EXCLUSIVE MODE");
        lockAcquired();
        await releasePromise;
      });

      await acquiredPromise;
      const startedAt = Date.now();
      await assert.rejects(
        () => applyGrantMigration(sql),
        /lock timeout|canceling statement due to lock timeout/i,
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs >= 4_000 && elapsedMs < 15_000, `unexpected lock timeout duration: ${elapsedMs}ms`);

      assert.equal(
        await columnIsNullable(sql, "registration_sessions", "ticket_type_id"),
        false,
      );
      assert.equal(
        await tableExists(sql, "registration_session_grant_batches"),
        false,
      );

      releaseLock();
      await lockTask;
      await applyGrantMigration(sql);

      assert.equal(
        await columnIsNullable(sql, "registration_sessions", "ticket_type_id"),
        true,
      );
      assert.equal(
        await tableExists(sql, "registration_session_grant_batches"),
        true,
      );

      const journal = await readFile(
        resolve(process.cwd(), "drizzle", "meta", "_journal.json"),
        "utf8",
      );
      assert.equal(journal.includes("0031_admin_session_grants"), false);
    });
  },
);
