import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
      100, 50, 150, 'k1', 'f1') RETURNING id`;
    await t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000001', 150, 'active', now())`;
    await assert.rejects(t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000002', 150, 'creating', now())`, { code: "23505" });
    await t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000003', 150, 'expired', now())`;
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
      100, 50, 150, 'k1', 'f2')`, { code: "23505" });
  } finally { await t.close(); }
});

test("merch migration defaults shipping to 50 baht and documents money columns as whole baht", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const t = await openMerchTestDatabase();
  try {
    const [d] = await t.sql`SELECT column_default FROM information_schema.columns
      WHERE table_name = 'merch_orders' AND column_name = 'shipping_fee' AND table_schema = ${t.schema}`;
    assert.equal(d.column_default, "50");
    const comments = await t.sql`SELECT col_description(c.oid, a.attnum) AS c
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = ${t.schema}::regnamespace AND (c.relname, a.attname) IN (('merch_products','base_price'),('merch_variants','price'),
        ('merch_orders','subtotal'),('merch_orders','shipping_fee'),('merch_orders','total'),
        ('merch_order_items','unit_price'),('merch_order_items','line_total'),('merch_payment_attempts','amount'))`;
    assert.equal(comments.length, 8);
    assert.ok(comments.every((r) => r.c === "THB, whole baht"));
  } finally { await t.close(); }
});

test("merch migration runs in one transaction and refuses to run over existing merch tables", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const migration = await readFile("drizzle/0043_merchandise.sql", "utf8");
  assert.match(migration, /^BEGIN;\r?$/m);
  assert.match(migration, /^COMMIT;\s*$/m);
  assert.doesNotMatch(migration, /IF NOT EXISTS/);
  const t = await openMerchTestDatabase();
  try {
    const reserved = await t.sql.reserve();
    try {
      await assert.rejects(reserved.unsafe(migration), (error: Error) => {
        assert.match(error.message, /0043_merchandise: already exist: .*merch_stores.*merch_payment_reference_seq/);
        return true;
      });
      await reserved.unsafe("ROLLBACK");
    } finally {
      reserved.release();
    }
    // The failed run changed nothing: still exactly the 14 tables from the first run.
    const [{ count }] = await t.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = ${t.schema} AND table_name LIKE 'merch\_%'`;
    assert.equal(count, 14);
  } finally {
    await t.close();
  }
});
