import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { createGrant } from "./service.js";
import { openSessionGrantTestDatabase, validateSessionGrantTestDatabaseUrl } from "./test-database.js";
import type { GrantDatabase } from "./types.js";

function asDatabase(client: ReturnType<typeof openSessionGrantTestDatabase>): GrantDatabase {
  return drizzle(client, { schema }) as GrantDatabase;
}

test("500-registration grant load is not truncated and records measured duration", { timeout: 120_000 }, async (t) => {
  validateSessionGrantTestDatabaseUrl();
  const sql = openSessionGrantTestDatabase();
  const database = asDatabase(sql);
  const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  const [actor] = await sql<Array<{ id: number }>>`
    INSERT INTO backoffice_users (email, password_hash, role, first_name, last_name)
    VALUES (${`load500-${unique}@example.invalid`}, 'x', 'admin', 'Load', 'Admin')
    RETURNING id
  `;
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code, event_name, event_type, start_date, end_date, status)
    VALUES (${`SG-500-${unique}`}, 'Session Grant 500 Load', 'multi_session', '2026-10-01', '2099-10-02', 'published')
    RETURNING id
  `;
  const [session] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, session_code, session_name, session_type, start_time, end_time, is_active)
    VALUES (${event.id}, ${`SG-500-S-${unique}`}, 'Load Session', 'lecture', '2026-10-01 09:00:00', '2099-10-01 12:00:00', true)
    RETURNING id
  `;
  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota)
    VALUES (${event.id}, 'primary', 'regular', 'Load Primary', 1000, 'THB', 1000)
    RETURNING id
  `;

  const registrations = await sql<Array<{ id: number }>>`
    INSERT INTO registrations (reg_code, event_id, ticket_type_id, email, first_name, last_name, status)
    SELECT
      ${`SG-500-${unique}-`} || g::text,
      ${event.id},
      ${ticket.id},
      ${`load500-${unique}-`} || g::text || '@example.invalid',
      'Load',
      g::text,
      'confirmed'
    FROM generate_series(1, 500) AS g
    RETURNING id
  `;

  t.after(async () => {
    await sql`DELETE FROM registration_session_grant_email_attempts
      WHERE item_id IN (
        SELECT i.id FROM registration_session_grant_items i
        JOIN registration_session_grant_batches b ON b.id = i.batch_id
        WHERE b.event_id = ${event.id}
      )`;
    await sql`DELETE FROM registration_session_grant_items
      WHERE batch_id IN (SELECT id FROM registration_session_grant_batches WHERE event_id = ${event.id})`;
    await sql`DELETE FROM registration_session_grant_batches WHERE event_id = ${event.id}`;
    await sql`DELETE FROM registration_sessions WHERE registration_id IN (SELECT id FROM registrations WHERE event_id = ${event.id})`;
    await sql`DELETE FROM registrations WHERE event_id = ${event.id}`;
    await sql`DELETE FROM ticket_types WHERE id = ${ticket.id}`;
    await sql`DELETE FROM sessions WHERE id = ${session.id}`;
    await sql`DELETE FROM events WHERE id = ${event.id}`;
    await sql`DELETE FROM backoffice_users WHERE id = ${actor.id}`;
    await sql.end({ timeout: 2 });
  });

  assert.equal(registrations.length, 500);
  const startedAt = performance.now();
  const result = await createGrant(database, {
    actorId: actor.id,
    idempotencyKey: randomUUID(),
    sessionId: session.id,
    registrationIds: registrations.map((row) => row.id),
  });
  const durationMs = performance.now() - startedAt;

  assert.equal(result.replayed, false);
  assert.equal(result.batch.requestedCount, 500);
  assert.equal(result.batch.addedCount, 500);
  assert.equal(result.batch.skippedCount, 0);
  assert.equal(result.batch.pagination.total, 500);
  assert.equal(result.batch.results.length, 500);
  assert.equal(result.batch.emailCounts.pending, 500);

  const [{ entitlement_count: entitlementCount }] = await sql<Array<{ entitlement_count: number }>>`
    SELECT count(*)::int AS entitlement_count
    FROM registration_sessions rs
    JOIN registrations r ON r.id = rs.registration_id
    WHERE r.event_id = ${event.id} AND rs.session_id = ${session.id}
  `;
  assert.equal(entitlementCount, 500);

  console.log(JSON.stringify({ scenario: "session-grant-500-load", durationMs: Math.round(durationMs), requested: 500, added: 500 }));
});
