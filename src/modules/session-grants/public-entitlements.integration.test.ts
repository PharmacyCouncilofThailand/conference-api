import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../database/schema.js";
import {
  findOwnedSessionIds,
  getRegistrationSessionEntitlements,
  hasWorkshopEntitlement,
} from "./public-entitlements.js";
import { validateSessionGrantTestDatabaseUrl } from "./test-database.js";

test("public entitlement helpers expose admin grants and guard exact session overlap without financial mutation", { timeout: 60_000 }, async (t) => {
  const databaseUrl = validateSessionGrantTestDatabaseUrl();
  const sql = postgres(databaseUrl, { max: 1 });
  const database = drizzle(sql, { schema });

  const unique = Date.now().toString(36);
  const [user] = await sql<Array<{ id: number }>>`
    INSERT INTO users (email, password_hash, role, first_name, last_name, status)
    VALUES (${`grant-public-${unique}@example.invalid`}, 'not-real', 'general', 'Grant', 'Participant', 'active')
    RETURNING id
  `;
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code, event_name, event_type, start_date, end_date, status)
    VALUES (${`SG-PUB-${unique}`}, 'Public Entitlement Event', 'multi_session', '2026-10-10', '2026-10-12', 'published')
    RETURNING id
  `;
  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota)
    VALUES (${event.id}, 'primary', 'regular', 'Primary Ticket', 1000, 'THB', 100)
    RETURNING id
  `;
  const sessions = await sql<Array<{ id: number; session_type: string }>>`
    INSERT INTO sessions (event_id, session_code, session_name, session_type, start_time, end_time, is_active)
    VALUES
      (${event.id}, ${`WORK-${unique}`}, 'Admin Workshop', 'workshop', '2026-10-10 09:00:00', '2026-10-10 10:00:00', true),
      (${event.id}, ${`LECT-${unique}`}, 'Unowned Lecture', 'lecture', '2026-10-10 11:00:00', '2026-10-10 12:00:00', true)
    RETURNING id, session_type
  `;
  const workshopId = sessions.find((row) => row.session_type === "workshop")!.id;
  const lectureId = sessions.find((row) => row.session_type === "lecture")!.id;
  const [registration] = await sql<Array<{ id: number }>>`
    INSERT INTO registrations (reg_code, event_id, ticket_type_id, user_id, email, first_name, last_name, status)
    VALUES (${`REG-${unique}`}, ${event.id}, ${ticket.id}, ${user.id}, ${`grant-public-${unique}@example.invalid`}, 'Grant', 'Participant', 'confirmed')
    RETURNING id
  `;
  await sql`
    INSERT INTO registration_sessions (registration_id, session_id, ticket_type_id, source)
    VALUES (${registration.id}, ${workshopId}, NULL, 'admin_grant')
  `;

  t.after(async () => {
    await sql`DELETE FROM registration_sessions WHERE registration_id = ${registration.id}`;
    await sql`DELETE FROM registrations WHERE id = ${registration.id}`;
    await sql`DELETE FROM sessions WHERE event_id = ${event.id}`;
    await sql`DELETE FROM ticket_types WHERE event_id = ${event.id}`;
    await sql`DELETE FROM events WHERE id = ${event.id}`;
    await sql`DELETE FROM users WHERE id = ${user.id}`;
    await sql.end({ timeout: 2 });
  });

  const [financialBefore] = await sql<Array<{ orders: number; payments: number }>>`
    SELECT (SELECT count(*)::int FROM orders) AS orders,
           (SELECT count(*)::int FROM payments) AS payments
  `;

  const entitlements = await getRegistrationSessionEntitlements(database, registration.id);
  assert.deepEqual(entitlements.map((row) => row.sessionId), [workshopId]);
  assert.equal(entitlements[0]?.source, "admin_grant");
  assert.equal(entitlements[0]?.sessionName, "Admin Workshop");

  assert.deepEqual(
    await findOwnedSessionIds(database, user.id, event.id, [workshopId, lectureId]),
    [workshopId],
  );
  assert.deepEqual(
    await findOwnedSessionIds(database, user.id, event.id, [lectureId]),
    [],
  );
  assert.equal(await hasWorkshopEntitlement(database, user.id, event.id), true);

  const [financialAfter] = await sql<Array<{ orders: number; payments: number }>>`
    SELECT (SELECT count(*)::int FROM orders) AS orders,
           (SELECT count(*)::int FROM payments) AS payments
  `;
  assert.deepEqual(financialAfter, financialBefore);
});
