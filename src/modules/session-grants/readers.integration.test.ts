import assert from "node:assert/strict";
import test from "node:test";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";

test(
  "nullable session entitlement readers preserve legacy and admin-granted sessions",
  { timeout: 60_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();

    const [{ migrated }] = await sql<Array<{ migrated: boolean }>>`
      SELECT
        to_regclass(current_schema() || '.registration_session_grant_batches') IS NOT NULL
        AND to_regclass(current_schema() || '.registration_sessions_registration_session_unique') IS NOT NULL
        AS migrated
    `;
    assert.equal(
      migrated,
      true,
      "0031 must be applied by the focused migration rehearsal before reader verification",
    );

    const unique = Date.now().toString(36);
    const eventCode = `SG-READ-${unique}`;
    const regCode = `SG-READ-REG-${unique}`;
    const actorEmail = `session-grant-reader-${unique}@example.invalid`;

    const [actor] = await sql<Array<{ id: number }>>`
      INSERT INTO backoffice_users (
        email, password_hash, role, first_name, last_name
      ) VALUES (
        ${actorEmail}, 'not-a-real-password-hash', 'admin',
        'Grant', 'Actor'
      )
      RETURNING id
    `;

    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        event_code, event_name, event_type, start_date, end_date, status
      ) VALUES (
        ${eventCode}, 'Reader Compatibility Event', 'multi_session',
        '2026-10-10 00:00:00', '2026-10-12 23:59:59', 'published'
      )
      RETURNING id
    `;

    const sessions = await sql<Array<{ id: number; code: string }>>`
      INSERT INTO sessions (
        event_id, session_code, session_name, start_time, end_time, is_active
      ) VALUES
        (
          ${event.id}, ${`LEGACY-${unique}`}, 'Legacy Paid Session',
          '2026-10-10 09:00:00', '2026-10-10 10:00:00', true
        ),
        (
          ${event.id}, ${`GRANT-${unique}`}, 'Admin Granted Session',
          '2026-10-10 10:00:00', '2026-10-10 11:00:00', true
        )
      RETURNING id, session_code AS code
    `;
    const legacySessionId = sessions[0]!.id;
    const grantedSessionId = sessions[1]!.id;

    const tickets = await sql<Array<{ id: number; category: string }>>`
      INSERT INTO ticket_types (
        event_id, category, priority, name, price, currency, quota
      ) VALUES
        (
          ${event.id}, 'primary', 'regular', 'Primary Reader Ticket',
          1000, 'THB', 100
        ),
        (
          ${event.id}, 'addon', 'regular', 'Legacy Session Add-on',
          100, 'THB', 100
        )
      RETURNING id, category
    `;
    const primaryTicketId = tickets.find((row) => row.category === "primary")!.id;
    const addonTicketId = tickets.find((row) => row.category === "addon")!.id;

    const [registration] = await sql<Array<{ id: number }>>`
      INSERT INTO registrations (
        reg_code, event_id, ticket_type_id, email,
        first_name, last_name, status
      ) VALUES (
        ${regCode}, ${event.id}, ${primaryTicketId},
        ${`reader-${unique}@example.invalid`},
        'Reader', 'Fixture', 'confirmed'
      )
      RETURNING id
    `;

    const insertedLinks = await sql<Array<{ id: number; session_id: number }>>`
      INSERT INTO registration_sessions (
        registration_id, session_id, ticket_type_id, source, added_by
      ) VALUES
        (
          ${registration.id}, ${legacySessionId}, ${addonTicketId},
          'purchase', NULL
        ),
        (
          ${registration.id}, ${grantedSessionId}, NULL,
          'admin_grant', ${actor.id}
        )
      RETURNING id, session_id
    `;
    assert.equal(insertedLinks.length, 2);

    t.after(async () => {
      await sql`DELETE FROM registration_session_grant_email_attempts
        WHERE item_id IN (
          SELECT i.id
          FROM registration_session_grant_items i
          JOIN registration_session_grant_batches b ON b.id = i.batch_id
          WHERE b.event_id = ${event.id}
        )`;
      await sql`DELETE FROM registration_session_grant_items
        WHERE batch_id IN (
          SELECT id FROM registration_session_grant_batches WHERE event_id = ${event.id}
        )`;
      await sql`DELETE FROM registration_session_grant_batches WHERE event_id = ${event.id}`;
      await sql`DELETE FROM registration_sessions WHERE registration_id = ${registration.id}`;
      await sql`DELETE FROM registrations WHERE id = ${registration.id}`;
      await sql`DELETE FROM ticket_types WHERE event_id = ${event.id}`;
      await sql`DELETE FROM sessions WHERE event_id = ${event.id}`;
      await sql`DELETE FROM events WHERE id = ${event.id}`;
      await sql`DELETE FROM backoffice_users WHERE id = ${actor.id}`;
      await sql.end({ timeout: 2 });
    });

    const details = await sql<Array<{
      session_id: number;
      ticket_type_id: number | null;
      ticket_name: string | null;
      ticket_category: string | null;
      source: string;
      added_by_id: number | null;
      added_by_first_name: string | null;
      added_by_last_name: string | null;
    }>>`
      SELECT
        rs.session_id,
        rs.ticket_type_id,
        tt.name AS ticket_name,
        tt.category AS ticket_category,
        rs.source,
        rs.added_by AS added_by_id,
        grant_actor.first_name AS added_by_first_name,
        grant_actor.last_name AS added_by_last_name
      FROM registration_sessions rs
      JOIN sessions s ON s.id = rs.session_id
      LEFT JOIN ticket_types tt ON tt.id = rs.ticket_type_id
      LEFT JOIN backoffice_users grant_actor ON grant_actor.id = rs.added_by
      WHERE rs.registration_id = ${registration.id}
      ORDER BY s.start_time
    `;

    assert.equal(details.length, 2);
    const legacy = details.find((row) => row.session_id === legacySessionId);
    const granted = details.find((row) => row.session_id === grantedSessionId);
    assert.ok(legacy);
    assert.ok(granted);
    assert.equal(legacy.ticket_type_id, addonTicketId);
    assert.equal(legacy.ticket_category, "addon");
    assert.equal(legacy.source, "purchase");
    assert.equal(granted.ticket_type_id, null);
    assert.equal(granted.ticket_name, null);
    assert.equal(granted.ticket_category, null);
    assert.equal(granted.source, "admin_grant");
    assert.equal(granted.added_by_id, actor.id);
    assert.equal(granted.added_by_first_name, "Grant");
    assert.equal(granted.added_by_last_name, "Actor");

    const [primary] = await sql<Array<{
      ticket_type_id: number;
      ticket_name: string;
    }>>`
      SELECT r.ticket_type_id, tt.name AS ticket_name
      FROM registrations r
      JOIN ticket_types tt ON tt.id = r.ticket_type_id
      WHERE r.id = ${registration.id}
    `;
    assert.equal(primary.ticket_type_id, primaryTicketId);
    assert.equal(primary.ticket_name, "Primary Reader Ticket");

    const enrollment = await sql<Array<{
      id: number;
      ticket_type_id: number | null;
      ticket_name: string | null;
      source: string;
    }>>`
      SELECT
        r.id,
        rs.ticket_type_id,
        tt.name AS ticket_name,
        rs.source
      FROM registration_sessions rs
      JOIN registrations r ON r.id = rs.registration_id
      LEFT JOIN ticket_types tt ON tt.id = rs.ticket_type_id
      WHERE rs.session_id = ${grantedSessionId}
        AND r.status = 'confirmed'
    `;
    assert.equal(enrollment.length, 1);
    assert.equal(enrollment[0]!.id, registration.id);
    assert.equal(enrollment[0]!.ticket_type_id, null);
    assert.equal(enrollment[0]!.ticket_name, null);
    assert.equal(enrollment[0]!.source, "admin_grant");

    const checkinEntitlements = await sql<Array<{
      id: number;
      session_id: number;
      ticket_name: string | null;
      source: string;
    }>>`
      SELECT
        rs.id,
        rs.session_id,
        tt.name AS ticket_name,
        rs.source
      FROM registration_sessions rs
      JOIN registrations r ON r.id = rs.registration_id
      LEFT JOIN ticket_types tt ON tt.id = rs.ticket_type_id
      WHERE r.id = ${registration.id}
        AND r.status = 'confirmed'
      ORDER BY rs.session_id
    `;
    assert.equal(checkinEntitlements.length, 2);
    const grantCheckin = checkinEntitlements.find(
      (row) => row.session_id === grantedSessionId,
    );
    assert.ok(grantCheckin);
    assert.equal(grantCheckin.ticket_name, null);
    assert.equal(grantCheckin.source, "admin_grant");
  },
);
