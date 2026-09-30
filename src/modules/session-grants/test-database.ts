import postgres from "postgres";

export class SessionGrantTestDatabaseError extends Error {
  constructor(
    public readonly code:
      | "TEST_DATABASE_URL_REQUIRED"
      | "TEST_DATABASE_URL_INVALID"
      | "TEST_DATABASE_MARKER_REQUIRED"
      | "TEST_DATABASE_SHARED",
    message: string,
  ) {
    super(message);
    this.name = "SessionGrantTestDatabaseError";
  }
}

function parsePostgresUrl(value: string, variableName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SessionGrantTestDatabaseError(
      "TEST_DATABASE_URL_INVALID",
      `${variableName} must be a valid PostgreSQL URL`,
    );
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.pathname ||
    parsed.pathname === "/"
  ) {
    throw new SessionGrantTestDatabaseError(
      "TEST_DATABASE_URL_INVALID",
      `${variableName} must target PostgreSQL and name a database`,
    );
  }

  return parsed;
}

function schemaIdentity(url: URL): string {
  const options = url.searchParams.get("options")?.toLowerCase() ?? "";
  return options.match(/search_path(?:=|%3d)([^\s&]+)/i)?.[1] ?? "public";
}

function targetIdentity(value: string, variableName: string): string {
  const url = parsePostgresUrl(value, variableName);
  return [
    url.hostname.toLowerCase(),
    url.port || "5432",
    decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase(),
    schemaIdentity(url),
  ].join("|");
}

export function validateSessionGrantTestDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const testUrl = environment.TEST_DATABASE_URL?.trim();
  if (!testUrl) {
    throw new SessionGrantTestDatabaseError(
      "TEST_DATABASE_URL_REQUIRED",
      "TEST_DATABASE_URL is required for Admin Session Grants integration tests",
    );
  }

  const parsed = parsePostgresUrl(testUrl, "TEST_DATABASE_URL");
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  const schema = schemaIdentity(parsed);

  if (!database.includes("test") && !schema.includes("test")) {
    throw new SessionGrantTestDatabaseError(
      "TEST_DATABASE_MARKER_REQUIRED",
      "Admin Session Grants integration database name or schema must contain test",
    );
  }

  const runtimeUrl = environment.DATABASE_URL?.trim();
  if (
    runtimeUrl &&
    targetIdentity(testUrl, "TEST_DATABASE_URL") ===
      targetIdentity(runtimeUrl, "DATABASE_URL")
  ) {
    throw new SessionGrantTestDatabaseError(
      "TEST_DATABASE_SHARED",
      "TEST_DATABASE_URL must not target the same database/schema as DATABASE_URL",
    );
  }

  return testUrl;
}

export function openSessionGrantTestDatabase(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const connectionString = validateSessionGrantTestDatabaseUrl(environment);
  return postgres(connectionString, {
    // Migration rehearsal files may contain explicit BEGIN/COMMIT, so keep
    // each guarded harness client on one physical connection.
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });
}

export async function resetSessionGrantIntegrationSchema(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const [{ database, schema }] = await sql<
    Array<{ database: string; schema: string }>
  >`SELECT current_database() AS database, current_schema() AS schema`;

  if (!database.toLowerCase().includes("test") || schema !== "public") {
    throw new SessionGrantTestDatabaseError(
      "TEST_DATABASE_MARKER_REQUIRED",
      "Refusing schema reset outside a dedicated test database public schema",
    );
  }

  await sql.unsafe("DROP SCHEMA public CASCADE");
  await sql.unsafe("CREATE SCHEMA public");
}
