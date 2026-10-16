import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { MerchContext } from "./payments/attempts.js";
import type {
  CreateQrInput,
  CreateQrResult,
  InquiryEvidence,
  InquiryResult,
  PaysoConfig,
} from "./payments/payso-client.js";
import { applyInquiryResult, requestNewQr } from "./payments/settlement.js";
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

const EVENT_CODE = "PAY2026";
let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let productId: string;
let variantId: string;
let payso: ReturnType<typeof fakePayso>;
let ctx: MerchContext;
let createQrOverride: ((input: CreateQrInput) => CreateQrResult | Promise<CreateQrResult>) | null = null;
let inquireImpl: (referenceNo: string, amountBaht: number) => InquiryResult | Promise<InquiryResult>;

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

function evidence(referenceNo: string, amountBaht: number, extra: Partial<InquiryEvidence> = {}): InquiryEvidence {
  return {
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
    ...extra,
  };
}

const paid = (referenceNo: string, amountBaht: number, extra: Partial<InquiryEvidence> = {}): InquiryResult => ({
  kind: "paid",
  evidence: evidence(referenceNo, amountBaht, extra),
});

type Buyer = { id: number; headers: { authorization: string } };

async function newBuyer(): Promise<Buyer> {
  const id = await t.createUser();
  return { id, headers: { authorization: `Bearer ${buyerToken(app, id)}` } };
}

/** Confirms a fresh order through the API; the default fake issues an active QR. */
async function placeOrder(): Promise<{ buyer: Buyer; orderId: string; attemptId: string; referenceNo: string; amount: number }> {
  const buyer = await newBuyer();
  const add = await app.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/cart/items`,
    headers: buyer.headers,
    payload: { productId, variantId, bundleSelections: [], quantity: 1 },
  });
  assert.equal(add.statusCode, 200, add.body);
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/orders`,
    headers: { ...buyer.headers, "idempotency-key": `k-${Math.random().toString(36).slice(2)}` },
    payload: { cartVersion: add.json().data.cartVersion, recipient },
  });
  assert.equal(res.statusCode, 201, res.body);
  const orderId = res.json().data.order.id as string;
  const [attempt] = await t.sql<{ id: string; reference_no: string; amount: number }[]>`
    SELECT id, reference_no, amount FROM merch_payment_attempts WHERE order_id = ${orderId}`;
  return { buyer, orderId, attemptId: attempt.id, referenceNo: attempt.reference_no, amount: attempt.amount };
}

/** Moves the attempt's QR expiry into the past by `seconds` (DB time). */
async function expireAgo(attemptId: string, seconds: number) {
  await t.sql`
    UPDATE merch_payment_attempts
    SET expires_at = clock_timestamp() - make_interval(secs => ${seconds}),
        requested_at = clock_timestamp() - make_interval(secs => ${seconds + 600})
    WHERE id = ${attemptId}`;
}

async function closeStore() {
  await t.sql`UPDATE merch_stores SET closes_at = clock_timestamp() - interval '1 minute' WHERE event_id = ${eventId}`;
}

async function openStore() {
  await t.sql`
    UPDATE merch_stores SET opens_at = clock_timestamp() - interval '1 hour', closes_at = clock_timestamp() + interval '1 hour'
    WHERE event_id = ${eventId}`;
}

const postCheck = (buyer: Buyer, orderId: string) =>
  app.inject({ method: "POST", url: `/api/v1/merchandise/orders/${orderId}/payment-checks`, headers: buyer.headers });
const postAttempt = (buyer: Buyer, orderId: string) =>
  app.inject({ method: "POST", url: `/api/v1/merchandise/orders/${orderId}/payment-attempts`, headers: buyer.headers });
const getOrder = (buyer: Buyer, orderId: string) =>
  app.inject({ method: "GET", url: `/api/v1/merchandise/orders/${orderId}`, headers: buyer.headers });

async function orderRow(orderId: string) {
  const [row] = await t.sql<
    { payment_status: string; paid_at: Date | string | null; paid_at_source: string | null; paid_attempt_id: string | null }[]
  >`SELECT payment_status, paid_at, paid_at_source, paid_attempt_id FROM merch_orders WHERE id = ${orderId}`;
  return row;
}

async function attemptRows(orderId: string) {
  return t.sql<
    {
      id: string;
      reference_no: string;
      amount: number;
      status: string;
      qr_payload_enc: Buffer | null;
      review_reason: string | null;
      paid_at: Date | null;
      paid_at_source: string | null;
      provider_order_no: string | null;
      transaction_id: string | null;
      last_check_result: string | null;
      check_count: number;
    }[]
  >`SELECT id, reference_no, amount, status, qr_payload_enc, review_reason, paid_at, paid_at_source,
           provider_order_no, transaction_id, last_check_result, check_count
    FROM merch_payment_attempts WHERE order_id = ${orderId} ORDER BY created_at, id`;
}

async function outboxCount(orderId: string): Promise<number> {
  const [row] = await t.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM merch_email_outbox WHERE order_id = ${orderId} AND type = 'paid'`;
  return row.n;
}

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent(EVENT_CODE);
  const adminId = await t.createAdmin({ email: "pay-admin@x.test" });
  const defaultPayso = fakePayso();
  payso = fakePayso({
    createQr: (input) => (createQrOverride ? createQrOverride(input) : defaultPayso.createQr(input)),
    inquire: (ref, amount) => inquireImpl(ref, amount),
  });
  const options = { database: t.db, payso, paysoConfig, nodeEnv: "test" };
  ctx = { db: t.db, payso, paysoConfig, nodeEnv: "test" };
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register((p) => merchandiseAdminRoutes(p, options), { prefix: "/api/backoffice" });
      await a.register((p) => merchandiseBuyerRoutes(p, options), { prefix: "/api/v1/merchandise" });
    },
  });
  const adminHeaders = { authorization: `Bearer ${adminToken(app, adminId, "pay-admin@x.test")}` };
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
  createQrOverride = null;
  inquireImpl = () => ({ kind: "not_found" });
  payso.calls.createQr.length = 0;
  payso.calls.inquire.length = 0;
  await openStore();
});

after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});

test("payment-check with inquiry paid settles the order (first_seen) and queues one paid email", { skip }, async () => {
  const o = await placeOrder();
  inquireImpl = (ref, amount) => paid(ref, amount);
  const res = await postCheck(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const view = res.json().data.payment;
  assert.equal(view.state, "paid");
  assert.equal(view.attempt.id, o.attemptId);
  assert.equal(view.attempt.qrPayload, null);

  const order = await orderRow(o.orderId);
  assert.equal(order.payment_status, "paid");
  assert.equal(order.paid_at_source, "first_seen");
  assert.equal(order.paid_attempt_id, o.attemptId);
  assert.ok(order.paid_at);
  const [attempt] = await attemptRows(o.orderId);
  assert.equal(attempt.status, "paid");
  assert.equal(attempt.qr_payload_enc, null);
  assert.equal(attempt.paid_at_source, "first_seen");
  assert.equal(attempt.provider_order_no, `ORD${o.referenceNo}`);
  assert.equal(attempt.transaction_id, `TX${o.referenceNo}`);
  assert.equal(attempt.last_check_result, "paid");
  assert.equal(attempt.check_count, 1);
  assert.equal(await outboxCount(o.orderId), 1);
  const events = await t.sql<{ kind: string; result: string; sanitized: Record<string, unknown> }[]>`
    SELECT kind, result, sanitized FROM merch_payment_events WHERE attempt_id = ${o.attemptId}`;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "inquiry");
  assert.equal(events[0].result, "paid");
  assert.equal(events[0].sanitized.referenceNo, o.referenceNo);
});

test("paid with provider paidAt uses paid_at_source provider and that timestamp", { skip }, async () => {
  const o = await placeOrder();
  const paidAt = new Date("2026-10-16T03:04:05.000Z");
  assert.equal(await applyInquiryResult(ctx, o.attemptId, paid(o.referenceNo, o.amount, { paidAt }), { at: new Date(), source: "inquiry" }), "settled");
  const order = await orderRow(o.orderId);
  assert.equal(order.paid_at_source, "provider");
  assert.equal(new Date(order.paid_at!).toISOString(), paidAt.toISOString());
});

test("first_seen paid_at is the earlier matched postback received_at", { skip }, async () => {
  const o = await placeOrder();
  const [pb] = await t.sql<{ received_at: Date | string }[]>`
    INSERT INTO merch_payment_events (attempt_id, kind, reference_no, received_at, result)
    VALUES (${o.attemptId}, 'postback', ${o.referenceNo}, clock_timestamp() - interval '90 seconds', 'matched')
    RETURNING received_at`;
  assert.equal(await applyInquiryResult(ctx, o.attemptId, paid(o.referenceNo, o.amount), { at: new Date(), source: "inquiry" }), "settled");
  const order = await orderRow(o.orderId);
  assert.equal(order.paid_at_source, "first_seen");
  assert.equal(new Date(order.paid_at!).toISOString(), new Date(pb.received_at).toISOString());
});

test("two concurrent paid results for one attempt settle once", { skip }, async () => {
  const o = await placeOrder();
  const result = paid(o.referenceNo, o.amount);
  const outcomes = await Promise.all([
    applyInquiryResult(ctx, o.attemptId, result, { at: new Date(), source: "inquiry" }),
    applyInquiryResult(ctx, o.attemptId, result, { at: new Date(), source: "postback" }),
  ]);
  assert.deepEqual([...outcomes].sort(), ["noop", "settled"]);
  assert.equal(await outboxCount(o.orderId), 1);
  const order = await orderRow(o.orderId);
  assert.equal(order.payment_status, "paid");
  assert.equal(order.paid_attempt_id, o.attemptId);
});

test("second attempt paid after the order is paid is flagged duplicate_payment", { skip }, async () => {
  const o = await placeOrder();
  const [b] = await t.sql<{ id: string; reference_no: string }[]>`
    INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at, expires_at)
    VALUES (${o.orderId}, '7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0'), ${o.amount},
            'expired', clock_timestamp() - interval '20 minutes', clock_timestamp() - interval '10 minutes')
    RETURNING id, reference_no`;
  assert.equal(await applyInquiryResult(ctx, o.attemptId, paid(o.referenceNo, o.amount), { at: new Date(), source: "inquiry" }), "settled");
  assert.equal(await applyInquiryResult(ctx, b.id, paid(b.reference_no, o.amount), { at: new Date(), source: "inquiry" }), "duplicate");
  const rows = await attemptRows(o.orderId);
  const dup = rows.find((r) => r.id === b.id)!;
  assert.equal(dup.status, "paid");
  assert.equal(dup.review_reason, "duplicate_payment");
  const order = await orderRow(o.orderId);
  assert.equal(order.paid_attempt_id, o.attemptId);
  assert.equal(await outboxCount(o.orderId), 1);
});

test("amount mismatch sets review, keeps order pending, view review", { skip }, async () => {
  const o = await placeOrder();
  inquireImpl = (ref, amount) => ({ kind: "mismatch", reason: "amount_mismatch", evidence: evidence(ref, amount + 100) });
  const res = await postCheck(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.payment.state, "review");
  const [attempt] = await attemptRows(o.orderId);
  assert.equal(attempt.review_reason, "amount_mismatch");
  assert.equal(attempt.last_check_result, "mismatch");
  assert.equal((await orderRow(o.orderId)).payment_status, "pending");
  assert.equal(await outboxCount(o.orderId), 0);
});

test("TC status on production is held for review test_status_in_production", { skip }, async () => {
  const o = await placeOrder();
  const prodCtx: MerchContext = { ...ctx, nodeEnv: "production" };
  const result = paid(o.referenceNo, o.amount, { status: "TC", statusName: "Test Complete" });
  assert.equal(await applyInquiryResult(prodCtx, o.attemptId, result, { at: new Date(), source: "inquiry" }), "review");
  const [attempt] = await attemptRows(o.orderId);
  assert.equal(attempt.review_reason, "test_status_in_production");
  assert.notEqual(attempt.status, "paid");
  assert.equal((await orderRow(o.orderId)).payment_status, "pending");
});

test("payment-check twice within 5 seconds calls the provider once", { skip }, async () => {
  const o = await placeOrder();
  const first = await postCheck(o.buyer, o.orderId);
  assert.equal(first.statusCode, 200, first.body);
  const second = await postCheck(o.buyer, o.orderId);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(payso.calls.inquire.length, 1);
  assert.equal(second.json().data.payment.state, "qr_active");
});

test("inquiry error gives view check_failed and keeps the order pending", { skip }, async () => {
  const o = await placeOrder();
  await expireAgo(o.attemptId, 180);
  inquireImpl = () => ({ kind: "error", code: "INQUIRY_HTTP_ERROR" });
  const res = await postCheck(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.payment.state, "check_failed");
  assert.equal((await orderRow(o.orderId)).payment_status, "pending");
});

test("new QR while the current QR is active returns the same attempt without createQr", { skip }, async () => {
  const o = await placeOrder();
  payso.calls.createQr.length = 0;
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json().data.payment;
  assert.equal(view.state, "qr_active");
  assert.equal(view.attempt.id, o.attemptId);
  assert.ok(view.attempt.qrPayload);
  assert.equal(payso.calls.createQr.length, 0);
});

test("new QR 30 s after expiry with not_found answers 409 MERCH_PAYMENT_VERIFYING", { skip }, async () => {
  const o = await placeOrder();
  await expireAgo(o.attemptId, 30);
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 409, res.body);
  const body = res.json();
  assert.equal(body.code, "MERCH_PAYMENT_VERIFYING");
  const retry = body.details.retryAfterSeconds as number;
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 90, `retryAfterSeconds=${retry}`);
  assert.equal((await attemptRows(o.orderId)).length, 1);
});

test("new QR 3 min after expiry with store open issues a new attempt at the current total", { skip }, async () => {
  const o = await placeOrder();
  await expireAgo(o.attemptId, 180);
  await t.sql`UPDATE merch_orders SET total = 560 WHERE id = ${o.orderId}`;
  payso.calls.createQr.length = 0;
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json().data.payment;
  assert.equal(view.state, "qr_active");
  assert.notEqual(view.attempt.id, o.attemptId);
  assert.notEqual(view.attempt.referenceNo, o.referenceNo);
  assert.ok(view.attempt.qrPayload);
  assert.equal(payso.calls.createQr.length, 1);
  assert.equal(payso.calls.createQr[0].amountBaht, 560);
  const rows = await attemptRows(o.orderId);
  assert.equal(rows.length, 2);
  const old = rows.find((r) => r.id === o.attemptId)!;
  assert.equal(old.status, "expired");
  assert.equal(old.qr_payload_enc, null);
  const fresh = rows.find((r) => r.id !== o.attemptId)!;
  assert.equal(fresh.status, "active");
  assert.equal(fresh.amount, 560);
});

test("new QR 3 min after expiry with store closed answers 409 MERCH_PREORDER_CLOSED", { skip }, async () => {
  const o = await placeOrder();
  await expireAgo(o.attemptId, 180);
  await closeStore();
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, "MERCH_PREORDER_CLOSED");
  const detail = await getOrder(o.buyer, o.orderId);
  assert.equal(detail.statusCode, 200, detail.body);
  const view = detail.json().data.payment;
  assert.equal(view.state, "qr_expired_closed");
  assert.equal(view.canRequestNewQr, false);
  assert.equal((await attemptRows(o.orderId)).length, 1);
});

test("new QR after expiry with inquiry paid returns view paid and no new attempt", { skip }, async () => {
  const o = await placeOrder();
  await expireAgo(o.attemptId, 180);
  payso.calls.createQr.length = 0;
  inquireImpl = (ref, amount) => paid(ref, amount);
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.payment.state, "paid");
  assert.equal(payso.calls.createQr.length, 0);
  assert.equal((await attemptRows(o.orderId)).length, 1);
});

test("new QR after expiry with inquiry error answers 503 MERCH_PAYMENT_CHECK_FAILED", { skip }, async () => {
  const o = await placeOrder();
  await expireAgo(o.attemptId, 180);
  payso.calls.createQr.length = 0;
  inquireImpl = () => ({ kind: "error", code: "INQUIRY_NETWORK_ERROR" });
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, "MERCH_PAYMENT_CHECK_FAILED");
  assert.equal(payso.calls.createQr.length, 0);
  assert.equal((await attemptRows(o.orderId)).length, 1);
});

test("create_unknown attempt allows a new QR immediately", { skip }, async () => {
  createQrOverride = () => ({ kind: "unknown", code: "QR_NETWORK_ERROR" });
  const o = await placeOrder();
  assert.equal((await attemptRows(o.orderId))[0].status, "create_unknown");
  createQrOverride = null;
  payso.calls.createQr.length = 0;
  const res = await postAttempt(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json().data.payment;
  assert.equal(view.state, "qr_active");
  assert.notEqual(view.attempt.id, o.attemptId);
  assert.equal(payso.calls.inquire.length, 1, "the unknown attempt was inquired first");
  assert.equal(payso.calls.createQr.length, 1);
  const rows = await attemptRows(o.orderId);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === o.attemptId)!.status, "create_unknown");
});

test("QR issued before close and paid after closes_at still settles", { skip }, async () => {
  const o = await placeOrder();
  await closeStore();
  inquireImpl = (ref, amount) => paid(ref, amount);
  const res = await postCheck(o.buyer, o.orderId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.payment.state, "paid");
  assert.equal((await orderRow(o.orderId)).payment_status, "paid");
});

test("payment routes answer 404 for another buyer's order", { skip }, async () => {
  const o = await placeOrder();
  const other = await newBuyer();
  assert.equal((await postCheck(other, o.orderId)).statusCode, 404);
  assert.equal((await postAttempt(other, o.orderId)).statusCode, 404);
  assert.equal(payso.calls.inquire.length, 0);
});

test("createQr throwing logs only the error name and code", { skip }, async () => {
  createQrOverride = () => ({ kind: "unknown", code: "QR_NETWORK_ERROR" });
  const o = await placeOrder();
  const logged: Array<{ obj: object; msg?: string }> = [];
  const loggingCtx: MerchContext = { ...ctx, log: { error: (obj, msg) => logged.push({ obj, msg }) } };
  createQrOverride = () => {
    throw Object.assign(new Error("https://apis.paysolutions.asia/?customerEmail=leak@x.test"), { code: "ECONNRESET" });
  };
  const view = await requestNewQr(loggingCtx, o.orderId);
  assert.equal(view.state, "awaiting_qr");
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].obj, { errorName: "Error", errorCode: "ECONNRESET" });
  assert.doesNotMatch(JSON.stringify(logged), /leak@x\.test|paysolutions/);
});
