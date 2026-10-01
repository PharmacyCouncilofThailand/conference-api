import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import {
  issueInvitationToken,
  readInvitationConfig,
} from "../src/modules/session-grants/invitation-token.js";

const PREFIX = "inv-review-20261001";
const EVENT_CODE = "PRIS-2026";
const EVENT_B_CODE = "INV-REVIEW-B";
const PASSWORD = "InvitationReview!2026";

function requireTestDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  if (database !== "confer_session_grants_runtime_test") {
    throw new Error(`Refusing invitation review fixture outside owned runtime test DB: ${database}`);
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
        WHERE e.event_code IN (${EVENT_CODE}, ${EVENT_B_CODE})
      )`;
    await tx`DELETE FROM session_invitations
      WHERE grant_item_id IN (
        SELECT i.id FROM registration_session_grant_items i
        JOIN registration_session_grant_batches b ON b.id = i.batch_id
        JOIN events e ON e.id = b.event_id
        WHERE e.event_code IN (${EVENT_CODE}, ${EVENT_B_CODE})
      )`;
    await tx`DELETE FROM registration_session_grant_items
      WHERE batch_id IN (
        SELECT b.id FROM registration_session_grant_batches b
        JOIN events e ON e.id = b.event_id
        WHERE e.event_code IN (${EVENT_CODE}, ${EVENT_B_CODE})
      )`;
    await tx`DELETE FROM registration_session_grant_batches
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_CODE}, ${EVENT_B_CODE}))`;
    await tx`DELETE FROM registration_sessions
      WHERE registration_id IN (SELECT id FROM registrations WHERE email LIKE ${`${PREFIX}-%@example.test`})`;
    await tx`DELETE FROM registrations WHERE email LIKE ${`${PREFIX}-%@example.test`}`;
    await tx`DELETE FROM ticket_sessions
      WHERE ticket_type_id IN (
        SELECT tt.id FROM ticket_types tt JOIN events e ON e.id = tt.event_id
        WHERE e.event_code IN (${EVENT_CODE}, ${EVENT_B_CODE})
      )`;
    await tx`DELETE FROM ticket_types
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_CODE}, ${EVENT_B_CODE}))`;
    await tx`DELETE FROM staff_event_assignments
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_CODE}, ${EVENT_B_CODE}))
         OR staff_id IN (SELECT id FROM backoffice_users WHERE email LIKE ${`${PREFIX}-%@example.test`})`;
    await tx`DELETE FROM sessions
      WHERE event_id IN (SELECT id FROM events WHERE event_code IN (${EVENT_CODE}, ${EVENT_B_CODE}))`;
    await tx`DELETE FROM events WHERE event_code IN (${EVENT_CODE}, ${EVENT_B_CODE})`;
    await tx`DELETE FROM users WHERE email LIKE ${`${PREFIX}-%@example.test`}`;
    await tx`DELETE FROM backoffice_users WHERE email LIKE ${`${PREFIX}-%@example.test`}`;
  });
}

async function setup(sql: postgres.Sql): Promise<void> {
  const [required] = await sql<Array<{
    invitations: string | null;
    grants: string | null;
    attendeeType: boolean;
    websiteUrl: boolean;
  }>>`
    SELECT
      to_regclass('public.session_invitations')::text AS invitations,
      to_regclass('public.registration_session_grant_batches')::text AS grants,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='registrations' AND column_name='attendee_type'
      ) AS "attendeeType",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='events' AND column_name='website_url'
      ) AS "websiteUrl"`;
  if (!required?.invitations || !required?.grants || !required.attendeeType || !required.websiteUrl) {
    throw new Error("Runtime review database is missing invitation schema/test-harness prerequisite");
  }

  await cleanup(sql);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const { key } = readInvitationConfig(process.env);
  const now = new Date();
  const future = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
  const past = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  const result = await sql.begin(async (tx) => {
    const [admin] = await tx<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
      VALUES (${`${PREFIX}-admin@example.test`},${passwordHash},'admin','Invitation','Admin',true)
      RETURNING id`;
    const [organizer] = await tx<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
      VALUES (${`${PREFIX}-organizer@example.test`},${passwordHash},'organizer','Invitation','Organizer',true)
      RETURNING id`;

    const [event] = await tx<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,max_capacity,status)
      VALUES (${EVENT_CODE},'Session Invitation Review Event','multi_session',${past(24)},${future(96)},1000,'published')
      RETURNING id`;
    const [eventB] = await tx<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,max_capacity,status)
      VALUES (${EVENT_B_CODE},'Invitation Review Event B','multi_session',${past(24)},${future(96)},1000,'published')
      RETURNING id`;

    const sessions = await tx<Array<{ id: number; session_code: string }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,room,start_time,end_time,max_capacity,is_active,admin_grant_requires_confirmation
      ) VALUES
        (${event.id},'POLICY-INNOVATION','Policy Innovation','workshop','Jupiter 4',${future(48)},${future(50)},50,true,false),
        (${event.id},'INVITE-UI','Invitation UI Capacity','workshop','Jupiter 5',${future(24)},${future(26)},50,true,true),
        (${event.id},'PRIS-RESPONSES','Invitation Response Review','workshop','Jupiter 6',${future(30)},${future(32)},50,true,true),
        (${event.id},'LEGACY-IMMEDIATE','Legacy Immediate Grant','workshop','Jupiter 7',${future(36)},${future(38)},50,true,false),
        (${event.id},'INV-INACTIVE','Inactive Invitation Session','workshop','Jupiter 8',${future(24)},${future(26)},50,false,true),
        (${event.id},'INV-CLOSED','Closed Invitation Session','workshop','Jupiter 9',${past(1)},${future(1)},50,true,true)
      RETURNING id,session_code`;
    const sessionByCode = new Map(sessions.map((row) => [row.session_code, row.id]));
    const targetSessionId = sessionByCode.get('POLICY-INNOVATION')!;
    const uiSessionId = sessionByCode.get('INVITE-UI')!;
    const responseSessionId = sessionByCode.get('PRIS-RESPONSES')!;
    const legacySessionId = sessionByCode.get('LEGACY-IMMEDIATE')!;

    const [ticket] = await tx<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota,sold_count,is_active)
      VALUES (${event.id},'primary','regular','Invitation Review Ticket',1000,'THB',1000,0,true)
      RETURNING id`;
    const [ticketB] = await tx<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota,sold_count,is_active)
      VALUES (${eventB.id},'primary','regular','Invitation Review Ticket B',1000,'THB',1000,0,true)
      RETURNING id`;

    await tx`INSERT INTO staff_event_assignments (staff_id,event_id) VALUES (${organizer.id},${event.id})`;

    const insertRegistration = async (
      code: string,
      emailSuffix: string,
      firstName: string,
      status = 'confirmed',
      userId: number | null = null,
    ) => {
      const [row] = await tx<Array<{ id: number }>>`
        INSERT INTO registrations (
          reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status,source,created_at
        ) VALUES (
          ${code},${event.id},${ticket.id},${userId},${`${PREFIX}-${emailSuffix}@example.test`},
          ${firstName},'Reviewer',${status},'manual',clock_timestamp()
        ) RETURNING id`;
      return row.id;
    };

    const fillerIds: number[] = [];
    for (let index = 1; index <= 47; index += 1) {
      fillerIds.push(await insertRegistration(`INV-FILL-${String(index).padStart(2, '0')}`, `fill-${index}`, `Fill${index}`));
    }

    const [knownUser] = await tx<Array<{ id: number }>>`
      INSERT INTO users (email,password_hash,role,first_name,last_name,status)
      VALUES (${`${PREFIX}-known@example.test`},${passwordHash},'general','Known','Participant','active')
      RETURNING id`;
    const duplicateOwnedId = await insertRegistration('INV-DUP-OWNED','dup-owned','KnownOwned','confirmed',knownUser.id);
    const duplicateSiblingId = await insertRegistration('INV-DUP-SIBLING','dup-sibling','KnownSibling','confirmed',knownUser.id);

    for (const registrationId of [...fillerIds, duplicateOwnedId]) {
      await tx`INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source,created_at)
        VALUES (${registrationId},${uiSessionId},${ticket.id},'purchase',clock_timestamp())`;
    }

    const candidate1Id = await insertRegistration('INV-CAND-1','cand-1','CapacityOne');
    const candidate2Id = await insertRegistration('INV-CAND-2','cand-2','CapacityTwo');
    const pendingUiId = await insertRegistration('INV-PENDING-UI','pending-ui','PendingUi');
    const cancelledId = await insertRegistration('INV-CANCELLED','cancelled','Cancelled','cancelled');
    const responseAcceptId = await insertRegistration('INV-RESP-ACCEPT','resp-accept','AcceptPerson');
    const responseDeclineId = await insertRegistration('INV-RESP-DECLINE','resp-decline','DeclinePerson');
    const responseUncertainId = await insertRegistration('INV-RESP-UNCERTAIN','resp-uncertain','UncertainPerson');
    const closedFailedId = await insertRegistration('INV-CLOSED-FAILED','closed-failed','ClosedFailed');

    const [wrongEventRegistration] = await tx<Array<{ id: number }>>`
      INSERT INTO registrations (reg_code,event_id,ticket_type_id,email,first_name,last_name,status,source,created_at)
      VALUES ('INV-WRONG-EVENT',${eventB.id},${ticketB.id},${`${PREFIX}-wrong-event@example.test`},'WrongEvent','Reviewer','confirmed','manual',clock_timestamp())
      RETURNING id`;

    const invitationTokens: Record<string, string> = {};
    const insertInvitation = async (
      registrationId: number,
      sessionId: number,
      label: string,
      status: 'pending' | 'declined' = 'pending',
      emailStatus: 'pending' | 'failed' | 'suppressed' = 'pending',
    ) => {
      const batchId = randomUUID();
      const itemId = randomUUID();
      const invitationId = randomUUID();
      const token = issueInvitationToken(invitationId, key);
      const terminal = status !== 'pending';
      const tokenCiphertext = terminal ? null : JSON.stringify(token.envelope);
      await tx`INSERT INTO registration_session_grant_batches (
        id,actor_id,actor_name_snapshot,idempotency_key,request_hash,session_id,event_id,
        session_name_snapshot,requested_count,added_count,invited_count,skipped_count,created_at,completed_at
      ) VALUES (
        ${batchId},${admin.id},'Invitation Admin',${randomUUID()},${'e'.repeat(64)},${sessionId},${event.id},
        ${label},1,0,1,0,clock_timestamp(),clock_timestamp()
      )`;
      await tx`INSERT INTO registration_session_grant_items (
        id,batch_id,requested_registration_id,reg_code_snapshot,name_snapshot,outcome,reason_code,
        recipient_email_snapshot,notification_snapshot,email_status,attempt_count,last_error_code,created_at
      ) SELECT
        ${itemId},${batchId},r.id,r.reg_code,concat(r.first_name,' ',r.last_name),'invited',NULL,
        r.email,'{}'::jsonb,${emailStatus},${emailStatus === 'failed' ? 1 : 0},${emailStatus === 'failed' ? 'SYNTHETIC_FAILED' : null},clock_timestamp()
      FROM registrations r WHERE r.id=${registrationId}`;
      await tx`INSERT INTO session_invitations (
        id,grant_item_id,registration_id,session_id,status,token_hash,token_ciphertext,expires_at,
        responded_at,closed_at,created_by,created_at
      ) VALUES (
        ${invitationId},${itemId},${registrationId},${sessionId},${status},${token.tokenHash},
        ${tokenCiphertext}::jsonb,${future(20)},
        ${terminal ? past(1) : null},${terminal ? past(1) : null},${admin.id},clock_timestamp()
      )`;
      if (!terminal) invitationTokens[label] = token.rawToken;
      return { batchId, itemId, invitationId };
    };

    const pendingUi = await insertInvitation(pendingUiId, uiSessionId, 'Pending UI Invitation', 'pending', 'suppressed');
    await insertInvitation(responseAcceptId, responseSessionId, 'responseAccept', 'pending', 'suppressed');
    await insertInvitation(responseDeclineId, responseSessionId, 'responseDecline', 'pending', 'suppressed');
    await insertInvitation(responseUncertainId, responseSessionId, 'responseUncertain', 'pending', 'suppressed');
    const closedFailed = await insertInvitation(closedFailedId, responseSessionId, 'Closed Failed Invitation', 'declined', 'failed');

    return {
      adminId: admin.id,
      organizerId: organizer.id,
      eventId: event.id,
      eventBId: eventB.id,
      targetSessionId,
      uiSessionId,
      responseSessionId,
      legacySessionId,
      candidate1Id,
      candidate2Id,
      pendingUiId,
      pendingUiBatchId: pendingUi.batchId,
      duplicateOwnedId,
      duplicateSiblingId,
      cancelledId,
      responseAcceptId,
      responseDeclineId,
      responseUncertainId,
      closedFailedId,
      closedFailedBatchId: closedFailed.batchId,
      wrongEventRegistrationId: wrongEventRegistration.id,
      invitationTokens,
    };
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    prefix: PREFIX,
    eventCode: EVENT_CODE,
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
