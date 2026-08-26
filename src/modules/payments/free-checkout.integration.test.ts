import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openPaymentsTestDatabase, validatePaymentsTestDatabaseUrl } from "./test-database.js";

const integrationRunRequested = process.env.npm_lifecycle_event === "test:payments:integration";
const PREFIX = "__payments_test__";

async function resetFixtures(sql: Awaited<ReturnType<typeof openPaymentsTestDatabase>>) {
  await sql`DELETE FROM registration_sessions WHERE registration_id IN (
    SELECT r.id FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.event_code LIKE ${PREFIX + "%"}
  )`;
  await sql`DELETE FROM promo_code_usages WHERE promo_code_id IN (
    SELECT p.id FROM promo_codes p JOIN events e ON e.id = p.event_id WHERE e.event_code LIKE ${PREFIX + "%"}
  )`;
  await sql`DELETE FROM payments WHERE order_id IN (
    SELECT o.id FROM orders o JOIN events e ON e.id = o.event_id WHERE e.event_code LIKE ${PREFIX + "%"}
  )`;
  await sql`DELETE FROM order_items WHERE order_id IN (
    SELECT o.id FROM orders o JOIN events e ON e.id = o.event_id WHERE e.event_code LIKE ${PREFIX + "%"}
  )`;
  await sql`DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE event_code LIKE ${PREFIX + "%"})`;
  await sql`DELETE FROM orders WHERE event_id IN (SELECT id FROM events WHERE event_code LIKE ${PREFIX + "%"})`;
  await sql`DELETE FROM promo_codes WHERE event_id IN (SELECT id FROM events WHERE event_code LIKE ${PREFIX + "%"})`;
  await sql`DELETE FROM ticket_sessions WHERE ticket_type_id IN (
    SELECT t.id FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.event_code LIKE ${PREFIX + "%"}
  )`;
  await sql`DELETE FROM ticket_types WHERE event_id IN (SELECT id FROM events WHERE event_code LIKE ${PREFIX + "%"})`;
  await sql`DELETE FROM sessions WHERE event_id IN (SELECT id FROM events WHERE event_code LIKE ${PREFIX + "%"})`;
  await sql`DELETE FROM events WHERE event_code LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM users WHERE email LIKE 'payments-test-%@example.test'`;
}

async function seedFixture(sql: Awaited<ReturnType<typeof openPaymentsTestDatabase>>, maxUses = 1) {
  const suffix = randomUUID().slice(0, 8);
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code, event_name, event_type, start_date, end_date, status)
    VALUES (${`${PREFIX}${suffix}`}, 'Payments Integration Event', 'single_room', now(), now() + interval '1 day', 'published')
    RETURNING id
  `;
  const users = await sql<Array<{ id: number }>>`
    INSERT INTO users (email, password_hash, role, first_name, last_name, status)
    VALUES
      (${`payments-test-${suffix}-1@example.test`}, 'test-hash', 'general', 'First', 'User', 'active'),
      (${`payments-test-${suffix}-2@example.test`}, 'test-hash', 'general', 'Second', 'User', 'active')
    RETURNING id
  `;
  const [ticket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota, sold_count, is_active)
    VALUES (${event.id}, 'primary', 'regular', 'Conference Ticket', 5000, 'THB', 100, 0, true)
    RETURNING id
  `;
  const [wrongEvent] = await sql<Array<{ id: number }>>`
    INSERT INTO events (event_code, event_name, event_type, start_date, end_date, status)
    VALUES (${`${PREFIX}${suffix}-wrong`}, 'Wrong Event', 'single_room', now(), now() + interval '1 day', 'published')
    RETURNING id
  `;
  const [wrongTicket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota, sold_count, is_active)
    VALUES (${wrongEvent.id}, 'primary', 'regular', 'Wrong Event Ticket', 5000, 'THB', 100, 0, true)
    RETURNING id
  `;
  const [promo] = await sql<Array<{ id: number }>>`
    INSERT INTO promo_codes (
      event_id, code, discount_type, discount_value, min_purchase,
      max_uses, max_uses_per_user, used_count, is_active
    ) VALUES (${event.id}, ${`FREE-${suffix}`}, 'percentage', 100, 0, ${maxUses}, 1, 0, true)
    RETURNING id
  `;
  return { suffix, eventId: event.id, wrongEventId: wrongEvent.id, userIds: users.map((row) => row.id), ticketId: ticket.id, wrongTicketId: wrongTicket.id, promoId: promo.id, promoCode: `FREE-${suffix}` };
}

const logger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function freeInput(fixture: Awaited<ReturnType<typeof seedFixture>>, userId: number, ticketId = fixture.ticketId) {
  return {
    logger,
    orderNumber: `TEST-${randomUUID().slice(0, 12)}`,
    userId,
    eventId: fixture.eventId,
    currency: "THB" as const,
    subtotal: 5000,
    preliminaryDiscountAmount: 5000,
    preliminaryDiscountType: "percentage" as const,
    preliminaryDiscountValue: 100,
    promoCode: fixture.promoCode,
    selectedTicketTypeIds: [ticketId],
    items: [{ itemType: "ticket" as const, ticketTypeId: ticketId, price: "5000", quantity: 1 }],
    workshopSessionId: null,
    optionalSessionIds: [],
    taxInvoice: {
      needTaxInvoice: false,
      taxName: null,
      taxId: null,
      taxAddress: null,
      taxSubDistrict: null,
      taxDistrict: null,
      taxProvince: null,
      taxPostalCode: null,
      taxFullAddress: null,
    },
  };
}

test("payments integration database guard requires an isolated test target", () => {
  assert.throws(() => validatePaymentsTestDatabaseUrl({}), /TEST_DATABASE_URL is required/);
  assert.throws(
    () => validatePaymentsTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://user:pass@localhost/conference" }),
    /must contain test/,
  );
});

test("proves free checkout atomicity, promo concurrency, and idempotent settlement", {
  skip: integrationRunRequested ? false : "run with npm run test:payments:integration",
}, async () => {
  const testUrl = validatePaymentsTestDatabaseUrl();
  const sql = await openPaymentsTestDatabase();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl;

  try {
    await resetFixtures(sql);
    const { completeFreeCheckout } = await import("./free-checkout.service.js");
    const { settlePromoUsageSuccess } = await import("./promo-usage.service.js");

    // Happy path.
    const happy = await seedFixture(sql, 1);
    const completed = await completeFreeCheckout(freeInput(happy, happy.userIds[0]));
    const [happyRow] = await sql<Array<Record<string, unknown>>>`
      SELECT o.status AS order_status, o.total_amount, p.amount, p.status AS payment_status,
             p.payment_provider, p.payment_channel, u.status AS usage_status,
             pc.used_count, r.status AS registration_status, r.reg_code, t.sold_count
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      JOIN promo_code_usages u ON u.order_id = o.id
      JOIN promo_codes pc ON pc.id = u.promo_code_id
      JOIN registrations r ON r.order_id = o.id
      JOIN ticket_types t ON t.id = ${happy.ticketId}
      WHERE o.id = ${completed.orderId}
    `;
    assert.equal(happyRow.order_status, "paid");
    assert.equal(Number(happyRow.total_amount), 0);
    assert.equal(Number(happyRow.amount), 0);
    assert.equal(happyRow.payment_status, "paid");
    assert.equal(happyRow.payment_provider, "internal");
    assert.equal(happyRow.payment_channel, "free");
    assert.equal(happyRow.usage_status, "used");
    assert.equal(Number(happyRow.used_count), 1);
    assert.equal(happyRow.registration_status, "confirmed");
    assert.equal(Number(happyRow.sold_count), 1);
    assert.ok(String(happyRow.reg_code).length > 0);

    // Duplicate settlement must be a no-op.
    await settlePromoUsageSuccess(completed.orderId);
    await settlePromoUsageSuccess(completed.orderId);
    const [afterDuplicate] = await sql<Array<{ used_count: number }>>`
      SELECT used_count FROM promo_codes WHERE id = ${happy.promoId}
    `;
    assert.equal(Number(afterDuplicate.used_count), 1);

    // Registration failure rolls back the order, payment, usage, and sold count.
    const rollbackFixture = await seedFixture(sql, 1);
    const rollbackOrderNumber = `TEST-${randomUUID().slice(0, 12)}`;
    await assert.rejects(
      completeFreeCheckout({ ...freeInput(rollbackFixture, rollbackFixture.userIds[0], rollbackFixture.wrongTicketId), orderNumber: rollbackOrderNumber }),
    );
    const [rollbackState] = await sql<Array<{ orders: number; payments: number; usages: number; registrations: number; used_count: number }>>`
      SELECT
        (SELECT count(*)::int FROM orders WHERE order_number = ${rollbackOrderNumber}) AS orders,
        (SELECT count(*)::int FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.order_number = ${rollbackOrderNumber}) AS payments,
        (SELECT count(*)::int FROM promo_code_usages u JOIN orders o ON o.id = u.order_id WHERE o.order_number = ${rollbackOrderNumber}) AS usages,
        (SELECT count(*)::int FROM registrations r JOIN orders o ON o.id = r.order_id WHERE o.order_number = ${rollbackOrderNumber}) AS registrations,
        (SELECT used_count FROM promo_codes WHERE id = ${rollbackFixture.promoId}) AS used_count
    `;
    assert.deepEqual(rollbackState, { orders: 0, payments: 0, usages: 0, registrations: 0, used_count: 0 });

    // Concurrent requests for maxUses=1 serialize on the promo row.
    const race = await seedFixture(sql, 1);
    const results = await Promise.allSettled([
      completeFreeCheckout(freeInput(race, race.userIds[0])),
      completeFreeCheckout(freeInput(race, race.userIds[1])),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const [raceState] = await sql<Array<{ usages: number; used_count: number; paid_orders: number; registrations: number }>>`
      SELECT
        (SELECT count(*)::int FROM promo_code_usages WHERE promo_code_id = ${race.promoId} AND status = 'used') AS usages,
        (SELECT used_count FROM promo_codes WHERE id = ${race.promoId}) AS used_count,
        (SELECT count(*)::int FROM orders WHERE event_id = ${race.eventId} AND status = 'paid') AS paid_orders,
        (SELECT count(*)::int FROM registrations WHERE event_id = ${race.eventId} AND status = 'confirmed') AS registrations
    `;
    assert.deepEqual(raceState, { usages: 1, used_count: 1, paid_orders: 1, registrations: 1 });
  } finally {
    await resetFixtures(sql);
    await sql.end({ timeout: 2 });
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
