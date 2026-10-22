// Test harness only: never imports the application's DATABASE_URL client.
import { readFile } from "node:fs/promises";
import { openSessionGrantTestDatabase } from "./test-database.js";

const client = openSessionGrantTestDatabase();
try {
  await client.unsafe(await readFile(new URL("../../../review/session-invitations-test-harness-prerequisites.sql", import.meta.url), "utf8"));
  const [row] = await client`SELECT to_regclass('public.session_invitation_resend_requests') AS relation`;
  if (!row.relation) {
    await client.unsafe(await readFile(new URL("../../../drizzle/0050_session_invitation_resends.sql", import.meta.url), "utf8"));
  }
  console.log("Session resend isolated test schema prepared");
} finally {
  await client.end({ timeout: 2 });
}
