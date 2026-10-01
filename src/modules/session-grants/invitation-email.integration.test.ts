import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import {
  createGrant,
} from "./service.js";
import {
  closeInactiveInvitationBatch,
  retryGrantEmails,
  runGrantEmailsOnce,
} from "./email-jobs.js";
import {
  decryptInvitationToken,
} from "./invitation-token.js";
import {
  respondToInvitation,
} from "./invitations.js";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";
import type {
  GrantDatabase,
  TokenEnvelope,
} from "./types.js";

function asDatabase(
  client: ReturnType<typeof openSessionGrantTestDatabase>,
): GrantDatabase {
  return drizzle(client, { schema }) as GrantDatabase;
}

function failedTransport() {
  return Object.assign(new Error("synthetic pre-send failure"), {
    code: "SYNTHETIC_PRE_SEND",
    deliveryState: "failed" as const,
  });
}

function invitationUrl(html: string): string {
  const match = /href="([^"]+)"/.exec(html);
  assert.ok(match?.[1], "invitation email must contain one response link");
  return match[1].replaceAll("&amp;", "&");
}

before(async () => {
  const sql = openSessionGrantTestDatabase();
  try {
    await sql.unsafe(await readFile(new URL("../../../review/session-invitations-test-harness-prerequisites.sql", import.meta.url), "utf8"));
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test(
  "invitation mail sends without entitlement and retry keeps the original credential while closed invitations suppress",
  { timeout: 90_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();
    const database = asDatabase(sql);
    const unique = `${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
    const actorEmail = `inv-mail-admin-${unique}@example.invalid`;
    const eventCode = `INV-MAIL-${unique}`;

    const [actor] = await sql<Array<{id:number}>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name)
      VALUES (${actorEmail},'synthetic','admin','Invitation Mail','Admin')
      RETURNING id
    `;
    const [event] = await sql<Array<{id:number}>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status,website_url)
      VALUES (
        ${eventCode},'Invitation Mail Event','multi_session',
        clock_timestamp(),clock_timestamp()+interval '5 days','published','http://localhost:3004'
      ) RETURNING id
    `;
    const [ticket] = await sql<Array<{id:number}>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (
        ${event.id},'primary','regular',${`Invitation Mail Ticket ${unique}`},
        100,'THB',20
      ) RETURNING id
    `;
    const [session] = await sql<Array<{id:number}>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,start_time,end_time,room,
        max_capacity,is_active,admin_grant_requires_confirmation
      ) VALUES (
        ${event.id},${`INV-MAIL-${unique}`},'Policy Innovation Workshop','workshop',
        clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 4 hours',
        'Synthetic Room',20,true,true
      ) RETURNING id
    `;
    const registrations = await sql<Array<{id:number;reg_code:string}>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,email,first_name,last_name,status
      ) VALUES
        (${`INV-MAIL-${unique}-RETRY`},${event.id},${ticket.id},${`retry-${unique}@example.invalid`},'Retry','Recipient','confirmed'),
        (${`INV-MAIL-${unique}-DECLINE`},${event.id},${ticket.id},${`decline-${unique}@example.invalid`},'Decline','Recipient','confirmed'),
        (${`INV-MAIL-${unique}-KEY`},${event.id},${ticket.id},${`key-${unique}@example.invalid`},'Key','Recipient','confirmed'),
        (${`INV-MAIL-${unique}-UNKNOWN`},${event.id},${ticket.id},${`unknown-${unique}@example.invalid`},'Unknown','Recipient','confirmed'),
        (${`INV-MAIL-${unique}-RESTART`},${event.id},${ticket.id},${`restart-${unique}@example.invalid`},'Restart','Recipient','confirmed'),
        (${`INV-MAIL-${unique}-BLOCKED`},${event.id},${ticket.id},${`blocked-${unique}@example.invalid`},'Blocked','Recipient','confirmed'),
        (${`INV-MAIL-${unique}-CLEANUP`},${event.id},${ticket.id},${`cleanup-${unique}@example.invalid`},'Cleanup','Recipient','confirmed')
      RETURNING id,reg_code
    `;

    t.after(async () => {
      await sql`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (
        SELECT gi.id FROM registration_session_grant_items gi
        JOIN registration_session_grant_batches gb ON gb.id=gi.batch_id
        WHERE gb.event_id=${event.id}
      )`;
      await sql`DELETE FROM session_invitations WHERE session_id=${session.id}`;
      await sql`DELETE FROM registration_session_grant_items WHERE batch_id IN (
        SELECT id FROM registration_session_grant_batches WHERE event_id=${event.id}
      )`;
      await sql`DELETE FROM registration_session_grant_batches WHERE event_id=${event.id}`;
      await sql`DELETE FROM registration_sessions WHERE registration_id IN (
        SELECT id FROM registrations WHERE event_id=${event.id}
      )`;
      await sql`DELETE FROM registrations WHERE event_id=${event.id}`;
      await sql`DELETE FROM ticket_types WHERE id=${ticket.id}`;
      await sql`DELETE FROM sessions WHERE id=${session.id}`;
      await sql`DELETE FROM events WHERE id=${event.id}`;
      await sql`DELETE FROM backoffice_users WHERE id=${actor.id}`;
      await sql.end({timeout:2});
    });

    for (const [index, origin] of [undefined, null, 17, { value: "https://pris.example.test" },
      "https://pris.example.test/private-origin", "https://user:private@pris.example.test", "https://pris.example.test/?private=query"].entries()) {
      await t.test(`invalid snapshot origin case ${index} fails safely without delivery or credential mutation`, async () => {
        const [registration] = await sql<Array<{ id: number }>>`
          INSERT INTO registrations (reg_code,event_id,ticket_type_id,email,first_name,last_name,status)
          VALUES (${`INV-MAIL-${unique}-INVALID-${index}`},${event.id},${ticket.id},
            ${`invalid-${unique}-${index}@example.invalid`},'Invalid','Origin','confirmed') RETURNING id
        `;
        const batch = await createGrant(database, { actorId: actor.id, idempotencyKey: randomUUID(),
          sessionId: session.id, registrationIds: [registration.id] });
        const itemId = batch.batch.results[0]!.id;
        await sql`UPDATE registration_session_grant_items SET notification_snapshot=
          (notification_snapshot - 'responseOrigin') || ${JSON.stringify(origin === undefined ? {} : { responseOrigin: origin })}::jsonb
          WHERE id=${itemId}::uuid`;
        const credential = async () => {
          const [row] = await sql`
            SELECT token_hash,token_ciphertext,expires_at,status FROM session_invitations WHERE grant_item_id=${itemId}::uuid
          `;
          return JSON.stringify(row);
        };
        const before = await credential();
        let sends = 0;
        await runGrantEmailsOnce(database, { async send() { sends += 1; return {}; } }, new Date());
        assert.equal(sends, 0);
        assert.equal((await credential()) === before, true, "invalid snapshot must preserve credentials/deadline");
        const [state] = await sql`
          SELECT gi.email_status,gi.last_error_code,gi.claim_token,gi.claimed_until,a.error_message
          FROM registration_session_grant_items gi JOIN registration_session_grant_email_attempts a ON a.item_id=gi.id
          WHERE gi.id=${itemId}::uuid ORDER BY a.attempt_no DESC LIMIT 1
        `;
        assert.equal(state.email_status, "failed");
        assert.equal(state.last_error_code, "SESSION_INVITATION_CONFIG_ERROR");
        assert.equal(state.claim_token, null);
        assert.equal(state.claimed_until, null);
        assert.equal(String(state.error_message).includes("private"), false);
        assert.equal(String(state.error_message).includes("pris.example.test"), false);
      });
    }

    const retryBatch = await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[0]!.id],
    });
    const retryItem = retryBatch.batch.results[0]!;
    assert.equal(retryItem.outcome,"invited");
    assert.equal(retryItem.registrationSessionId,null);

    await sql`UPDATE events SET website_url='http://127.0.0.1:3004' WHERE id=${event.id}`;

    let firstHtml = "";
    const firstRun = await runGrantEmailsOnce(database,{
      async send(input) {
        firstHtml=input.html;
        assert.match(input.subject,/คำเชิญเข้าร่วมเซสชัน/);
        assert.match(input.html,/ตอบรับคำเชิญเข้าร่วม Session/);
        assert.match(input.html,/สิทธิ์เข้าร่วมจะเริ่มใช้งานหลังจากคุณยืนยันเข้าร่วม/);
        throw failedTransport();
      },
    },new Date());
    if (firstRun.claimed !== 1) {
      const [diagnostic] = await sql<Array<{
        email_status:string; last_error_code:string|null;
        attempt_error_code:string|null; attempt_error_message:string|null;
      }>>`
        SELECT gi.email_status,gi.last_error_code,
          (
            SELECT a.error_code
            FROM registration_session_grant_email_attempts a
            WHERE a.item_id=gi.id
            ORDER BY a.attempt_no DESC
            LIMIT 1
          ) AS attempt_error_code,
          (
            SELECT a.error_message
            FROM registration_session_grant_email_attempts a
            WHERE a.item_id=gi.id
            ORDER BY a.attempt_no DESC
            LIMIT 1
          ) AS attempt_error_message
        FROM registration_session_grant_items gi
        WHERE gi.id=${retryItem.id}::uuid
      `;
      assert.fail(
        `invitation mail was not claimed: ${JSON.stringify(diagnostic)}`,
      );
    }
    assert.equal(firstRun.failed,1);
    const firstUrl=invitationUrl(firstHtml);
    assert.equal(new URL(firstUrl).origin, "http://localhost:3004");
    assert.equal(new URL(firstUrl).pathname, "/th/sessions/confirm");
    const firstToken=new URL(firstUrl).searchParams.get("token");
    assert.ok(firstToken);
    const [storedRetryInvitation]=await sql<Array<{
      token_hash:string;status:string;token_ciphertext:TokenEnvelope;expires_at:Date;
    }>>`
      SELECT token_hash,status,token_ciphertext,expires_at
      FROM session_invitations
      WHERE grant_item_id=${retryItem.id}::uuid
    `;
    assert.equal(storedRetryInvitation.status,"pending");
    assert.equal(
      storedRetryInvitation.token_hash,
      createHash("sha256").update(firstToken!).digest("hex"),
    );

    await sql`UPDATE events SET website_url='http://[::1]:3004/' WHERE id=${event.id}`;
    const retryResult=await retryGrantEmails(database,{
      actorId:actor.id,batchId:retryBatch.batch.batchId,itemIds:[retryItem.id],
      acknowledgeUnknown:false,
    });
    assert.deepEqual(retryResult.queued,[retryItem.id]);
    let retryHtml="";
    const secondRun=await runGrantEmailsOnce(database,{
      async send(input) {
        retryHtml=input.html;
        return {providerMessageId:"synthetic-invitation"};
      },
    },new Date());
    assert.equal(secondRun.sent,1);
    assert.equal(invitationUrl(retryHtml) === firstUrl, true, "retry must preserve response URL without logging credential");
    assert.equal(retryHtml === firstHtml, true, "retry must preserve snapshotted deadline and content");
    const [retryAfter] = await sql`
      SELECT token_hash,status,token_ciphertext,expires_at FROM session_invitations WHERE grant_item_id=${retryItem.id}::uuid
    `;
    assert.equal(JSON.stringify(retryAfter) === JSON.stringify(storedRetryInvitation), true);

    const [newRegistration] = await sql<Array<{ id: number }>>`
      INSERT INTO registrations (reg_code,event_id,ticket_type_id,email,first_name,last_name,status)
      VALUES (${`INV-MAIL-${unique}-NEW`},${event.id},${ticket.id},${`new-${unique}@example.invalid`},'New','Origin','confirmed') RETURNING id
    `;
    const newBatch = await createGrant(database, { actorId: actor.id, idempotencyKey: randomUUID(), sessionId: session.id,
      registrationIds: [newRegistration.id] });
    let newOrigin = "";
    let newToken = "";
    const newRun = await runGrantEmailsOnce(database, { async send(input) {
      const url = new URL(invitationUrl(input.html));
      newOrigin = url.origin;
      newToken = url.searchParams.get("token")!;
      return {};
    } }, new Date());
    assert.equal(newRun.sent, 1);
    assert.equal(newOrigin, "http://[::1]:3004");
    await respondToInvitation(database, newToken, "accepted");
    await sql`UPDATE registration_session_grant_items SET email_status='pending'
      WHERE id=${newBatch.batch.results[0]!.id}::uuid`;
    let acceptedSends = 0;
    const acceptedRun = await runGrantEmailsOnce(database, { async send() { acceptedSends += 1; return {}; } }, new Date());
    assert.equal(acceptedRun.suppressed, 1);
    assert.equal(acceptedSends, 0);
    await sql`UPDATE session_invitations SET expires_at=clock_timestamp()-interval '1 minute'
      WHERE grant_item_id=${retryItem.id}::uuid`;
    await sql`UPDATE registration_session_grant_items SET email_status='pending' WHERE id=${retryItem.id}::uuid`;
    let expiredSends = 0;
    const expiredRun = await runGrantEmailsOnce(database, { async send() { expiredSends += 1; return {}; } }, new Date());
    assert.equal(expiredRun.suppressed, 1);
    assert.equal(expiredSends, 0);

    const declineBatch=await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[1]!.id],
    });
    const declineItem=declineBatch.batch.results[0]!;
    const [declineInvitation]=await sql<Array<{
      id:string;token_ciphertext:TokenEnvelope;
    }>>`
      SELECT id,token_ciphertext FROM session_invitations
      WHERE grant_item_id=${declineItem.id}::uuid
    `;
    const configuredKey=Buffer.from(process.env.SESSION_INVITATION_ENCRYPTION_KEY ?? "","base64");
    const declineToken=decryptInvitationToken(
      declineInvitation.id,declineInvitation.token_ciphertext,configuredKey,
    );
    await respondToInvitation(database,declineToken,"declined");
    let closedSendCalls=0;
    const closedRun=await runGrantEmailsOnce(database,{
      async send(){closedSendCalls+=1;return{};},
    },new Date());
    assert.equal(closedRun.suppressed,1);
    assert.equal(closedSendCalls,0);

    const keyBatch=await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[2]!.id],
    });
    const keyItem=keyBatch.batch.results[0]!;
    const originalKey=process.env.SESSION_INVITATION_ENCRYPTION_KEY;
    try {
      delete process.env.SESSION_INVITATION_ENCRYPTION_KEY;
      let missingKeySends = 0;
      await runGrantEmailsOnce(database, { async send() { missingKeySends += 1; return {}; } }, new Date());
      assert.equal(missingKeySends, 0);
      const [missingKeyState] = await sql`
        SELECT email_status,last_error_code FROM registration_session_grant_items WHERE id=${keyItem.id}::uuid
      `;
      assert.equal(missingKeyState.email_status, "failed");
      assert.equal(missingKeyState.last_error_code, "SESSION_INVITATION_CONFIG_ERROR");
      await retryGrantEmails(database, { actorId: actor.id, batchId: keyBatch.batch.batchId,
        itemIds: [keyItem.id], acknowledgeUnknown: false });
      process.env.SESSION_INVITATION_ENCRYPTION_KEY=Buffer.alloc(32,9).toString("base64");
      let keySendCalls=0;
      await runGrantEmailsOnce(database,{
        async send(){keySendCalls+=1;return{};},
      },new Date());
      assert.equal(keySendCalls,0);
    } finally {
      if(originalKey===undefined) delete process.env.SESSION_INVITATION_ENCRYPTION_KEY;
      else process.env.SESSION_INVITATION_ENCRYPTION_KEY=originalKey;
    }
    const [keyState]=await sql<Array<{
      email_status:string;status:string;token_ciphertext:TokenEnvelope|null;
    }>>`
      SELECT gi.email_status,si.status,si.token_ciphertext
      FROM registration_session_grant_items gi
      JOIN session_invitations si ON si.grant_item_id=gi.id
      WHERE gi.id=${keyItem.id}::uuid
    `;
    assert.equal(keyState.email_status,"failed");
    assert.equal(keyState.status,"pending");
    assert.ok(keyState.token_ciphertext);

    const unknownBatch=await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[3]!.id],
    });
    const unknownItem=unknownBatch.batch.results[0]!;
    const [unknownBefore]=await sql<Array<{
      token_hash:string;expires_at:Date;
    }>>`
      SELECT token_hash,expires_at
      FROM session_invitations
      WHERE grant_item_id=${unknownItem.id}::uuid
    `;
    let unknownFirstHtml="";
    const unknownRun=await runGrantEmailsOnce(database,{
      async send(input){
        unknownFirstHtml=input.html;
        throw Object.assign(new Error("synthetic ambiguous delivery"),{
          code:"SYNTHETIC_UNKNOWN",
          deliveryState:"unknown" as const,
        });
      },
    },new Date());
    assert.equal(unknownRun.unknown,1);
    const unknownNoAck=await retryGrantEmails(database,{
      actorId:actor.id,batchId:unknownBatch.batch.batchId,
      itemIds:[unknownItem.id],acknowledgeUnknown:false,
    });
    assert.deepEqual(unknownNoAck.queued,[]);
    assert.deepEqual(unknownNoAck.skipped,[
      {itemId:unknownItem.id,reasonCode:"UNKNOWN_ACK_REQUIRED"},
    ]);
    const unknownAck=await retryGrantEmails(database,{
      actorId:actor.id,batchId:unknownBatch.batch.batchId,
      itemIds:[unknownItem.id],acknowledgeUnknown:true,
    });
    assert.deepEqual(unknownAck.queued,[unknownItem.id]);
    let unknownRetryHtml="";
    const unknownRetryRun=await runGrantEmailsOnce(database,{
      async send(input){
        unknownRetryHtml=input.html;
        return {providerMessageId:"synthetic-unknown-retry"};
      },
    },new Date());
    assert.equal(unknownRetryRun.sent,1);
    assert.equal(
      invitationUrl(unknownRetryHtml),
      invitationUrl(unknownFirstHtml),
    );
    const [unknownAfter]=await sql<Array<{
      token_hash:string;expires_at:Date;
    }>>`
      SELECT token_hash,expires_at
      FROM session_invitations
      WHERE grant_item_id=${unknownItem.id}::uuid
    `;
    assert.equal(unknownAfter.token_hash,unknownBefore.token_hash);
    assert.equal(
      new Date(unknownAfter.expires_at).getTime(),
      new Date(unknownBefore.expires_at).getTime(),
    );

    const restartBatch=await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[4]!.id],
    });
    const restartItem=restartBatch.batch.results[0]!;
    const [restartBefore]=await sql<Array<{token_hash:string}>>`
      SELECT token_hash
      FROM session_invitations
      WHERE grant_item_id=${restartItem.id}::uuid
    `;
    const restartClaim=randomUUID();
    await sql`
      UPDATE registration_session_grant_items
      SET email_status='sending',attempt_count=1,
        claim_token=${restartClaim}::uuid,
        claimed_until=clock_timestamp()-interval '1 minute'
      WHERE id=${restartItem.id}::uuid
    `;
    await sql`
      INSERT INTO registration_session_grant_email_attempts (
        id,item_id,attempt_no,claim_token,trigger,recipient_email,
        template_version,subject_snapshot,result,started_at
      ) VALUES (
        ${randomUUID()}::uuid,${restartItem.id}::uuid,1,
        ${restartClaim}::uuid,'system',
        ${`restart-${unique}@example.invalid`},
        'session-invitation-v1','ก่อนส่งคำเชิญ','sending',
        clock_timestamp()-interval '2 minutes'
      )
    `;
    const restartRun=await runGrantEmailsOnce(database,{
      async send(){return {providerMessageId:"synthetic-restart"};},
    },new Date());
    assert.equal(restartRun.claimed,1);
    assert.equal(restartRun.sent,1);
    const restartAttempts=await sql<Array<{
      attempt_no:number;result:string;error_code:string|null;
    }>>`
      SELECT attempt_no,result,error_code
      FROM registration_session_grant_email_attempts
      WHERE item_id=${restartItem.id}::uuid
      ORDER BY attempt_no
    `;
    assert.deepEqual(
      restartAttempts.map((row)=>[
        row.attempt_no,row.result,row.error_code,
      ]),
      [
        [1,"failed","PRE_SEND_WORKER_INTERRUPTED"],
        [2,"sent",null],
      ],
    );
    const [restartAfter]=await sql<Array<{token_hash:string}>>`
      SELECT token_hash
      FROM session_invitations
      WHERE grant_item_id=${restartItem.id}::uuid
    `;
    assert.equal(restartAfter.token_hash,restartBefore.token_hash);

    const blockedBatch=await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[5]!.id],
    });
    const blockedItem=blockedBatch.batch.results[0]!;
    const [blockedInvitation]=await sql<Array<{
      id:string;token_ciphertext:TokenEnvelope;
    }>>`
      SELECT id,token_ciphertext
      FROM session_invitations
      WHERE grant_item_id=${blockedItem.id}::uuid
    `;
    const blockedToken=decryptInvitationToken(
      blockedInvitation.id,
      blockedInvitation.token_ciphertext,
      configuredKey,
    );
    const blockedRun=await runGrantEmailsOnce(database,{
      async send(){
        await respondToInvitation(
          database,
          blockedToken,
          "declined",
        );
        return {providerMessageId:"synthetic-after-decline"};
      },
    },new Date());
    assert.equal(blockedRun.sent,1);
    const [blockedState]=await sql<Array<{
      status:string;entitlement_count:number;
    }>>`
      SELECT si.status,
        (
          SELECT count(*)::int
          FROM registration_sessions rs
          WHERE rs.registration_id=${registrations[5]!.id}
            AND rs.session_id=${session.id}
        ) AS entitlement_count
      FROM session_invitations si
      WHERE si.id=${blockedInvitation.id}::uuid
    `;
    assert.equal(blockedState.status,"declined");
    assert.equal(blockedState.entitlement_count,0);

    const cleanupBatch=await createGrant(database,{
      actorId:actor.id,idempotencyKey:randomUUID(),sessionId:session.id,
      registrationIds:[registrations[6]!.id],
    });
    const cleanupItem=cleanupBatch.batch.results[0]!;
    await sql`
      UPDATE registrations
      SET status='cancelled'
      WHERE id=${registrations[6]!.id}
    `;
    const cleanup=await closeInactiveInvitationBatch(database,10);
    assert.ok(cleanup.sessionsInspected>=1);
    assert.ok(cleanup.invitationsClosed>=1);
    const [cleanupState]=await sql<Array<{
      status:string;token_ciphertext:TokenEnvelope|null;
    }>>`
      SELECT status,token_ciphertext
      FROM session_invitations
      WHERE grant_item_id=${cleanupItem.id}::uuid
    `;
    assert.equal(cleanupState.status,"revoked");
    assert.equal(cleanupState.token_ciphertext,null);
    let cleanupSendCalls=0;
    const cleanupRun=await runGrantEmailsOnce(database,{
      async send(){cleanupSendCalls+=1;return{};},
    },new Date());
    assert.equal(cleanupRun.suppressed,1);
    assert.equal(cleanupSendCalls,0);
  },
);
