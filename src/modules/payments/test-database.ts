import postgres from "postgres";

export class PaymentsTestDatabaseError extends Error {
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
    this.name = "PaymentsTestDatabaseError";
  }
}

function parsePostgresUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PaymentsTestDatabaseError("TEST_DATABASE_URL_INVALID", "TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.pathname || parsed.pathname === "/") {
    throw new PaymentsTestDatabaseError("TEST_DATABASE_URL_INVALID", "TEST_DATABASE_URL must target PostgreSQL and name a database");
  }
  return parsed;
}

function schemaIdentity(url: URL): string {
  const options = url.searchParams.get("options")?.toLowerCase() ?? "";
  return options.match(/search_path(?:=|%3d)([^\s&]+)/i)?.[1] ?? "public";
}

function targetIdentity(value: string): string {
  const url = parsePostgresUrl(value);
  return [
    url.hostname.toLowerCase(),
    url.port || "5432",
    decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase(),
    schemaIdentity(url),
  ].join("|");
}

export function validatePaymentsTestDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.TEST_DATABASE_URL?.trim();
  if (!value) throw new PaymentsTestDatabaseError("TEST_DATABASE_URL_REQUIRED", "TEST_DATABASE_URL is required for payment integration tests");

  const parsed = parsePostgresUrl(value);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  const schema = schemaIdentity(parsed);
  const allowUnmarkedTestDatabase = environment.PAYMENTS_ALLOW_UNMARKED_TEST_DATABASE?.trim().toLowerCase() === "true";
  if (!database.includes("test") && !schema.includes("test") && !allowUnmarkedTestDatabase) {
    throw new PaymentsTestDatabaseError("TEST_DATABASE_MARKER_REQUIRED", "Payment integration database name or schema must contain test");
  }

  const regularUrl = environment.DATABASE_URL?.trim();
  if (
    regularUrl
    && targetIdentity(value) === targetIdentity(regularUrl)
    && environment.PAYMENTS_ALLOW_SHARED_TEST_DATABASE?.trim().toLowerCase() !== "true"
  ) {
    throw new PaymentsTestDatabaseError("TEST_DATABASE_SHARED", "TEST_DATABASE_URL targets DATABASE_URL");
  }
  return value;
}

export async function openPaymentsTestDatabase() {
  const connectionString = validatePaymentsTestDatabaseUrl();
  const sql = postgres(connectionString, { max: 8, idle_timeout: 5, connect_timeout: 10 });
  const requiredTables = [
    "orders",
    "payments",
    "promo_codes",
    "promo_code_usages",
    "registrations",
    "registration_sessions",
  ];
  const rows = await sql<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ANY(${requiredTables})
  `;
  const found = new Set(rows.map((row) => row.table_name));
  if (requiredTables.some((table) => !found.has(table))) {
    await sql.end({ timeout: 1 });
    throw new PaymentsTestDatabaseError("TEST_DATABASE_SCHEMA_REQUIRED", "TEST_DATABASE_URL must have repository migrations applied");
  }
  return sql;
}
