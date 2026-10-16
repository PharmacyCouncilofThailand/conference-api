import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { NipaMailTransportError } from "../../services/emailService.js";
import { sendDueEmails } from "./email.js";
import { runMerchandiseJobsOnce } from "./jobs.js";
import type { MerchContext } from "./payments/attempts.js";
import type { InquiryResult, PaysoConfig } from "./payments/payso-client.js";
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

const EVENT_CODE = "MAIL2026";
const ADMIN_EMAIL = "mail-admin@x.test";
let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let adminId: number;
let adminHeaders: { authorization: string };
let ctx: MerchContext;
let inquireImpl: (referenceNo: string, amountBaht: number) => InquiryResult;
let mug: { id: string; m: string; l: string };
let gift: { id: string; v: string };

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

function admin(method: string, path: string, payload?: unknown) {
  return app.inject({
    method: method as "GET",
    url: `/api/backoffice/merchandise/events/${eventId}${path}`,
    headers: adminHeaders,
    payload: payload as object | undefined,
  });
}

type Placed = { orderId: string; orderNumber: string; attemptId: string; referenceNo: string; total: number };

async function placeOrder(
  lines: { productId: string; variantId: string; quantity: number }[],
  user: Partial<{ firstName: string; lastName: string }> = {},
): Promise<Placed> {
  const id = await t.createUser(user);
  const headers = { authorization: `Bearer ${buyerToken(app, id)}` };
  let cartVersion = "";
  for (const line of lines) {
    const add = await app.inject({
      method: "POST",
      url: `/api/v1/merchandise/events/${EVENT_CODE}/cart/items`,
      headers,
      payload: { ...line, bundleSelections: [] },
    });
    assert.equal(add.statusCode, 200, add.body);
    cartVersion = add.json().data.cartVersion;
  }
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/merchandise/events/${EVENT_CODE}/orders`,
    headers: { ...headers, "idempotency-key": `k-${Math.random().toString(36).slice(2)}` },
    payload: { cartVersion, recipient },
  });
  assert.equal(res.statusCode, 201, res.body);
  const order = res.json().data.order;
  const [attempt] = await t.sql<{ id: string; reference_no: string }[]>`
    SELECT id, reference_no FROM merch_payment_attempts WHERE order_id = ${order.id}`;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    attemptId: attempt.id,
    referenceNo: attempt.reference_no,
    total: order.amounts.totalBaht,
  };
}

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent(EVENT_CODE);
  adminId = await t.createAdmin({ email: ADMIN_EMAIL });
  const payso = fakePayso({ inquire: (ref, amount) => inquireImpl(ref, amount) });
  const options = { database: t.db, payso, paysoConfig, nodeEnv: "test" };
  ctx = { db: t.db, payso, paysoConfig, nodeEnv: "test" };
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register((p) => merchandiseAdminRoutes(p, options), { prefix: "/api/backoffice" });
      await a.register((p) => merchandiseBuyerRoutes(p, options), { prefix: "/api/v1/merchandise" });
    },
  });
  adminHeaders = { authorization: `Bearer ${adminToken(app, adminId, ADMIN_EMAIL)}` };

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
    productionInfoTh: null,
    shippingInfoTh: null,
  });
  assert.equal(store.statusCode, 200, store.body);

  const mkSingle = async (nameTh: string, basePriceBaht: number, variants?: unknown[]) => {
    const created = await admin("POST", "/products", {
      imageIds: [image.id],
      kind: "single",
      nameTh,
      basePriceBaht,
      saleEnabled: true,
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id as string;
    if (variants) {
      const put = await admin("PUT", `/products/${id}/variants`, { variants });
      assert.equal(put.statusCode, 200, put.body);
    }
    const published = await admin("POST", `/products/${id}/publish`, {});
    assert.equal(published.statusCode, 200, published.body);
    return published.json().data as { id: string; variants: { id: string; sizeTh: string | null }[] };
  };
  const mugDto = await mkSingle("แก้ว Mug", 150, [{ sizeTh: "M" }, { sizeTh: "L" }]);
  mug = {
    id: mugDto.id,
    m: mugDto.variants.find((v) => v.sizeTh === "M")!.id,
    l: mugDto.variants.find((v) => v.sizeTh === "L")!.id,
  };
  const giftDto = await mkSingle("ชุดของขวัญ", 300);
  gift = { id: giftDto.id, v: giftDto.variants[0].id };
});

beforeEach(async () => {
  if (skip) return;
  inquireImpl = () => ({ kind: "not_found" });
  await t.sql`
    UPDATE merch_stores SET opens_at = clock_timestamp() - interval '1 hour', closes_at = clock_timestamp() + interval '1 hour'
    WHERE event_id = ${eventId}`;
});

after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});
async function markPaid(orderId: string) {
  await t.sql`UPDATE merch_orders SET payment_status = 'paid', paid_at = clock_timestamp(), paid_at_source = 'first_seen' WHERE id = ${orderId}`;
}

async function paidOrder(): Promise<Placed> {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await markPaid(o.orderId);
  return o;
}


const rowOf = async (orderId: string, type = "paid") => {
  const [r] = await t.sql<
    { status: string; attempts: number; last_error_code: string | null; sent_at: Date | null; delta: number }[]
  >`SELECT status, attempts, last_error_code, sent_at,
           extract(epoch FROM (next_attempt_at - clock_timestamp()))::float AS delta
    FROM merch_email_outbox WHERE order_id = ${orderId} AND type = ${type}`;
  return r;
};

async function queuedOrder(type = "paid"): Promise<Placed> {
  const o = await paidOrder();
  await t.sql`INSERT INTO merch_email_outbox (order_id, type) VALUES (${o.orderId}, ${type})`;
  return o;
}

test("outbox: queued -> sent with recipient from the buyer email snapshot", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder();
  const calls: { to: string; subject: string }[] = [];
  const res = await sendDueEmails(t.db, async (to, subject) => void calls.push({ to, subject }));
  assert.deepEqual(res, { sent: 1, failed: 0, unknown: 0 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].subject.includes(o.orderNumber));
  const [buyer] = await t.sql<{ buyer_email: string }[]>`SELECT buyer_email FROM merch_orders WHERE id = ${o.orderId}`;
  assert.equal(calls[0].to, buyer.buyer_email);
  const row = await rowOf(o.orderId);
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 1);
  assert.ok(row.sent_at);
  assert.deepEqual(await sendDueEmails(t.db, async () => assert.fail("must not resend")), { sent: 0, failed: 0, unknown: 0 });
});

test("outbox: definite failure -> failed, attempts 1, retry in about a minute", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder();
  const res = await sendDueEmails(t.db, async () => {
    throw new NipaMailTransportError("HTTP_500", "failed", "boom");
  });
  assert.deepEqual(res, { sent: 0, failed: 1, unknown: 0 });
  const row = await rowOf(o.orderId);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error_code, "HTTP_500");
  assert.ok(row.delta > 40 && row.delta <= 60, `delta ${row.delta}`);
  // not due yet
  assert.deepEqual(await sendDueEmails(t.db, async () => assert.fail("not due")), { sent: 0, failed: 0, unknown: 0 });
});

test("outbox: backoff grows and stops after 5 attempts", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder();
  const fail = async () => {
    throw new NipaMailTransportError("HTTP_500", "failed", "boom");
  };
  const expected = [60, 300, 900, 3600];
  for (let n = 1; n <= 4; n++) {
    await sendDueEmails(t.db, fail);
    const row = await rowOf(o.orderId);
    assert.equal(row.attempts, n);
    assert.ok(Math.abs(row.delta - expected[n - 1]) < 20, `attempt ${n} delta ${row.delta}`);
    await t.sql`UPDATE merch_email_outbox SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE order_id = ${o.orderId}`;
  }
  const last = await sendDueEmails(t.db, fail);
  assert.equal(last.failed, 1);
  assert.equal((await rowOf(o.orderId)).attempts, 5);
  await t.sql`UPDATE merch_email_outbox SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE order_id = ${o.orderId}`;
  assert.deepEqual(await sendDueEmails(t.db, async () => assert.fail("exhausted")), { sent: 0, failed: 0, unknown: 0 });
  assert.equal((await rowOf(o.orderId)).status, "failed");
});

test("outbox: unknown outcome is never retried automatically; resend then sends", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder();
  const res = await sendDueEmails(t.db, async () => {
    throw new NipaMailTransportError("TIMEOUT", "unknown", "timeout");
  });
  assert.deepEqual(res, { sent: 0, failed: 0, unknown: 1 });
  assert.equal((await rowOf(o.orderId)).status, "unknown");
  assert.deepEqual(await sendDueEmails(t.db, async () => assert.fail("unknown stays")), { sent: 0, failed: 0, unknown: 0 });

  const resend = await admin("POST", `/orders/${o.orderId}/notifications/paid/resend`, { reason: "buyer asked" });
  assert.equal(resend.statusCode, 200, resend.body);
  assert.deepEqual(resend.json().data, { ok: true });
  const queued = await rowOf(o.orderId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempts, 0);
  const [audit] = await t.sql<{ reason: string }[]>`
    SELECT reason FROM merch_audit_log WHERE entity_id = ${o.orderId} AND action = 'notification.resend'`;
  assert.equal(audit.reason, "buyer asked");

  assert.equal((await sendDueEmails(t.db, async () => undefined)).sent, 1);
  assert.equal((await rowOf(o.orderId)).status, "sent");
});

test("outbox: non-transport error counts as unknown", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder();
  const res = await sendDueEmails(t.db, async () => {
    throw new Error("socket hang up");
  });
  assert.equal(res.unknown, 1);
  assert.equal((await rowOf(o.orderId)).status, "unknown");
});

test("outbox: expired lease becomes unknown", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder();
  await t.sql`UPDATE merch_email_outbox SET status = 'sending', attempts = 1, claimed_until = clock_timestamp() - interval '1 minute' WHERE order_id = ${o.orderId}`;
  await sendDueEmails(t.db, async () => assert.fail("lease expired rows are not resent"));
  const row = await rowOf(o.orderId);
  assert.equal(row.status, "unknown");
  assert.equal(row.last_error_code, "LEASE_EXPIRED");
});

test("resend: sent -> 409, wrong event/order -> 404, missing reason -> 400", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  const o = await queuedOrder("shipped");
  await sendDueEmails(t.db, async () => undefined);
  assert.equal((await rowOf(o.orderId, "shipped")).status, "sent");
  const conflict = await admin("POST", `/orders/${o.orderId}/notifications/shipped/resend`, { reason: "x" });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, "MERCH_NOTIFICATION_NOT_RESENDABLE");
  const missing = await admin("POST", `/orders/00000000-0000-4000-8000-000000000000/notifications/paid/resend`, { reason: "x" });
  assert.equal(missing.statusCode, 404, missing.body);
  const noReason = await admin("POST", `/orders/${o.orderId}/notifications/shipped/resend`, {});
  assert.equal(noReason.statusCode, 400, noReason.body);
  const badType = await admin("POST", `/orders/${o.orderId}/notifications/other/resend`, { reason: "x" });
  assert.equal(badType.statusCode, 400, badType.body);
});

test("jobs: runMerchandiseJobsOnce reports the number of emails sent", { skip }, async () => {
  await t.sql`DELETE FROM merch_email_outbox`;
  await queuedOrder();
  const result = await runMerchandiseJobsOnce(ctx, { sendEmails: (db) => sendDueEmails(db, async () => undefined) });
  assert.equal(result.emails, 1);
});
