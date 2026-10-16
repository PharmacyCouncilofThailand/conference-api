import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { MerchContext } from "./payments/attempts.js";
import type { InquiryResult, PaysoConfig } from "./payments/payso-client.js";
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

const EVENT_CODE = "ADMORD2026";
const ADMIN_EMAIL = "orders-admin@x.test";
let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let adminId: number;
let adminHeaders: { authorization: string };
let ctx: MerchContext;
let inquireImpl: (referenceNo: string, amountMinor: number) => InquiryResult;
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

const paidResult = (referenceNo: string, amountMinor: number): InquiryResult => ({
  kind: "paid",
  evidence: {
    referenceNo,
    orderNo: `ORD${referenceNo}`,
    transactionId: `TX${referenceNo}`,
    merchantId: paysoConfig.merchantId,
    totalMinor: amountMinor,
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
    total: order.amounts.totalMinor,
  };
}

async function expireAgo(attemptId: string, seconds: number) {
  await t.sql`
    UPDATE merch_payment_attempts
    SET expires_at = clock_timestamp() - make_interval(secs => ${seconds}),
        requested_at = clock_timestamp() - make_interval(secs => ${seconds + 600})
    WHERE id = ${attemptId}`;
}

async function settle(o: Placed) {
  assert.equal(
    await applyInquiryResult(ctx, o.attemptId, paidResult(o.referenceNo, o.total), { at: new Date(), source: "inquiry" }),
    "settled",
  );
}

async function detail(orderId: string) {
  const res = await admin("GET", `/orders/${orderId}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data;
}

async function list(query: string): Promise<{ id: string; paymentStatus: string; itemsText: string; buyerName: string; buyerEmail: string }[]> {
  const res = await admin("GET", `/orders?limit=100&${query}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  return res.json().data.items;
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

  const mkSingle = async (nameTh: string, basePriceMinor: number, variants?: unknown[]) => {
    const created = await admin("POST", "/products", {
      imageIds: [image.id],
      kind: "single",
      nameTh,
      basePriceMinor,
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
  const mugDto = await mkSingle("แก้ว Mug", 15000, [{ sizeTh: "M" }, { sizeTh: "L" }]);
  mug = {
    id: mugDto.id,
    m: mugDto.variants.find((v) => v.sizeTh === "M")!.id,
    l: mugDto.variants.find((v) => v.sizeTh === "L")!.id,
  };
  const giftDto = await mkSingle("ชุดของขวัญ", 30000);
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

test("list: search by order number fragment and buyer name, itemsText, buyer fields", { skip }, async () => {
  const o = await placeOrder(
    [
      { productId: mug.id, variantId: mug.m, quantity: 2 },
      { productId: gift.id, variantId: gift.v, quantity: 1 },
    ],
    { firstName: "Zebediah", lastName: "Quill" },
  );
  const fragment = o.orderNumber.slice(-4);
  const byNumber = await list(`search=${encodeURIComponent(fragment)}`);
  assert.ok(byNumber.some((r) => r.id === o.orderId));

  const byName = await list(`search=${encodeURIComponent("zebed")}`);
  assert.deepEqual(byName.map((r) => r.id), [o.orderId]);
  assert.equal(byName[0].buyerName, "Zebediah Quill");
  assert.match(byName[0].buyerEmail, /@x\.test$/);
  assert.equal(byName[0].itemsText, "แก้ว Mug (M) ×2, ชุดของขวัญ ×1");
  assert.equal(byName[0].paymentStatus, "pending");

  const shipping = await list(`search=zebed&shippingStatus=shipped`);
  assert.equal(shipping.length, 0);
  const bad = await admin("GET", "/orders?paymentStatus=nope");
  assert.equal(bad.statusCode, 400);
});

test("list: search '%' is literal", { skip }, async () => {
  const pct = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }], { firstName: "Half%Off" });
  await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }], { firstName: "Plain" });
  const rows = await list(`search=${encodeURIComponent("%")}`);
  assert.deepEqual(rows.map((r) => r.id), [pct.orderId]);
  const underscore = await list(`search=${encodeURIComponent("_")}`);
  assert.equal(underscore.length, 0);
});

test("list: paymentStatus=expired only when the store is closed and no open QR", { skip }, async () => {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }], { firstName: "Expirytest" });
  const q = (status: string) => list(`search=expirytest&paymentStatus=${status}`);
  assert.deepEqual((await q("expired")).map((r) => r.id), []);
  assert.deepEqual((await q("pending")).map((r) => r.id), [o.orderId]);

  await t.sql`UPDATE merch_stores SET closes_at = clock_timestamp() - interval '1 minute' WHERE event_id = ${eventId}`;
  // QR still active: pending even though closed
  assert.deepEqual((await q("expired")).map((r) => r.id), []);
  assert.deepEqual((await q("pending")).map((r) => r.id), [o.orderId]);

  await expireAgo(o.attemptId, 30);
  const expired = await q("expired");
  assert.deepEqual(expired.map((r) => r.id), [o.orderId]);
  assert.equal(expired[0].paymentStatus, "expired");
  assert.deepEqual((await q("pending")).map((r) => r.id), []);
  assert.deepEqual((await q("paid")).map((r) => r.id), []);
});

test("list: createdFrom/createdTo use Bangkok day bounds", { skip }, async () => {
  const late = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  const midnight = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await t.sql`UPDATE merch_orders SET created_at = '2026-10-16T16:30:00Z' WHERE id = ${late.orderId}`;
  await t.sql`UPDATE merch_orders SET created_at = '2026-10-16T17:00:00Z' WHERE id = ${midnight.orderId}`;

  const to16 = (await list("createdTo=2026-10-16")).map((r) => r.id);
  assert.ok(to16.includes(late.orderId));
  assert.ok(!to16.includes(midnight.orderId));

  const from17 = (await list("createdFrom=2026-10-17")).map((r) => r.id);
  assert.ok(!from17.includes(late.orderId));
  assert.ok(from17.includes(midnight.orderId));

  const only16 = (await list("createdFrom=2026-10-16&createdTo=2026-10-16")).map((r) => r.id);
  assert.ok(only16.includes(late.orderId));
  assert.ok(!only16.includes(midnight.orderId));

  const bad = await admin("GET", "/orders?createdFrom=2026-13-40");
  assert.equal(bad.statusCode, 400);
});

test("detail: attempts without payload, notifications, audit; payment-checks settles", { skip }, async () => {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  const d0 = await detail(o.orderId);
  assert.equal(d0.version, 1);
  assert.equal(d0.attempts.length, 1);
  for (const attempt of d0.attempts) {
    assert.ok(!Object.keys(attempt).some((k) => /payload/i.test(k)), JSON.stringify(attempt));
  }
  assert.equal(d0.attempts[0].referenceNo, o.referenceNo);
  assert.equal(d0.attempts[0].amountMinor, o.total);
  assert.equal(d0.payment.attempt.qrPayload, null);
  assert.deepEqual(d0.notifications, []);
  assert.deepEqual(d0.audit, []);

  inquireImpl = (ref, amount) => paidResult(ref, amount);
  const checked = await admin("POST", `/orders/${o.orderId}/payment-checks`);
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().data.paymentStatus, "paid");

  const d1 = await detail(o.orderId);
  assert.equal(d1.notifications.length, 1);
  assert.equal(d1.notifications[0].type, "paid");
  assert.equal(d1.notifications[0].status, "queued");

  const other = await t.createEvent();
  const foreign = await app.inject({
    method: "GET",
    url: `/api/backoffice/merchandise/events/${other}/orders/${o.orderId}`,
    headers: adminHeaders,
  });
  assert.equal(foreign.statusCode, 404);
});

test("edit unpaid: active QR blocks; after expiry total changes and next QR uses it", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.m, quantity: 1 }]);
  const d0 = await detail(o.orderId);
  const itemId = d0.items[0].id;
  const body = { expectedVersion: 1, reason: "ลูกค้าขอเพิ่มจำนวน", lines: [{ sourceItemId: itemId, quantity: 3 }] };

  const blocked = await admin("PATCH", `/orders/${o.orderId}`, body);
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "MERCH_ORDER_HAS_ACTIVE_QR");

  await expireAgo(o.attemptId, 300);
  const res = await admin("PATCH", `/orders/${o.orderId}`, body);
  assert.equal(res.statusCode, 200, res.body);
  const edited = res.json().data;
  assert.equal(edited.version, 2);
  assert.equal(edited.items[0].quantity, 3);
  assert.equal(edited.amounts.subtotalMinor, 45000);
  assert.equal(edited.amounts.totalMinor, 50000);
  assert.equal(edited.audit.length, 1);
  assert.equal(edited.audit[0].action, "order.edit");
  assert.equal(edited.audit[0].actorId, adminId);
  assert.equal(edited.audit[0].reason, "ลูกค้าขอเพิ่มจำนวน");
  assert.equal(edited.audit[0].before.total, 20000);
  assert.equal(edited.audit[0].after.total, 50000);
  assert.equal(edited.audit[0].before.items[0].quantity, 1);
  assert.equal(edited.audit[0].after.items[0].quantity, 3);

  await requestNewQr(ctx, o.orderId);
  const attempts = await t.sql<{ amount: number }[]>`
    SELECT amount FROM merch_payment_attempts WHERE order_id = ${o.orderId} ORDER BY created_at DESC, id DESC`;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].amount, 50000);
});

test("edit unpaid is blocked inside the 2-minute verifying window after QR expiry", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.m, quantity: 1 }]);
  const itemId = (await detail(o.orderId)).items[0].id;
  const body = { expectedVersion: 1, reason: "ลูกค้าขอเพิ่มจำนวน", lines: [{ sourceItemId: itemId, quantity: 2 }] };

  await expireAgo(o.attemptId, 60);
  const verifying = await admin("PATCH", `/orders/${o.orderId}`, body);
  assert.equal(verifying.statusCode, 409, verifying.body);
  assert.equal(verifying.json().code, "MERCH_ORDER_HAS_ACTIVE_QR");

  await t.sql`UPDATE merch_payment_attempts SET status = 'expired', qr_payload_enc = NULL WHERE id = ${o.attemptId}`;
  const stillVerifying = await admin("PATCH", `/orders/${o.orderId}`, body);
  assert.equal(stillVerifying.statusCode, 409, stillVerifying.body);
  assert.equal(stillVerifying.json().code, "MERCH_ORDER_HAS_ACTIVE_QR");

  await expireAgo(o.attemptId, 121);
  const res = await admin("PATCH", `/orders/${o.orderId}`, body);
  assert.equal(res.statusCode, 200, res.body);
});

test("old QR paid at the old amount after an edit goes to amount_mismatch review, not settled", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.m, quantity: 1 }]);
  const itemId = (await detail(o.orderId)).items[0].id;
  await expireAgo(o.attemptId, 300);
  const edit = await admin("PATCH", `/orders/${o.orderId}`, {
    expectedVersion: 1,
    reason: "ลูกค้าขอเพิ่มจำนวน",
    lines: [{ sourceItemId: itemId, quantity: 3 }],
  });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().data.amounts.totalMinor, 50000);

  inquireImpl = (ref, amount) => paidResult(ref, amount);
  assert.equal(
    await applyInquiryResult(ctx, o.attemptId, paidResult(o.referenceNo, o.total), { at: new Date(), source: "inquiry" }),
    "review",
  );
  const [order] = await t.sql<{ payment_status: string; paid_attempt_id: string | null }[]>`
    SELECT payment_status, paid_attempt_id FROM merch_orders WHERE id = ${o.orderId}`;
  assert.equal(order.payment_status, "pending");
  assert.equal(order.paid_attempt_id, null);
  const [attempt] = await t.sql<{ status: string; review_reason: string | null; next_check_at: Date | null }[]>`
    SELECT status, review_reason, next_check_at FROM merch_payment_attempts WHERE id = ${o.attemptId}`;
  assert.notEqual(attempt.status, "paid");
  assert.equal(attempt.review_reason, "amount_mismatch");
  assert.equal(attempt.next_check_at, null);
  const outbox = await t.sql`SELECT 1 FROM merch_email_outbox WHERE order_id = ${o.orderId}`;
  assert.equal(outbox.length, 0);
  assert.equal((await detail(o.orderId)).payment.state, "review");
});

test("paid evidence on an attempt with an unresolved review is recorded only, not settled", { skip }, async () => {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await t.sql`UPDATE merch_payment_attempts SET review_reason = 'merchant_mismatch' WHERE id = ${o.attemptId}`;
  assert.equal(
    await applyInquiryResult(ctx, o.attemptId, paidResult(o.referenceNo, o.total), { at: new Date(), source: "inquiry" }),
    "review",
  );
  const [order] = await t.sql<{ payment_status: string }[]>`SELECT payment_status FROM merch_orders WHERE id = ${o.orderId}`;
  assert.equal(order.payment_status, "pending");
  const [attempt] = await t.sql<{ status: string; review_reason: string }[]>`
    SELECT status, review_reason FROM merch_payment_attempts WHERE id = ${o.attemptId}`;
  assert.notEqual(attempt.status, "paid");
  assert.equal(attempt.review_reason, "merchant_mismatch");
  assert.equal((await t.sql`SELECT 1 FROM merch_email_outbox WHERE order_id = ${o.orderId}`).length, 0);
});

test("edit paid: contact required, total must match, same-price variant swap is audited", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.m, quantity: 2 }]);
  await settle(o);
  const itemId = (await detail(o.orderId)).items[0].id;

  const noContact = await admin("PATCH", `/orders/${o.orderId}`, {
    expectedVersion: 1,
    reason: "เปลี่ยนไซซ์",
    lines: [{ productId: mug.id, variantId: mug.l, bundleSelections: [], quantity: 2 }],
  });
  assert.equal(noContact.statusCode, 422, noContact.body);
  assert.equal(noContact.json().code, "MERCH_CONTACT_REQUIRED");

  const totalChange = await admin("PATCH", `/orders/${o.orderId}`, {
    expectedVersion: 1,
    reason: "เพิ่มจำนวน",
    contactConfirmed: true,
    contactNote: "โทรคุยแล้ว",
    lines: [{ sourceItemId: itemId, quantity: 3 }],
  });
  assert.equal(totalChange.statusCode, 422, totalChange.body);
  assert.equal(totalChange.json().code, "MERCH_PAID_TOTAL_MUST_MATCH");

  const swap = await admin("PATCH", `/orders/${o.orderId}`, {
    expectedVersion: 1,
    reason: "เปลี่ยนไซซ์",
    contactConfirmed: true,
    contactNote: "โทรยืนยันกับลูกค้า 16 ต.ค.",
    lines: [{ productId: mug.id, variantId: mug.l, bundleSelections: [], quantity: 2 }],
  });
  assert.equal(swap.statusCode, 200, swap.body);
  const d = swap.json().data;
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].sizeTh, "L");
  assert.equal(d.amounts.totalMinor, o.total);
  assert.equal(d.paymentStatus, "paid");
  assert.equal(d.audit[0].contactNote, "โทรยืนยันกับลูกค้า 16 ต.ค.");
  const [row] = await t.sql<{ contact_confirmed: boolean; contact_note: string }[]>`
    SELECT contact_confirmed, contact_note FROM merch_audit_log WHERE entity_id = ${o.orderId} AND action = 'order.edit'`;
  assert.equal(row.contact_confirmed, true);
  assert.equal(row.contact_note, "โทรยืนยันกับลูกค้า 16 ต.ค.");
});

test("edit keeps original unit_price of existing lines after a catalog price change", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.m, quantity: 1 }]);
  await expireAgo(o.attemptId, 300);
  const itemId = (await detail(o.orderId)).items[0].id;
  await t.sql`UPDATE merch_products SET base_price = 20000 WHERE id = ${mug.id}`;
  try {
    const res = await admin("PATCH", `/orders/${o.orderId}`, {
      expectedVersion: 1,
      reason: "แก้ที่อยู่และจำนวน",
      recipient: { ...recipient, addressLine: "1 ถนนใหม่" },
      lines: [
        { sourceItemId: itemId, quantity: 2 },
        { productId: mug.id, variantId: mug.l, bundleSelections: [], quantity: 1 },
      ],
    });
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.equal(d.items[0].unitPriceMinor, 15000);
    assert.equal(d.items[0].lineTotalMinor, 30000);
    assert.equal(d.items[1].unitPriceMinor, 20000);
    assert.equal(d.amounts.totalMinor, 30000 + 20000 + 5000);
    assert.equal(d.recipient.addressLine, "1 ถนนใหม่");
    assert.equal(d.audit[0].before.recipient.addressLine, recipient.addressLine);
    assert.equal(d.audit[0].after.recipient.addressLine, "1 ถนนใหม่");
  } finally {
    await t.sql`UPDATE merch_products SET base_price = 15000 WHERE id = ${mug.id}`;
  }
});

test("edit validation: stale version, missing reason, empty lines, unknown source item", { skip }, async () => {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await expireAgo(o.attemptId, 300);
  const stale = await admin("PATCH", `/orders/${o.orderId}`, { expectedVersion: 7, reason: "x", recipient });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, "MERCH_VERSION_CONFLICT");

  const noReason = await admin("PATCH", `/orders/${o.orderId}`, { expectedVersion: 1, recipient });
  assert.equal(noReason.statusCode, 400, noReason.body);

  const empty = await admin("PATCH", `/orders/${o.orderId}`, { expectedVersion: 1, reason: "x", lines: [] });
  assert.equal(empty.statusCode, 422, empty.body);
  assert.equal(empty.json().code, "MERCH_ORDER_EMPTY");

  const giftItemId = (await detail(o.orderId)).items[0].id;
  const tooLarge = await admin("PATCH", `/orders/${o.orderId}`, {
    expectedVersion: 1,
    reason: "x",
    lines: [{ sourceItemId: giftItemId, quantity: 9999 }],
  });
  assert.equal(tooLarge.statusCode, 422, tooLarge.body);
  assert.equal(tooLarge.json().code, "MERCH_ORDER_TOO_LARGE");

  const unknown = await admin("PATCH", `/orders/${o.orderId}`, {
    expectedVersion: 1,
    reason: "x",
    lines: [{ sourceItemId: "00000000-0000-4000-8000-000000000000", quantity: 1 }],
  });
  assert.equal(unknown.statusCode, 422, unknown.body);
  assert.equal(unknown.json().code, "MERCH_ORDER_LINE_INVALID");
});

test("reviews: duplicate payment listed, resolve audited, second resolve conflicts", { skip }, async () => {
  const o = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  const [b] = await t.sql<{ id: string; reference_no: string }[]>`
    INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at, expires_at)
    VALUES (${o.orderId}, '7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0'), ${o.total},
            'expired', clock_timestamp() - interval '20 minutes', clock_timestamp() - interval '10 minutes')
    RETURNING id, reference_no`;
  await settle(o);
  assert.equal(
    await applyInquiryResult(ctx, b.id, paidResult(b.reference_no, o.total), { at: new Date(), source: "inquiry" }),
    "duplicate",
  );

  const open = await admin("GET", "/payment-reviews?resolved=false");
  assert.equal(open.statusCode, 200, open.body);
  const row = open.json().data.find((r: { attemptId: string }) => r.attemptId === b.id);
  assert.ok(row, open.body);
  assert.equal(row.reviewReason, "duplicate_payment");
  assert.equal(row.orderId, o.orderId);
  assert.equal(row.orderNumber, o.orderNumber);
  assert.equal(row.referenceNo, b.reference_no);
  assert.equal(row.amountMinor, o.total);
  assert.equal(row.resolvedAt, null);

  const noNote = await admin("POST", `/payment-attempts/${b.id}/resolve-review`, {});
  assert.equal(noNote.statusCode, 400);

  const resolved = await admin("POST", `/payment-attempts/${b.id}/resolve-review`, { note: "คืนเงินผ่านธนาคารแล้ว" });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.ok(resolved.json().data.resolvedAt);
  assert.equal(resolved.json().data.note, "คืนเงินผ่านธนาคารแล้ว");
  const audit = await t.sql<{ action: string; actor_backoffice_user_id: number }[]>`
    SELECT action, actor_backoffice_user_id FROM merch_audit_log WHERE entity_id = ${b.id}`;
  assert.deepEqual(audit.map((a) => a.action), ["review.resolve"]);
  assert.equal(audit[0].actor_backoffice_user_id, adminId);

  const again = await admin("POST", `/payment-attempts/${b.id}/resolve-review`, { note: "ซ้ำ" });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().code, "MERCH_REVIEW_ALREADY_RESOLVED");

  const stillOpen = (await admin("GET", "/payment-reviews")).json().data;
  assert.ok(!stillOpen.some((r: { attemptId: string }) => r.attemptId === b.id));
  const done = (await admin("GET", "/payment-reviews?resolved=true")).json().data;
  assert.ok(done.some((r: { attemptId: string }) => r.attemptId === b.id));
});
