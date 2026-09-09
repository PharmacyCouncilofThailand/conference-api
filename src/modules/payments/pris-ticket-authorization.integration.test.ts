import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openPaymentsTestDatabase, validatePaymentsTestDatabaseUrl } from "./test-database.js";

const integrationRunRequested =
  process.env.npm_lifecycle_event === "test:pris-ticket-authorization:integration";
const NOW = new Date("2026-09-09T00:00:00.000Z");
const CUTOFF = new Date("2026-08-31T17:00:00.000Z");
const SALE_END = new Date("2026-09-15T16:59:59.999Z");

test("PRIS authorization integration database is isolated", () => {
  assert.throws(() => validatePaymentsTestDatabaseUrl({}), /TEST_DATABASE_URL is required/);
});

test("DB-backed PRIS ticket authorization matrix", {
  skip: integrationRunRequested
    ? false
    : "run with npm run test:pris-ticket-authorization:integration",
}, async () => {
  const validatedTestUrl = validatePaymentsTestDatabaseUrl();
  const sql = await openPaymentsTestDatabase();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = validatedTestUrl;

  let eventId: number | null = null;
  let categoryId: number | null = null;
  const ticketIds: number[] = [];
  const userIds: number[] = [];
  const abstractIds: number[] = [];
  let eligibilityRequestId: number | null = null;

  try {
    const existingPris = await sql<Array<{ id: number }>>`
      SELECT id FROM events WHERE event_code = 'PRIS-2026'
    `;
    assert.equal(
      existingPris.length,
      0,
      "isolated PRIS integration DB must not already contain PRIS-2026",
    );

    const suffix = randomUUID().slice(0, 8);
    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        event_code, event_name, event_type, start_date, end_date, status
      ) VALUES (
        'PRIS-2026', 'PRIS Authorization Integration', 'single_room',
        TIMESTAMP '2026-09-01 00:00:00', TIMESTAMP '2026-10-30 10:30:00', 'published'
      )
      RETURNING id
    `;
    eventId = event.id;

    const [category] = await sql<Array<{ id: number }>>`
      INSERT INTO abstract_categories (event_id, name, is_active)
      VALUES (${eventId}, 'Integration Category', true)
      RETURNING id
    `;
    categoryId = category.id;

    const tickets = await sql<Array<{ id: number; name: string }>>`
      INSERT INTO ticket_types (
        event_id, category, priority, name, price, currency,
        allowed_roles, allowed_student_levels, quota, sold_count,
        sale_start_date, sale_end_date, is_active, display_order
      ) VALUES
        (${eventId}, 'primary', 'early_bird', 'Early Bird', 1250, 'THB',
          'pharmacist,medical_professional', NULL, 100, 0,
          TIMESTAMP '2026-07-01 03:00:00', TIMESTAMP '2026-09-15 16:59:59.999', true, 1),
        (${eventId}, 'primary', 'regular', 'Regular', 2500, 'THB',
          'pharmacist,medical_professional', NULL, 100, 0,
          TIMESTAMP '2026-08-31 17:00:00', TIMESTAMP '2026-10-30 10:30:00', true, 2),
        (${eventId}, 'primary', 'regular', 'Postgraduate', 1250, 'THB',
          'student', 'postgraduate', 100, 0,
          TIMESTAMP '2026-07-01 03:00:00', TIMESTAMP '2026-10-30 10:30:00', true, 3),
        (${eventId}, 'primary', 'regular', 'Undergraduate', 500, 'THB',
          'student', 'undergraduate', 100, 0,
          TIMESTAMP '2026-07-01 03:00:00', TIMESTAMP '2026-10-30 10:30:00', true, 4)
      RETURNING id, name
    `;
    ticketIds.push(...tickets.map((row) => row.id));
    const ticketId = (name: string) => {
      const row = tickets.find((ticket) => ticket.name === name);
      assert.ok(row, `missing ${name} fixture ticket`);
      return row.id;
    };

    const users = await sql<Array<{ id: number; email: string }>>`
      INSERT INTO users (
        email, password_hash, role, first_name, last_name, status,
        student_level, created_at
      ) VALUES
        (${`pris-auth-${suffix}-a@example.test`}, 'test-hash', 'pharmacist', 'A', 'User', 'active', NULL, TIMESTAMP '2026-08-20 00:00:00'),
        (${`pris-auth-${suffix}-b@example.test`}, 'test-hash', 'pharmacist', 'B', 'User', 'active', NULL, TIMESTAMP '2026-08-20 00:00:00'),
        (${`pris-auth-${suffix}-c@example.test`}, 'test-hash', 'pharmacist', 'C', 'User', 'active', NULL, TIMESTAMP '2026-09-01 00:00:00'),
        (${`pris-auth-${suffix}-d@example.test`}, 'test-hash', 'pharmacist', 'D', 'User', 'active', NULL, TIMESTAMP '2026-08-20 00:00:00'),
        (${`pris-auth-${suffix}-e@example.test`}, 'test-hash', 'medical_professional', 'E', 'User', 'active', NULL, TIMESTAMP '2026-08-20 00:00:00'),
        (${`pris-auth-${suffix}-f@example.test`}, 'test-hash', 'general', 'F', 'User', 'active', NULL, TIMESTAMP '2026-08-20 00:00:00'),
        (${`pris-auth-${suffix}-g@example.test`}, 'test-hash', 'student', 'G', 'User', 'active', 'postgraduate', TIMESTAMP '2026-08-20 00:00:00'),
        (${`pris-auth-${suffix}-h@example.test`}, 'test-hash', 'student', 'H', 'User', 'active', 'undergraduate', TIMESTAMP '2026-08-20 00:00:00')
      RETURNING id, email
    `;
    userIds.push(...users.map((row) => row.id));
    const userId = (letter: string) => {
      const marker = `-${letter.toLowerCase()}@example.test`;
      const row = users.find((user) => user.email.endsWith(marker));
      assert.ok(row, `missing user ${letter}`);
      return row.id;
    };

    for (const letter of ["A", "D", "E"] as const) {
      const [abstract] = await sql<Array<{ id: number }>>`
        INSERT INTO abstracts (
          user_id, event_id, title, category_id, presentation_type,
          background, objective, methods, results, conclusion, status, created_at
        ) VALUES (
          ${userId(letter)}, ${eventId}, ${`Qualifying ${letter}`}, ${categoryId}, 'oral',
          'Background', 'Objective', 'Methods', 'Results', 'Conclusion', 'pending',
          TIMESTAMP '2026-08-20 00:00:00'
        )
        RETURNING id
      `;
      abstractIds.push(abstract.id);
    }

    const [eligibility] = await sql<Array<{ id: number }>>`
      INSERT INTO event_student_eligibility_requests (
        event_id, user_id, student_level, status,
        document_file_name, document_file_url
      ) VALUES (
        ${eventId}, ${userId("D")}, 'postgraduate', 'approved',
        'integration.pdf', '/integration.pdf'
      )
      RETURNING id
    `;
    eligibilityRequestId = eligibility.id;

    const { resolvePris2026Pricing } = await import("../pris2026/pricing-policy.js");
    const { resolveEffectiveTicketIdentity } = await import("../../utils/studentEligibility.js");

    const resolve = (id: number) => resolvePris2026Pricing({
      userId: id,
      eventId: eventId!,
      currency: "THB",
      now: NOW,
    });

    const a = await resolve(userId("A"));
    const b = await resolve(userId("B"));
    const c = await resolve(userId("C"));
    const d = await resolve(userId("D"));
    const e = await resolve(userId("E"));
    const f = await resolve(userId("F"));
    const g = await resolve(userId("G"));
    const h = await resolve(userId("H"));

    assert.equal(a.applies, true);
    assert.equal(a.effectiveTicketTypeId, ticketId("Early Bird"));
    assert.equal(b.applies, true);
    assert.equal(b.effectiveTicketTypeId, ticketId("Regular"));
    assert.equal(c.applies, true);
    assert.equal(c.effectiveTicketTypeId, ticketId("Regular"));
    assert.equal(d.applies, false);
    assert.equal(d.reason, "postgraduate_override");
    assert.equal(d.effectiveTicketTypeId, null);
    assert.equal(e.applies, true);
    assert.equal(e.effectiveTicketTypeId, ticketId("Early Bird"));
    assert.equal(f.applies, false);
    assert.equal(g.applies, false);
    assert.equal(h.applies, false);

    await sql`
      UPDATE ticket_types
      SET sale_end_date = TIMESTAMP '2026-08-31 16:30:00'
      WHERE id = ${ticketId("Early Bird")}
    `;
    const expiredEarlyBird = await resolve(userId("A"));
    assert.equal(expiredEarlyBird.effectivePriority, "early_bird");
    assert.equal(expiredEarlyBird.effectiveTicketTypeId, null);
    await sql`
      UPDATE ticket_types
      SET sale_end_date = ${SALE_END}
      WHERE id = ${ticketId("Early Bird")}
    `;

    const identity = await resolveEffectiveTicketIdentity(userId("D"), eventId);
    assert.equal(identity.allowed, true);
    if (identity.allowed) {
      assert.equal(identity.identity.canonicalRole, "pharmacist");
      assert.equal(identity.identity.effectiveRole, "student");
      assert.equal(identity.identity.effectiveStudentLevel, "postgraduate");
      assert.equal(identity.identity.source, "pharmacist_event_student_eligibility");
    }

    assert.ok(CUTOFF.getTime() < NOW.getTime());
  } finally {
    if (eligibilityRequestId !== null) {
      await sql`DELETE FROM event_student_eligibility_requests WHERE id = ${eligibilityRequestId}`;
    }
    if (abstractIds.length > 0) {
      await sql`DELETE FROM abstracts WHERE id = ANY(${abstractIds})`;
    }
    if (ticketIds.length > 0) {
      await sql`DELETE FROM ticket_types WHERE id = ANY(${ticketIds})`;
    }
    if (categoryId !== null) {
      await sql`DELETE FROM abstract_categories WHERE id = ${categoryId}`;
    }
    if (eventId !== null) {
      await sql`DELETE FROM events WHERE id = ${eventId}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM users WHERE id = ANY(${userIds})`;
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await sql.end({ timeout: 1 });
  }
});
