import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { createGrant, getGrantBatch } from "./service.js";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";
import type { GrantDatabase } from "./types.js";
import { GrantError } from "./types.js";

function asDatabase(client: ReturnType<typeof openSessionGrantTestDatabase>): GrantDatabase {
  return drizzle(client, { schema }) as GrantDatabase;
}

test(
  "atomic session grant persists mixed outcomes, replays exactly, paginates globally, and serializes concurrent keys",
  { timeout: 90_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();
    const database = asDatabase(sql);

    const [{ migrated }] = await sql<Array<{ migrated: boolean }>>`
      SELECT
        to_regclass(current_schema() || '.registration_session_grant_batches') IS NOT NULL
        AND to_regclass(current_schema() || '.registration_session_grant_items') IS NOT NULL
        AND to_regclass(current_schema() || '.registration_sessions_registration_session_unique') IS NOT NULL
        AS migrated
    `;
    assert.equal(migrated, true, "0031 must be applied before T04 service verification");

    const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const [actor] = await sql<Array<{ id: number }>>`
      INSERT INTO backoffice_users (
        email, password_hash, role, first_name, last_name
      ) VALUES (
        ${`grant-service-${unique}@example.invalid`}, 'not-a-real-password-hash',
        'admin', 'Atomic', 'Admin'
      )
      RETURNING id
    `;

    const events = await sql<Array<{ id: number; event_code: string }>>`
      INSERT INTO events (
        event_code, event_name, event_type, start_date, end_date, status
      ) VALUES
        (
          ${`SG-SVC-A-${unique}`}, 'Atomic Grant Event A', 'multi_session',
          '2026-10-01 00:00:00', '2099-10-03 23:59:59', 'published'
        ),
        (
          ${`SG-SVC-B-${unique}`}, 'Atomic Grant Event B', 'multi_session',
          '2026-10-01 00:00:00', '2099-10-03 23:59:59', 'published'
        )
      RETURNING id, event_code
    `;
    const eventA = events.find((row) => row.event_code.startsWith("SG-SVC-A-"))!;
    const eventB = events.find((row) => row.event_code.startsWith("SG-SVC-B-"))!;

    const [session] = await sql<Array<{ id: number }>>`
      INSERT INTO sessions (
        event_id, session_code, session_name, start_time, end_time, is_active
      ) VALUES (
        ${eventA.id}, ${`SG-SVC-SESSION-${unique}`}, 'Atomic Grant Session',
        '2026-10-01 09:00:00', '2099-10-01 12:00:00', true
      )
      RETURNING id
    `;

    const tickets = await sql<Array<{ id: number; event_id: number }>>`
      INSERT INTO ticket_types (
        event_id, category, priority, name, price, currency, quota
      ) VALUES
        (${eventA.id}, 'primary', 'regular', 'Atomic Event A Ticket', 1000, 'THB', 1000),
        (${eventB.id}, 'primary', 'regular', 'Atomic Event B Ticket', 1000, 'THB', 1000)
      RETURNING id, event_id
    `;
    const ticketA = tickets.find((row) => row.event_id === eventA.id)!;
    const ticketB = tickets.find((row) => row.event_id === eventB.id)!;

    const registrations = await sql<Array<{ id: number; reg_code: string; status: string }>>`
      INSERT INTO registrations (
        reg_code, event_id, ticket_type_id, email, first_name, last_name, status
      ) VALUES
        (${`SG-ADD-1-${unique}`}, ${eventA.id}, ${ticketA.id}, ${`add1-${unique}@example.invalid`}, 'Add', 'One', 'confirmed'),
        (${`SG-ADD-2-${unique}`}, ${eventA.id}, ${ticketA.id}, ${`add2-${unique}@example.invalid`}, 'Add', 'Two', 'confirmed'),
        (${`SG-CANCEL-${unique}`}, ${eventA.id}, ${ticketA.id}, ${`cancel-${unique}@example.invalid`}, 'Cancel', 'Person', 'cancelled'),
        (${`SG-WRONG-${unique}`}, ${eventB.id}, ${ticketB.id}, ${`wrong-${unique}@example.invalid`}, 'Wrong', 'Event', 'confirmed'),
        (${`SG-EXIST-${unique}`}, ${eventA.id}, ${ticketA.id}, ${`existing-${unique}@example.invalid`}, 'Existing', 'Link', 'confirmed'),
        (${`SG-RACE-${unique}`}, ${eventA.id}, ${ticketA.id}, ${`race-${unique}@example.invalid`}, 'Race', 'Person', 'confirmed'),
        (${`SG-ROLLBACK-${unique}`}, ${eventA.id}, ${ticketA.id}, ${`rollback-${unique}@example.invalid`}, 'Rollback', 'Person', 'confirmed')
      RETURNING id, reg_code, status
    `;
    const byCode = (prefix: string) => registrations.find((row) => row.reg_code.startsWith(prefix))!;
    const add1 = byCode("SG-ADD-1-");
    const add2 = byCode("SG-ADD-2-");
    const cancelled = byCode("SG-CANCEL-");
    const wrongEvent = byCode("SG-WRONG-");
    const existing = byCode("SG-EXIST-");
    const race = byCode("SG-RACE-");
    const rollback = byCode("SG-ROLLBACK-");
    const missingRegistrationId = 2_000_000_000;

    await sql`
      INSERT INTO registration_sessions (
        registration_id, session_id, ticket_type_id, source
      ) VALUES (
        ${existing.id}, ${session.id}, ${ticketA.id}, 'purchase'
      )
    `;

    t.after(async () => {
      await sql.unsafe("DROP TRIGGER IF EXISTS session_grant_test_force_item_failure ON registration_session_grant_items");
      await sql.unsafe("DROP FUNCTION IF EXISTS session_grant_test_force_item_failure() CASCADE");
      await sql`DELETE FROM registration_session_grant_email_attempts
        WHERE item_id IN (
          SELECT i.id FROM registration_session_grant_items i
          JOIN registration_session_grant_batches b ON b.id = i.batch_id
          WHERE b.event_id IN (${eventA.id}, ${eventB.id})
        )`;
      await sql`DELETE FROM registration_session_grant_items
        WHERE batch_id IN (
          SELECT id FROM registration_session_grant_batches
          WHERE event_id IN (${eventA.id}, ${eventB.id})
        )`;
      await sql`DELETE FROM registration_session_grant_batches
        WHERE event_id IN (${eventA.id}, ${eventB.id})`;
      await sql`DELETE FROM registration_sessions
        WHERE registration_id IN (
          SELECT id FROM registrations WHERE event_id IN (${eventA.id}, ${eventB.id})
        )`;
      await sql`DELETE FROM registrations
        WHERE event_id IN (${eventA.id}, ${eventB.id})`;
      await sql`DELETE FROM ticket_types WHERE id IN (${ticketA.id}, ${ticketB.id})`;
      await sql`DELETE FROM sessions WHERE id = ${session.id}`;
      await sql`DELETE FROM events WHERE id IN (${eventA.id}, ${eventB.id})`;
      await sql`DELETE FROM backoffice_users WHERE id = ${actor.id}`;
      await sql.end({ timeout: 2 });
    });

    const mixedKey = randomUUID();
    const mixedIds = [
      add2.id,
      missingRegistrationId,
      existing.id,
      cancelled.id,
      add1.id,
      wrongEvent.id,
      add1.id,
    ];
    const mixed = await createGrant(database, {
      actorId: actor.id,
      idempotencyKey: mixedKey,
      sessionId: session.id,
      registrationIds: mixedIds,
    });

    assert.equal(mixed.replayed, false);
    assert.equal(mixed.batch.requestedCount, 6);
    assert.equal(mixed.batch.addedCount, 2);
    assert.equal(mixed.batch.skippedCount, 4);
    assert.equal(mixed.batch.addedCount + mixed.batch.skippedCount, mixed.batch.requestedCount);
    assert.equal(mixed.batch.currentEnrollmentCount, 3);
    assert.equal(mixed.batch.emailCounts.pending, 2);
    assert.equal(mixed.batch.emailCounts.not_applicable, 4);

    const outcomes = new Map(mixed.batch.results.map((row) => [row.registrationId, row]));
    assert.equal(outcomes.get(add1.id)?.outcome, "added");
    assert.equal(outcomes.get(add2.id)?.outcome, "added");
    assert.equal(outcomes.get(cancelled.id)?.reasonCode, "REGISTRATION_NOT_CONFIRMED");
    assert.equal(outcomes.get(wrongEvent.id)?.reasonCode, "EVENT_MISMATCH");
    assert.equal(outcomes.get(existing.id)?.reasonCode, "ALREADY_REGISTERED");
    assert.equal(outcomes.get(missingRegistrationId)?.reasonCode, "REGISTRATION_NOT_FOUND");
    for (const item of mixed.batch.results) {
      assert.equal(item.emailStatus, item.outcome === "added" ? "pending" : "not_applicable");
    }

    const [preservedExisting] = await sql<Array<{
      ticket_type_id: number | null;
      source: string;
    }>>`
      SELECT ticket_type_id, source
      FROM registration_sessions
      WHERE registration_id = ${existing.id} AND session_id = ${session.id}
    `;
    assert.equal(preservedExisting.ticket_type_id, ticketA.id);
    assert.equal(preservedExisting.source, "purchase");

    const page1 = await getGrantBatch(database, mixed.batch.batchId, 1, 2);
    const page2 = await getGrantBatch(database, mixed.batch.batchId, 2, 2);
    assert.ok(page1);
    assert.ok(page2);
    assert.equal(page1.pagination.total, 6);
    assert.equal(page1.pagination.totalPages, 3);
    assert.equal(page1.results.length, 2);
    assert.equal(page2.results.length, 2);
    assert.equal(page1.emailCounts.pending, 2);
    assert.equal(page2.emailCounts.pending, 2);
    assert.deepEqual(
      [...page1.results, ...page2.results].map((row) => row.registrationId),
      [...page1.results, ...page2.results].map((row) => row.registrationId).sort((a, b) => a - b),
    );

    await sql`UPDATE sessions SET is_active = false WHERE id = ${session.id}`;
    await sql`UPDATE registrations SET status = 'cancelled' WHERE id = ${add2.id}`;
    const replay = await createGrant(database, {
      actorId: actor.id,
      idempotencyKey: mixedKey,
      sessionId: session.id,
      registrationIds: [...mixedIds].reverse(),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.batch.batchId, mixed.batch.batchId);
    assert.equal(replay.batch.addedCount, mixed.batch.addedCount);
    assert.equal(replay.batch.skippedCount, mixed.batch.skippedCount);
    assert.deepEqual(
      replay.batch.results.map((row) => [row.registrationId, row.outcome, row.reasonCode]),
      mixed.batch.results.map((row) => [row.registrationId, row.outcome, row.reasonCode]),
    );
    assert.equal(replay.batch.currentEnrollmentCount, 2, "current enrollment excludes registrations no longer confirmed");

    await assert.rejects(
      () => createGrant(database, {
        actorId: actor.id,
        idempotencyKey: mixedKey,
        sessionId: session.id,
        registrationIds: [add1.id],
      }),
      (error: unknown) => {
        assert.ok(error instanceof GrantError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "IDEMPOTENCY_KEY_MISMATCH");
        return true;
      },
    );

    await sql`UPDATE sessions SET is_active = true WHERE id = ${session.id}`;
    await sql`UPDATE registrations SET status = 'confirmed' WHERE id = ${add2.id}`;

    const raceKey = randomUUID();
    const sql2 = openSessionGrantTestDatabase();
    const database2 = asDatabase(sql2);
    const raceInput = {
      actorId: actor.id,
      idempotencyKey: raceKey,
      sessionId: session.id,
      registrationIds: [race.id],
    };
    const raceResults = await Promise.all([
      createGrant(database, raceInput),
      createGrant(database2, raceInput),
    ]);
    assert.deepEqual(raceResults.map((row) => row.replayed).sort(), [false, true]);
    assert.equal(raceResults[0]!.batch.batchId, raceResults[1]!.batch.batchId);
    const [{ entitlement_count: entitlementCount }] = await sql<Array<{ entitlement_count: number }>>`
      SELECT count(*)::int AS entitlement_count
      FROM registration_sessions
      WHERE registration_id = ${race.id} AND session_id = ${session.id}
    `;
    const [{ item_count: itemCount, pending_count: pendingCount }] = await sql<Array<{
      item_count: number;
      pending_count: number;
    }>>`
      SELECT
        count(*)::int AS item_count,
        count(*) FILTER (WHERE email_status = 'pending')::int AS pending_count
      FROM registration_session_grant_items
      WHERE batch_id = ${raceResults[0]!.batch.batchId}::uuid
    `;
    assert.equal(entitlementCount, 1);
    assert.equal(itemCount, 1);
    assert.equal(pendingCount, 1);
    await sql2.end({ timeout: 2 });

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION session_grant_test_force_item_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.requested_registration_id = ${rollback.id} THEN
          RAISE EXCEPTION 'forced session grant item persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER session_grant_test_force_item_failure
      BEFORE INSERT ON registration_session_grant_items
      FOR EACH ROW EXECUTE FUNCTION session_grant_test_force_item_failure();
    `);

    const rollbackKey = randomUUID();
    await assert.rejects(
      () => createGrant(database, {
        actorId: actor.id,
        idempotencyKey: rollbackKey,
        sessionId: session.id,
        registrationIds: [rollback.id],
      }),
      /forced session grant item persistence failure/i,
    );
    const [{ rollback_entitlements: rollbackEntitlements }] = await sql<Array<{ rollback_entitlements: number }>>`
      SELECT count(*)::int AS rollback_entitlements
      FROM registration_sessions
      WHERE registration_id = ${rollback.id} AND session_id = ${session.id}
    `;
    const [{ rollback_batches: rollbackBatches }] = await sql<Array<{ rollback_batches: number }>>`
      SELECT count(*)::int AS rollback_batches
      FROM registration_session_grant_batches
      WHERE actor_id = ${actor.id} AND idempotency_key = ${rollbackKey}::uuid
    `;
    const [{ rollback_items: rollbackItems }] = await sql<Array<{ rollback_items: number }>>`
      SELECT count(*)::int AS rollback_items
      FROM registration_session_grant_items i
      JOIN registration_session_grant_batches b ON b.id = i.batch_id
      WHERE b.actor_id = ${actor.id} AND b.idempotency_key = ${rollbackKey}::uuid
    `;
    assert.equal(rollbackEntitlements, 0);
    assert.equal(rollbackBatches, 0);
    assert.equal(rollbackItems, 0);
  },
);
