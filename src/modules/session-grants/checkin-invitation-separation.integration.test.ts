import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import postgres from "postgres";
import { closeDatabase } from "../../database/index.js";
import backofficeCheckinsRoutes from "../../routes/backoffice/checkins.js";

test(
  "check-in surfaces use actual entitlements only and ignore pending invitations",
  { timeout: 60_000 },
  async (t) => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl?.includes("session_grants"), "isolated Docker runtime DB required");
    const sql = postgres(databaseUrl!, { max: 1 });
    const unique = Date.now().toString(36);

    const [actor] = await sql<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${`checkin-reader-${unique}@example.invalid`},'x','admin','Check','Admin')
      RETURNING id
    `;
    const [user] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email,password_hash,role,first_name,last_name,status)
      VALUES (${`checkin-user-${unique}@example.invalid`},'x','general','Check','User','active')
      RETURNING id
    `;
    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (${`CHECK-INV-${unique}`},'Checkin Invitation Event','multi_session','2026-10-01','2099-10-03','published')
      RETURNING id
    `;
    const [ticket] = await sql<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (${event.id},'primary','regular','Checkin Ticket',1000,'THB',100)
      RETURNING id
    `;
    const sessions = await sql<Array<{ id: number; gated: boolean }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,start_time,end_time,is_active,
        admin_grant_requires_confirmation,max_capacity
      ) VALUES
        (${event.id},${`CHECK-ACT-${unique}`},'Actual Checkin','workshop','2026-01-01 00:00','2099-10-01 10:00',true,false,50),
        (${event.id},${`CHECK-INV-${unique}`},'Pending Invitation','workshop','2026-01-01 00:00','2099-10-01 11:00',true,true,50)
      RETURNING id,admin_grant_requires_confirmation AS gated
    `;
    const actualSession = sessions.find((row) => !row.gated)!;
    const invitationSession = sessions.find((row) => row.gated)!;
    const [registration] = await sql<Array<{ id: number; reg_code: string }>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status,source
      ) VALUES (
        ${`CHECK-REG-${unique}`},${event.id},${ticket.id},${user.id},
        ${`checkin-user-${unique}@example.invalid`},'Check','User','confirmed','purchase'
      ) RETURNING id,reg_code
    `;
    await sql`
      INSERT INTO registration_sessions (
        registration_id,session_id,ticket_type_id,source,added_by
      ) VALUES (${registration.id},${actualSession.id},NULL,'admin_grant',${actor.id})
    `;
    const [batch] = await sql<Array<{ id: string }>>`
      INSERT INTO registration_session_grant_batches (
        id,event_id,session_id,actor_id,idempotency_key,request_hash,
        requested_count,added_count,invited_count,skipped_count,
        actor_name_snapshot,session_name_snapshot,completed_at
      ) VALUES (
        gen_random_uuid(),${event.id},${invitationSession.id},${actor.id},gen_random_uuid(),repeat('c',64),
        1,0,1,0,'Check Admin','Pending Invitation',clock_timestamp()
      ) RETURNING id
    `;
    const [item] = await sql<Array<{ id: string }>>`
      INSERT INTO registration_session_grant_items (
        id,batch_id,requested_registration_id,outcome,
        reason_code,email_status,recipient_email_snapshot,notification_snapshot
      ) VALUES (
        gen_random_uuid(),${batch.id},${registration.id},'invited',
        NULL,'pending',${`checkin-user-${unique}@example.invalid`},'{}'::jsonb
      ) RETURNING id
    `;
    await sql`
      INSERT INTO session_invitations (
        id,grant_item_id,registration_id,session_id,status,
        token_hash,token_ciphertext,expires_at,created_by
      ) VALUES (
        gen_random_uuid(),${item.id},${registration.id},${invitationSession.id},'pending',
        repeat('d',64),
        '{"v":1,"alg":"A256GCM","iv":"x","tag":"y","ciphertext":"z"}'::jsonb,
        '2099-10-01 09:30',${actor.id}
      )
    `;

    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (request) => {
      (request as any).user = { id: actor.id, role: "admin" };
    });
    await app.register(backofficeCheckinsRoutes, { prefix: "/checkins" });
    await app.ready();

    t.after(async () => {
      await app.close();
      await sql`DELETE FROM session_invitations WHERE grant_item_id=${item.id}`;
      await sql`DELETE FROM registration_session_grant_items WHERE id=${item.id}`;
      await sql`DELETE FROM registration_session_grant_batches WHERE id=${batch.id}`;
      await sql`DELETE FROM registration_sessions WHERE registration_id=${registration.id}`;
      await sql`DELETE FROM registrations WHERE id=${registration.id}`;
      await sql`DELETE FROM sessions WHERE event_id=${event.id}`;
      await sql`DELETE FROM ticket_types WHERE id=${ticket.id}`;
      await sql`DELETE FROM events WHERE id=${event.id}`;
      await sql`DELETE FROM users WHERE id=${user.id}`;
      await sql`DELETE FROM backoffice_users WHERE id=${actor.id}`;
      await sql.end({ timeout: 2 });
      await closeDatabase();
    });

    const picker = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: { regCode: registration.reg_code },
    });
    assert.equal(picker.statusCode, 200, picker.body);
    const pickerSessions = picker.json().sessions;
    assert.equal(pickerSessions.length, 1);
    assert.equal(pickerSessions[0].sessionId, actualSession.id);

    const deniedAssigned = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: {
        regCode: registration.reg_code,
        assignedSessionId: invitationSession.id,
      },
    });
    assert.equal(deniedAssigned.statusCode, 400);
    assert.equal(deniedAssigned.json().code, "NO_ACCESS");

    const deniedSpecific = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: {
        regCode: registration.reg_code,
        sessionId: invitationSession.id,
      },
    });
    assert.equal(deniedSpecific.statusCode, 400);
    assert.equal(deniedSpecific.json().code, "NO_ACCESS");

    const beforeAcceptAll = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: { regCode: registration.reg_code, checkInAll: true },
    });
    assert.equal(beforeAcceptAll.statusCode, 200, beforeAcceptAll.body);
    assert.equal(beforeAcceptAll.json().checkedInCount, 1);
    await sql`
      UPDATE registration_sessions
      SET checked_in_at = NULL, checked_in_by = NULL
      WHERE registration_id = ${registration.id}
    `;

    const beforeAcceptStats = await app.inject({
      method: "GET",
      url: `/checkins/stats?eventId=${event.id}`,
    });
    assert.equal(beforeAcceptStats.statusCode, 200);
    assert.equal(beforeAcceptStats.json().total, 1);

    await sql`
      UPDATE session_invitations
      SET status = 'accepted',
          responded_at = clock_timestamp(),
          closed_at = clock_timestamp(),
          token_ciphertext = NULL
      WHERE grant_item_id = ${item.id}
    `;
    await sql`
      INSERT INTO registration_sessions (
        registration_id,session_id,ticket_type_id,source,added_by
      ) VALUES (
        ${registration.id},${invitationSession.id},NULL,'admin_grant',${actor.id}
      )
    `;

    const acceptedPicker = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: { regCode: registration.reg_code },
    });
    assert.equal(acceptedPicker.statusCode, 200, acceptedPicker.body);
    const acceptedSessions = acceptedPicker.json().sessions;
    assert.equal(acceptedSessions.length, 2);
    const acceptedInvitationSession = acceptedSessions.find(
      (row: any) => row.sessionId === invitationSession.id,
    );
    assert.ok(acceptedInvitationSession);
    assert.equal(acceptedInvitationSession.source, "admin_grant");
    assert.equal(acceptedInvitationSession.ticketName, null);

    const acceptedAssigned = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: {
        regCode: registration.reg_code,
        assignedSessionId: invitationSession.id,
      },
    });
    assert.equal(acceptedAssigned.statusCode, 200, acceptedAssigned.body);
    assert.equal(acceptedAssigned.json().checkedInSession.source, "admin_grant");
    assert.equal(acceptedAssigned.json().checkedInSession.ticketName, null);
    await sql`
      UPDATE registration_sessions
      SET checked_in_at = NULL, checked_in_by = NULL
      WHERE registration_id = ${registration.id}
    `;

    const acceptedSpecific = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: {
        regCode: registration.reg_code,
        sessionId: invitationSession.id,
      },
    });
    assert.equal(acceptedSpecific.statusCode, 200, acceptedSpecific.body);
    assert.equal(acceptedSpecific.json().checkedInSession.source, "admin_grant");
    assert.equal(acceptedSpecific.json().checkedInSession.ticketName, null);
    await sql`
      UPDATE registration_sessions
      SET checked_in_at = NULL, checked_in_by = NULL
      WHERE registration_id = ${registration.id}
    `;

    const acceptedAll = await app.inject({
      method: "POST",
      url: "/checkins",
      payload: { regCode: registration.reg_code, checkInAll: true },
    });
    assert.equal(acceptedAll.statusCode, 200, acceptedAll.body);
    assert.equal(acceptedAll.json().checkedInCount, 2);

    const acceptedStats = await app.inject({
      method: "GET",
      url: `/checkins/stats?eventId=${event.id}`,
    });
    assert.equal(acceptedStats.statusCode, 200);
    assert.equal(acceptedStats.json().total, 2);
    assert.equal(acceptedStats.json().checkedIn, 2);
  },
);
