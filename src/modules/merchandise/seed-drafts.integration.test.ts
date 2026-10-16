import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DRAFT_PRODUCT_NAMES, seedDraftCatalog } from "./seed-drafts.js";
import { MerchError } from "./errors.js";
import { openMerchTestDatabase, type MerchTestDb } from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

let t: MerchTestDb;

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
});

after(async () => {
  if (skip) return;
  await t.close();
});

test("seedDraftCatalog creates drafts once and is idempotent", { skip }, async () => {
  const code = "PRIS-2026";
  const eventId = await t.createEvent(code);

  const first = await seedDraftCatalog(t.db, code);
  assert.deepEqual(first, { created: 11, skipped: 0 });

  const [store] = await t.sql`SELECT enabled FROM merch_stores WHERE event_id = ${eventId}`;
  assert.equal(store.enabled, false);

  const products = await t.sql`
    SELECT id, name_th, kind, publish_state, sale_enabled, base_price, image_ids, description_th, sort_order
    FROM merch_products WHERE event_id = ${eventId} ORDER BY sort_order`;
  assert.equal(products.length, 11);
  assert.deepEqual(
    products.map((p) => p.name_th),
    [...DRAFT_PRODUCT_NAMES],
  );
  for (const p of products) {
    assert.equal(p.kind, "single");
    assert.equal(p.publish_state, "draft");
    assert.equal(p.sale_enabled, false);
    assert.equal(p.base_price, null);
    assert.deepEqual(p.image_ids, []);
    assert.equal(p.description_th, null);
    const variants = await t.sql`SELECT id FROM merch_variants WHERE product_id = ${p.id}`;
    assert.equal(variants.length, 1);
  }

  // Edit one product and the store, then re-run.
  const target = products[2];
  await t.sql`UPDATE merch_products SET base_price = 12900, updated_at = now() - interval '1 day' WHERE id = ${target.id}`;
  await t.sql`UPDATE merch_stores SET enabled = true, shipping_info_th = 'x' WHERE event_id = ${eventId}`;
  const [beforeRow] = await t.sql`SELECT base_price, updated_at FROM merch_products WHERE id = ${target.id}`;
  const [storeBefore] = await t.sql`SELECT * FROM merch_stores WHERE event_id = ${eventId}`;

  const second = await seedDraftCatalog(t.db, code);
  assert.deepEqual(second, { created: 0, skipped: 11 });

  const [afterRow] = await t.sql`SELECT base_price, updated_at FROM merch_products WHERE id = ${target.id}`;
  assert.equal(afterRow.base_price, 12900);
  assert.equal(new Date(afterRow.updated_at).getTime(), new Date(beforeRow.updated_at).getTime());
  const [storeAfter] = await t.sql`SELECT * FROM merch_stores WHERE event_id = ${eventId}`;
  assert.deepEqual(storeAfter, storeBefore);
  const [count] = await t.sql`SELECT count(*)::int AS n FROM merch_products WHERE event_id = ${eventId}`;
  assert.equal(count.n, 11);
});

test("seedDraftCatalog rejects an unknown event code", { skip }, async () => {
  await assert.rejects(
    () => seedDraftCatalog(t.db, "NOPE-0000"),
    (error: unknown) => error instanceof MerchError && error.code === "MERCH_EVENT_NOT_FOUND",
  );
});
