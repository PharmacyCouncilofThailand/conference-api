import bcrypt from "bcryptjs";
import postgres from "postgres";

const PREFIX = "sg-review-20260930";
const EVENT_A = "SGREV-A-20260930";
const EVENT_B = "SGREV-B-20260930";
const PASSWORD = "ReviewOnly!2026";
const RETRY_BATCH_ID = "22222222-2222-4222-8222-222222222222";
const FAILED_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_ITEM_ID = "44444444-4444-4444-8444-444444444444";

function requireTestDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  if (!database.includes("test")) {
    throw new Error(`Refusing review fixture outside a test database: ${database}`);
  }
  return value;
}

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM registration_session_grant_email_attempts
      WHERE item_id IN (
        SELECT i.id FROM registration_session_grant_items i
        JOIN registration_session_grant_batches b ON b.id = i.batch_id
        JOIN events e ON e.id = b.event_id
        WHERE e.event_code IN (${EVENT_A}, ${EVENT_B})
      )`;
    await tx`DELETE FROM registration_session_grant_items
      WHERE batch_id IN (
        SELECT b.id FROM registration_session_grant_batches b
        JOIN events e ON e.id = b.event_id
        WHERE e.event_code IN (${EVENT_A}, ${EVENT_B})
      )`;
    await tx`DELETE FROM registration_session_grant_batches
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_A}, ${EVENT_B}))`;
    await tx`DELETE FROM registration_sessions
      WHERE registration_id IN (SELECT id FROM registrations WHERE email LIKE ${`${PREFIX}-%@example.test`})`;
    await tx`DELETE FROM registrations WHERE email LIKE ${`${PREFIX}-%@example.test`}`;
    await tx`DELETE FROM ticket_sessions
      WHERE ticket_type_id IN (
        SELECT tt.id FROM ticket_types tt JOIN events e ON e.id = tt.event_id
        WHERE e.event_code IN (${EVENT_A}, ${EVENT_B})
      )`;
    await tx`DELETE FROM ticket_types
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_A}, ${EVENT_B}))`;
    await tx`DELETE FROM staff_event_assignments
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_A}, ${EVENT_B}))
         OR staff_id IN (SELECT id FROM backoffice_users WHERE email LIKE ${`${PREFIX}-%@example.test`})`;
    await tx`DELETE FROM sessions
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_A}, ${EVENT_B}))`;
    await tx`DELETE FROM events WHERE event_code IN (${EVENT_A}, ${EVENT_B})`;
    await tx`DELETE FROM users WHERE email LIKE ${`${PREFIX}-%@example.test`}`;
    await tx`DELETE FROM backoffice_users WHERE email LIKE ${`${PREFIX}-%@example.test`}`;
  });
}

async function setup(sql: postgres.Sql): Promise<void> {
  const required = await sql<Array<{ events: string | null; grants: string | null }>>`
    SELECT to_regclass('public.events')::text AS events,
           to_regclass('public.registration_session_grant_batches')::text AS grants`;
  if (!required[0]?.events || !required[0]?.grants) {
    throw new Error("Runtime review database is not provisioned with the current schema");
  }

  await cleanup(sql);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const now = Date.now();

  const result = await sql.begin(async (tx) => {
    const [admin] = await tx<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email, password_hash, role, first_name, last_name, is_active)
      VALUES (${`${PREFIX}-admin@example.test`}, ${passwordHash}, 'admin', 'Review', 'Admin', true)
      RETURNING id`;
    const [organizer] = await tx<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email, password_hash, role, first_name, last_name, is_active)
      VALUES (${`${PREFIX}-organizer@example.test`}, ${passwordHash}, 'organizer', 'Review', 'Organizer', true)
      RETURNING id`;

    const [eventA] = await tx<Array<{ id: number }>>`
      INSERT INTO events (event_code, event_name, event_type, start_date, end_date, max_capacity, status)
      VALUES (${EVENT_A}, 'Session Grant Review Event A', 'multi_session', ${new Date(now - 86_400_000)}, ${new Date(now + 86_400_000)}, 1000, 'published')
      RETURNING id`;
    const [eventB] = await tx<Array<{ id: number }>>`
      INSERT INTO events (event_code, event_name, event_type, start_date, end_date, max_capacity, status)
      VALUES (${EVENT_B}, 'Session Grant Review Event B', 'multi_session', ${new Date(now - 86_400_000)}, ${new Date(now + 86_400_000)}, 1000, 'published')
      RETURNING id`;

    const [sessionA] = await tx<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, session_code, session_name, session_type, room, start_time, end_time, max_capacity, is_active)
      VALUES (${eventA.id}, 'SG-ACTIVE-1', 'Review Active Session 1', 'workshop', 'Review Room 1', ${new Date(now - 3_600_000)}, ${new Date(now + 7_200_000)}, 1000, true)
      RETURNING id`;
    const [sessionB] = await tx<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, session_code, session_name, session_type, room, start_time, end_time, max_capacity, is_active)
      VALUES (${eventA.id}, 'SG-ACTIVE-2', 'Review Active Session 2', 'workshop', 'Review Room 2', ${new Date(now - 3_600_000)}, ${new Date(now + 10_800_000)}, 1000, true)
      RETURNING id`;
    const [inactiveSession] = await tx<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, session_code, session_name, session_type, room, start_time, end_time, max_capacity, is_active)
      VALUES (${eventA.id}, 'SG-INACTIVE', 'Review Inactive Session', 'workshop', 'Review Room 3', ${new Date(now + 3_600_000)}, ${new Date(now + 7_200_000)}, 1000, false)
      RETURNING id`;
    const [endedSession] = await tx<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, session_code, session_name, session_type, room, start_time, end_time, max_capacity, is_active)
      VALUES (${eventA.id}, 'SG-ENDED', 'Review Ended Session', 'workshop', 'Review Room 4', ${new Date(now - 10_800_000)}, ${new Date(now - 7_200_000)}, 1000, true)
      RETURNING id`;

    const [ticketA] = await tx<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota, sold_count, is_active)
      VALUES (${eventA.id}, 'primary', 'regular', 'Review Primary Ticket A', 1000, 'THB', 1000, 0, true)
      RETURNING id`;
    const [ticketB] = await tx<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota, sold_count, is_active)
      VALUES (${eventB.id}, 'primary', 'regular', 'Review Primary Ticket B', 1000, 'THB', 1000, 0, true)
      RETURNING id`;

    await tx`INSERT INTO staff_event_assignments (staff_id, event_id) VALUES (${organizer.id}, ${eventA.id})`;

    const registrationIds: number[] = [];
    for (let index = 1; index <= 105; index += 1) {
      const status = index === 4 ? "cancelled" : "confirmed";
      const code = `SGREV-${String(index).padStart(3, "0")}`;
      const [registration] = await tx<Array<{ id: number }>>`
        INSERT INTO registrations (
          reg_code, event_id, ticket_type_id, email, first_name, last_name, status, source, created_at
        ) VALUES (
          ${code}, ${eventA.id}, ${ticketA.id}, ${`${PREFIX}-${index}@example.test`},
          ${`Review${index}`}, 'Registrant', ${status}, 'manual', ${new Date(now - index * 1000)}
        ) RETURNING id`;
      registrationIds.push(registration.id);
    }

    const [wrongEventRegistration] = await tx<Array<{ id: number }>>`
      INSERT INTO registrations (reg_code, event_id, ticket_type_id, email, first_name, last_name, status, source, created_at)
      VALUES ('SGREV-WRONG-EVENT', ${eventB.id}, ${ticketB.id}, ${`${PREFIX}-wrong-event@example.test`}, 'WrongEvent', 'Registrant', 'confirmed', 'manual', ${new Date(now)})
      RETURNING id`;

    await tx`INSERT INTO registration_sessions (registration_id, session_id, ticket_type_id, source, created_at)
      VALUES (${registrationIds[2]}, ${sessionA.id}, ${ticketA.id}, 'purchase', ${new Date(now - 60_000)})`;

    const [failedEntitlement] = await tx<Array<{ id: number }>>`
      INSERT INTO registration_sessions (registration_id, session_id, ticket_type_id, source, added_by, added_note, created_at)
      VALUES (${registrationIds[102]}, ${sessionB.id}, NULL, 'admin_grant', ${admin.id}, 'review fixture failed email', ${new Date(now - 120_000)})
      RETURNING id`;
    const [unknownEntitlement] = await tx<Array<{ id: number }>>`
      INSERT INTO registration_sessions (registration_id, session_id, ticket_type_id, source, added_by, added_note, created_at)
      VALUES (${registrationIds[103]}, ${sessionB.id}, NULL, 'admin_grant', ${admin.id}, 'review fixture unknown email', ${new Date(now - 90_000)})
      RETURNING id`;

    await tx`INSERT INTO registration_session_grant_batches (
      id, actor_id, actor_name_snapshot, idempotency_key, request_hash, session_id, event_id,
      session_name_snapshot, requested_count, added_count, skipped_count, created_at, completed_at
    ) VALUES (
      ${RETRY_BATCH_ID}, ${admin.id}, 'Review Admin', '55555555-5555-4555-8555-555555555555',
      ${"a".repeat(64)}, ${sessionB.id}, ${eventA.id}, 'Review Active Session 2', 2, 2, 0,
      ${new Date(now - 60_000)}, ${new Date(now - 59_000)}
    )`;
    await tx`INSERT INTO registration_session_grant_items (
      id, batch_id, requested_registration_id, registration_session_id, reg_code_snapshot, name_snapshot,
      outcome, reason_code, recipient_email_snapshot, notification_snapshot, email_status, attempt_count,
      last_attempt_at, last_error_code, created_at
    ) VALUES
      (${FAILED_ITEM_ID}, ${RETRY_BATCH_ID}, ${registrationIds[102]}, ${failedEntitlement.id}, 'SGREV-103', 'Review103 Registrant',
       'added', NULL, ${`${PREFIX}-103@example.test`}, '{}'::jsonb, 'failed', 1, ${new Date(now - 30_000)}, 'REVIEW_FAILED', ${new Date(now - 60_000)}),
      (${UNKNOWN_ITEM_ID}, ${RETRY_BATCH_ID}, ${registrationIds[103]}, ${unknownEntitlement.id}, 'SGREV-104', 'Review104 Registrant',
       'added', NULL, ${`${PREFIX}-104@example.test`}, '{}'::jsonb, 'unknown', 1, ${new Date(now - 25_000)}, 'REVIEW_UNKNOWN', ${new Date(now - 60_000)})`;

    return {
      adminId: admin.id,
      organizerId: organizer.id,
      eventAId: eventA.id,
      eventBId: eventB.id,
      sessionAId: sessionA.id,
      sessionBId: sessionB.id,
      inactiveSessionId: inactiveSession.id,
      endedSessionId: endedSession.id,
      ticketAId: ticketA.id,
      registrationIds,
      wrongEventRegistrationId: wrongEventRegistration.id,
      retryBatchId: RETRY_BATCH_ID,
      failedItemId: FAILED_ITEM_ID,
      unknownItemId: UNKNOWN_ITEM_ID,
    };
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    prefix: PREFIX,
    adminEmail: `${PREFIX}-admin@example.test`,
    organizerEmail: `${PREFIX}-organizer@example.test`,
    password: PASSWORD,
    ...result,
  })}\n`);
}

async function main() {
  const action = process.argv[2] ?? "setup";
  const sql = postgres(requireTestDatabaseUrl(), { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    if (action === "setup") await setup(sql);
    else if (action === "cleanup") {
      await cleanup(sql);
      process.stdout.write(`${JSON.stringify({ ok: true, cleaned: PREFIX })}\n`);
    } else throw new Error(`Unknown action: ${action}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
