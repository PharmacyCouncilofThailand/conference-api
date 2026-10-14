import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import axios from 'axios';
import { openPaymentsTestDatabase, validatePaymentsTestDatabaseUrl } from './test-database.js';

const run = process.env.npm_lifecycle_event === 'test:checkout-flow:integration';

test('checkout HTTP contract uses an isolated DB', { skip: !run }, async () => {
  const testUrl = validatePaymentsTestDatabaseUrl();
  const sql = await openPaymentsTestDatabase();
  const savedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
    PAY_SOLUTIONS_MERCHANT_ID: process.env.PAY_SOLUTIONS_MERCHANT_ID,
    PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL: process.env.PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.DATABASE_URL = testUrl;
  process.env.STRIPE_SECRET_KEY = 'sk_test_checkout_contract';
  process.env.JWT_SECRET = 'checkout-contract-test-secret';
  process.env.PAY_SOLUTIONS_MERCHANT_ID = '99999';
  process.env.PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL = 'https://gateway.example.test/payment';
  process.env.NODE_ENV = 'test';
  let outboundCalls = 0;
  mock.method(axios, 'post', async () => {
    outboundCalls++;
    throw new Error('Outbound HTTP is disabled in checkout integration tests');
  });
  mock.method(axios, 'get', async () => {
    outboundCalls++;
    throw new Error('Outbound HTTP is disabled in checkout integration tests');
  });

  const app = Fastify({ logger: false });
  let eventId: number | undefined;
  const userIds: number[] = [];
  let closeDatabase: (() => Promise<void>) | undefined;
  const suffix = randomUUID().slice(0, 8);
  try {
    const paymentRoutes = (await import('../../routes/payments/index.js')).default;
    closeDatabase = (await import('../../database/index.js')).closeDatabase;
    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.user = {
        id: Number(request.headers['x-test-user-id']),
        email: 'checkout@example.test', role: 'general',
      };
    });
    await app.register(paymentRoutes, { prefix: '/api/payments' });
    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (event_code, event_name, event_type, start_date, end_date, status)
      VALUES (${`__checkout_flow_${suffix}`}, 'Checkout Flow Test', 'single_room', now(), now() + interval '1 day', 'published')
      RETURNING id
    `;
    eventId = event.id;
    const [ticket] = await sql<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota, sold_count, is_active, allowed_roles)
      VALUES (${eventId}, 'primary', 'regular', 'Checkout Ticket', 500, 'THB', 100, 0, true, 'general') RETURNING id
    `;
    const [promo] = await sql<Array<{ id: number }>>`
      INSERT INTO promo_codes (event_id, code, discount_type, discount_value, min_purchase, max_uses, max_uses_per_user, used_count, is_active)
      VALUES (${eventId}, ${`FREE-${suffix}`}, 'percentage', 100, 0, 20, 1, 0, true) RETURNING id
    `;
    const newUser = async () => {
      const [user] = await sql<Array<{ id: number }>>`
        INSERT INTO users (email, password_hash, role, first_name, last_name, status)
        VALUES (${`checkout-${randomUUID()}@example.test`}, 'test-hash', 'general', 'Test', 'User', 'active') RETURNING id
      `;
      userIds.push(user.id);
      return user.id;
    };
    const inject = (userId: number, endpoint: string, payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/api/payments/${endpoint}`,
      headers: { 'x-test-user-id': String(userId) }, payload,
    });
    const body = { eventId, packageId: String(ticket.id), addOnIds: [], currency: 'THB', needTaxInvoice: false };
    const counts = async () => (await sql`
      SELECT
        (SELECT count(*)::int FROM orders WHERE event_id=${event.id}) AS orders,
        (SELECT count(*)::int FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.event_id=${event.id}) AS payments,
        (SELECT count(*)::int FROM promo_code_usages WHERE promo_code_id=${promo.id}) AS usages,
        (SELECT count(*)::int FROM registrations WHERE event_id=${event.id}) AS registrations,
        (SELECT sold_count FROM ticket_types WHERE id=${ticket.id}) AS sold
    `)[0];

    const before = await counts();
    const preview = await inject(await newUser(), 'preview', { ...body, promoCode: `FREE-${suffix}` });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().data.total, 0);
    assert.deepEqual(await counts(), before);
    const missing = await inject(await newUser(), 'create-intent', body);
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().code, 'PAYMENT_METHOD_REQUIRED');
    assert.deepEqual(await counts(), before);
    const invalidAddon = await inject(await newUser(), 'preview', { ...body, addOnIds: ['missing-addon'] });
    assert.equal(invalidAddon.statusCode, 400);
    assert.equal(invalidAddon.json().code, 'EVENT_TICKET_MISMATCH');
    const empty = await inject(await newUser(), 'preview', { ...body, packageId: '' });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().code, 'EMPTY_CHECKOUT');
    assert.deepEqual(await counts(), before);

    // Valid legacy tax input must not persist a tax request on a free order.
    const free = await inject(await newUser(), 'create-intent', {
      ...body, promoCode: `FREE-${suffix}`, needTaxInvoice: true,
      taxName: 'Test User', taxId: '1234567890123', taxAddress: '1 Test Road',
      taxSubDistrict: 'Test', taxDistrict: 'Test', taxProvince: 'Test', taxPostalCode: '10100',
    });
    assert.equal(free.statusCode, 200);
    const result = free.json().data;
    assert.equal(result.free, true);
    assert.equal(result.gateway, null);
    assert.equal(result.redirectForm, null);
    assert.equal(result.total, 0);
    assert.ok(result.regCode);
    const [stored] = await sql`
      SELECT o.status, o.need_tax_invoice, o.tax_id, p.payment_provider, p.payment_channel, r.status AS registration_status
      FROM orders o JOIN payments p ON p.order_id=o.id JOIN registrations r ON r.order_id=o.id
      WHERE o.id=${result.orderId}
    `;
    assert.equal(stored.status, 'paid');
    assert.equal(stored.need_tax_invoice, false);
    assert.equal(stored.tax_id, null);
    assert.equal(stored.payment_provider, 'internal');
    assert.equal(stored.payment_channel, 'free');
    assert.equal(stored.registration_status, 'confirmed');

    // Email is best-effort; any attempt is blocked by axios mocks.
    const callsBeforeMissing = outboundCalls;
    const conflict = await inject(await newUser(), 'create-intent', body);
    assert.equal(conflict.statusCode, 409);
    assert.equal(outboundCalls, callsBeforeMissing);

for (const currency of ['THB', 'USD']) {
  const [freeTicket] = await sql<Array<{ id: number }>>`
    INSERT INTO ticket_types (event_id, category, priority, name, price, currency, quota, sold_count, is_active, allowed_roles)
    VALUES (${eventId}, 'primary', 'regular', ${`Free ${currency}`}, 0, ${currency}, 100, 0, true, 'general') RETURNING id
  `;
  const response = await inject(await newUser(), 'create-intent', {
    ...body, packageId: String(freeTicket.id), currency,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.total, 0);
  assert.equal(response.json().data.currency, currency);
  assert.equal(response.json().data.gateway, null);
}
await sql`UPDATE promo_codes SET discount_type='fixed', discount_value=500 WHERE id=${promo.id}`;
const fixed = await inject(await newUser(), 'create-intent', { ...body, promoCode: `FREE-${suffix}` });
assert.equal(fixed.statusCode, 200);
assert.equal(fixed.json().data.discountType, 'fixed');
assert.equal(fixed.json().data.total, 0);
await sql`UPDATE promo_codes SET discount_type='percentage', discount_value=100, max_discount=100 WHERE id=${promo.id}`;
const cappedBefore = await counts();
const capped = await inject(await newUser(), 'create-intent', { ...body, promoCode: `FREE-${suffix}` });
assert.equal(capped.statusCode, 409);
assert.equal(capped.json().code, 'PAYMENT_METHOD_REQUIRED');
assert.deepEqual(await counts(), cappedBefore);
for (const paymentMethod of [null, 'free', 'cash']) {
  const invalid = await inject(await newUser(), 'create-intent', { ...body, paymentMethod });
  assert.equal(invalid.statusCode, 400);
}
for (const paymentMethod of ['qr', 'card']) {
  const paid = await inject(await newUser(), 'create-intent', { ...body, paymentMethod });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.json().data.free, false);
  assert.ok(paid.json().data.redirectForm);
  assert.equal(paid.json().data.redirectForm.actionUrl, 'https://gateway.example.test/payment');
}
const owner = await newUser();
await sql`UPDATE ticket_types SET price=0 WHERE id=${ticket.id}`;
const primary = await inject(owner, 'create-intent', body);
assert.equal(primary.statusCode, 200);
const [addon] = await sql<Array<{ id: number }>>`
  INSERT INTO ticket_types (event_id, category, priority, group_name, name, price, currency, quota, sold_count, is_active)
  VALUES (${eventId}, 'addon', 'regular', 'gala', 'Gala Test', 0, 'THB', 100, 0, true) RETURNING id
`;
const [session] = await sql<Array<{ id: number }>>`
  INSERT INTO sessions (event_id, session_code, session_name, session_type, start_time, end_time, requires_opt_in, is_active)
  VALUES (${eventId}, ${`GALA-${suffix}`}, 'Gala Session', 'other', now(), now() + interval '1 hour', false, true) RETURNING id
`;
await sql`INSERT INTO ticket_sessions (ticket_type_id, session_id) VALUES (${addon.id}, ${session.id})`;
const extra = await inject(owner, 'create-intent', { ...body, packageId: '', addOnIds: ['gala'] });
assert.equal(extra.statusCode, 200);
assert.equal(extra.json().data.free, true);
assert.equal(extra.json().data.regCode, primary.json().data.regCode);
const [entitlement] = await sql`
  SELECT count(*)::int AS count FROM registration_sessions rs
  JOIN registrations r ON r.id=rs.registration_id
  WHERE r.user_id=${owner} AND r.event_id=${eventId} AND rs.session_id=${session.id}
`;
assert.equal(entitlement.count, 1);
  } finally {
    await app.close();
    if (eventId !== undefined) {
      await sql`DELETE FROM registration_sessions WHERE registration_id IN (SELECT id FROM registrations WHERE event_id=${eventId})`;
      await sql`DELETE FROM promo_code_usages WHERE promo_code_id IN (SELECT id FROM promo_codes WHERE event_id=${eventId})`;
      await sql`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE event_id=${eventId})`;
      await sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id=${eventId})`;
      await sql`DELETE FROM registrations WHERE event_id=${eventId}`;
      await sql`DELETE FROM orders WHERE event_id=${eventId}`;
      await sql`DELETE FROM promo_codes WHERE event_id=${eventId}`;
      await sql`DELETE FROM ticket_sessions WHERE ticket_type_id IN (SELECT id FROM ticket_types WHERE event_id=${eventId})`;
      await sql`DELETE FROM ticket_types WHERE event_id=${eventId}`;
      await sql`DELETE FROM sessions WHERE event_id=${eventId}`;
      await sql`DELETE FROM events WHERE id=${eventId}`;
    }
    if (userIds.length) await sql`DELETE FROM users WHERE id=ANY(${userIds})`;
    await closeDatabase?.();
    await sql.end({ timeout: 1 });
    mock.restoreAll();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
