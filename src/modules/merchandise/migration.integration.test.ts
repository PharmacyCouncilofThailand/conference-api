import assert from "node:assert/strict";
import test from "node:test";
import { openMerchTestDatabase } from "./test-support.js";

test("merch migration enforces money, uniqueness and active-attempt rules", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const t = await openMerchTestDatabase();
  try {
    const eventId = await t.createEvent("PRIS-2026");
    const userId = await t.createUser();
    // reference sequence format
    const [{ ref }] = await t.sql`SELECT '7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0') AS ref`;
    assert.match(ref, /^7\d{11}$/);
    // order + two attempts: only one creating/active allowed
    const [order] = await t.sql`INSERT INTO merch_orders (event_id, order_number, buyer_user_id, buyer_name, buyer_email,
      recipient_name, recipient_phone, address_line, subdistrict, district, province, postal_code,
      subtotal, shipping_fee, total, idempotency_key, idempotency_fingerprint)
      VALUES (${eventId}, 'PRIS2026-M-000001', ${userId}, 'A B', 'a@x.test', 'A B', '0812345678', '1', 's', 'd', 'p', '10110',
      10000, 5000, 15000, 'k1', 'f1') RETURNING id`;
    await t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000001', 15000, 'active', now())`;
    await assert.rejects(t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000002', 15000, 'creating', now())`, { code: "23505" });
    await t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000003', 15000, 'expired', now())`;
    // outbox unique per (order,type)
    await t.sql`INSERT INTO merch_email_outbox (order_id, type) VALUES (${order.id}, 'paid')`;
    await assert.rejects(t.sql`INSERT INTO merch_email_outbox (order_id, type) VALUES (${order.id}, 'paid')`, { code: "23505" });
    // negative money rejected
    await assert.rejects(t.sql`UPDATE merch_orders SET total = -1 WHERE id = ${order.id}`, { code: "23514" });
    // idempotency unique per buyer
    await assert.rejects(t.sql`INSERT INTO merch_orders (event_id, order_number, buyer_user_id, buyer_name, buyer_email,
      recipient_name, recipient_phone, address_line, subdistrict, district, province, postal_code,
      subtotal, shipping_fee, total, idempotency_key, idempotency_fingerprint)
      VALUES (${eventId}, 'PRIS2026-M-000002', ${userId}, 'A B', 'a@x.test', 'A B', '0812345678', '1', 's', 'd', 'p', '10110',
      10000, 5000, 15000, 'k1', 'f2')`, { code: "23505" });
  } finally { await t.close(); }
});
