import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import type { MerchContext } from "./payments/attempts.js";
import type { InquiryResult, PaysoConfig } from "./payments/payso-client.js";
import { applyInquiryResult } from "./payments/settlement.js";
import { productionRows } from "./reports.js";
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
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EVENT_CODE = "RPT2026";
const ADMIN_EMAIL = "reports-admin@x.test";
let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;
let adminHeaders: { authorization: string };
let ctx: MerchContext;
let mug: { id: string; s: string; m: string };
let bag: { id: string };
let book: { id: string };
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
  phone: "0812345678",
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

type Placed = { orderId: string; orderNumber: string; attemptId: string; referenceNo: string; total: number };

function admin(method: string, path: string, payload?: unknown) {
  return app.inject({
    method: method as "GET",
    url: `/api/backoffice/merchandise/events/${eventId}${path}`,
    headers: adminHeaders,
    payload: payload as object | undefined,
  });
}

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

async function settle(o: Placed) {
  assert.equal(
    await applyInquiryResult(ctx, o.attemptId, paidResult(o.referenceNo, o.total), { at: new Date(), source: "inquiry" }),
    "settled",
  );
}

/** Rewrites the order's only line into a bundle snapshot with the given components. */
async function makeBundle(orderId: string, quantity: number, components: object[]) {
  await t.sql`
    UPDATE merch_order_items
    SET kind = 'bundle', name_th = 'ชุดสุดคุ้ม', size_th = NULL, color_th = NULL,
        quantity = ${quantity}, components = ${JSON.stringify(components)}::jsonb
    WHERE order_id = ${orderId}`;
}

const comp = (productId: string, nameTh: string, sizeTh: string | null = null, colorTh: string | null = null) => ({
  productId,
  variantId: null,
  nameTh,
  sizeTh,
  colorTh,
  quantityPerBundle: 1,
});

/** Mug lines placed through the cart carry a size; the spec example uses size-less Mug. */
async function clearSize(orderId: string) {
  await t.sql`UPDATE merch_order_items SET size_th = NULL WHERE order_id = ${orderId}`;
}

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent(EVENT_CODE);
  const adminId = await t.createAdmin({ email: ADMIN_EMAIL });
  const payso = fakePayso({ inquire: () => ({ kind: "not_found" }) });
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
  const mugDto = await mkSingle("Mug", 15000, [{ sizeTh: "S" }, { sizeTh: "M" }]);
  mug = {
    id: mugDto.id,
    s: mugDto.variants.find((v) => v.sizeTh === "S")!.id,
    m: mugDto.variants.find((v) => v.sizeTh === "M")!.id,
  };
  bag = { id: (await mkSingle("กระเป๋า", 20000)).id };
  book = { id: (await mkSingle("สมุด", 5000)).id };
  const giftDto = await mkSingle("ชุดของขวัญ", 30000);
  gift = { id: giftDto.id, v: giftDto.variants[0].id };
});

beforeEach(async () => {
  if (skip) return;
  await t.sql`DELETE FROM merch_payment_events WHERE attempt_id IN (SELECT a.id FROM merch_payment_attempts a JOIN merch_orders o ON o.id = a.order_id WHERE o.event_id = ${eventId})`;
  await t.sql`DELETE FROM merch_email_outbox WHERE order_id IN (SELECT id FROM merch_orders WHERE event_id = ${eventId})`;
  await t.sql`DELETE FROM merch_payment_attempts WHERE order_id IN (SELECT id FROM merch_orders WHERE event_id = ${eventId})`;
  await t.sql`DELETE FROM merch_orders WHERE event_id = ${eventId}`;
});

after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});

async function loadWorkbook(res: { rawPayload: Buffer }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
  return wb;
}

test("production: bundle components + singles, unpaid excluded (spec example)", { skip }, async () => {
  const b = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await makeBundle(b.orderId, 2, [comp(mug.id, "Mug"), comp(bag.id, "กระเป๋า"), comp(book.id, "สมุด")]);
  await settle(b);
  const single = await placeOrder([{ productId: mug.id, variantId: mug.s, quantity: 3 }]);
  await clearSize(single.orderId);
  await settle(single);
  const unpaid = await placeOrder([{ productId: mug.id, variantId: mug.s, quantity: 5 }]);
  await clearSize(unpaid.orderId);

  const rows = await productionRows(t.db, eventId);
  assert.deepEqual(
    rows.map((r) => [r.nameTh, r.singleQuantity, r.bundleQuantity, r.totalQuantity]),
    [
      ["Mug", 3, 2, 5],
      ["กระเป๋า", 0, 2, 2],
      ["สมุด", 0, 2, 2],
    ],
  );

  const api = await admin("GET", "/production");
  assert.equal(api.statusCode, 200, api.body);
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal(api.json().data.length, 3);
});

test("production: variants split rows", { skip }, async () => {
  const a = await placeOrder([{ productId: mug.id, variantId: mug.s, quantity: 1 }]);
  const c = await placeOrder([{ productId: mug.id, variantId: mug.m, quantity: 2 }]);
  await settle(a);
  await settle(c);
  const rows = await productionRows(t.db, eventId);
  assert.deepEqual(
    rows.map((r) => [r.nameTh, r.sizeTh, r.totalQuantity]),
    [
      ["Mug", "M", 2],
      ["Mug", "S", 1],
    ],
  );
});

test("production: duplicate-payment review does not change totals", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.s, quantity: 2 }]);
  const [dup] = await t.sql<{ id: string; reference_no: string }[]>`
    INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at, expires_at)
    VALUES (${o.orderId}, '7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0'), ${o.total},
            'expired', clock_timestamp() - interval '20 minutes', clock_timestamp() - interval '10 minutes')
    RETURNING id, reference_no`;
  await settle(o);
  assert.equal(
    await applyInquiryResult(ctx, dup.id, paidResult(dup.reference_no, o.total), { at: new Date(), source: "inquiry" }),
    "duplicate",
  );
  const rows = await productionRows(t.db, eventId);
  assert.deepEqual(rows.map((r) => r.totalQuantity), [2]);
});

test("production export: xlsx headers and sheet", { skip }, async () => {
  const o = await placeOrder([{ productId: mug.id, variantId: mug.s, quantity: 2 }]);
  await settle(o);
  const res = await admin("GET", "/production/export.xlsx");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["content-type"], XLSX);
  assert.equal(res.headers["content-disposition"], `attachment; filename="merch-production-${EVENT_CODE}.xlsx"`);
  assert.equal(res.headers["cache-control"], "no-store");
  const ws = (await loadWorkbook(res)).worksheets[0];
  assert.equal(ws.getRow(2).getCell(1).value, "Mug");
  assert.equal(ws.getRow(2).getCell(6).value, 2);
});

test("orders export: sheets, text cells, formula escape, filters, ignores paging", { skip }, async () => {
  const a = await placeOrder([{ productId: mug.id, variantId: mug.s, quantity: 2 }], { firstName: "=cmd" });
  await settle(a);
  await t.sql`UPDATE merch_orders SET shipping_status = 'shipped', carrier = 'Flash', tracking_id = '00123',
    shipped_at = '2026-10-16T05:30:00Z' WHERE id = ${a.orderId}`;
  const pending = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }], { firstName: "Pend" });
  const bundle = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await makeBundle(bundle.orderId, 1, [comp(mug.id, "Mug", "S"), comp(bag.id, "กระเป๋า")]);
  await settle(bundle);

  const res = await admin("GET", "/orders/export.xlsx?page=2&limit=1");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["content-type"], XLSX);
  assert.equal(res.headers["content-disposition"], `attachment; filename="merch-orders-${EVENT_CODE}.xlsx"`);
  assert.equal(res.headers["cache-control"], "no-store");
  const wb = await loadWorkbook(res);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["ออเดอร์", "รายการสินค้า"]);
  const orders = wb.getWorksheet("ออเดอร์")!;
  assert.equal(orders.rowCount, 4); // header + 3 orders despite page=2&limit=1
  const header = (orders.getRow(1).values as unknown[]).slice(1);
  assert.equal(header[0], "เลขออเดอร์");
  const col = (name: string) => {
    const i = header.indexOf(name);
    assert.ok(i >= 0, `column ${name}`);
    return i + 1;
  };
  const rowFor = (num: string) => {
    for (let i = 2; i <= orders.rowCount; i++) if (orders.getRow(i).getCell(1).value === num) return orders.getRow(i);
    throw new Error(`row ${num} missing`);
  };
  const ra = rowFor(a.orderNumber);
  assert.equal(ra.getCell(col("Tracking")).type, ExcelJS.ValueType.String);
  assert.equal(ra.getCell(col("Tracking")).value, "00123");
  assert.equal(ra.getCell(col("ผู้ซื้อ")).value, "'=cmd Buyer");
  assert.equal(ra.getCell(col("วันที่จัดส่ง")).value, "2026-10-16 12:30");
  assert.equal(ra.getCell(col("โทร")).type, ExcelJS.ValueType.String);
  assert.equal(ra.getCell(col("โทร")).value, "0812345678");
  assert.equal(ra.getCell(col("ยอดรวม")).type, ExcelJS.ValueType.Number);

  const items = wb.getWorksheet("รายการสินค้า")!;
  const itemRows: unknown[][] = [];
  for (let i = 2; i <= items.rowCount; i++) itemRows.push((items.getRow(i).values as unknown[]).slice(1));
  const bundleRow = itemRows.find((r) => r[0] === bundle.orderNumber)!;
  assert.equal(bundleRow[1], "ชุดสุดคุ้ม");
  assert.equal(bundleRow[7], "Mug (S) ×1, กระเป๋า ×1");

  const paid = await admin("GET", "/orders/export.xlsx?paymentStatus=paid&limit=1");
  const paidOrders = (await loadWorkbook(paid)).getWorksheet("ออเดอร์")!;
  assert.equal(paidOrders.rowCount, 3); // header + 2 paid
  const nums = [2, 3].map((i) => paidOrders.getRow(i).getCell(1).value);
  assert.ok(!nums.includes(pending.orderNumber));

  const bad = await admin("GET", "/orders/export.xlsx?paymentStatus=nope");
  assert.equal(bad.statusCode, 400);
  assert.match(String(bad.headers["content-type"]), /json/);
});

test("production: quantityPerBundle multiplies bundle quantity", { skip }, async () => {
  const b = await placeOrder([{ productId: gift.id, variantId: gift.v, quantity: 1 }]);
  await makeBundle(b.orderId, 2, [{ ...comp(book.id, "สมุด"), quantityPerBundle: 3 }]);
  await settle(b);
  const rows = await productionRows(t.db, eventId);
  assert.deepEqual(
    rows.map((r) => [r.nameTh, r.singleQuantity, r.bundleQuantity, r.totalQuantity]),
    [["สมุด", 0, 6, 6]],
  );
});
