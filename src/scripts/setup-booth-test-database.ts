import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { validatePaymentsTestDatabaseUrl } from "../modules/payments/test-database.js";
const target = validatePaymentsTestDatabaseUrl();
const client = postgres(target, { max: 1 });
try {
  const [scope] = await client`SELECT current_schema() AS name`;
  if (scope.name !== "public")
    throw new Error("Schema export initializes public only; use a dedicated test database");
  const [existing] =
    await client`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
  if (existing.n !== 0)
    throw new Error(
      "Test database must be empty; this command never resets data",
    );
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const command = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../node_modules/drizzle-kit/bin.cjs", import.meta.url),
      ),
      "export",
      "--config=drizzle.config.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (command.status !== 0)
    throw new Error(command.stderr || "Schema export failed");
  const statements = command.stdout
    // `drizzle-kit export` emits plain DDL, unlike migration files.
    .split(/;[ \t]*\r?\n(?:--> statement-breakpoint[ \t]*\r?\n)?/)
    .map((x) => x.trim())
    .filter(Boolean);
  const first = statements.filter(
    (x) => !x.startsWith("ALTER TABLE") && !/^CREATE (?:UNIQUE )?INDEX/.test(x),
  );
  const indexes = statements.filter((x) => /^CREATE (?:UNIQUE )?INDEX/.test(x));
  const foreignKeys = statements.filter((x) => x.startsWith("ALTER TABLE"));
  // Drizzle push orders some composite FKs before their required unique indexes.
  await client.begin(async (tx) => {
    for (const statement of [...first, ...indexes, ...foreignKeys])
      await tx.unsafe(statement);
  });
  process.stdout.write("Local test schema initialized\n");
} finally {
  await client.end({ timeout: 5 });
}
