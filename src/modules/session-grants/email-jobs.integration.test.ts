import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { getGrantMailBacklogHealth, retryGrantEmails, runGrantEmailsOnce } from "./email-jobs.js";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";
import type { GrantDatabase } from "./types.js";

function asDatabase(client: ReturnType<typeof openSessionGrantTestDatabase>): GrantDatabase {
  return drizzle(client, { schema }) as GrantDatabase;
}

function transportError(code: string, deliveryState: "failed" | "unknown") {
  return Object.assign(new Error(code), { code, deliveryState });
}

test("durable grant mail lifecycle records attempts, ambiguity, suppression, recovery, and controlled retry", { timeout: 90_000 }, async (t) => {
  validateSessionGrantTestDatabaseUrl();
  const sql = openSessionGrantTestDatabase();
  const database = asDatabase(sql);
  const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const now = new Date("2026-10-01T10:00:00.000Z");

  const [actor] = await sql<Array<{ id: number }>>`
    INSERT INTO backoffice_users (email, password_hash, role, first_name, last_name)
    VALUES (${`mail-admin-${unique}@example.invalid`}, 'x', 'admin', 'Mail', 'Admin')
    RETURNING id
  `;
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code, event_name, event_type, start_date, end_date, status)
    VALUES (${`SG-MAIL-${unique}`}, 'Mail Event', 'multi_session', '2026-10-01', '2099-10-02', 'published')
    RETURNING id
  `;
  const [session] = await sql<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, session_code, session_name, session_type, start_time, end_time, room, is_active)
    VALUES (${event.id}, ${`SG-MAIL-SESSION-${unique}`}, 'Mail Session', 'workshop', '2026-10-01 09:00:00', '2099-10-01 12:00:00', 'A1', true)
    RETURNING id
  `;
  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota)
    VALUES (${event.id}, 'primary', 'regular', 'Mail Primary', 1000, 'THB', 100)
    RETURNING id
  `;
  const registrations = await sql<Array<{ id: number; reg_code: string; email: string }>>`
    INSERT INTO registrations (reg_code, event_id, ticket_type_id, email, first_name, last_name, status)
    VALUES
      (${`SG-MAIL-1-${unique}`}, ${event.id}, ${ticket.id}, ${`mail1-${unique}@example.invalid`}, 'Mail', 'One', 'confirmed'),
      (${`SG-MAIL-2-${unique}`}, ${event.id}, ${ticket.id}, ${`mail2-${unique}@example.invalid`}, 'Mail', 'Two', 'confirmed'),
      (${`SG-MAIL-3-${unique}`}, ${event.id}, ${ticket.id}, ${`mail3-${unique}@example.invalid`}, 'Mail', 'Three', 'confirmed'),
      (${`SG-MAIL-4-${unique}`}, ${event.id}, ${ticket.id}, ${`mail4-${unique}@example.invalid`}, 'Mail', 'Four', 'confirmed'),
      (${`SG-MAIL-5-${unique}`}, ${event.id}, ${ticket.id}, ${`mail5-${unique}@example.invalid`}, 'Mail', 'Five', 'confirmed'),
      (${`SG-MAIL-6-${unique}`}, ${event.id}, ${ticket.id}, ${`mail6-${unique}@example.invalid`}, 'Mail', 'Six', 'confirmed')
    RETURNING id, reg_code, email
  `;
  const links = await sql<Array<{ id: number; registration_id: number }>>`
    INSERT INTO registration_sessions (registration_id, session_id, ticket_type_id, source, added_by)
    SELECT id, ${session.id}, NULL, 'admin_grant', ${actor.id}
    FROM registrations
    WHERE id IN (${registrations[0]!.id}, ${registrations[1]!.id}, ${registrations[2]!.id}, ${registrations[3]!.id}, ${registrations[4]!.id}, ${registrations[5]!.id})
    ORDER BY id
    RETURNING id, registration_id
  `;
  const linkByRegistration = new Map(links.map((row) => [row.registration_id, row.id]));
  const batchId = randomUUID();
  await sql`
    INSERT INTO registration_session_grant_batches (
      id, actor_id, actor_name_snapshot, idempotency_key, request_hash,
      session_id, event_id, session_name_snapshot, requested_count,
      added_count, skipped_count, completed_at
    ) VALUES (
      ${batchId}::uuid, ${actor.id}, 'Mail Admin', ${randomUUID()}::uuid,
      ${"a".repeat(64)}, ${session.id}, ${event.id}, 'Mail Session', 6, 6, 0, ${now.toISOString()}
    )
  `;

  const itemIds = registrations.map(() => randomUUID());
  for (let index = 0; index < registrations.length; index += 1) {
    const registration = registrations[index]!;
    await sql`
      INSERT INTO registration_session_grant_items (
        id, batch_id, requested_registration_id, registration_session_id,
        reg_code_snapshot, name_snapshot, outcome, reason_code,
        recipient_email_snapshot, notification_snapshot, email_status,
        attempt_count, next_trigger, created_at
      ) VALUES (
        ${itemIds[index]}::uuid, ${batchId}::uuid, ${registration.id}, ${linkByRegistration.get(registration.id)!},
        ${registration.reg_code}, ${`Mail ${index + 1}`}, 'added', NULL,
        ${registration.email}, ${JSON.stringify({
          personName: `Mail ${index + 1}`,
          regCode: registration.reg_code,
          eventName: "Mail Event",
          eventShortName: "Mail Event",
          eventDates: "1–2 ตุลาคม 2569",
          eventVenue: "ไม่ระบุ",
          sessionName: "Mail Session",
          sessionType: "workshop",
          startTime: "2026-10-01T02:00:00.000Z",
          endTime: "2099-10-01T05:00:00.000Z",
          room: "A1",
          participantUrl: "https://conference.example.com/profile",
        })}::jsonb,
        ${index === 0 ? "pending" : "failed"}, 0, 'system', ${new Date(now.getTime() + index * 1000).toISOString()}
      )
    `;
  }

  t.after(async () => {
    await sql`DELETE FROM registration_session_grant_email_attempts WHERE item_id IN (${itemIds[0]}::uuid, ${itemIds[1]}::uuid, ${itemIds[2]}::uuid, ${itemIds[3]}::uuid, ${itemIds[4]}::uuid, ${itemIds[5]}::uuid)`;
    await sql`DELETE FROM registration_session_grant_items WHERE batch_id = ${batchId}::uuid`;
    await sql`DELETE FROM registration_session_grant_batches WHERE id = ${batchId}::uuid`;
    await sql`DELETE FROM registration_sessions WHERE registration_id IN (${registrations[0]!.id}, ${registrations[1]!.id}, ${registrations[2]!.id}, ${registrations[3]!.id}, ${registrations[4]!.id}, ${registrations[5]!.id})`;
    await sql`DELETE FROM registrations WHERE event_id = ${event.id}`;
    await sql`DELETE FROM ticket_types WHERE id = ${ticket.id}`;
    await sql`DELETE FROM sessions WHERE id = ${session.id}`;
    await sql`DELETE FROM events WHERE id = ${event.id}`;
    await sql`DELETE FROM backoffice_users WHERE id = ${actor.id}`;
    await sql.end({ timeout: 2 });
  });

  let sentCalls = 0;
  const sent = await runGrantEmailsOnce(database, {
    async send(input) {
      sentCalls += 1;
      assert.match(input.subject, /เพิ่มสิทธิ์เข้าร่วมเซสชัน/);
      assert.match(input.html, /รหัสลงทะเบียน/);
      return { providerMessageId: "provider-1" };
    },
  }, now);
  assert.deepEqual(sent, { claimed: 1, sent: 1, failed: 0, unknown: 0, suppressed: 0 });
  assert.equal(sentCalls, 1);
  const [sentAttempt] = await sql<Array<{ result: string; request_started_at: Date | null; provider_message_id: string | null }>>`
    SELECT result, request_started_at, provider_message_id
    FROM registration_session_grant_email_attempts WHERE item_id = ${itemIds[0]}::uuid
  `;
  assert.equal(sentAttempt.result, "sent");
  assert.ok(sentAttempt.request_started_at);
  assert.equal(sentAttempt.provider_message_id, "provider-1");

  await sql`UPDATE registration_session_grant_items SET email_status = 'pending' WHERE id = ${itemIds[1]}::uuid`;
  const failed = await runGrantEmailsOnce(database, {
    async send() { throw transportError("TEST_REJECTED", "failed"); },
  }, new Date(now.getTime() + 10_000));
  assert.equal(failed.failed, 1);
  const [failedItem] = await sql<Array<{ email_status: string; last_error_code: string | null }>>`
    SELECT email_status, last_error_code FROM registration_session_grant_items WHERE id = ${itemIds[1]}::uuid
  `;
  assert.equal(failedItem.email_status, "failed");
  assert.equal(failedItem.last_error_code, "TEST_REJECTED");

  await sql`UPDATE registration_session_grant_items SET email_status = 'pending' WHERE id = ${itemIds[2]}::uuid`;
  const unknown = await runGrantEmailsOnce(database, {
    async send() { throw transportError("TEST_TIMEOUT", "unknown"); },
  }, new Date(now.getTime() + 20_000));
  assert.equal(unknown.unknown, 1);
  const [unknownItem] = await sql<Array<{ email_status: string }>>`
    SELECT email_status FROM registration_session_grant_items WHERE id = ${itemIds[2]}::uuid
  `;
  assert.equal(unknownItem.email_status, "unknown");

  await sql`UPDATE registration_session_grant_items SET email_status = 'pending' WHERE id = ${itemIds[3]}::uuid`;
  await sql`DELETE FROM registration_sessions WHERE id = ${linkByRegistration.get(registrations[3]!.id)!}`;
  let suppressedCalls = 0;
  const suppressed = await runGrantEmailsOnce(database, {
    async send() { suppressedCalls += 1; return {}; },
  }, new Date(now.getTime() + 30_000));
  assert.equal(suppressed.suppressed, 1);
  assert.equal(suppressedCalls, 0);

  const noAck = await retryGrantEmails(database, {
    actorId: actor.id,
    batchId,
    itemIds: [itemIds[1]!, itemIds[2]!],
    acknowledgeUnknown: false,
  });
  assert.deepEqual(noAck.queued, [itemIds[1]!]);
  assert.deepEqual(noAck.skipped, [{ itemId: itemIds[2]!, reasonCode: "UNKNOWN_ACK_REQUIRED" }]);

  await sql`UPDATE registration_session_grant_items SET email_status = 'failed' WHERE id = ${itemIds[1]}::uuid`;
  const sql2 = openSessionGrantTestDatabase();
  const database2 = asDatabase(sql2);
  const retryRace = await Promise.all([
    retryGrantEmails(database, { actorId: actor.id, batchId, itemIds: [itemIds[1]!], acknowledgeUnknown: false }),
    retryGrantEmails(database2, { actorId: actor.id, batchId, itemIds: [itemIds[1]!], acknowledgeUnknown: false }),
  ]);
  await sql2.end({ timeout: 2 });
  assert.equal(retryRace.filter((row) => row.queued.length === 1).length, 1);
  assert.equal(retryRace.filter((row) => row.skipped.some((entry) => entry.reasonCode === "EMAIL_BUSY")).length, 1);

  await sql`UPDATE registration_session_grant_items SET email_status = 'failed' WHERE id = ${itemIds[1]}::uuid`;
  const preToken = randomUUID();
  await sql`UPDATE registration_session_grant_items SET email_status = 'sending', attempt_count = 1, claim_token = ${preToken}::uuid, claimed_until = ${new Date(now.getTime() - 60_000).toISOString()} WHERE id = ${itemIds[4]}::uuid`;
  await sql`INSERT INTO registration_session_grant_email_attempts (id, item_id, attempt_no, claim_token, trigger, recipient_email, template_version, subject_snapshot, result, started_at)
    VALUES (${randomUUID()}::uuid, ${itemIds[4]}::uuid, 1, ${preToken}::uuid, 'system', ${registrations[4]!.email}, 'session-grant-v1', 'ก่อนส่ง', 'sending', ${new Date(now.getTime() - 120_000).toISOString()})`;
  const recoveredPre = await runGrantEmailsOnce(database, { async send() { return {}; } }, new Date(now.getTime() + 40_000));
  assert.equal(recoveredPre.claimed, 1);
  const preAttempts = await sql<Array<{ attempt_no: number; result: string; error_code: string | null }>>`
    SELECT attempt_no, result, error_code FROM registration_session_grant_email_attempts WHERE item_id = ${itemIds[4]}::uuid ORDER BY attempt_no
  `;
  assert.equal(preAttempts[0]!.result, "failed");
  assert.equal(preAttempts[0]!.error_code, "PRE_SEND_WORKER_INTERRUPTED");
  assert.equal(preAttempts[1]!.result, "sent");

  const postToken = randomUUID();
  await sql`UPDATE registration_session_grant_items SET email_status = 'sending', attempt_count = 1, claim_token = ${postToken}::uuid, claimed_until = ${new Date(now.getTime() - 60_000).toISOString()} WHERE id = ${itemIds[5]}::uuid`;
  await sql`INSERT INTO registration_session_grant_email_attempts (id, item_id, attempt_no, claim_token, trigger, recipient_email, template_version, subject_snapshot, result, started_at, request_started_at)
    VALUES (${randomUUID()}::uuid, ${itemIds[5]}::uuid, 1, ${postToken}::uuid, 'system', ${registrations[5]!.email}, 'session-grant-v1', 'เริ่มส่งแล้ว', 'sending', ${new Date(now.getTime() - 120_000).toISOString()}, ${new Date(now.getTime() - 110_000).toISOString()})`;
  const recoveredPost = await runGrantEmailsOnce(database, { async send() { throw new Error("must not send recovered unknown"); } }, new Date(now.getTime() + 50_000));
  assert.equal(recoveredPost.unknown, 1);
  assert.equal(recoveredPost.claimed, 0);
  const [postItem] = await sql<Array<{ email_status: string }>>`
    SELECT email_status FROM registration_session_grant_items WHERE id = ${itemIds[5]}::uuid
  `;
  assert.equal(postItem.email_status, "unknown");

  await sql`UPDATE registration_session_grant_items
    SET email_status = 'pending', claim_token = NULL, claimed_until = NULL, sent_at = NULL
    WHERE id = ${itemIds[0]}::uuid`;
  const replacementToken = randomUUID();
  const staleWorker = await runGrantEmailsOnce(database, {
    async send() {
      await sql`UPDATE registration_session_grant_items
        SET claim_token = ${replacementToken}::uuid, claimed_until = ${new Date(now.getTime() + 300_000).toISOString()}
        WHERE id = ${itemIds[0]}::uuid`;
      return { providerMessageId: "stale-worker-provider-id" };
    },
  }, new Date(now.getTime() + 60_000));
  assert.equal(staleWorker.claimed, 1);
  assert.equal(staleWorker.sent, 0);
  const [staleItem] = await sql<Array<{ email_status: string; claim_token: string | null }>>`
    SELECT email_status, claim_token FROM registration_session_grant_items WHERE id = ${itemIds[0]}::uuid
  `;
  assert.equal(staleItem.email_status, "sending");
  assert.equal(staleItem.claim_token, replacementToken);
  const staleAttempts = await sql<Array<{ attempt_no: number; result: string; provider_message_id: string | null }>>`
    SELECT attempt_no, result, provider_message_id
    FROM registration_session_grant_email_attempts
    WHERE item_id = ${itemIds[0]}::uuid
    ORDER BY attempt_no
  `;
  assert.equal(staleAttempts.at(-1)?.result, "sending");
  assert.equal(staleAttempts.at(-1)?.provider_message_id, null);

  const health = await getGrantMailBacklogHealth(database, new Date(now.getTime() + 60_000));
  assert.ok(health.sending >= 1);
  assert.ok(health.oldestPendingAgeMs >= 0);
});
