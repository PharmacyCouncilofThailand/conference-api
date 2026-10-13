import { readFile } from "node:fs/promises";
import postgres from "postgres";
const target = process.env.BOOTH_MIGRATION_DATABASE_URL;
if (!target)
  throw new Error("BOOTH_MIGRATION_DATABASE_URL must be explicitly configured");
const client = postgres(target, { max: 1 });
try {
  const [existing] =
    await client`SELECT to_regclass('booths') AS booths,to_regclass('booth_members') AS members`;
  if (existing.booths || existing.members)
    throw new Error(
      "Booth schema already exists or is partial; inspect migration state",
    );
  const [legacy] =
    await client`SELECT count(*)::int AS count FROM users WHERE role='booth'`;
  if (legacy.count !== 0)
    throw new Error(
      "Existing Booth accounts conflict with the no-backfill rollout",
    );
  await client.unsafe(
    await readFile(
      new URL("../../drizzle/0042_booth_directory.sql", import.meta.url),
      "utf8",
    ),
  );
  process.stdout.write("Booth directory migration applied\n");
} finally {
  await client.end({ timeout: 5 });
}
