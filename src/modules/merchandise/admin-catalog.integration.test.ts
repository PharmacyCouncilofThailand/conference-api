import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
import {
  adminToken,
  buildMerchTestApp,
  openMerchTestDatabase,
  type MerchTestDb,
} from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let otherEventId: number;
let auth: { authorization: string };
let adminId: number;
let imageId: string;
let otherImageId: string;

const base = (id = eventId) => `/api/backoffice/merchandise/events/${id}`;

async function insertImage(forEvent: number): Promise<string> {
  const key = `k-${Math.random().toString(36).slice(2)}`;
  const [row] = await t.sql<{ id: string }[]>`
    INSERT INTO merch_images (event_id, object_key, public_url, mime_type, width, height, byte_size, uploaded_by)
    VALUES (${forEvent}, ${key}, ${"https://img.example.test/" + key}, 'image/png', 10, 10, 100, ${adminId})
    RETURNING id`;
  return row.id;
}

async function call(method: string, path: string, payload?: unknown, forEvent = eventId) {
  return app.inject({
    method: method as "GET",
    url: `${base(forEvent)}${path}`,
    headers: auth,
    payload: payload as object | undefined,
  });
}

async function mkProduct(body: Record<string, unknown>, forEvent = eventId) {
  const res = await call("POST", "/products", body, forEvent);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().data;
}

const MISSING = "00000000-0000-4000-8000-000000000000";

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent();
  otherEventId = await t.createEvent();
  adminId = await t.createAdmin({ email: "boss@x.test" });
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register(
        (plugin) =>
          merchandiseAdminRoutes(plugin, {
            database: t.db,
            payso: null,
            paysoConfig: null,
            nodeEnv: "test",
          }),
        { prefix: "/api/backoffice" },
      );
    },
  });
  auth = { authorization: `Bearer ${adminToken(app, adminId, "boss@x.test")}` };
  imageId = await insertImage(eventId);
  otherImageId = await insertImage(otherEventId);
});

after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});

test("create: single gets default variant, bundle gets none, image and kind rules", { skip }, async () => {
  const single = await mkProduct({ kind: "single", nameTh: "เสื้อ", basePriceBaht: 250, imageIds: [imageId] });
  assert.equal(single.kind, "single");
  assert.equal(single.publishState, "draft");
  assert.equal(single.version, 1);
  assert.equal(single.variants.length, 1);
  assert.equal(single.variants[0].sizeTh, null);
  assert.equal(single.variants[0].colorTh, null);
  assert.equal(single.images.length, 1);

  const bundle = await mkProduct({ kind: "bundle", nameTh: "ชุด", basePriceBaht: 500 });
  assert.equal(bundle.variants.length, 0);

  const badImage = await call("POST", "/products", { kind: "single", nameTh: "x", imageIds: [otherImageId] });
  assert.equal(badImage.statusCode, 422);
  assert.equal(badImage.json().code, "MERCH_IMAGE_INVALID");

  const patchKind = await call("PATCH", `/products/${single.id}`, { expectedVersion: 1, kind: "bundle" });
  assert.equal(patchKind.statusCode, 400);

  const patched = await call("PATCH", `/products/${single.id}`, {
    expectedVersion: 1, nameTh: "เสื้อใหม่", saleEnabled: true,
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().data.version, 2);
  assert.equal(patched.json().data.nameTh, "เสื้อใหม่");
  assert.equal(patched.json().data.saleEnabled, true);

  const stale = await call("PATCH", `/products/${single.id}`, { expectedVersion: 1, nameTh: "z" });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "MERCH_VERSION_CONFLICT");

  const badImg = await call("PATCH", `/products/${single.id}`, { expectedVersion: 2, imageIds: [otherImageId] });
  assert.equal(badImg.statusCode, 422);
  assert.equal(badImg.json().code, "MERCH_IMAGE_INVALID");

  const list = await call("GET", "/products?kind=bundle");
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().data.length >= 1);
  assert.ok(list.json().data.every((p: { kind: string }) => p.kind === "bundle"));
  const search = await call("GET", "/products?search=" + encodeURIComponent("เสื้อใหม่"));
  assert.equal(search.json().data.length, 1);
});

test("variants: imageId must be a photo of the product; omitted keeps, null clears", { skip }, async () => {
  const second = await insertImage(eventId);
  const p = await mkProduct({ kind: "single", nameTh: "แก้ว", imageIds: [imageId, second] });
  const set = await call("PUT", `/products/${p.id}/variants`, [
    { sizeTh: "46Oz", imageId },
    { sizeTh: "32Oz", imageId: second },
  ]);
  assert.equal(set.statusCode, 200, set.body);
  const [big, small] = set.json().data.variants;
  assert.deepEqual([big.imageId, small.imageId], [imageId, second]);

  const kept = await call("PUT", `/products/${p.id}/variants`, [
    { id: big.id, sizeTh: "46Oz" },
    { id: small.id, sizeTh: "32Oz", imageId: null },
    { sizeTh: "20Oz" },
  ]);
  assert.equal(kept.statusCode, 200, kept.body);
  assert.deepEqual(kept.json().data.variants.map((v: { imageId: string | null }) => v.imageId), [imageId, null, null]);

  const unrelated = await insertImage(eventId);
  for (const bad of [unrelated, otherImageId, MISSING]) {
    const res = await call("PUT", `/products/${p.id}/variants`, [{ id: big.id, sizeTh: "46Oz", imageId: bad }]);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, "MERCH_VARIANT_IMAGE_INVALID");
  }
});

test("variants: replace semantics, shape, duplicate, bundle reference", { skip }, async () => {
  const shirt = await mkProduct({ kind: "single", nameTh: "เสื้อยืด", imageIds: [imageId] });
  const defaultId = shirt.variants[0].id;

  const mixed = await call("PUT", `/products/${shirt.id}/variants`, {
    variants: [{ id: defaultId }, { sizeTh: "S", priceBaht: 250 }],
  });
  assert.equal(mixed.statusCode, 422);
  assert.equal(mixed.json().code, "MERCH_VARIANT_SHAPE_MIXED");

  const dup = await call("PUT", `/products/${shirt.id}/variants`, {
    variants: [{ sizeTh: "S", colorTh: "ดำ", priceBaht: 1 }, { sizeTh: "S", colorTh: "ดำ", priceBaht: 2 }],
  });
  assert.equal(dup.statusCode, 422);
  assert.equal(dup.json().code, "MERCH_VARIANT_DUPLICATE");

  const ok = await call("PUT", `/products/${shirt.id}/variants`, [
    { sizeTh: "S", priceBaht: 250 },
    { sizeTh: "M", priceBaht: 300 },
  ]);
  assert.equal(ok.statusCode, 200, ok.body);
  const v = ok.json().data.variants;
  assert.deepEqual(v.map((x: { sizeTh: string }) => x.sizeTh), ["S", "M"]);
  assert.deepEqual(v.map((x: { priceBaht: number }) => x.priceBaht), [250, 300]);
  assert.equal(ok.json().data.version, 2);
  const gone = await t.sql`SELECT id FROM merch_variants WHERE id = ${defaultId}`;
  assert.equal(gone.length, 0);

  // swap sizes in place (keeps ids) and add L
  const [s, m] = v;
  const swapped = await call("PUT", `/products/${shirt.id}/variants`, {
    variants: [
      { id: s.id, sizeTh: "M", priceBaht: 250 },
      { id: m.id, sizeTh: "S", priceBaht: 300 },
      { sizeTh: "L", priceBaht: 310, saleEnabled: false },
    ],
  });
  assert.equal(swapped.statusCode, 200, swapped.body);
  assert.equal(swapped.json().data.variants.length, 3);
  assert.equal(swapped.json().data.variants[0].id, s.id);
  assert.equal(swapped.json().data.variants[0].sizeTh, "M");
  assert.equal(swapped.json().data.variants[2].saleEnabled, false);

  const foreign = await call("PUT", `/products/${shirt.id}/variants`, {
    variants: [{ id: MISSING, sizeTh: "XL" }],
  });
  assert.equal(foreign.statusCode, 422);
  assert.equal(foreign.json().code, "MERCH_VARIANT_INVALID");

  const bundle = await mkProduct({ kind: "bundle", nameTh: "ชุดเสื้อ", basePriceBaht: 600 });
  const bundleVariants = await call("PUT", `/products/${bundle.id}/variants`, { variants: [{ sizeTh: "S" }] });
  assert.equal(bundleVariants.statusCode, 422);
  assert.equal(bundleVariants.json().code, "MERCH_PRODUCT_KIND_INVALID");

  const comp = await call("PUT", `/products/${bundle.id}/components`, {
    components: [{ componentProductId: shirt.id, mode: "fixed", fixedVariantId: s.id, quantityPerBundle: 2 }],
  });
  assert.equal(comp.statusCode, 200, comp.body);
  assert.equal(comp.json().data.components.length, 1);
  assert.equal(comp.json().data.components[0].fixedVariantId, s.id);

  const removeUsed = await call("PUT", `/products/${shirt.id}/variants`, {
    variants: [{ id: m.id, sizeTh: "S", priceBaht: 300 }],
  });
  assert.equal(removeUsed.statusCode, 422);
  assert.equal(removeUsed.json().code, "MERCH_VARIANT_IN_BUNDLE");
  const still = await t.sql`SELECT id FROM merch_variants WHERE id = ${s.id}`;
  assert.equal(still.length, 1);
});

test("variants: price input accepts only whole-baht priceBaht", { skip }, async () => {
  const shirt = await mkProduct({ kind: "single", nameTh: "เสื้อบาท", imageIds: [imageId] });
  for (const bad of [{ priceMinor: 600 }, { price: 600 }, { priceBaht: 6.5 }, { priceBaht: 1_000_001 }]) {
    const res = await call("PUT", `/products/${shirt.id}/variants`, { variants: [{ sizeTh: "S", ...bad }] });
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} -> ${res.body}`);
  }
  const ok = await call("PUT", `/products/${shirt.id}/variants`, { variants: [{ sizeTh: "S", priceBaht: 6 }] });
  assert.equal(ok.statusCode, 200, ok.body);
  const [row] = await t.sql<{ price: number }[]>`SELECT price FROM merch_variants WHERE product_id = ${shirt.id}`;
  assert.equal(row.price, 6);
});

test("components: only single products, validated variants, replace", { skip }, async () => {
  const shirt = await mkProduct({ kind: "single", nameTh: "คอมโพเนนต์", imageIds: [imageId] });
  const bundleA = await mkProduct({ kind: "bundle", nameTh: "A", basePriceBaht: 100 });
  const bundleB = await mkProduct({ kind: "bundle", nameTh: "B", basePriceBaht: 100 });
  const variantId = shirt.variants[0].id;

  const nested = await call("PUT", `/products/${bundleA.id}/components`, {
    components: [{ componentProductId: bundleB.id, mode: "fixed", fixedVariantId: variantId, quantityPerBundle: 1 }],
  });
  assert.equal(nested.statusCode, 422);
  assert.equal(nested.json().code, "MERCH_COMPONENT_INVALID");

  const wrongVariant = await call("PUT", `/products/${bundleA.id}/components`, {
    components: [{ componentProductId: shirt.id, mode: "fixed", fixedVariantId: MISSING, quantityPerBundle: 1 }],
  });
  assert.equal(wrongVariant.statusCode, 422);
  assert.equal(wrongVariant.json().code, "MERCH_COMPONENT_INVALID");

  const otherSingle = await mkProduct({ kind: "single", nameTh: "other" }, otherEventId);
  const cross = await call("PUT", `/products/${bundleA.id}/components`, {
    components: [{
      componentProductId: otherSingle.id, mode: "selectable",
      allowedVariantIds: [otherSingle.variants[0].id], quantityPerBundle: 1,
    }],
  });
  assert.equal(cross.statusCode, 422);
  assert.equal(cross.json().code, "MERCH_COMPONENT_INVALID");

  const onSingle = await call("PUT", `/products/${shirt.id}/components`, { components: [] });
  assert.equal(onSingle.statusCode, 422);
  assert.equal(onSingle.json().code, "MERCH_PRODUCT_KIND_INVALID");

  const first = await call("PUT", `/products/${bundleA.id}/components`, {
    components: [{ componentProductId: shirt.id, mode: "selectable", allowedVariantIds: [variantId], quantityPerBundle: 3 }],
  });
  assert.equal(first.statusCode, 200, first.body);
  const cid = first.json().data.components[0].id;
  const second = await call("PUT", `/products/${bundleA.id}/components`, {
    components: [{ id: cid, componentProductId: shirt.id, mode: "fixed", fixedVariantId: variantId, quantityPerBundle: 1 }],
  });
  assert.equal(second.json().data.components[0].id, cid);
  assert.equal(second.json().data.components[0].mode, "fixed");
  const cleared = await call("PUT", `/products/${bundleA.id}/components`, { components: [] });
  assert.equal(cleared.json().data.components.length, 0);
});

test("publish: incomplete 422 with issues, complete publishes, unpublish returns draft", { skip }, async () => {
  const empty = await mkProduct({ kind: "single", nameTh: "ไม่ครบ" });
  const res = await call("POST", `/products/${empty.id}/publish`, {});
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "MERCH_PUBLISH_INCOMPLETE");
  assert.deepEqual(res.json().details.issues, empty.publishIssues);
  assert.ok(res.json().details.issues.includes("IMAGE_REQUIRED"));
  assert.ok(res.json().details.issues.includes("VARIANT_PRICE_REQUIRED"));

  const full = await mkProduct({ kind: "single", nameTh: "ครบ", basePriceBaht: 100, imageIds: [imageId] });
  assert.deepEqual(full.publishIssues, []);
  const pub = await call("POST", `/products/${full.id}/publish`, {});
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(pub.json().data.publishState, "published");
  assert.equal(pub.json().data.version, full.version + 1);

  const unpub = await call("POST", `/products/${full.id}/unpublish`, {});
  assert.equal(unpub.statusCode, 200);
  assert.equal(unpub.json().data.publishState, "draft");

  const audit = await t.sql`SELECT action FROM merch_audit_log WHERE entity_id = ${full.id}`;
  assert.ok(audit.some((a) => a.action === "product.publish"));
  assert.ok(audit.some((a) => a.action === "product.unpublish"));
});

test("bulk: per-row results, saleEnabled and categoryId, limits", { skip }, async () => {
  const a = await mkProduct({ kind: "single", nameTh: "bulk-a", saleEnabled: true });
  const b = await mkProduct({ kind: "single", nameTh: "bulk-b", saleEnabled: true });
  const missing = "00000000-0000-4000-8000-0000000000aa";
  const res = await call("POST", "/products/bulk", {
    ids: [a.id, b.id, missing], change: { saleEnabled: false },
  });
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json().data;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { id: a.id, ok: true, code: null, error: null });
  assert.equal(rows[2].ok, false);
  assert.equal(rows[2].code, "MERCH_PRODUCT_NOT_FOUND");
  const state = await t.sql`SELECT sale_enabled, version FROM merch_products WHERE id = ${a.id}`;
  assert.equal(state[0].sale_enabled, false);
  assert.equal(state[0].version, a.version + 1);

  const cat = (await call("POST", "/categories", { nameTh: "หมวด" })).json().data;
  const moved = await call("POST", "/products/bulk", { ids: [a.id, b.id], change: { categoryId: cat.id } });
  assert.ok(moved.json().data.every((r: { ok: boolean }) => r.ok));
  const cats = await t.sql`SELECT category_id FROM merch_products WHERE id = ANY(${[a.id, b.id]}::uuid[])`;
  assert.equal(cats.length, 2);
  assert.ok(cats.every((r) => r.category_id === cat.id));

  const tooMany = await call("POST", "/products/bulk", {
    ids: Array.from({ length: 201 }, () => "00000000-0000-4000-8000-0000000000bb"),
    change: { saleEnabled: true },
  });
  assert.equal(tooMany.statusCode, 400);
  const badChange = await call("POST", "/products/bulk", { ids: [a.id], change: {} });
  assert.equal(badChange.statusCode, 400);
  const badCategory = await call("POST", "/products/bulk", { ids: [a.id], change: { categoryId: MISSING } });
  assert.equal(badCategory.statusCode, 422);
  assert.equal(badCategory.json().code, "MERCH_CATEGORY_INVALID");
});

test("order products", { skip }, async () => {
  const x = await mkProduct({ kind: "single", nameTh: "ord-x" });
  const y = await mkProduct({ kind: "single", nameTh: "ord-y" });
  const all = (await call("GET", "/products")).json().data.map((p: { id: string }) => p.id);
  const rest = all.filter((id: string) => id !== x.id && id !== y.id);
  const res = await call("PUT", "/products/order", { ids: [y.id, x.id, ...rest] });
  assert.equal(res.statusCode, 200, res.body);
  const ids = res.json().data.map((p: { id: string }) => p.id);
  assert.equal(ids.slice(0, 2).join(), [y.id, x.id].join());
});

test("preview: drafts included, purchasable computed as open", { skip }, async () => {
  const shop = await t.createEvent();
  const img = await insertImage(shop);
  const draft = await mkProduct(
    { kind: "single", nameTh: "draft", basePriceBaht: 100, imageIds: [img], saleEnabled: true },
    shop,
  );
  const published = await mkProduct(
    { kind: "single", nameTh: "pub", basePriceBaht: 100, imageIds: [img], saleEnabled: true },
    shop,
  );
  const pubRes = await call("POST", `/products/${published.id}/publish`, {}, shop);
  assert.equal(pubRes.statusCode, 200);

  const store = await call("GET", "/preview/store", undefined, shop);
  assert.equal(store.statusCode, 200, store.body);
  const data = store.json().data;
  assert.equal(data.store.state, "disabled");
  const byId = new Map<string, { purchasable: boolean; unavailableCodes: string[] }>(
    data.products.map((p: { id: string }) => [p.id, p]),
  );
  assert.equal(data.products.length, 2);
  assert.equal(byId.get(published.id)?.purchasable, true);
  assert.equal(byId.get(draft.id)?.purchasable, false);
  assert.deepEqual(byId.get(draft.id)?.unavailableCodes, ["PRODUCT_DISABLED"]);

  const one = await call("GET", `/preview/products/${draft.id}`, undefined, shop);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().data.id, draft.id);
  assert.equal(one.json().data.hasOptions, false);
});

test("other event's product is 404 and auth is required", { skip }, async () => {
  const p = await mkProduct({ kind: "single", nameTh: "mine" });
  const wrong = await call("GET", `/products/${p.id}`, undefined, otherEventId);
  assert.equal(wrong.statusCode, 404);
  assert.equal(wrong.json().code, "MERCH_PRODUCT_NOT_FOUND");
  const attempts: Array<[string, string, unknown]> = [
    ["PATCH", `/products/${p.id}`, { expectedVersion: 1, nameTh: "z" }],
    ["PUT", `/products/${p.id}/variants`, { variants: [{ sizeTh: "S" }] }],
    ["PUT", `/products/${p.id}/components`, { components: [] }],
    ["POST", `/products/${p.id}/publish`, {}],
    ["POST", `/products/${p.id}/unpublish`, {}],
    ["GET", `/preview/products/${p.id}`, undefined],
  ];
  for (const [m, path, body] of attempts) {
    const r = await call(m, path, body, otherEventId);
    assert.equal(r.statusCode, 404, `${m} ${path}`);
  }
  const anon = await app.inject({ method: "GET", url: `${base()}/products` });
  assert.equal(anon.statusCode, 401);
});
