import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { CreateQrInput, CreateQrResult, PaysoConfig } from "./payments/payso-client.js";
import { verifyPromptPayPayload } from "./payments/qr-payload.js";
import { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
import { merchandiseBuyerRoutes } from "./routes.buyer.js";
import {
  adminToken,
  buildMerchTestApp,
  buyerToken,
  fakePayso,
  openMerchTestDatabase,
  type MerchTestDb,
} from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

const EVENT_CODE = "PRIS2026";
let t: MerchTestDb;
let app: FastifyInstance;
let appNoConfig: FastifyInstance;
let eventId: number;
let adminAuth: { authorization: string };
let storeVersion = 0;
let productId: string;
let variantId: string;
let payso: ReturnType<typeof fakePayso>;
let createQrOverride: ((input: CreateQrInput) => CreateQrResult | Promise<CreateQrResult>) | null = null;

const paysoConfig: PaysoConfig = {
  merchantId: "12345678",
  authKey: "auth",
  apiKey: "api",
  secretKey: "secret",
  qrPayloadKey: randomBytes(32).toString("base64"),
  nodeEnv: "test",
};

const recipient = {
  fullName: "สมชาย ใจดี",
  phone: "081-234-5678",
  addressLine: "99/1 ถนนสุขุมวิท",
  subdistrict: "คลองเตย",
  district: "คลองเตย",
  province: "กรุงเทพมหานคร",
  postalCode: "10110",
  company: null,
  deliveryNote: null,
};

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const auth = (userId: number) => ({ authorization: `Bearer ${buyerToken(app, userId)}` });

const admin = (method: string, path: string, payload?: unknown) =>
  app.inject({
    method: method as "GET",
    url: `/api/backoffice/merchandise/events/${eventId}${path}`,
    headers: adminAuth,
    payload: payload as object | undefined,
  });

async function setStore(opensAt: string | null, closesAt: string | null) {
  const res = await admin("PUT", "/store", {
    expectedVersion: storeVersion,
    enabled: true,
    opensAt,
    closesAt,
    productionInfoTh: "ผลิตหลังปิดรับ",
    shippingInfoTh: "ส่งภายใน 30 วัน",
  });
  assert.equal(res.statusCode, 200, res.body);
  storeVersion += 1;
}

async function newBuyer(): Promise<{ id: number; headers: { authorization: string } }> {
  const id = await t.createUser({ phone: "0899999999" });
  return { id, headers: auth(id) };
}

async function addToCart(headers: { authorization: string }, quantity = 2, target = app) {
  const res = await target.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/cart/items`,
    headers,
    payload: { productId, variantId, bundleSelections: [], quantity },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.cartVersion as string;
}

async function cartVersion(headers: { authorization: string }, target = app): Promise<string> {
  const res = await target.inject({
    method: "GET",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/cart`,
    headers,
  });
  return res.json().data.cartVersion as string;
}

function confirm(
  headers: { authorization: string },
  key: string,
  body: Record<string, unknown>,
  target = app,
) {
  return target.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/orders`,
    headers: { ...headers, "idempotency-key": key },
    payload: body,
  });
}

async function attemptsOf(orderId: string) {
  return t.sql<
    { id: string; status: string; failure_code: string | null; next_check_at: Date | null; qr_payload_enc: Buffer | null }[]
  >`SELECT id, status, failure_code, next_check_at, qr_payload_enc FROM merch_payment_attempts WHERE order_id = ${orderId}`;
}

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent(EVENT_CODE);
  const adminId = await t.createAdmin({ email: "boss@x.test" });
  const defaultPayso = fakePayso();
  payso = fakePayso({
    createQr: (input) => (createQrOverride ? createQrOverride(input) : defaultPayso.createQr(input)),
  });
  const options = { database: t.db, payso, paysoConfig, nodeEnv: "test" };
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register((p) => merchandiseAdminRoutes(p, options), { prefix: "/api/backoffice" });
      await a.register((p) => merchandiseBuyerRoutes(p, options), { prefix: "/api/v1/merchandise" });
    },
  });
  const noConfig = { database: t.db, payso: null, paysoConfig: null, nodeEnv: "test" };
  appNoConfig = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register((p) => merchandiseBuyerRoutes(p, noConfig), { prefix: "/api/v1/merchandise" });
    },
  });
  adminAuth = { authorization: `Bearer ${adminToken(app, adminId, "boss@x.test")}` };
  const key = `k-${Math.random().toString(36).slice(2)}`;
  const [image] = await t.sql<{ id: string }[]>`
    INSERT INTO merch_images (event_id, object_key, public_url, mime_type, width, height, byte_size, uploaded_by)
    VALUES (${eventId}, ${key}, ${"https://img.example.test/" + key}, 'image/png', 10, 10, 100, ${adminId})
    RETURNING id`;
  await setStore(hours(-1), hours(1));
  const created = await admin("POST", "/products", {
    imageIds: [image.id],
    kind: "single",
    nameTh: "เสื้อยืด",
    basePriceMinor: 25000,
    saleEnabled: true,
  });
  assert.equal(created.statusCode, 201, created.body);
  productId = created.json().data.id;
  const published = await admin("POST", `/products/${productId}/publish`, {});
  assert.equal(published.statusCode, 200, published.body);
  variantId = (await admin("GET", `/products/${productId}`)).json().data.variants[0].id;
});

after(async () => {
  if (skip) return;
  await app.close();
  await appNoConfig.close();
  await t.close();
});

let firstOrderId: string;
let firstBuyer: { id: number; headers: { authorization: string } };

test("happy path: 201, order number, amounts, cart emptied, active QR stored encrypted", { skip }, async () => {
  firstBuyer = await newBuyer();
  const version = await addToCart(firstBuyer.headers, 2);
  const res = await confirm(firstBuyer.headers, "key-happy-1", { cartVersion: version, recipient });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const { order, replayed } = res.json().data;
  firstOrderId = order.id;
  assert.equal(replayed, false);
  assert.equal(order.orderNumber, "PRIS2026-M-000001");
  assert.deepEqual(order.amounts, { subtotalMinor: 50000, shippingMinor: 5000, totalMinor: 55000, currency: "THB" });
  assert.equal(order.paymentStatus, "pending");
  assert.equal(order.recipient.phone, "0812345678");
  assert.equal(order.buyer.phone, "0899999999");
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].nameTh, "เสื้อยืด");
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].unitPriceMinor, 25000);
  assert.equal(order.productionInfoTh, "ผลิตหลังปิดรับ");
  assert.equal(order.payment.state, "qr_active");
  assert.equal(order.payment.canRequestNewQr, false);
  const payload = order.payment.attempt.qrPayload as string;
  assert.ok(verifyPromptPayPayload(payload, 55000).ok, "payload is a PromptPay QR for 550.00");
  assert.match(payload, /5406550\.00/);

  const cart = await app.inject({
    method: "GET",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/cart`,
    headers: firstBuyer.headers,
  });
  assert.deepEqual(cart.json().data.items, []);

  const [attempt] = await attemptsOf(order.id);
  assert.equal(attempt.status, "active");
  assert.equal(attempt.failure_code, null, "provider expiry within tolerance: no fallback");
  assert.ok(attempt.qr_payload_enc);
  assert.notDeepEqual(Buffer.from(attempt.qr_payload_enc), Buffer.from(payload, "utf8"));
  assert.ok(!Buffer.from(attempt.qr_payload_enc).includes(Buffer.from("550.00")));
  assert.match(payso.calls.createQr[0].referenceNo, /^7\d{11}$/);
  assert.equal(payso.calls.createQr[0].amountMinor, 55000);
  assert.equal(payso.calls.createQr[0].productDetail, "PRIS2026 M 000001");
});

test("second order gets the next number", { skip }, async () => {
  const buyer = await newBuyer();
  const version = await addToCart(buyer.headers, 1);
  const res = await confirm(buyer.headers, "key-second", { cartVersion: version, recipient });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().data.order.orderNumber, "PRIS2026-M-000002");
});

test("same key + same body replays without a second attempt; different body is 422", { skip }, async () => {
  const buyer = await newBuyer();
  const version = await addToCart(buyer.headers, 1);
  const body = { cartVersion: version, recipient };
  const first = await confirm(buyer.headers, "key-replay", body);
  assert.equal(first.statusCode, 201, first.body);
  const calls = payso.calls.createQr.length;
  const again = await confirm(buyer.headers, "key-replay", body);
  assert.ok(again.statusCode === 200 || again.statusCode === 201, again.body);
  assert.equal(again.json().data.replayed, true);
  assert.equal(again.json().data.order.id, first.json().data.order.id);
  assert.equal(payso.calls.createQr.length, calls, "no createQr on replay");
  assert.equal((await attemptsOf(first.json().data.order.id)).length, 1);

  const other = await confirm(buyer.headers, "key-replay", {
    cartVersion: version,
    recipient: { ...recipient, fullName: "คนอื่น" },
  });
  assert.equal(other.statusCode, 422, other.body);
  assert.equal(other.json().code, "MERCH_IDEMPOTENCY_KEY_REUSED");
});

test("concurrent requests with the same key create one order and one attempt", { skip }, async () => {
  const buyer = await newBuyer();
  const version = await addToCart(buyer.headers, 3);
  const body = { cartVersion: version, recipient };
  const [a, b] = await Promise.all([
    confirm(buyer.headers, "key-race", body),
    confirm(buyer.headers, "key-race", body),
  ]);
  assert.ok([200, 201].includes(a.statusCode), a.body);
  assert.ok([200, 201].includes(b.statusCode), b.body);
  const replays = [a, b].map((r) => r.json().data.replayed);
  assert.deepEqual(replays.sort(), [false, true]);
  assert.equal(a.json().data.order.id, b.json().data.order.id);
  const orders = await t.sql`SELECT id FROM merch_orders WHERE buyer_user_id = ${buyer.id}`;
  assert.equal(orders.length, 1);
  assert.equal((await attemptsOf(a.json().data.order.id)).length, 1);
});

test("stale cartVersion and a price change after the cart read both return 409 MERCH_CART_CHANGED", { skip }, async () => {
  const buyer = await newBuyer();
  const stale = await addToCart(buyer.headers, 1);
  await addToCart(buyer.headers, 1);
  const res = await confirm(buyer.headers, "key-stale", { cartVersion: stale, recipient });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, "MERCH_CART_CHANGED");

  const current = await cartVersion(buyer.headers);
  await t.sql`UPDATE merch_products SET base_price = 26000 WHERE id = ${productId}`;
  try {
    const priced = await confirm(buyer.headers, "key-price", { cartVersion: current, recipient });
    assert.equal(priced.statusCode, 409, priced.body);
    assert.equal(priced.json().code, "MERCH_CART_CHANGED");
  } finally {
    await t.sql`UPDATE merch_products SET base_price = 25000 WHERE id = ${productId}`;
  }
  const orders = await t.sql`SELECT id FROM merch_orders WHERE buyer_user_id = ${buyer.id}`;
  assert.equal(orders.length, 0);
});

test("order total over 2,000,000 THB is 422 MERCH_ORDER_TOO_LARGE; exactly 2,000,000 THB is accepted", { skip }, async () => {
  await t.sql`UPDATE merch_products SET base_price = 100000000 WHERE id = ${productId}`;
  try {
    const buyer = await newBuyer();
    const version = await addToCart(buyer.headers, 9999);
    const res = await confirm(buyer.headers, "key-too-large", { cartVersion: version, recipient });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().code, "MERCH_ORDER_TOO_LARGE");
    const orders = await t.sql`SELECT id FROM merch_orders WHERE buyer_user_id = ${buyer.id}`;
    assert.equal(orders.length, 0);

    await t.sql`UPDATE merch_products SET base_price = 99997500 WHERE id = ${productId}`;
    const edge = await newBuyer();
    const edgeVersion = await addToCart(edge.headers, 2);
    const ok = await confirm(edge.headers, "key-at-limit", { cartVersion: edgeVersion, recipient });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(ok.json().data.order.amounts.totalMinor, 200_000_000);
  } finally {
    await t.sql`UPDATE merch_products SET base_price = 25000 WHERE id = ${productId}`;
  }
});

test("closed store 409, empty cart 422, invalid line 422 with details.items", { skip }, async () => {
  const buyer = await newBuyer();
  const empty = await confirm(buyer.headers, "key-empty", { cartVersion: await cartVersion(buyer.headers), recipient });
  assert.equal(empty.statusCode, 422, empty.body);
  assert.equal(empty.json().code, "MERCH_CART_EMPTY");

  const version = await addToCart(buyer.headers, 1);
  await setStore(hours(-2), hours(-1));
  try {
    const closed = await confirm(buyer.headers, "key-closed", { cartVersion: version, recipient });
    assert.equal(closed.statusCode, 409, closed.body);
    assert.equal(closed.json().code, "MERCH_PREORDER_CLOSED");
  } finally {
    await setStore(hours(-1), hours(1));
  }

  await t.sql`UPDATE merch_products SET sale_enabled = false WHERE id = ${productId}`;
  try {
    const invalidVersion = await cartVersion(buyer.headers);
    const invalid = await confirm(buyer.headers, "key-invalid", { cartVersion: invalidVersion, recipient });
    assert.equal(invalid.statusCode, 422, invalid.body);
    assert.equal(invalid.json().code, "MERCH_CART_INVALID");
    const items = invalid.json().details.items as { id: string; issueCodes: string[] }[];
    assert.equal(items.length, 1);
    assert.ok(items[0].issueCodes.length > 0);
  } finally {
    await t.sql`UPDATE merch_products SET sale_enabled = true WHERE id = ${productId}`;
  }
});

test("rejects a missing or malformed Idempotency-Key and an invalid recipient", { skip }, async () => {
  const buyer = await newBuyer();
  const version = await addToCart(buyer.headers, 1);
  const bad = await confirm(buyer.headers, "bad key!", { cartVersion: version, recipient });
  assert.equal(bad.statusCode, 400, bad.body);
  const badRecipient = await confirm(buyer.headers, "key-badrecipient", {
    cartVersion: version,
    recipient: { ...recipient, postalCode: "1011" },
  });
  assert.equal(badRecipient.statusCode, 400, badRecipient.body);
  assert.equal(badRecipient.json().code, "VALIDATION_ERROR");
});

test("createQr unknown: order still 201, awaiting_qr, attempt create_unknown with next_check_at", { skip }, async () => {
  const buyer = await newBuyer();
  const version = await addToCart(buyer.headers, 1);
  createQrOverride = () => ({ kind: "unknown", code: "QR_NETWORK_ERROR" });
  try {
    const res = await confirm(buyer.headers, "key-unknown", { cartVersion: version, recipient });
    assert.equal(res.statusCode, 201, res.body);
    const payment = res.json().data.order.payment;
    assert.equal(payment.state, "awaiting_qr");
    assert.equal(payment.canRequestNewQr, true);
    assert.equal(payment.attempt.qrPayload, null);
    const [attempt] = await attemptsOf(res.json().data.order.id);
    assert.equal(attempt.status, "create_unknown");
    assert.equal(attempt.failure_code, "QR_NETWORK_ERROR");
    assert.ok(attempt.next_check_at);
  } finally {
    createQrOverride = null;
  }
});

test("missing payment config: order 201, attempt create_failed PAYMENT_NOT_CONFIGURED", { skip }, async () => {
  const buyer = await newBuyer();
  const version = await addToCart(buyer.headers, 1, appNoConfig);
  const res = await confirm(buyer.headers, "key-noconfig", { cartVersion: version, recipient }, appNoConfig);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().data.order.payment.state, "awaiting_qr");
  const [attempt] = await attemptsOf(res.json().data.order.id);
  assert.equal(attempt.status, "create_failed");
  assert.equal(attempt.failure_code, "PAYMENT_NOT_CONFIGURED");
});

test("GET /orders/:id: owner only, no-store, payload while active, verifying then qr_expired_open", { skip }, async () => {
  const get = (headers: { authorization: string }) =>
    app.inject({ method: "GET", url: `/api/v1/merchandise/orders/${firstOrderId}`, headers });
  const stranger = await newBuyer();
  const denied = await get(stranger.headers);
  assert.equal(denied.statusCode, 404, denied.body);

  const own = await get(firstBuyer.headers);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.headers["cache-control"], "no-store");
  assert.equal(own.json().data.payment.state, "qr_active");
  assert.ok(own.json().data.payment.attempt.qrPayload);

  await t.sql`UPDATE merch_payment_attempts SET expires_at = clock_timestamp() - interval '30 seconds'
    WHERE order_id = ${firstOrderId}`;
  const verifying = (await get(firstBuyer.headers)).json().data.payment;
  assert.equal(verifying.state, "verifying");
  assert.equal(verifying.attempt.qrPayload, null);
  assert.ok(verifying.retryAfterSeconds > 0 && verifying.retryAfterSeconds <= 90);

  await t.sql`UPDATE merch_payment_attempts SET expires_at = clock_timestamp() - interval '3 minutes'
    WHERE order_id = ${firstOrderId}`;
  const expired = (await get(firstBuyer.headers)).json().data.payment;
  assert.equal(expired.state, "qr_expired_open");
  assert.equal(expired.canRequestNewQr, true);
  assert.equal(expired.attempt.qrPayload, null);

  const malformed = await app.inject({
    method: "GET",
    url: "/api/v1/merchandise/orders/not-a-uuid",
    headers: firstBuyer.headers,
  });
  assert.equal(malformed.statusCode, 404);
});

test("GET /events/:code/orders lists only own orders, newest first", { skip }, async () => {
  const buyer = await newBuyer();
  const v1 = await addToCart(buyer.headers, 1);
  const o1 = await confirm(buyer.headers, "key-list-1", { cartVersion: v1, recipient });
  const v2 = await addToCart(buyer.headers, 2);
  const o2 = await confirm(buyer.headers, "key-list-2", { cartVersion: v2, recipient });
  assert.equal(o2.statusCode, 201, o2.body);
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/orders?page=1&limit=10`,
    headers: buyer.headers,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const data = res.json().data;
  assert.deepEqual(
    data.items.map((o: { id: string }) => o.id),
    [o2.json().data.order.id, o1.json().data.order.id],
  );
  assert.deepEqual(data.pagination, { page: 1, limit: 10, total: 2, totalPages: 1 });
  assert.equal(data.items[0].paymentStatus, "pending");
  assert.equal(data.items[0].amounts.totalMinor, 55000);
});

test("order items are snapshots: renaming the product does not change them", { skip }, async () => {
  await t.sql`UPDATE merch_products SET name_th = 'ชื่อใหม่' WHERE id = ${productId}`;
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/merchandise/orders/${firstOrderId}`,
      headers: firstBuyer.headers,
    });
    assert.equal(res.json().data.items[0].nameTh, "เสื้อยืด");
  } finally {
    await t.sql`UPDATE merch_products SET name_th = 'เสื้อยืด' WHERE id = ${productId}`;
  }
});
