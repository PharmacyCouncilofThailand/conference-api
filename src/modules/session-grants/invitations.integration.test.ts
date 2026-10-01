import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import {
  decryptInvitationToken,
  issueInvitationToken,
} from "./invitation-token.js";
import {
  closeInactiveInvitations,
  lookupInvitation,
  readInvitationCapacity,
  respondToInvitation,
} from "./invitations.js";
import { createGrant } from "./service.js";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";
import type { GrantDatabase, TokenEnvelope } from "./types.js";
import { GrantError } from "./types.js";

function asDatabase(
  client: ReturnType<typeof openSessionGrantTestDatabase>,
): GrantDatabase {
  return drizzle(client, { schema }) as GrantDatabase;
}

async function insertPendingInvitation(
  sql: ReturnType<typeof openSessionGrantTestDatabase>,
  input: {
    actorId: number;
    eventId: number;
    sessionId: number;
    registrationId: number;
    sessionName: string;
    tokenHash?: string;
    tokenCiphertext?: TokenEnvelope;
    expiresAtSql?: string;
  },
): Promise<{ invitationId: string; itemId: string; batchId: string }> {
  const batchId = randomUUID();
  const itemId = randomUUID();
  const invitationId = randomUUID();
  const tokenHash =
    input.tokenHash ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16).padStart(64, "0").slice(-64);
  const tokenCiphertext = input.tokenCiphertext ?? {
    version: 1,
    nonce: Buffer.alloc(12, 1).toString("base64"),
    tag: Buffer.alloc(16, 2).toString("base64"),
    ciphertext: Buffer.from("synthetic").toString("base64"),
  };
  const expiresAtSql = input.expiresAtSql ?? "clock_timestamp() + interval '1 day'";

  await sql.unsafe(
    `INSERT INTO registration_session_grant_batches (
      id,actor_id,actor_name_snapshot,idempotency_key,request_hash,
      session_id,event_id,session_name_snapshot,requested_count,
      added_count,invited_count,skipped_count,completed_at
    ) VALUES (
      $1,$2,'Capacity Admin',$3,$4,$5,$6,$7,1,0,1,0,clock_timestamp()
    )`,
    [batchId,input.actorId,randomUUID(),"c".repeat(64),input.sessionId,input.eventId,input.sessionName],
  );
  await sql.unsafe(
    `INSERT INTO registration_session_grant_items (
      id,batch_id,requested_registration_id,registration_session_id,
      reg_code_snapshot,name_snapshot,outcome,reason_code,
      recipient_email_snapshot,notification_snapshot,email_status,
      attempt_count,next_trigger
    )
    SELECT $1,$2,r.id,NULL,r.reg_code,r.first_name || ' ' || r.last_name,
      'invited',NULL,r.email,'{}'::jsonb,'pending',0,'system'
    FROM registrations r WHERE r.id=$3`,
    [itemId,batchId,input.registrationId],
  );
  await sql.unsafe(
    `INSERT INTO session_invitations (
      id,registration_id,session_id,grant_item_id,status,token_hash,
      token_ciphertext,expires_at,responded_at,closed_at,close_reason,created_by
    ) VALUES ($1,$2,$3,$4,'pending',$5,$6::jsonb,${expiresAtSql},NULL,NULL,NULL,$7)`,
    [
      invitationId,
      input.registrationId,
      input.sessionId,
      itemId,
      tokenHash,
      JSON.stringify(tokenCiphertext),
      input.actorId,
    ],
  );
  return { invitationId,itemId,batchId };
}

test(
  "configured invitation capacity and public lookup are read-only and participant-aware",
  { timeout: 60_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();
    const database = asDatabase(sql);
    t.after(async () => {
      await sql`DELETE FROM session_invitations WHERE created_by IN (
        SELECT id FROM backoffice_users WHERE email LIKE 'inv-reader-%@example.invalid'
      )`;
      await sql`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (
        SELECT i.id FROM registration_session_grant_items i
        JOIN registration_session_grant_batches b ON b.id=i.batch_id
        WHERE b.actor_name_snapshot='Capacity Admin'
      )`;
      await sql`DELETE FROM registration_session_grant_items WHERE batch_id IN (
        SELECT id FROM registration_session_grant_batches WHERE actor_name_snapshot='Capacity Admin'
      )`;
      await sql`DELETE FROM registration_session_grant_batches WHERE actor_name_snapshot='Capacity Admin'`;
      await sql`DELETE FROM registration_sessions WHERE registration_id IN (
        SELECT id FROM registrations WHERE reg_code LIKE 'INV-READ-%'
      )`;
      await sql`DELETE FROM registrations WHERE reg_code LIKE 'INV-READ-%'`;
      await sql`DELETE FROM users WHERE email LIKE 'inv-reader-user-%@example.invalid'`;
      await sql`DELETE FROM ticket_types WHERE name LIKE 'Invitation Reader Ticket %'`;
      await sql`DELETE FROM sessions WHERE session_code LIKE 'INV-READ-%'`;
      await sql`DELETE FROM events WHERE event_code LIKE 'INV-READ-%'`;
      await sql`DELETE FROM backoffice_users WHERE email LIKE 'inv-reader-%@example.invalid'`;
      await sql.end({ timeout: 2 });
    });

    const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const [actor] = await sql<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${`inv-reader-${unique}@example.invalid`},'synthetic','admin','Capacity','Admin')
      RETURNING id
    `;
    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (
        ${`INV-READ-${unique}`},'Invitation Reader Event','multi_session',
        clock_timestamp(),clock_timestamp()+interval '5 days','published'
      ) RETURNING id
    `;
    const [ticket] = await sql<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (
        ${event.id},'primary','regular',${`Invitation Reader Ticket ${unique}`},
        100,'THB',500
      ) RETURNING id
    `;
    const sessions = await sql<Array<{ id: number; code: string }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,start_time,end_time,max_capacity,
        is_active,admin_grant_requires_confirmation
      ) VALUES
        (
          ${event.id},${`INV-READ-CAP-${unique}`},'Capacity Session',
          clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',
          50,true,true
        ),
        (
          ${event.id},${`INV-READ-SIB-${unique}`},'Sibling Session',
          clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',
          5,true,true
        ),
        (
          ${event.id},${`INV-READ-OVER-${unique}`},'Over Capacity Session',
          clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',
          2,true,true
        )
      RETURNING id,session_code AS code
    `;
    const capacitySessionId = sessions.find((row) => row.code.includes("-CAP-"))!.id;
    const siblingSessionId = sessions.find((row) => row.code.includes("-SIB-"))!.id;
    const overSessionId = sessions.find((row) => row.code.includes("-OVER-"))!.id;

    const registrations = await sql<Array<{ id: number }>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,email,first_name,last_name,status
      )
      SELECT
        ${`INV-READ-${unique}-`} || gs::text,${event.id},${ticket.id},
        'inv-reader-' || ${unique} || '-' || gs::text || '@example.invalid',
        'Reader','Participant ' || gs::text,'confirmed'
      FROM generate_series(1,50) gs
      ORDER BY gs
      RETURNING id
    `;
    assert.equal(registrations.length, 50);

    for (const registration of registrations.slice(0, 30)) {
      await sql`
        INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
        VALUES (${registration.id},${capacitySessionId},${ticket.id},'purchase')
      `;
    }

    const lookupRegistration = registrations[30]!;
    const lookupInvitationId = randomUUID();
    const issued = issueInvitationToken(lookupInvitationId, Buffer.alloc(32, 7));
    const lookupBatchId = randomUUID();
    const lookupItemId = randomUUID();
    await sql`
      INSERT INTO registration_session_grant_batches (
        id,actor_id,actor_name_snapshot,idempotency_key,request_hash,
        session_id,event_id,session_name_snapshot,requested_count,
        added_count,invited_count,skipped_count,completed_at
      ) VALUES (
        ${lookupBatchId},${actor.id},'Capacity Admin',${randomUUID()},${"d".repeat(64)},
        ${capacitySessionId},${event.id},'Capacity Session',1,0,1,0,clock_timestamp()
      )
    `;
    await sql`
      INSERT INTO registration_session_grant_items (
        id,batch_id,requested_registration_id,reg_code_snapshot,name_snapshot,
        outcome,recipient_email_snapshot,notification_snapshot,email_status,
        attempt_count,next_trigger
      ) SELECT
        ${lookupItemId},${lookupBatchId},r.id,r.reg_code,r.first_name || ' ' || r.last_name,
        'invited',r.email,'{}'::jsonb,'pending',0,'system'
      FROM registrations r WHERE r.id=${lookupRegistration.id}
    `;
    await sql`
      INSERT INTO session_invitations (
        id,registration_id,session_id,grant_item_id,status,token_hash,
        token_ciphertext,expires_at,created_by
      ) VALUES (
        ${lookupInvitationId},${lookupRegistration.id},${capacitySessionId},
        ${lookupItemId},'pending',${issued.tokenHash},${JSON.stringify(issued.envelope)}::jsonb,
        clock_timestamp()+interval '1 day',${actor.id}
      )
    `;

    for (const registration of registrations.slice(31, 45)) {
      await insertPendingInvitation(sql,{
        actorId:actor.id,eventId:event.id,sessionId:capacitySessionId,
        registrationId:registration.id,sessionName:"Capacity Session",
      });
    }

    await insertPendingInvitation(sql,{
      actorId:actor.id,eventId:event.id,sessionId:capacitySessionId,
      registrationId:registrations[45]!.id,sessionName:"Capacity Session",
      expiresAtSql:"clock_timestamp() - interval '1 second'",
    });

    const nowRows = await sql<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const capacity = await readInvitationCapacity(database,capacitySessionId,new Date(nowRows[0]!.now));
    assert.deepEqual(capacity,{
      currentEnrollmentCount:30,
      reservedCount:15,
      occupiedCount:45,
      seatsRemaining:5,
    });

    const [sharedUser] = await sql<Array<{ id: number }>>`
      INSERT INTO users (email,password_hash,role,first_name,last_name,status)
      VALUES (
        ${`inv-reader-user-${unique}@example.invalid`},'synthetic','general',
        'Shared','Participant','active'
      ) RETURNING id
    `;
    const siblingRegs = await sql<Array<{ id: number }>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status
      ) VALUES
        (
          ${`INV-READ-${unique}-SIB-A`},${event.id},${ticket.id},${sharedUser.id},
          ${`inv-reader-${unique}-sib-a@example.invalid`},'Sibling','Actual','confirmed'
        ),
        (
          ${`INV-READ-${unique}-SIB-B`},${event.id},${ticket.id},${sharedUser.id},
          ${`inv-reader-${unique}-sib-b@example.invalid`},'Sibling','Pending','confirmed'
        )
      RETURNING id
    `;
    await sql`
      INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
      VALUES (${siblingRegs[0]!.id},${siblingSessionId},${ticket.id},'purchase')
    `;
    await insertPendingInvitation(sql,{
      actorId:actor.id,eventId:event.id,sessionId:siblingSessionId,
      registrationId:siblingRegs[1]!.id,sessionName:"Sibling Session",
    });
    const siblingCapacity = await readInvitationCapacity(
      database,siblingSessionId,new Date(nowRows[0]!.now),
    );
    assert.deepEqual(siblingCapacity,{
      currentEnrollmentCount:1,
      reservedCount:0,
      occupiedCount:1,
      seatsRemaining:4,
    });

    for (const registration of registrations.slice(46, 49)) {
      await sql`
        INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
        VALUES (${registration.id},${overSessionId},${ticket.id},'purchase')
      `;
    }
    const overCapacity = await readInvitationCapacity(database,overSessionId,new Date(nowRows[0]!.now));
    assert.deepEqual(overCapacity,{
      currentEnrollmentCount:3,
      reservedCount:0,
      occupiedCount:3,
      seatsRemaining:0,
    });
    await sql`UPDATE sessions SET max_capacity=0 WHERE id=${overSessionId}`;
    await assert.rejects(
      () => readInvitationCapacity(database,overSessionId,new Date(nowRows[0]!.now)),
      (error:unknown) =>
        error instanceof GrantError &&
        error.statusCode===503 &&
        error.code==="SESSION_INVITATION_CONFIG_ERROR",
    );
    await assert.rejects(
      () => readInvitationCapacity(database,2147483000,new Date(nowRows[0]!.now)),
      (error:unknown) =>
        error instanceof GrantError &&
        error.statusCode===404 &&
        error.code==="SESSION_NOT_FOUND",
    );

    const before = await sql<Array<{
      status:string; token_hash:string; token_ciphertext:unknown; responded_at:Date|null; closed_at:Date|null;
    }>>`
      SELECT status,token_hash,token_ciphertext,responded_at,closed_at
      FROM session_invitations WHERE id=${lookupInvitationId}
    `;
    assert.equal(before[0]!.token_hash,issued.tokenHash);
    assert.notEqual(before[0]!.token_hash,issued.rawToken);
    assert.equal(JSON.stringify(before[0]!.token_ciphertext).includes(issued.rawToken),false);
    const first = await lookupInvitation(database,issued.rawToken);
    const second = await lookupInvitation(database,issued.rawToken);
    assert.deepEqual(second,first);
    assert.equal(first.invitationId,lookupInvitationId);
    assert.equal(first.status,"pending");
    assert.equal(first.recipientFirstName,"Reader");
    assert.equal(first.session.sessionName,"Capacity Session");
    const after = await sql<Array<{
      status:string; token_hash:string; token_ciphertext:unknown; responded_at:Date|null; closed_at:Date|null;
    }>>`
      SELECT status,token_hash,token_ciphertext,responded_at,closed_at
      FROM session_invitations WHERE id=${lookupInvitationId}
    `;
    assert.deepEqual(after,before);

    await assert.rejects(
      () => lookupInvitation(database,"f".repeat(64)),
      (error:unknown) =>
        error instanceof GrantError &&
        error.statusCode===401 &&
        error.code==="INVALID_INVITATION_TOKEN",
    );

    await sql`UPDATE registrations SET status='cancelled' WHERE id=${lookupRegistration.id}`;
    await assert.rejects(
      () => lookupInvitation(database,issued.rawToken),
      (error:unknown) =>
        error instanceof GrantError &&
        error.statusCode===409 &&
        error.code==="REGISTRATION_NOT_CONFIRMED",
    );
    const cancelledSnapshot = await sql<Array<{ status:string; token_ciphertext:unknown }>>`
      SELECT status,token_ciphertext FROM session_invitations WHERE id=${lookupInvitationId}
    `;
    assert.equal(cancelledSnapshot[0]!.status,"pending");
    assert.ok(cancelledSnapshot[0]!.token_ciphertext);
  },
);

test(
  "configured createGrant reserves capacity atomically with idempotency and participant semantics",
  { timeout: 90_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();
    const database = asDatabase(sql);
    const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const actorEmail = `inv-create-${unique}@example.invalid`;
    const eventCode = `INV-CREATE-${unique}`;

    t.after(async () => {
      await sql`DELETE FROM session_invitations WHERE created_by IN (
        SELECT id FROM backoffice_users WHERE email = ${actorEmail}
      )`;
      await sql`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (
        SELECT i.id FROM registration_session_grant_items i
        JOIN registration_session_grant_batches b ON b.id=i.batch_id
        WHERE b.actor_name_snapshot='Invitation Create Admin'
      )`;
      await sql`DELETE FROM registration_session_grant_items WHERE batch_id IN (
        SELECT id FROM registration_session_grant_batches
        WHERE actor_name_snapshot='Invitation Create Admin'
      )`;
      await sql`DELETE FROM registration_session_grant_batches
        WHERE actor_name_snapshot='Invitation Create Admin'`;
      await sql`DELETE FROM registration_sessions WHERE registration_id IN (
        SELECT id FROM registrations WHERE reg_code LIKE ${`INV-CREATE-${unique}-%`}
      )`;
      await sql`DELETE FROM registrations WHERE reg_code LIKE ${`INV-CREATE-${unique}-%`}`;
      await sql`DELETE FROM users WHERE email = ${`inv-create-user-${unique}@example.invalid`}`;
      await sql`DELETE FROM ticket_types WHERE name = ${`Invitation Create Ticket ${unique}`}`;
      await sql`DELETE FROM sessions WHERE session_code LIKE ${`INV-CREATE-${unique}-%`}`;
      await sql`DELETE FROM events WHERE event_code = ${eventCode}`;
      await sql`DELETE FROM backoffice_users WHERE email = ${actorEmail}`;
      await sql.end({ timeout: 2 });
    });

    const [actor] = await sql<Array<{id:number}>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${actorEmail},'synthetic','admin','Invitation Create','Admin')
      RETURNING id
    `;
    const [event] = await sql<Array<{id:number}>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (
        ${eventCode},'Invitation Create Event','multi_session',
        clock_timestamp(),clock_timestamp()+interval '5 days','published'
      ) RETURNING id
    `;
    const [ticket] = await sql<Array<{id:number}>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (
        ${event.id},'primary','regular',${`Invitation Create Ticket ${unique}`},
        100,'THB',50
      ) RETURNING id
    `;
    const createdSessions = await sql<Array<{id:number;session_code:string}>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,start_time,end_time,max_capacity,
        is_active,admin_grant_requires_confirmation
      ) VALUES
        (
          ${event.id},${`INV-CREATE-${unique}-CAP`},'Invitation Create Capacity',
          clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',
          2,true,true
        ),
        (
          ${event.id},${`INV-CREATE-${unique}-CONFIG`},'Invitation Create Config',
          clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',
          5,true,true
        )
      RETURNING id,session_code
    `;
    const capacitySession = createdSessions.find((row)=>row.session_code.endsWith("-CAP"))!;
    const configSession = createdSessions.find((row)=>row.session_code.endsWith("-CONFIG"))!;

    const [sharedUser] = await sql<Array<{id:number}>>`
      INSERT INTO users (email,password_hash,role,first_name,last_name,status)
      VALUES (
        ${`inv-create-user-${unique}@example.invalid`},'synthetic','general',
        'Shared','User','active'
      ) RETURNING id
    `;
    const regs = await sql<Array<{id:number;reg_code:string}>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status
      ) VALUES
        (
          ${`INV-CREATE-${unique}-A`},${event.id},${ticket.id},${sharedUser.id},
          ${`inv-create-a-${unique}@example.invalid`},'Invite','Alpha','confirmed'
        ),
        (
          ${`INV-CREATE-${unique}-A2`},${event.id},${ticket.id},${sharedUser.id},
          ${`inv-create-a2-${unique}@example.invalid`},'Invite','Alpha Two','confirmed'
        ),
        (
          ${`INV-CREATE-${unique}-B`},${event.id},${ticket.id},NULL,
          ${`inv-create-b-${unique}@example.invalid`},'Invite','Beta','confirmed'
        ),
        (
          ${`INV-CREATE-${unique}-C`},${event.id},${ticket.id},NULL,
          ${`inv-create-c-${unique}@example.invalid`},'Invite','Gamma','confirmed'
        ),
        (
          ${`INV-CREATE-${unique}-CANCEL`},${event.id},${ticket.id},NULL,
          ${`inv-create-cancel-${unique}@example.invalid`},'Invite','Cancelled','cancelled'
        ),
        (
          ${`INV-CREATE-${unique}-CONFIG`},${event.id},${ticket.id},NULL,
          ${`inv-create-config-${unique}@example.invalid`},'Invite','Config','confirmed'
        )
      RETURNING id,reg_code
    `;
    const bySuffix=(suffix:string)=>regs.find((row)=>row.reg_code.endsWith(suffix))!;
    const alpha=bySuffix("-A");
    const alphaTwo=bySuffix("-A2");
    const beta=bySuffix("-B");
    const gamma=bySuffix("-C");
    const cancelled=bySuffix("-CANCEL");
    const configReg=bySuffix("-CONFIG");

    const firstKey=randomUUID();
    const first = await createGrant(database,{
      actorId:actor.id,
      idempotencyKey:firstKey,
      sessionId:capacitySession.id,
      registrationIds:[alphaTwo.id,cancelled.id,alpha.id],
    });
    assert.equal(first.replayed,false);
    assert.equal(first.batch.addedCount,0);
    assert.equal(first.batch.invitedCount,1);
    assert.equal(first.batch.skippedCount,2);
    assert.equal(first.batch.requestedCount,3);
    assert.equal(first.batch.reservedCount,1);
    assert.equal(first.batch.occupiedCount,1);
    assert.equal(first.batch.seatsRemaining,1);
    const firstByRegistration=new Map(first.batch.results.map((row)=>[row.registrationId,row]));
    assert.equal(firstByRegistration.get(alpha.id)?.outcome,"invited");
    assert.equal(firstByRegistration.get(alpha.id)?.invitation?.invitationStatus,"pending");
    assert.equal(firstByRegistration.get(alphaTwo.id)?.reasonCode,"DUPLICATE_PARTICIPANT");
    assert.equal(firstByRegistration.get(cancelled.id)?.reasonCode,"REGISTRATION_NOT_CONFIRMED");

    const [{entitlements}] = await sql<Array<{entitlements:number}>>`
      SELECT count(*)::int AS entitlements FROM registration_sessions
      WHERE session_id=${capacitySession.id}
    `;
    assert.equal(entitlements,0,"configured creation must not grant access before acceptance");

    const invitationRows = await sql<Array<{
      id:string;token_hash:string;token_ciphertext:TokenEnvelope;registration_id:number;
    }>>`
      SELECT id,token_hash,token_ciphertext,registration_id
      FROM session_invitations WHERE session_id=${capacitySession.id}
    `;
    assert.equal(invitationRows.length,1);
    assert.equal(invitationRows[0]!.registration_id,alpha.id);
    assert.ok(invitationRows[0]!.token_ciphertext);
    assert.equal(invitationRows[0]!.token_hash.length,64);

    const replay=await createGrant(database,{
      actorId:actor.id,
      idempotencyKey:firstKey,
      sessionId:capacitySession.id,
      registrationIds:[alpha.id,alphaTwo.id,cancelled.id],
    });
    assert.equal(replay.replayed,true);
    assert.equal(replay.batch.batchId,first.batch.batchId);
    const replayInvitationRows = await sql<Array<{token_hash:string;token_ciphertext:TokenEnvelope}>>`
      SELECT token_hash,token_ciphertext FROM session_invitations
      WHERE session_id=${capacitySession.id}
    `;
    assert.deepEqual([...replayInvitationRows],invitationRows.map((row)=>({
      token_hash:row.token_hash,token_ciphertext:row.token_ciphertext,
    })));

    const overKey=randomUUID();
    await assert.rejects(
      () => createGrant(database,{
        actorId:actor.id,
        idempotencyKey:overKey,
        sessionId:capacitySession.id,
        registrationIds:[beta.id,gamma.id],
      }),
      (error:unknown) =>
        error instanceof GrantError &&
        error.statusCode===409 &&
        error.code==="SESSION_CAPACITY_EXCEEDED" &&
        error.details?.capacity?.seatsRemaining===1,
    );
    const [{over_batches:overBatches}] = await sql<Array<{over_batches:number}>>`
      SELECT count(*)::int AS over_batches
      FROM registration_session_grant_batches
      WHERE actor_id=${actor.id} AND idempotency_key=${overKey}::uuid
    `;
    assert.equal(overBatches,0,"capacity rejection must persist no batch");

    const sql2=openSessionGrantTestDatabase();
    const database2=asDatabase(sql2);
    const raceResults=await Promise.allSettled([
      createGrant(database,{
        actorId:actor.id,idempotencyKey:randomUUID(),
        sessionId:capacitySession.id,registrationIds:[beta.id],
      }),
      createGrant(database2,{
        actorId:actor.id,idempotencyKey:randomUUID(),
        sessionId:capacitySession.id,registrationIds:[gamma.id],
      }),
    ]);
    await sql2.end({timeout:2});
    assert.equal(raceResults.filter((row)=>row.status==="fulfilled").length,1);
    assert.equal(raceResults.filter((row)=>
      row.status==="rejected" &&
      row.reason instanceof GrantError &&
      row.reason.code==="SESSION_CAPACITY_EXCEEDED"
    ).length,1);
    const nowRows=await sql<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
    const finalCapacity=await readInvitationCapacity(database,capacitySession.id,new Date(nowRows[0]!.now));
    assert.equal(finalCapacity.occupiedCount,2);
    assert.equal(finalCapacity.seatsRemaining,0);

    const originalKey=process.env.SESSION_INVITATION_ENCRYPTION_KEY;
    try {
      delete process.env.SESSION_INVITATION_ENCRYPTION_KEY;
      const configKey=randomUUID();
      await assert.rejects(
        () => createGrant(database,{
          actorId:actor.id,idempotencyKey:configKey,
          sessionId:configSession.id,registrationIds:[configReg.id],
        }),
        (error:unknown) =>
          error instanceof GrantError &&
          error.statusCode===503 &&
          error.code==="SESSION_INVITATION_CONFIG_ERROR",
      );
      const [{config_batches:configBatches}] = await sql<Array<{config_batches:number}>>`
        SELECT count(*)::int AS config_batches
        FROM registration_session_grant_batches
        WHERE actor_id=${actor.id} AND idempotency_key=${configKey}::uuid
      `;
      assert.equal(configBatches,0);
    } finally {
      if (originalKey===undefined) delete process.env.SESSION_INVITATION_ENCRYPTION_KEY;
      else process.env.SESSION_INVITATION_ENCRYPTION_KEY=originalKey;
    }

    const sql3=openSessionGrantTestDatabase();
    const database3=asDatabase(sql3);
    const participantRace=await Promise.all([
      createGrant(database,{
        actorId:actor.id,idempotencyKey:randomUUID(),
        sessionId:configSession.id,registrationIds:[configReg.id],
      }),
      createGrant(database3,{
        actorId:actor.id,idempotencyKey:randomUUID(),
        sessionId:configSession.id,registrationIds:[configReg.id],
      }),
    ]);
    await sql3.end({timeout:2});
    assert.deepEqual(
      participantRace.map((row)=>[row.batch.invitedCount,row.batch.skippedCount]).sort(),
      [[0,1],[1,0]].sort(),
    );
    const loser=participantRace.find((row)=>row.batch.skippedCount===1)!;
    assert.equal(loser.batch.results[0]?.reasonCode,"ALREADY_INVITED");
    const [{participant_pending:participantPending,pending_mail:pendingMail}] =
      await sql<Array<{participant_pending:number;pending_mail:number}>>`
        SELECT
          count(DISTINCT si.id)::int AS participant_pending,
          count(*) FILTER (WHERE gi.email_status='pending')::int AS pending_mail
        FROM registration_session_grant_items gi
        JOIN registration_session_grant_batches gb ON gb.id=gi.batch_id
        LEFT JOIN session_invitations si ON si.grant_item_id=gi.id
        WHERE gb.session_id=${configSession.id}
          AND gi.requested_registration_id=${configReg.id}
      `;
    assert.equal(participantPending,1);
    assert.equal(pendingMail,1);
  },
);

test(
  "invitation responses atomically accept decline normalize conflicts and roll back failures",
  { timeout: 90_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();
    const database = asDatabase(sql);
    const unique = `${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
    const actorEmail = `inv-response-${unique}@example.invalid`;
    const eventCode = `INV-RESP-${unique}`;
    let triggerInstalled = false;

    t.after(async () => {
      if (triggerInstalled) {
        await sql.unsafe("DROP TRIGGER IF EXISTS invitation_response_force_failure ON session_invitations");
        await sql.unsafe("DROP FUNCTION IF EXISTS invitation_response_force_failure() CASCADE");
      }
      await sql`DELETE FROM session_invitations WHERE session_id IN (
        SELECT id FROM sessions WHERE session_code=${`INV-RESP-${unique}`}
      )`;
      await sql`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (
        SELECT i.id FROM registration_session_grant_items i
        JOIN registration_session_grant_batches b ON b.id=i.batch_id
        WHERE b.event_id IN (SELECT id FROM events WHERE event_code=${eventCode})
      )`;
      await sql`DELETE FROM registration_session_grant_items WHERE batch_id IN (
        SELECT id FROM registration_session_grant_batches
        WHERE event_id IN (SELECT id FROM events WHERE event_code=${eventCode})
      )`;
      await sql`DELETE FROM registration_session_grant_batches
        WHERE event_id IN (SELECT id FROM events WHERE event_code=${eventCode})`;
      await sql`DELETE FROM registration_sessions WHERE registration_id IN (
        SELECT id FROM registrations WHERE reg_code LIKE ${`INV-RESP-${unique}-%`}
      )`;
      await sql`DELETE FROM registrations WHERE reg_code LIKE ${`INV-RESP-${unique}-%`}`;
      await sql`DELETE FROM users WHERE email=${`inv-response-user-${unique}@example.invalid`}`;
      await sql`DELETE FROM ticket_types WHERE name=${`Invitation Response Ticket ${unique}`}`;
      await sql`DELETE FROM sessions WHERE session_code=${`INV-RESP-${unique}`}`;
      await sql`DELETE FROM events WHERE event_code=${eventCode}`;
      await sql`DELETE FROM backoffice_users WHERE email=${actorEmail}`;
      await sql.end({timeout:2});
    });

    const [actor] = await sql<Array<{id:number}>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${actorEmail},'synthetic','admin','Response','Admin')
      RETURNING id
    `;
    const [event] = await sql<Array<{id:number}>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (
        ${eventCode},'Invitation Response Event','multi_session',
        clock_timestamp(),clock_timestamp()+interval '5 days','published'
      ) RETURNING id
    `;
    const [ticket] = await sql<Array<{id:number}>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (
        ${event.id},'primary','regular',${`Invitation Response Ticket ${unique}`},
        100,'THB',100
      ) RETURNING id
    `;
    const [session] = await sql<Array<{id:number}>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,start_time,end_time,max_capacity,
        is_active,admin_grant_requires_confirmation
      ) VALUES (
        ${event.id},${`INV-RESP-${unique}`},'Invitation Response Session',
        clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',
        20,true,true
      ) RETURNING id
    `;
    const [sharedUser] = await sql<Array<{id:number}>>`
      INSERT INTO users (email,password_hash,role,first_name,last_name,status)
      VALUES (
        ${`inv-response-user-${unique}@example.invalid`},'synthetic','general',
        'Shared','Response','active'
      ) RETURNING id
    `;
    const regs = await sql<Array<{id:number;reg_code:string}>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status
      ) VALUES
        (${`INV-RESP-${unique}-ACCEPT`},${event.id},${ticket.id},NULL,${`accept-${unique}@example.invalid`},'Accept','Person','confirmed'),
        (${`INV-RESP-${unique}-DECLINE`},${event.id},${ticket.id},NULL,${`decline-${unique}@example.invalid`},'Decline','Person','confirmed'),
        (${`INV-RESP-${unique}-RACE`},${event.id},${ticket.id},NULL,${`race-${unique}@example.invalid`},'Race','Person','confirmed'),
        (${`INV-RESP-${unique}-EXPIRE`},${event.id},${ticket.id},NULL,${`expire-${unique}@example.invalid`},'Expire','Person','confirmed'),
        (${`INV-RESP-${unique}-CANCEL`},${event.id},${ticket.id},NULL,${`cancel-${unique}@example.invalid`},'Cancel','Person','confirmed'),
        (${`INV-RESP-${unique}-ROLLBACK`},${event.id},${ticket.id},NULL,${`rollback-${unique}@example.invalid`},'Rollback','Person','confirmed'),
        (${`INV-RESP-${unique}-SIB-TARGET`},${event.id},${ticket.id},${sharedUser.id},${`sib-target-${unique}@example.invalid`},'Sibling','Target','confirmed'),
        (${`INV-RESP-${unique}-SIB-OWNER`},${event.id},${ticket.id},${sharedUser.id},${`sib-owner-${unique}@example.invalid`},'Sibling','Owner','confirmed'),
        (${`INV-RESP-${unique}-EXACT`},${event.id},${ticket.id},NULL,${`exact-${unique}@example.invalid`},'Exact','Person','confirmed'),
        (${`INV-RESP-${unique}-CLOSE`},${event.id},${ticket.id},NULL,${`close-${unique}@example.invalid`},'Close','Person','confirmed')
      RETURNING id,reg_code
    `;
    const bySuffix=(suffix:string)=>regs.find((row)=>row.reg_code.endsWith(suffix))!;
    const key=Buffer.from(process.env.SESSION_INVITATION_ENCRYPTION_KEY ?? "","base64");
    assert.equal(key.length,32);

    async function invite(registrationId:number) {
      const created=await createGrant(database,{
        actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
        registrationIds:[registrationId],
      });
      assert.equal(created.batch.invitedCount,1);
      const [row]=await sql<Array<{
        invitation_id:string;item_id:string;token_ciphertext:TokenEnvelope;
      }>>`
        SELECT si.id AS invitation_id,si.grant_item_id AS item_id,si.token_ciphertext
        FROM session_invitations si
        WHERE si.session_id=${session.id} AND si.registration_id=${registrationId}
          AND si.status='pending'
        ORDER BY si.created_at DESC LIMIT 1
      `;
      return {
        invitationId:row.invitation_id,
        itemId:row.item_id,
        token:decryptInvitationToken(row.invitation_id,row.token_ciphertext,key),
      };
    }

    const acceptReg=bySuffix("-ACCEPT");
    const acceptInvitation=await invite(acceptReg.id);
    const accepted=await respondToInvitation(database,acceptInvitation.token,"accepted");
    assert.equal(accepted.status,"accepted");
    const [acceptedRelation]=await sql<Array<{
      id:number;source:string;ticket_type_id:number|null;added_by:number|null;
    }>>`
      SELECT id,source,ticket_type_id,added_by FROM registration_sessions
      WHERE registration_id=${acceptReg.id} AND session_id=${session.id}
    `;
    assert.equal(acceptedRelation.source,"admin_grant");
    assert.equal(acceptedRelation.ticket_type_id,null);
    assert.equal(acceptedRelation.added_by,actor.id);
    const acceptedReplay=await respondToInvitation(database,acceptInvitation.token,"accepted");
    assert.equal(acceptedReplay.status,"accepted");
    await assert.rejects(
      ()=>respondToInvitation(database,acceptInvitation.token,"declined"),
      (error:unknown)=>error instanceof GrantError && error.code==="RESPONSE_ALREADY_RECORDED",
    );

    const declineReg=bySuffix("-DECLINE");
    const declineInvitation=await invite(declineReg.id);
    const declined=await respondToInvitation(database,declineInvitation.token,"declined");
    assert.equal(declined.status,"declined");
    const [{declined_access:declinedAccess}]=await sql<Array<{declined_access:number}>>`
      SELECT count(*)::int AS declined_access FROM registration_sessions
      WHERE registration_id=${declineReg.id} AND session_id=${session.id}
    `;
    assert.equal(declinedAccess,0);

    const raceReg=bySuffix("-RACE");
    const raceInvitation=await invite(raceReg.id);
    const sql2=openSessionGrantTestDatabase();
    const database2=asDatabase(sql2);
    const raceResponses=await Promise.allSettled([
      respondToInvitation(database,raceInvitation.token,"accepted"),
      respondToInvitation(database2,raceInvitation.token,"declined"),
    ]);
    await sql2.end({timeout:2});
    assert.equal(raceResponses.filter((row)=>row.status==="fulfilled").length,1);
    assert.equal(raceResponses.filter((row)=>
      row.status==="rejected" &&
      row.reason instanceof GrantError &&
      row.reason.code==="RESPONSE_ALREADY_RECORDED"
    ).length,1);
    const [raceStored]=await sql<Array<{status:string}>>`
      SELECT status FROM session_invitations WHERE id=${raceInvitation.invitationId}
    `;
    const [{race_access:raceAccess}]=await sql<Array<{race_access:number}>>`
      SELECT count(*)::int AS race_access FROM registration_sessions
      WHERE registration_id=${raceReg.id} AND session_id=${session.id}
    `;
    assert.equal(raceAccess,raceStored.status==="accepted" ? 1 : 0);

    const expireReg=bySuffix("-EXPIRE");
    const expireInvitation=await invite(expireReg.id);
    await sql`UPDATE session_invitations SET expires_at=clock_timestamp()
      WHERE id=${expireInvitation.invitationId}`;
    await assert.rejects(
      ()=>respondToInvitation(database,expireInvitation.token,"accepted"),
      (error:unknown)=>error instanceof GrantError && error.code==="INVITATION_EXPIRED",
    );
    const [expiredStored]=await sql<Array<{status:string;token_ciphertext:unknown;responded_at:Date|null}>>`
      SELECT status,token_ciphertext,responded_at FROM session_invitations
      WHERE id=${expireInvitation.invitationId}
    `;
    assert.equal(expiredStored.status,"expired");
    assert.equal(expiredStored.token_ciphertext,null);
    assert.equal(expiredStored.responded_at,null);

    const cancelReg=bySuffix("-CANCEL");
    const cancelInvitation=await invite(cancelReg.id);
    await sql`UPDATE registrations SET status='cancelled' WHERE id=${cancelReg.id}`;
    await assert.rejects(
      ()=>respondToInvitation(database,cancelInvitation.token,"accepted"),
      (error:unknown)=>error instanceof GrantError && error.code==="REGISTRATION_NOT_CONFIRMED",
    );
    const [cancelStored]=await sql<Array<{status:string;token_ciphertext:unknown}>>`
      SELECT status,token_ciphertext FROM session_invitations
      WHERE id=${cancelInvitation.invitationId}
    `;
    assert.equal(cancelStored.status,"revoked");
    assert.equal(cancelStored.token_ciphertext,null);

    const rollbackReg=bySuffix("-ROLLBACK");
    const rollbackInvitation=await invite(rollbackReg.id);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION invitation_response_force_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${rollbackInvitation.invitationId}'::uuid AND NEW.status = 'accepted' THEN
          RAISE EXCEPTION 'forced invitation response update failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER invitation_response_force_failure
      BEFORE UPDATE ON session_invitations
      FOR EACH ROW EXECUTE FUNCTION invitation_response_force_failure();
    `);
    triggerInstalled=true;
    await assert.rejects(
      ()=>respondToInvitation(database,rollbackInvitation.token,"accepted"),
      /forced invitation response update failure/i,
    );
    await sql.unsafe("DROP TRIGGER invitation_response_force_failure ON session_invitations");
    await sql.unsafe("DROP FUNCTION invitation_response_force_failure() CASCADE");
    triggerInstalled=false;
    const [{rollback_access:rollbackAccess}]=await sql<Array<{rollback_access:number}>>`
      SELECT count(*)::int AS rollback_access FROM registration_sessions
      WHERE registration_id=${rollbackReg.id} AND session_id=${session.id}
    `;
    const [rollbackStored]=await sql<Array<{status:string;token_ciphertext:unknown}>>`
      SELECT status,token_ciphertext FROM session_invitations
      WHERE id=${rollbackInvitation.invitationId}
    `;
    assert.equal(rollbackAccess,0);
    assert.equal(rollbackStored.status,"pending");
    assert.ok(rollbackStored.token_ciphertext);

    const siblingTarget=bySuffix("-SIB-TARGET");
    const siblingOwner=bySuffix("-SIB-OWNER");
    const siblingInvitation=await invite(siblingTarget.id);
    await sql`
      INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
      VALUES (${siblingOwner.id},${session.id},${ticket.id},'purchase')
    `;
    await assert.rejects(
      ()=>respondToInvitation(database,siblingInvitation.token,"accepted"),
      (error:unknown)=>
        error instanceof GrantError &&
        error.code==="PARTICIPANT_ALREADY_REGISTERED",
    );
    const [siblingStored]=await sql<Array<{status:string;token_ciphertext:unknown}>>`
      SELECT status,token_ciphertext FROM session_invitations
      WHERE id=${siblingInvitation.invitationId}
    `;
    assert.equal(siblingStored.status,"revoked");
    assert.equal(siblingStored.token_ciphertext,null);

    const exactReg=bySuffix("-EXACT");
    const exactInvitation=await invite(exactReg.id);
    const [existingExact]=await sql<Array<{id:number}>>`
      INSERT INTO registration_sessions (
        registration_id,session_id,ticket_type_id,checked_in_at,source,added_note
      ) VALUES (
        ${exactReg.id},${session.id},${ticket.id},clock_timestamp(),'purchase','preserve-me'
      ) RETURNING id
    `;
    const exactAccepted=await respondToInvitation(database,exactInvitation.token,"accepted");
    assert.equal(exactAccepted.status,"accepted");
    const [exactStored]=await sql<Array<{
      id:number;ticket_type_id:number|null;source:string;added_note:string|null;
    }>>`
      SELECT id,ticket_type_id,source,added_note FROM registration_sessions
      WHERE registration_id=${exactReg.id} AND session_id=${session.id}
    `;
    assert.equal(exactStored.id,existingExact.id);
    assert.equal(exactStored.ticket_type_id,ticket.id);
    assert.equal(exactStored.source,"purchase");
    assert.equal(exactStored.added_note,"preserve-me");

    const closeReg=bySuffix("-CLOSE");
    const closeInvitation=await invite(closeReg.id);
    await sql`UPDATE registrations SET status='cancelled' WHERE id=${closeReg.id}`;
    const closedCount=await closeInactiveInvitations(database,session.id);
    assert.ok(closedCount>=1);
    const [closedStored]=await sql<Array<{status:string;token_ciphertext:unknown}>>`
      SELECT status,token_ciphertext FROM session_invitations
      WHERE id=${closeInvitation.invitationId}
    `;
    assert.equal(closedStored.status,"revoked");
    assert.equal(closedStored.token_ciphertext,null);
  },
);
