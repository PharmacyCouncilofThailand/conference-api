import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { MerchDb } from "./db.js";
import { merchandiseWorkerHealth } from "./jobs.js";
import type { MerchContext } from "./payments/attempts.js";
import type { InquiryResult, PaysoConfig } from "./payments/payso-client.js";
import { expireAttempts, reconcileAttempt, reconcileDue } from "./payments/reconcile.js";
import { requestNewQr } from "./payments/settlement.js";
import { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
import { merchandiseBuyerRoutes } from "./routes.buyer.js";
import { merchandiseProviderRoutes } from "./routes.provider.js";
import {
  adminToken,
  buildMerchTestApp,
  buyerToken,
  fakePayso,
  openMerchTestDatabase,
  type MerchTestDb,
} from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

const EVENT_CODE = "REC2026";
const POSTBACK_URL = "/api/v1/merchandise/provider/payso/postback";
let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let productId: string;
let variantId: string;
let payso: ReturnType<typeof fakePayso>;
let ctx: MerchContext;
let inquireImpl: (referenceNo: string, amountBaht: number) => InquiryResult | Promise<InquiryResult>;
/** What the postback route fires after replying; tests switch it and await `background`. */
let fireReconcile: (ctx: MerchContext, attemptId: string) => Promise<void>;
let background: Promise<void>[] = [];

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

const paid = (referenceNo: string, amountBaht: number): InquiryResult => ({
  kind: "paid",
  evidence: {
    referenceNo,
    orderNo: `ORD${referenceNo}`,
    transactionId: `TX${referenceNo}`,
    merchantId: paysoConfig.merchantId,
    totalBaht: amountBaht,
    currencyCode: "00",
    status: "CP",
    statusName: "Completed",
    paidAt: null,
    fieldNames: ["ReferenceNo", "Status"],
  },
});

async function drainBackground() {
  const pending = background;
  background = [];
  await Promise.all(pending);
}

async function placeOrder(): Promise<{ orderId: string; attemptId: string; referenceNo: string; amount: number }> {
  const buyerId = await t.createUser();
  const headers = { authorization: `Bearer ${buyerToken(app, buyerId)}` };
  const add = await app.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/cart/items`,
    headers,
    payload: { productId, variantId, bundleSelections: [], quantity: 1 },
  });
  assert.equal(add.statusCode, 200, add.body);
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/orders`,
    headers: { ...headers, "idempotency-key": `k-${Math.random().toString(36).slice(2)}` },
    payload: { cartVersion: add.json().data.cartVersion, recipient },
  });
  assert.equal(res.statusCode, 201, res.body);
  const orderId = res.json().data.order.id as string;
  const [attempt] = await t.sql<{ id: string; reference_no: string; amount: number }[]>`
    SELECT id, reference_no, amount FROM merch_payment_attempts WHERE order_id = ${orderId}`;
  return { orderId, attemptId: attempt.id, referenceNo: attempt.reference_no, amount: attempt.amount };
}

async function paymentStatus(orderId: string): Promise<string> {
  const [row] = await t.sql<{ payment_status: string }[]>`
    SELECT payment_status FROM merch_orders WHERE id = ${orderId}`;
  return row.payment_status;
}

async function outboxCount(orderId: string): Promise<number> {
  const [row] = await t.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM merch_email_outbox WHERE order_id = ${orderId} AND type = 'paid'`;
  return row.n;
}

async function makeDue(attemptId: string) {
  await t.sql`UPDATE merch_payment_attempts SET next_check_at = clock_timestamp() - interval '1 second' WHERE id = ${attemptId}`;
}

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent(EVENT_CODE);
  const adminId = await t.createAdmin({ email: "rec-admin@x.test" });
  payso = fakePayso({ inquire: (ref, amount) => inquireImpl(ref, amount) });
  const options = { database: t.db, payso, paysoConfig, nodeEnv: "test" };
  ctx = { db: t.db, payso, paysoConfig, nodeEnv: "test" };
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register((p) => merchandiseAdminRoutes(p, options), { prefix: "/api/backoffice" });
      await a.register((p) => merchandiseBuyerRoutes(p, options), { prefix: "/api/v1/merchandise" });
      await a.register(
        (p) =>
          merchandiseProviderRoutes(p, {
            ...options,
            reconcile: (c, id) => {
              const run = fireReconcile(c, id);
              background.push(run.catch(() => {}));
              return run;
            },
          }),
        { prefix: "/api/v1/merchandise" },
      );
    },
  });
  const adminHeaders = { authorization: `Bearer ${adminToken(app, adminId, "rec-admin@x.test")}` };
  const admin = (method: string, path: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/api/backoffice/merchandise/events/${eventId}${path}`,
      headers: adminHeaders,
      payload: payload as object | undefined,
    });
  const key = `k-${Math.random().toString(36).slice(2)}`;
  const [image] = await t.sql<{ id: string }[]>`
    INSERT INTO merch_images (event_id, object_key, public_url, mime_type, width, height, byte_size, uploaded_by)
    VALUES (${eventId}, ${key}, ${"https://img.example.test/" + key}, 'image/png', 10, 10, 100, ${adminId})
    RETURNING id`;
  const store = await admin("PUT", "/store", {
    expectedVersion: 0,
    enabled: true,
    opensAt: hours(-1),
    closesAt: hours(1),
    productionInfoTh: "ผลิตหลังปิดรับ",
    shippingInfoTh: "ส่งภายใน 30 วัน",
  });
  assert.equal(store.statusCode, 200, store.body);
  const created = await admin("POST", "/products", {
    imageIds: [image.id],
    kind: "single",
    nameTh: "เสื้อยืด",
    basePriceBaht: 250,
    saleEnabled: true,
  });
  assert.equal(created.statusCode, 201, created.body);
  productId = created.json().data.id;
  const published = await admin("POST", `/products/${productId}/publish`, {});
  assert.equal(published.statusCode, 200, published.body);
  variantId = (await admin("GET", `/products/${productId}`)).json().data.variants[0].id;
});

beforeEach(async () => {
  if (skip) return;
  await drainBackground();
  inquireImpl = () => ({ kind: "not_found" });
  fireReconcile = async () => {};
  payso.calls.inquire.length = 0;
  payso.calls.createQr.length = 0;
  // Keep earlier tests' attempts out of the due queue.
  await t.sql`UPDATE merch_payment_attempts SET next_check_at = NULL`;
});

after(async () => {
  if (skip) return;
  await drainBackground();
  await app?.close();
  await t?.close();
});

test("form-encoded postback is logged sanitized and makes the attempt due", { skip }, async () => {
  const { attemptId, referenceNo } = await placeOrder();
  await t.sql`UPDATE merch_payment_attempts SET next_check_at = clock_timestamp() + interval '1 hour' WHERE id = ${attemptId}`;
  const res = await app.inject({
    method: "POST",
    url: POSTBACK_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `refno=${referenceNo}&total=550.00&customeremail=buyer%40x.test&customername=Somchai`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  assert.match(String(res.headers["content-type"]), /^text\/plain/);
  const events = await t.sql<{ kind: string; attempt_id: string | null; sanitized: Record<string, unknown> }[]>`
    SELECT kind, attempt_id, sanitized FROM merch_payment_events WHERE reference_no = ${referenceNo}`;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "postback");
  assert.equal(events[0].attempt_id, attemptId);
  assert.equal("customeremail" in events[0].sanitized, false);
  assert.equal("customername" in events[0].sanitized, false);
  assert.equal(JSON.stringify(events[0].sanitized).includes("buyer@x.test"), false);
  const [row] = await t.sql<{ due: boolean }[]>`
    SELECT next_check_at <= clock_timestamp() AS due FROM merch_payment_attempts WHERE id = ${attemptId}`;
  assert.equal(row.due, true);
});

test("JSON postback for an unknown reference is logged with a null attempt", { skip }, async () => {
  const res = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { RefNo: "799999999999", Total: "1.00" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  const events = await t.sql<{ attempt_id: string | null; kind: string }[]>`
    SELECT attempt_id, kind FROM merch_payment_events WHERE reference_no = '799999999999'`;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "postback");
  assert.equal(events[0].attempt_id, null);
});

test("malformed and oversized postbacks still get 200 OK", { skip }, async () => {
  const bad = await app.inject({
    method: "POST",
    url: POSTBACK_URL,
    headers: { "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.body, "OK");
  const odd = await app.inject({
    method: "POST",
    url: POSTBACK_URL,
    headers: { "content-type": "text/xml" },
    payload: "<x/>",
  });
  assert.equal(odd.statusCode, 200);
  assert.equal(odd.body, "OK");
  const big = await app.inject({
    method: "POST",
    url: POSTBACK_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `refno=700000000001&pad=${"a".repeat(20_000)}`,
  });
  assert.equal(big.statusCode, 200);
  assert.equal(big.body, "OK");
});

test("postback plus provider paid settles through reconcileDue; postback alone never settles", { skip }, async () => {
  const notFound = await placeOrder();
  const postNotFound = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { refno: notFound.referenceNo } });
  assert.equal(postNotFound.statusCode, 200);
  await reconcileDue(ctx, { limit: 10, concurrency: 2 });
  assert.equal(await paymentStatus(notFound.orderId), "pending");

  const order = await placeOrder();
  inquireImpl = (ref, amount) => (ref === order.referenceNo ? paid(ref, amount) : { kind: "not_found" });
  const res = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { refno: order.referenceNo } });
  assert.equal(res.statusCode, 200);
  assert.equal(await paymentStatus(order.orderId), "pending");
  const { checked } = await reconcileDue(ctx, { limit: 10, concurrency: 2 });
  assert.ok(checked >= 1);
  assert.equal(await paymentStatus(order.orderId), "paid");
  const [attempt] = await t.sql<{ status: string; next_check_at: Date | null; claimed_until: Date | null }[]>`
    SELECT status, next_check_at, claimed_until FROM merch_payment_attempts WHERE id = ${order.attemptId}`;
  assert.equal(attempt.status, "paid");
  assert.equal(attempt.next_check_at, null);
  assert.equal(attempt.claimed_until, null);
});

test("the postback's fire-and-forget reconcile settles a paid attempt", { skip }, async () => {
  fireReconcile = reconcileAttempt;
  const order = await placeOrder();
  inquireImpl = (ref, amount) => (ref === order.referenceNo ? paid(ref, amount) : { kind: "not_found" });
  const res = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { refno: order.referenceNo } });
  assert.equal(res.statusCode, 200);
  await drainBackground();
  assert.equal(await paymentStatus(order.orderId), "paid");
});

test("three postbacks and a paid result queue one outbox row", { skip }, async () => {
  fireReconcile = reconcileAttempt;
  const order = await placeOrder();
  inquireImpl = (ref, amount) => (ref === order.referenceNo ? paid(ref, amount) : { kind: "not_found" });
  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { refno: order.referenceNo } });
    assert.equal(res.statusCode, 200);
  }
  await drainBackground();
  await makeDue(order.attemptId);
  await reconcileDue(ctx, { limit: 10, concurrency: 2 });
  assert.equal(await paymentStatus(order.orderId), "paid");
  assert.equal(await outboxCount(order.orderId), 1);
  const [events] = await t.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM merch_payment_events WHERE attempt_id = ${order.attemptId} AND kind = 'postback'`;
  assert.equal(events.n, 3);
});

test("attempts with an unresolved review are never claimed by the worker or a postback", { skip }, async () => {
  const order = await placeOrder();
  await t.sql`UPDATE merch_payment_attempts SET review_reason = 'amount_mismatch' WHERE id = ${order.attemptId}`;
  await makeDue(order.attemptId);
  payso.calls.inquire.length = 0;
  await reconcileDue(ctx, { limit: 10, concurrency: 2 });
  await reconcileAttempt(ctx, order.attemptId);
  assert.deepEqual(payso.calls.inquire, []);

  await t.sql`UPDATE merch_payment_attempts SET review_resolved_at = clock_timestamp() WHERE id = ${order.attemptId}`;
  await makeDue(order.attemptId);
  await reconcileDue(ctx, { limit: 10, concurrency: 2 });
  assert.deepEqual(payso.calls.inquire, [order.referenceNo]);
});

test("postback within 10 s of the last check makes the attempt due without an immediate reconcile", { skip }, async () => {
  const fired: string[] = [];
  fireReconcile = async (_c, id) => {
    fired.push(id);
  };
  const order = await placeOrder();
  await t.sql`
    UPDATE merch_payment_attempts
    SET last_check_at = clock_timestamp() - interval '3 seconds', next_check_at = clock_timestamp() + interval '1 hour'
    WHERE id = ${order.attemptId}`;
  const recent = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { refno: order.referenceNo } });
  assert.equal(recent.statusCode, 200);
  await drainBackground();
  assert.deepEqual(fired, []);
  const [row] = await t.sql<{ due: boolean }[]>`
    SELECT next_check_at <= clock_timestamp() AS due FROM merch_payment_attempts WHERE id = ${order.attemptId}`;
  assert.equal(row.due, true);

  await t.sql`UPDATE merch_payment_attempts SET last_check_at = clock_timestamp() - interval '30 seconds' WHERE id = ${order.attemptId}`;
  const later = await app.inject({ method: "POST", url: POSTBACK_URL, payload: { refno: order.referenceNo } });
  assert.equal(later.statusCode, 200);
  await drainBackground();
  assert.deepEqual(fired, [order.attemptId]);
});

test("expireAttempts expires active QRs and recovers stale creating attempts", { skip }, async () => {
  const active = await placeOrder();
  await t.sql`
    UPDATE merch_payment_attempts SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${active.attemptId}`;

  const stale = await placeOrder();
  await t.sql`
    UPDATE merch_payment_attempts
    SET status = 'creating', qr_payload_enc = NULL, expires_at = NULL, next_check_at = NULL,
        requested_at = clock_timestamp() - interval '3 minutes'
    WHERE id = ${stale.attemptId}`;

  const result = await expireAttempts(t.db);
  assert.deepEqual(result, { expired: 1, staleCreating: 1 });

  const [expired] = await t.sql<{ status: string; qr_payload_enc: Buffer | null }[]>`
    SELECT status, qr_payload_enc FROM merch_payment_attempts WHERE id = ${active.attemptId}`;
  assert.equal(expired.status, "expired");
  assert.equal(expired.qr_payload_enc, null);

  const [recovered] = await t.sql<
    { status: string; failure_code: string | null; window_ok: boolean; due: boolean }[]
  >`
    SELECT status, failure_code,
           expires_at = requested_at + interval '10 minutes' AS window_ok,
           next_check_at <= clock_timestamp() AS due
    FROM merch_payment_attempts WHERE id = ${stale.attemptId}`;
  assert.equal(recovered.status, "create_unknown");
  assert.equal(recovered.failure_code, "CREATE_INTERRUPTED");
  assert.equal(recovered.window_ok, true);
  assert.equal(recovered.due, true);

  const view = await requestNewQr(ctx, stale.orderId);
  assert.equal(view.state, "qr_active");
  const attempts = await t.sql<{ status: string }[]>`
    SELECT status FROM merch_payment_attempts WHERE order_id = ${stale.orderId} ORDER BY created_at, id`;
  assert.deepEqual(
    attempts.map((a) => a.status),
    ["create_unknown", "active"],
  );
});

test("expireAttempts removes a payload left on a paid attempt", { skip }, async () => {
  const order = await placeOrder();
  await t.sql`UPDATE merch_payment_attempts SET status = 'paid' WHERE id = ${order.attemptId}`;
  await expireAttempts(t.db);
  const [row] = await t.sql<{ qr_payload_enc: Buffer | null }[]>`
    SELECT qr_payload_enc FROM merch_payment_attempts WHERE id = ${order.attemptId}`;
  assert.equal(row.qr_payload_enc, null);
});

test("concurrent reconcileDue calls never inquire the same attempt twice", { skip }, async () => {
  const orders = [];
  for (let i = 0; i < 5; i += 1) orders.push(await placeOrder());
  for (const order of orders) await makeDue(order.attemptId);
  payso.calls.inquire.length = 0;
  inquireImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { kind: "not_found" };
  };
  const [a, b] = await Promise.all([
    reconcileDue(ctx, { limit: 10, concurrency: 2 }),
    reconcileDue(ctx, { limit: 10, concurrency: 2 }),
  ]);
  const refs = payso.calls.inquire;
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(a.checked + b.checked, 5);
  assert.deepEqual(new Set(refs), new Set(orders.map((o) => o.referenceNo)));
  const rows = await t.sql<{ future: boolean; claimed_until: Date | null }[]>`
    SELECT next_check_at > clock_timestamp() AS future, claimed_until
    FROM merch_payment_attempts WHERE id IN ${t.sql(orders.map((o) => o.attemptId))}`;
  for (const row of rows) {
    assert.equal(row.future, true);
    assert.equal(row.claimed_until, null);
  }
});

test("merchandiseWorkerHealth reports configuration and database reachability", { skip }, async () => {
  assert.deepEqual(await merchandiseWorkerHealth(ctx), { configured: true, databaseOk: true });
  assert.deepEqual(await merchandiseWorkerHealth({ ...ctx, payso: null, paysoConfig: null }), {
    configured: false,
    databaseOk: true,
  });
  const brokenDb = {
    execute: async () => {
      throw new Error("down");
    },
  } as unknown as MerchDb;
  assert.deepEqual(await merchandiseWorkerHealth({ ...ctx, db: brokenDb }), { configured: true, databaseOk: false });
});
