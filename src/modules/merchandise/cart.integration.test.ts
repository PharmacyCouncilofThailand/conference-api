import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
import { merchandiseBuyerRoutes } from "./routes.buyer.js";
import {
  adminToken,
  buildMerchTestApp,
  buyerToken,
  openMerchTestDatabase,
  type MerchTestDb,
} from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let eventCode: string;
let adminAuth: { authorization: string };
let adminId: number;
let imageId: string;
let storeVersion = 0;
let buyerId: number;
let buyer: { authorization: string };

const cartUrl = (path = "") => `/api/v1/merchandise/events/${eventCode}/cart${path}`;
const admin = (method: string, path: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url: `/api/backoffice/merchandise/events/${eventId}${path}`,
    headers: adminAuth,
    payload: payload as object | undefined,
  });
const call = (method: string, path: string, payload?: unknown, headers = buyer) =>
  app.inject({ method: method as "GET", url: cartUrl(path), headers, payload: payload as object | undefined });
const tokenFor = (userId: number) => ({ authorization: `Bearer ${buyerToken(app, userId)}` });

async function mkProduct(body: Record<string, unknown>) {
  const res = await admin("POST", "/products", { imageIds: [imageId], ...body });
  assert.equal(res.statusCode, 201, res.body);
  const product = res.json().data;
  const p = await admin("POST", `/products/${product.id}/publish`, {});
  assert.equal(p.statusCode, 200, p.body);
  return product;
}

async function variantsOf(productId: string) {
  const res = await admin("GET", `/products/${productId}`);
  return res.json().data.variants as { id: string; sizeTh: string | null; priceBaht: number | null }[];
}

async function setStore(opensAt: string | null, closesAt: string | null) {
  const res = await admin("PUT", "/store", {
    expectedVersion: storeVersion,
    enabled: true,
    opensAt,
    closesAt,
    productionInfoTh: null,
    shippingInfoTh: null,
  });
  assert.equal(res.statusCode, 200, res.body);
  storeVersion += 1;
}

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventCode = `CART-${Math.random().toString(36).slice(2, 8)}`;
  eventId = await t.createEvent(eventCode);
  adminId = await t.createAdmin({ email: "boss@x.test" });
  buyerId = await t.createUser({ phone: "0899999999", email: "buyer@x.test" });
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      const options = { database: t.db, payso: null, paysoConfig: null, nodeEnv: "test" };
      await a.register((p) => merchandiseAdminRoutes(p, options), { prefix: "/api/backoffice" });
      await a.register((p) => merchandiseBuyerRoutes(p, options), { prefix: "/api/v1/merchandise" });
    },
  });
  adminAuth = { authorization: `Bearer ${adminToken(app, adminId, "boss@x.test")}` };
  buyer = tokenFor(buyerId);
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

test("no token returns 401; empty cart has buyerDefaults", { skip }, async () => {
  const anon = await app.inject({ method: "GET", url: cartUrl() });
  assert.equal(anon.statusCode, 401);
  await setStore(hours(-1), hours(1));
  const res = await call("GET", "");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const data = res.json().data;
  assert.deepEqual(data.items, []);
  assert.deepEqual(data.buyerDefaults, { fullName: "Test Buyer", phone: "0899999999", email: "buyer@x.test" });
  assert.match(data.cartVersion, /^[0-9a-f]{64}$/);
});

test("add single: valid line, total = price + shipping; same selection sums; >9999 rejected", { skip }, async () => {
  const p = await mkProduct({ kind: "single", nameTh: "สติกเกอร์", basePriceBaht: 50, saleEnabled: true });
  const [v] = await variantsOf(p.id);
  const add = (quantity: number) =>
    call("POST", "/items", { productId: p.id, variantId: v.id, bundleSelections: [], quantity });
  const first = await add(2);
  assert.equal(first.statusCode, 200, first.body);
  const line = first.json().data.items[0];
  assert.equal(line.valid, true);
  assert.equal(line.unitPriceBaht, 50);
  assert.equal(line.lineTotalBaht, 100);
  assert.equal(first.json().data.amounts.subtotalBaht, 100);
  assert.equal(first.json().data.amounts.totalBaht, 100 + 50);

  const second = await add(3);
  assert.equal(second.statusCode, 200, second.body);
  const items = second.json().data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 5);

  const big = await add(10000);
  assert.equal(big.statusCode, 400);
  assert.equal(big.json().code, "VALIDATION_ERROR");
  const over = await add(9999);
  assert.equal(over.statusCode, 400, "summed quantity beyond 9999 is rejected");
  await call("DELETE", `/items/${items[0].id}`);
});

test("store not_open rejects add with MERCH_PRODUCT_UNAVAILABLE", { skip }, async () => {
  const p = await mkProduct({ kind: "single", nameTh: "ปิด", basePriceBaht: 10, saleEnabled: true });
  const [v] = await variantsOf(p.id);
  await setStore(hours(2), hours(3));
  const res = await call("POST", "/items", { productId: p.id, variantId: v.id, bundleSelections: [], quantity: 1 });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().code, "MERCH_PRODUCT_UNAVAILABLE");
  assert.ok(res.json().details.issueCodes.includes("STORE_NOT_OPEN"));
  await setStore(hours(-1), hours(1));
});

test("invalid selection returns MERCH_SELECTION_INVALID", { skip }, async () => {
  const p = await mkProduct({ kind: "single", nameTh: "เลือก", basePriceBaht: 10, saleEnabled: true });
  const res = await call("POST", "/items", {
    productId: p.id,
    variantId: "00000000-0000-4000-8000-000000000000",
    bundleSelections: [],
    quantity: 1,
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().code, "MERCH_SELECTION_INVALID");
  assert.ok(res.json().details.issueCodes.includes("VARIANT_NOT_ALLOWED"));
});

test("disabled variant keeps the line invalid with null amounts; cartVersion tracks price changes", { skip }, async () => {
  const headers = tokenFor(await t.createUser({ email: "second@x.test" }));
  const shirt = await mkProduct({ kind: "single", nameTh: "เสื้อ", basePriceBaht: 200, saleEnabled: true });
  const put = await admin("PUT", `/products/${shirt.id}/variants`, { variants: [{ sizeTh: "S" }, { sizeTh: "M" }] });
  assert.equal(put.statusCode, 200, put.body);
  const [s, m] = await variantsOf(shirt.id);
  const added = await call("POST", "/items", { productId: shirt.id, variantId: s.id, bundleSelections: [], quantity: 1 }, headers);
  assert.equal(added.statusCode, 200, added.body);
  const itemId = added.json().data.items[0].id;

  const first = (await call("GET", "", undefined, headers)).json().data;
  const reprice = await admin("PUT", `/products/${shirt.id}/variants`, {
    variants: [
      { id: s.id, sizeTh: "S", priceBaht: 250 },
      { id: m.id, sizeTh: "M" },
    ],
  });
  assert.equal(reprice.statusCode, 200, reprice.body);
  const second = (await call("GET", "", undefined, headers)).json().data;
  assert.notEqual(second.cartVersion, first.cartVersion);
  assert.equal(second.items[0].unitPriceBaht, 250);

  const off = await admin("PUT", `/products/${shirt.id}/variants`, {
    variants: [
      { id: s.id, sizeTh: "S", priceBaht: 250, saleEnabled: false },
      { id: m.id, sizeTh: "M" },
    ],
  });
  assert.equal(off.statusCode, 200, off.body);
  const res = await call("GET", "", undefined, headers);
  const data = res.json().data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].valid, false);
  assert.ok(data.items[0].issueCodes.includes("VARIANT_DISABLED"));
  assert.equal(data.items[0].unitPriceBaht, null);
  assert.equal(data.items[0].lineTotalBaht, null);
  assert.equal(data.amounts, null);
  assert.notEqual(data.cartVersion, second.cartVersion);

  const fix = await call("PATCH", `/items/${itemId}`, { variantId: m.id, quantity: 2 }, headers);
  assert.equal(fix.statusCode, 200, fix.body);
  assert.equal(fix.json().data.items[0].valid, true);
  assert.equal(fix.json().data.items[0].quantity, 2);
});

test("PATCH merges into an existing line with the same selection", { skip }, async () => {
  const headers = tokenFor(await t.createUser({ email: "merge@x.test" }));
  const shirt = await mkProduct({ kind: "single", nameTh: "เสื้อรวม", basePriceBaht: 10, saleEnabled: true });
  await admin("PUT", `/products/${shirt.id}/variants`, { variants: [{ sizeTh: "S" }, { sizeTh: "M" }] });
  const [s, m] = await variantsOf(shirt.id);
  const body = (variantId: string, quantity: number) => ({ productId: shirt.id, variantId, bundleSelections: [], quantity });
  await call("POST", "/items", body(s.id, 1), headers);
  const two = await call("POST", "/items", body(m.id, 4), headers);
  assert.equal(two.json().data.items.length, 2);
  const sItem = two.json().data.items.find((i: { variantId: string }) => i.variantId === s.id);
  const merged = await call("PATCH", `/items/${sItem.id}`, { variantId: m.id }, headers);
  assert.equal(merged.statusCode, 200, merged.body);
  assert.equal(merged.json().data.items.length, 1);
  assert.equal(merged.json().data.items[0].quantity, 5);
});

test("another user's item returns 404 on PATCH and DELETE; DELETE removes own", { skip }, async () => {
  const p = await mkProduct({ kind: "single", nameTh: "ของฉัน", basePriceBaht: 10, saleEnabled: true });
  const [v] = await variantsOf(p.id);
  const added = await call("POST", "/items", { productId: p.id, variantId: v.id, bundleSelections: [], quantity: 1 });
  const itemId = added.json().data.items.find((i: { productId: string }) => i.productId === p.id).id;
  const headers = tokenFor(await t.createUser({ email: "other@x.test" }));
  const patch = await call("PATCH", `/items/${itemId}`, { quantity: 3 }, headers);
  assert.equal(patch.statusCode, 404, patch.body);
  assert.equal(patch.json().code, "MERCH_CART_ITEM_NOT_FOUND");
  assert.equal((await call("DELETE", `/items/${itemId}`, undefined, headers)).statusCode, 404);
  assert.equal((await call("DELETE", "/items/not-a-uuid")).statusCode, 404);
  const del = await call("DELETE", `/items/${itemId}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.ok(!del.json().data.items.some((i: { id: string }) => i.id === itemId));
});

test("bundle: selection key merges regardless of selection order", { skip }, async () => {
  const comp = await mkProduct({ kind: "single", nameTh: "ส่วนประกอบ", basePriceBaht: 10, saleEnabled: true });
  await admin("PUT", `/products/${comp.id}/variants`, { variants: [{ sizeTh: "S" }, { sizeTh: "M" }] });
  const [s, m] = await variantsOf(comp.id);
  const bundle = await admin("POST", "/products", {
    imageIds: [imageId], kind: "bundle", nameTh: "ชุด", basePriceBaht: 90, saleEnabled: true,
  });
  const bid = bundle.json().data.id;
  const put = await admin("PUT", `/products/${bid}/components`, {
    components: [
      { componentProductId: comp.id, mode: "selectable", allowedVariantIds: [s.id, m.id] },
      { componentProductId: comp.id, mode: "selectable", allowedVariantIds: [s.id, m.id] },
    ],
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await admin("POST", `/products/${bid}/publish`, {})).statusCode, 200);
  const comps = (await admin("GET", `/products/${bid}`)).json().data.components as { id: string }[];
  const headers = tokenFor(await t.createUser({ email: "bundle@x.test" }));
  const sel1 = [
    { componentId: comps[0].id, variantId: s.id },
    { componentId: comps[1].id, variantId: m.id },
  ];
  const incomplete = await call("POST", "/items", { productId: bid, variantId: null, bundleSelections: [sel1[0]], quantity: 1 }, headers);
  assert.equal(incomplete.statusCode, 422, incomplete.body);
  assert.equal(incomplete.json().code, "MERCH_SELECTION_INVALID");
  await call("POST", "/items", { productId: bid, variantId: null, bundleSelections: sel1, quantity: 1 }, headers);
  const again = await call("POST", "/items", { productId: bid, variantId: null, bundleSelections: [...sel1].reverse(), quantity: 2 }, headers);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().data.items.length, 1);
  assert.equal(again.json().data.items[0].quantity, 3);
  assert.equal(again.json().data.amounts.totalBaht, 270 + 50);
});

function forgedToken(id: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ id, email: "victim@x.test", role: "general" });
  const sig = createHmac("sha256", "some-other-secret").update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

test("rate limit: enveloped no-store 429 on the 61st request; forged tokens do not drain a victim bucket", { skip }, async () => {
  const victim = await t.createUser({ email: "limited@x.test" });
  const headers = tokenFor(victim);
  const forged = { authorization: "Bearer " + forgedToken(victim) };
  for (let i = 0; i < 70; i += 1) await call("GET", "", undefined, forged);
  let last = await call("GET", "", undefined, headers);
  for (let i = 0; i < 59; i += 1) last = await call("GET", "", undefined, headers);
  assert.equal(last.statusCode, 200, "forged requests did not consume the victim's 60 requests");
  last = await call("GET", "", undefined, headers);
  assert.equal(last.statusCode, 429);
  assert.equal(last.json().success, false);
  assert.equal(last.json().code, "MERCH_RATE_LIMITED");
  assert.ok(last.json().requestId);
  assert.equal(last.headers["cache-control"], "no-store");
  assert.equal((await call("GET", "")).statusCode, 200, "other buyers are unaffected");
});
