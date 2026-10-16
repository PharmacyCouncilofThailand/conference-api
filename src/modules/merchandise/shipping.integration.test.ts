import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
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

const EVENT_CODE = "SHIP2026";
const ADMIN_EMAIL = "ship-admin@x.test";
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

const paidResult = (referenceNo: string, amountBaht: number): InquiryResult => ({
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

async function versionOf(orderId: string): Promise<number> {
  const [r] = await t.sql<{ version: number }[]>`SELECT version FROM merch_orders WHERE id = ${orderId}`;
  return r.version;
}

const outbox = (orderId: string) =>
  t.sql<{ type: string }[]>`SELECT type FROM merch_email_outbox WHERE order_id = ${orderId}`;
const audits = (orderId: string) =>
  t.sql<{ action: string; reason: string | null }[]>`
    SELECT action, reason FROM merch_audit_log WHERE entity_id = ${orderId} AND entity_type = 'order' ORDER BY created_at`;

test("shipment: unpaid order -> 422, blank carrier -> 400", { skip }, async () => {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  const unpaid = await admin("PUT", `/orders/${o.orderId}/shipment`, { expectedVersion: 1, carrier: "Kerry", trackingId: "T1" });
  assert.equal(unpaid.statusCode, 422, unpaid.body);
  assert.equal(unpaid.json().code, "MERCH_ORDER_NOT_PAID");
  const blank = await admin("PUT", `/orders/${o.orderId}/shipment`, { expectedVersion: 1, carrier: "   ", trackingId: "T1" });
  assert.equal(blank.statusCode, 400, blank.body);
  assert.equal(blank.json().code, "VALIDATION_ERROR");
  const missing = await admin("PUT", `/orders/00000000-0000-4000-8000-000000000000/shipment`, { expectedVersion: 1, carrier: "K", trackingId: "T" });
  assert.equal(missing.statusCode, 404);
});

test("shipment: first set ships, keeps leading zeros, queues one email; edit needs reason", { skip }, async () => {
  const o = await paidOrder();
  const v = await versionOf(o.orderId);
  const res = await admin("PUT", `/orders/${o.orderId}/shipment`, { expectedVersion: v, carrier: " Kerry ", trackingId: "00123" });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.shipping.status, "shipped");
  assert.equal(data.shipping.carrier, "Kerry");
  assert.equal(data.shipping.trackingId, "00123");
  assert.ok(data.shipping.shippedAt);
  assert.equal(data.paymentStatus, "paid");
  const [row] = await t.sql<{ tracking_id: string; shipped_at: Date | null }[]>`
    SELECT tracking_id, shipped_at FROM merch_orders WHERE id = ${o.orderId}`;
  assert.equal(row.tracking_id, "00123");
  assert.ok(row.shipped_at);
  assert.deepEqual((await outbox(o.orderId)).map((r) => r.type), ["shipped"]);
  assert.deepEqual((await audits(o.orderId)).map((r) => r.action), ["shipment.set"]);

  const v2 = await versionOf(o.orderId);
  assert.equal(v2, v + 1);
  const noReason = await admin("PUT", `/orders/${o.orderId}/shipment`, { expectedVersion: v2, carrier: "Kerry", trackingId: "00124" });
  assert.equal(noReason.statusCode, 422, noReason.body);
  assert.equal(noReason.json().code, "MERCH_REASON_REQUIRED");

  const stale = await admin("PUT", `/orders/${o.orderId}/shipment`, { expectedVersion: v, carrier: "Kerry", trackingId: "00124", reason: "typo" });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "MERCH_VERSION_CONFLICT");

  const edited = await admin("PUT", `/orders/${o.orderId}/shipment`, { expectedVersion: v2, carrier: "Flash", trackingId: "00124", reason: "typo" });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().data.shipping.trackingId, "00124");
  assert.equal(edited.json().data.shipping.shippedAt, data.shipping.shippedAt);
  assert.deepEqual((await outbox(o.orderId)).map((r) => r.type), ["shipped"]);
  assert.deepEqual((await audits(o.orderId)).map((r) => ({ ...r })), [
    { action: "shipment.set", reason: null },
    { action: "shipment.update", reason: "typo" },
  ]);
});

test("bulk: per-row results, valid row committed, others rejected", { skip }, async () => {
  const good = await paidOrder();
  const unpaid = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  const stale = await paidOrder();
  const res = await admin("POST", "/orders/shipments/bulk", {
    rows: [
      { orderId: good.orderId, expectedVersion: await versionOf(good.orderId), carrier: "Kerry", trackingId: "B1" },
      { orderId: unpaid.orderId, expectedVersion: 1, carrier: "Kerry", trackingId: "B2" },
      { orderId: stale.orderId, expectedVersion: 999, carrier: "Kerry", trackingId: "B3" },
    ],
  });
  assert.equal(res.statusCode, 200, res.body);
  const results = res.json().data.results as { id: string; ok: boolean; code: string | null }[];
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.code]),
    [
      [good.orderId, true, null],
      [unpaid.orderId, false, "MERCH_ORDER_NOT_PAID"],
      [stale.orderId, false, "MERCH_VERSION_CONFLICT"],
    ],
  );
  const [row] = await t.sql<{ shipping_status: string }[]>`SELECT shipping_status FROM merch_orders WHERE id = ${good.orderId}`;
  assert.equal(row.shipping_status, "shipped");
  assert.equal((await outbox(good.orderId)).length, 1);
  assert.equal((await outbox(stale.orderId)).length, 0);

  const tooMany = await admin("POST", "/orders/shipments/bulk", {
    rows: Array.from({ length: 501 }, () => ({ orderId: good.orderId, expectedVersion: 1, carrier: "K", trackingId: "T" })),
  });
  assert.equal(tooMany.statusCode, 400);
});
