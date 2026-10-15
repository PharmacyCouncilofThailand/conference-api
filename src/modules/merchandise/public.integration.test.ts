import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { merchandisePublicRoutes } from "./routes.public.js";
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
let eventCode: string;
let auth: { authorization: string };
let adminId: number;
let imageId: string;
let storeVersion = 0;

const pub = (path: string, code = eventCode) => `/api/v1/merchandise/events/${code}${path}`;
const admin = (method: string, path: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url: `/api/backoffice/merchandise/events/${eventId}${path}`,
    headers: auth,
    payload: payload as object | undefined,
  });

async function mkProduct(body: Record<string, unknown>, publish = true) {
  const res = await admin("POST", "/products", { imageIds: [imageId], ...body });
  assert.equal(res.statusCode, 201, res.body);
  const product = res.json().data;
  if (publish) {
    const p = await admin("POST", `/products/${product.id}/publish`, {});
    assert.equal(p.statusCode, 200, p.body);
  }
  return product;
}

async function setStore(opensAt: string | null, closesAt: string | null, productionInfoTh: string | null = null) {
  const res = await admin("PUT", "/store", {
    expectedVersion: storeVersion,
    enabled: true,
    opensAt,
    closesAt,
    productionInfoTh,
    shippingInfoTh: null,
  });
  assert.equal(res.statusCode, 200, res.body);
  storeVersion += 1;
}

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventCode = `PUB-${Math.random().toString(36).slice(2, 8)}`;
  eventId = await t.createEvent(eventCode);
  adminId = await t.createAdmin({ email: "boss@x.test" });
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      const options = { database: t.db, payso: null, paysoConfig: null, nodeEnv: "test" };
      await a.register((p) => merchandiseAdminRoutes(p, options), { prefix: "/api/backoffice" });
      await a.register((p) => merchandisePublicRoutes(p, options), { prefix: "/api/v1/merchandise" });
    },
  });
  auth = { authorization: `Bearer ${adminToken(app, adminId, "boss@x.test")}` };
  const key = `k-${Math.random().toString(36).slice(2)}`;
  const [row] = await t.sql<{ id: string }[]>`
    INSERT INTO merch_images (event_id, object_key, public_url, mime_type, width, height, byte_size, uploaded_by)
    VALUES (${eventId}, ${key}, ${"https://img.example.test/" + key}, 'image/png', 10, 10, 100, ${adminId})
    RETURNING id`;
  imageId = row.id;
});

after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});

test("unknown event returns 404 MERCH_EVENT_NOT_FOUND on all routes", { skip }, async () => {
  for (const path of ["/store", "/products", "/products/00000000-0000-4000-8000-000000000000"]) {
    const res = await app.inject({ method: "GET", url: pub(path, "NOPE") });
    assert.equal(res.statusCode, 404, path);
    assert.equal(res.json().code, "MERCH_EVENT_NOT_FOUND");
    assert.equal(res.json().success, false);
  }
});

test("store: envelope, null productionInfoTh when empty, disabled without store row", { skip }, async () => {
  const first = await app.inject({ method: "GET", url: pub("/store") });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().success, true);
  assert.equal(first.json().data.state, "disabled");
  assert.equal(first.json().data.productionInfoTh, null);

  await setStore(hours(-1), hours(1), "");
  const res = await app.inject({ method: "GET", url: pub("/store") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.state, "open");
  assert.equal(res.json().data.eventCode, eventCode);
  assert.equal(res.json().data.productionInfoTh, null);
  assert.equal(res.json().data.shippingMinor, 5000);
});

test("products: drafts hidden, hasOptions, purchasable, 404 by id for draft", { skip }, async () => {
  const draft = await mkProduct({ kind: "single", nameTh: "ร่าง", basePriceMinor: 10000 }, false);
  const plain = await mkProduct({ kind: "single", nameTh: "สติกเกอร์", basePriceMinor: 5000, saleEnabled: true });

  const list = await app.inject({ method: "GET", url: pub("/products") });
  assert.equal(list.statusCode, 200, list.body);
  const body = list.json();
  assert.equal(body.success, true);
  const ids = body.data.items.map((p: { id: string }) => p.id);
  assert.ok(ids.includes(plain.id));
  assert.ok(!ids.includes(draft.id));
  assert.deepEqual(body.data.pagination, { page: 1, limit: 20, total: 1, totalPages: 1 });
  const item = body.data.items.find((p: { id: string }) => p.id === plain.id);
  assert.equal(item.hasOptions, false);
  assert.equal(item.purchasable, true);
  assert.deepEqual(item.unavailableCodes, []);

  const one = await app.inject({ method: "GET", url: pub(`/products/${plain.id}`) });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().data.id, plain.id);

  const hidden = await app.inject({ method: "GET", url: pub(`/products/${draft.id}`) });
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.json().code, "MERCH_PRODUCT_NOT_FOUND");
  const badId = await app.inject({ method: "GET", url: pub("/products/not-a-uuid") });
  assert.equal(badId.statusCode, 404);
});

test("products: pagination, kind and category filters, validation", { skip }, async () => {
  const cat = await admin("POST", "/categories", { nameTh: "หมวด" });
  assert.equal(cat.statusCode, 201, cat.body);
  const categoryId = cat.json().data.id;
  await mkProduct({ kind: "single", nameTh: "ในหมวด", basePriceMinor: 100, categoryId, saleEnabled: true });
  const total = (await app.inject({ method: "GET", url: pub("/products") })).json().data.pagination.total;
  assert.ok(total >= 2);

  const paged = await app.inject({ method: "GET", url: pub("/products?limit=1&page=2") });
  const p = paged.json().data;
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.pagination, { page: 2, limit: 1, total, totalPages: total });

  const beyond = await app.inject({ method: "GET", url: pub(`/products?limit=1&page=${total + 5}`) });
  assert.equal(beyond.json().data.items.length, 0);

  const byCat = await app.inject({ method: "GET", url: pub(`/products?categoryId=${categoryId}`) });
  assert.equal(byCat.json().data.items.length, 1);
  assert.equal(byCat.json().data.items[0].categoryId, categoryId);

  const bundles = await app.inject({ method: "GET", url: pub("/products?kind=bundle") });
  assert.ok(bundles.json().data.items.every((x: { kind: string }) => x.kind === "bundle"));

  for (const q of ["limit=101", "limit=0", "page=0", "kind=bad", "categoryId=zzz"]) {
    const res = await app.inject({ method: "GET", url: pub(`/products?${q}`) });
    assert.equal(res.statusCode, 400, q);
    assert.equal(res.json().code, "VALIDATION_ERROR");
  }
});

test("products with options report hasOptions=true", { skip }, async () => {
  const shirt = await mkProduct({ kind: "single", nameTh: "เสื้อ", basePriceMinor: 20000, saleEnabled: true }, false);
  const v = await admin("PUT", `/products/${shirt.id}/variants`, {
    variants: [{ sizeTh: "S" }, { sizeTh: "M" }],
  });
  assert.equal(v.statusCode, 200, v.body);
  assert.equal((await admin("POST", `/products/${shirt.id}/publish`, {})).statusCode, 200);
  const res = await app.inject({ method: "GET", url: pub(`/products/${shirt.id}`) });
  assert.equal(res.json().data.hasOptions, true);
  assert.equal(res.json().data.variants.length, 2);
});

test("closed store: products still listed, purchasable=false with STORE_NOT_OPEN", { skip }, async () => {
  await setStore(hours(-3), hours(-2));
  const store = await app.inject({ method: "GET", url: pub("/store") });
  assert.equal(store.json().data.state, "closed");
  const list = await app.inject({ method: "GET", url: pub("/products") });
  const items = list.json().data.items;
  assert.ok(items.length >= 1);
  for (const item of items) {
    assert.equal(item.purchasable, false);
    assert.ok(item.unavailableCodes.includes("STORE_NOT_OPEN"));
  }
  await setStore(hours(-1), hours(1));
});

test("bundle with draft component keeps a non-empty component name and is unpurchasable", { skip }, async () => {
  const comp = await mkProduct({ kind: "single", nameTh: "ส่วนประกอบร่าง", basePriceMinor: 3000, saleEnabled: true });
  const detail = await admin("GET", `/products/${comp.id}`);
  const variantId = detail.json().data.variants[0].id;
  const bundle = await mkProduct(
    { kind: "bundle", nameTh: "ชุดพิเศษ", basePriceMinor: 9000, saleEnabled: true },
    false,
  );
  const put = await admin("PUT", `/products/${bundle.id}/components`, {
    components: [{ componentProductId: comp.id, mode: "fixed", fixedVariantId: variantId }],
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await admin("POST", `/products/${bundle.id}/publish`, {})).statusCode, 200);

  const okRes = await app.inject({ method: "GET", url: pub(`/products/${bundle.id}`) });
  assert.equal(okRes.json().data.purchasable, true);
  assert.equal(okRes.json().data.components[0].nameTh, "ส่วนประกอบร่าง");

  assert.equal((await admin("POST", `/products/${comp.id}/unpublish`, {})).statusCode, 200);
  for (const url of [pub(`/products/${bundle.id}`), pub("/products?kind=bundle")]) {
    const res = await app.inject({ method: "GET", url });
    const data = res.json().data;
    const dto = data.items ? data.items.find((p: { id: string }) => p.id === bundle.id) : data;
    assert.equal(dto.purchasable, false);
    assert.ok(dto.unavailableCodes.includes("COMPONENT_UNAVAILABLE"));
    assert.equal(dto.components.length, 1);
    assert.equal(dto.components[0].nameTh, "ส่วนประกอบร่าง");
  }
});
