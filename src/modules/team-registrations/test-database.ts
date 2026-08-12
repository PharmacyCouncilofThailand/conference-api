import { randomUUID } from "node:crypto";
import postgres from "postgres";

const TEST_EVENT_CODE_PREFIX = "__tr_test__";

export type TeamRegistrationTestSql = postgres.Sql;

export class TeamRegistrationTestDatabaseError extends Error {
  constructor(
    public readonly code:
      | "TEST_DATABASE_URL_REQUIRED"
      | "TEST_DATABASE_URL_INVALID"
      | "TEST_DATABASE_SHARED"
      | "TEST_DATABASE_MARKER_REQUIRED"
      | "TEST_DATABASE_SCHEMA_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "TeamRegistrationTestDatabaseError";
  }
}

function parsePostgresUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_URL_INVALID",
      "TEST_DATABASE_URL must be a valid PostgreSQL URL",
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_URL_INVALID",
      "TEST_DATABASE_URL must use the postgres or postgresql scheme",
    );
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_URL_INVALID",
      "TEST_DATABASE_URL must name a database",
    );
  }

  return parsed;
}

function schemaIdentity(url: URL): string {
  // Only trust PostgreSQL's libpq-style options. Arbitrary query parameters such
  // as `schema=...` may be ignored by the driver and must not weaken this guard.
  const options = url.searchParams.get("options")?.toLowerCase() ?? "";
  const match = options.match(/search_path(?:=|%3d)([^\s&]+)/i);
  return match?.[1] ?? "public";
}

function databaseTargetIdentity(value: string): string {
  const url = parsePostgresUrl(value);
  const protocol = "postgresql:";
  const hostname = url.hostname.toLowerCase();
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase();
  return [protocol, hostname, port, database, schemaIdentity(url)].join("|");
}

function hasTestMarker(url: URL): boolean {
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const schema = schemaIdentity(url);
  return database.toLowerCase().includes("test") || schema.includes("test");
}

function isExplicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function validateTeamRegistrationTestDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_URL_REQUIRED",
      "TEST_DATABASE_URL is required for Team Registration integration tests",
    );
  }

  const testUrl = parsePostgresUrl(value);
  if (!hasTestMarker(testUrl)) {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_MARKER_REQUIRED",
      "The test database name or schema must contain the word test",
    );
  }

  const regularUrl = environment.DATABASE_URL?.trim();
  if (
    regularUrl &&
    databaseTargetIdentity(value) === databaseTargetIdentity(regularUrl) &&
    !isExplicitTrue(environment.TEAM_REGISTRATION_ALLOW_SHARED_TEST_DATABASE)
  ) {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_SHARED",
      "TEST_DATABASE_URL targets DATABASE_URL; set TEAM_REGISTRATION_ALLOW_SHARED_TEST_DATABASE=true only for a deliberate isolated test target",
    );
  }

  return value;
}

async function verifyTeamRegistrationTestSchema(sql: TeamRegistrationTestSql): Promise<void> {
  const [result] = await sql<
    Array<{
      database_name: string;
      schema_name: string | null;
      registrations_table: boolean;
      attempts_table: boolean;
      heartbeat_table: boolean;
      registration_revision: boolean;
      winner_column: boolean;
      expected_status_count: number;
    }>
  >`
    SELECT
      current_database() AS database_name,
      current_schema() AS schema_name,
      to_regclass(current_schema() || '.team_registrations') IS NOT NULL AS registrations_table,
      to_regclass(current_schema() || '.team_registration_payment_attempts') IS NOT NULL AS attempts_table,
      to_regclass(current_schema() || '.team_registration_job_state') IS NOT NULL AS heartbeat_table,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'team_registrations'
          AND column_name = 'revision'
      ) AS registration_revision,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'team_registration_payment_attempts'
          AND column_name = 'is_winner'
      ) AS winner_column,
      (
        SELECT count(*)::integer
        FROM pg_type
        JOIN pg_enum ON pg_enum.enumtypid = pg_type.oid
        JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
        WHERE pg_namespace.nspname = current_schema()
          AND pg_type.typname = 'team_registration_payment_status'
          AND pg_enum.enumlabel IN (
            'creating',
            'pending',
            'paid',
            'failed',
            'expired',
            'verification_required',
            'cancelled',
            'duplicate_paid',
            'refunded'
          )
      ) AS expected_status_count
  `;

  if (
    !result ||
    (!result.database_name.toLowerCase().includes("test") &&
      !result.schema_name?.toLowerCase().includes("test"))
  ) {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_MARKER_REQUIRED",
      "The connected database or effective schema must contain the word test",
    );
  }

  if (
    !result?.registrations_table ||
    !result.attempts_table ||
    !result.heartbeat_table ||
    !result.registration_revision ||
    !result.winner_column ||
    result.expected_status_count !== 9
  ) {
    throw new TeamRegistrationTestDatabaseError(
      "TEST_DATABASE_SCHEMA_REQUIRED",
      "TEST_DATABASE_URL must point to an isolated database with all repository migrations applied",
    );
  }
}

export async function resetTeamRegistrationFixtures(sql: TeamRegistrationTestSql): Promise<void> {
  await sql.begin(async (transaction) => {
    const transactionSql = transaction as unknown as TeamRegistrationTestSql;
    await transactionSql.unsafe(`
      TRUNCATE TABLE
        team_registration_audit_logs,
        team_registration_email_outbox,
        team_registration_payment_events,
        team_registration_payment_attempts,
        team_registration_email_claims,
        team_registration_members,
        team_registrations,
        team_registration_access_sessions,
        team_registration_otp_challenges,
        team_registration_prices,
        team_registration_pricing_rounds,
        team_registration_categories,
        team_registration_configs,
        team_registration_job_state
      RESTART IDENTITY CASCADE
    `);
    await transactionSql`
      DELETE FROM events
      WHERE strpos(event_code, ${TEST_EVENT_CODE_PREFIX}) = 1
    `;
  });
}

export interface SeededTeamRegistrationEvent {
  eventId: number;
  configId: number;
  categoryId: number;
  pricingRoundId: number;
  eventCode: string;
  paymentProfileCode: string;
}

export async function seedTeamRegistrationEvent(
  sql: TeamRegistrationTestSql,
): Promise<SeededTeamRegistrationEvent> {
  const suffix = randomUUID();
  const eventCode = `${TEST_EVENT_CODE_PREFIX}${suffix}`;
  const paymentProfileCode = `test_profile_${suffix}`;

  return sql.begin(async (transaction) => {
    const transactionSql = transaction as unknown as TeamRegistrationTestSql;
    const [event] = await transactionSql<Array<{ id: number }>>`
      INSERT INTO events (
        event_code,
        event_name,
        event_type,
        start_date,
        end_date,
        status
      )
      VALUES (
        ${eventCode},
        'Team Registration integration test',
        'single_room',
        now() - interval '1 day',
        now() + interval '2 days',
        'published'
      )
      RETURNING id
    `;

    const [config] = await transactionSql<Array<{ id: number }>>`
      INSERT INTO team_registration_configs (
        event_id,
        is_enabled,
        registration_opens_at,
        registration_closes_at,
        payment_profile_code,
        event_website_origin,
        payment_result_url
      )
      VALUES (
        ${event.id},
        true,
        now() - interval '1 day',
        now() + interval '1 day',
        ${paymentProfileCode},
        'https://team-test.example.com',
        'https://team-test.example.com/payment/result'
      )
      RETURNING id
    `;

    const [category] = await transactionSql<Array<{ id: number }>>`
      INSERT INTO team_registration_categories (
        config_id,
        code,
        display_name,
        education_level,
        pharmacy_rule
      )
      VALUES (
        ${config.id},
        'test_category',
        'Test category',
        'higher_education',
        'forbidden'
      )
      RETURNING id
    `;

    const [pricingRound] = await transactionSql<Array<{ id: number }>>`
      INSERT INTO team_registration_pricing_rounds (
        config_id,
        code,
        display_name,
        starts_at,
        ends_at
      )
      VALUES (
        ${config.id},
        'test_round',
        'Test round',
        now() - interval '1 day',
        now() + interval '1 day'
      )
      RETURNING id
    `;

    await transactionSql`
      INSERT INTO team_registration_prices (
        pricing_round_id,
        category_id,
        amount,
        currency
      )
      VALUES (${pricingRound.id}, ${category.id}, '700.00', 'THB')
    `;

    return {
      eventId: Number(event.id),
      configId: Number(config.id),
      categoryId: Number(category.id),
      pricingRoundId: Number(pricingRound.id),
      eventCode,
      paymentProfileCode,
    };
  });
}

export interface TeamRegistrationTestDatabase {
  sql: TeamRegistrationTestSql;
  reset(): Promise<void>;
  seedEvent(): Promise<SeededTeamRegistrationEvent>;
  close(): Promise<void>;
}

export async function openTeamRegistrationTestDatabase(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TeamRegistrationTestDatabase> {
  const connectionString = validateTeamRegistrationTestDatabaseUrl(environment);
  const sql = postgres(connectionString, {
    max: 5,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    await verifyTeamRegistrationTestSchema(sql);
  } catch (error) {
    await sql.end({ timeout: 1 });
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    sql,
    reset: () => resetTeamRegistrationFixtures(sql),
    seedEvent: () => seedTeamRegistrationEvent(sql),
    close: async () => {
      closePromise ??= sql.end({ timeout: 5 });
      await closePromise;
    },
  };
}
