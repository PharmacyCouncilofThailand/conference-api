import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import postgres from "postgres";
import { closeDatabase } from "../../database/index.js";
import backofficeEventsRoutes from "../../routes/backoffice/events.js";
import backofficeRegistrationsRoutes from "../../routes/backoffice/registrations.js";

test(
  "Backoffice selector/list/details separate pending invitations from actual entitlements",
  { timeout: 60_000 },
  async (t) => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl?.includes("session_grants"), "isolated Docker runtime DB required");
    const sql = postgres(databaseUrl!, { max: 1 });
    const unique = Date.now().toString(36);

    const [actor] = await sql<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${`bo-reader-${unique}@example.invalid`},'x','admin','Reader','Admin')
      RETURNING id
    `;
    const [user] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email,password_hash,role,first_name,last_name,status)
      VALUES (${`bo-reader-user-${unique}@example.invalid`},'x','general','Reader','User','active')
      RETURNING id
    `;
    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (${`BO-READ-${unique}`},'BO Reader Event','multi_session','2026-10-01','2099-10-03','published')
      RETURNING id
    `;
    const [ticket] = await sql<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (${event.id},'primary','regular','Reader Ticket',1000,'THB',100)
      RETURNING id
    `;
    const sessions = await sql<Array<{ id: number; gated: boolean }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,start_time,end_time,is_active,
        admin_grant_requires_confirmation,max_capacity
      ) VALUES
        (${event.id},${`BO-ACT-${unique}`},'Actual Session','workshop','2099-10-01 09:00','2099-10-01 10:00',true,false,50),
        (${event.id},${`BO-INV-${unique}`},'Invitation Session','workshop','2099-10-01 10:00','2099-10-01 11:00',true,true,50)
      RETURNING id,admin_grant_requires_confirmation AS gated
    `;
    const actualSession = sessions.find((row) => !row.gated)!;
    const invitationSession = sessions.find((row) => row.gated)!;
    const [registration] = await sql<Array<{ id: number }>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status,source
      ) VALUES (
        ${`BO-REG-${unique}`},${event.id},${ticket.id},${user.id},
        ${`bo-reader-user-${unique}@example.invalid`},'Reader','User','confirmed','purchase'
      ) RETURNING id
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
        gen_random_uuid(),${event.id},${invitationSession.id},${actor.id},gen_random_uuid(),repeat('a',64),
        1,0,1,0,'Reader Admin','Invitation Session',clock_timestamp()
      ) RETURNING id
    `;
    const [item] = await sql<Array<{ id: string }>>`
      INSERT INTO registration_session_grant_items (
        id,batch_id,requested_registration_id,outcome,
        reason_code,email_status,recipient_email_snapshot,notification_snapshot
      ) VALUES (
        gen_random_uuid(),${batch.id},${registration.id},'invited',
        NULL,'pending',${`bo-reader-user-${unique}@example.invalid`},
        '{}'::jsonb
      ) RETURNING id
    `;
    await sql`
      INSERT INTO session_invitations (
        id,grant_item_id,registration_id,session_id,status,
        token_hash,token_ciphertext,expires_at,created_by
      ) VALUES (
        gen_random_uuid(),${item.id},${registration.id},${invitationSession.id},'pending',
        repeat('b',64),
        '{"v":1,"alg":"A256GCM","iv":"x","tag":"y","ciphertext":"z"}'::jsonb,
        '2099-10-01 09:30',${actor.id}
      )
    `;

    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (request) => {
      (request as any).user = { id: actor.id, role: "admin" };
    });
    await app.register(backofficeEventsRoutes, { prefix: "/events" });
    await app.register(backofficeRegistrationsRoutes, { prefix: "/registrations" });
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

    const selector = await app.inject({
      method: "GET",
      url: `/events/${event.id}/sessions?forGrant=true`,
    });
    assert.equal(selector.statusCode, 200);
    const selectorBody = selector.json();
    const gated = selectorBody.sessions.find((row: any) => row.id === invitationSession.id);
    assert.ok(gated);
    assert.equal(gated.enrollmentCount, 0);
    assert.equal(gated.reservedCount, 1);
    assert.equal(gated.occupiedCount, 1);
    assert.equal(gated.seatsRemaining, 49);
    assert.equal(gated.grantEligible, true);

    const list = await app.inject({
      method: "GET",
      url: `/registrations?eventId=${event.id}&sessionId=${invitationSession.id}&page=1&limit=50`,
    });
    assert.equal(list.statusCode, 200);
    const listed = list.json().registrations.find((row: any) => row.id === registration.id);
    assert.ok(listed);
    assert.equal(listed.hasSession, false);
    assert.equal(listed.hasParticipantSession, false);
    assert.equal(listed.hasPendingInvitation, true);
    assert.equal(listed.grantEligible, false);
    assert.equal(listed.grantDisabledReason, "ALREADY_INVITED");

    const details = await app.inject({
      method: "GET",
      url: `/registrations/${registration.id}`,
    });
    assert.equal(details.statusCode, 200);
    const detail = details.json().registration;
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.sessions[0].sessionId, actualSession.id);
    assert.equal(detail.invitations.length, 1);
    assert.equal(detail.invitations[0].sessionId, invitationSession.id);
    assert.equal(detail.invitations[0].status, "pending");
    assert.equal(detail.invitations[0].emailStatus, "pending");
  },
);
