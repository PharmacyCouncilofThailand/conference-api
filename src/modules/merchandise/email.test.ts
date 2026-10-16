import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBaht, renderPaidEmail, renderShippedEmail } from "./email.js";
import type { OrderDetail } from "./types.js";

const order = {
  id: "o1",
  orderNumber: "EVT-M-000001",
  createdAt: "2026-10-16T00:00:00.000Z",
  paymentStatus: "paid",
  paidAt: null,
  shipping: { status: "shipped", carrier: "Kerry", trackingId: "00123", shippedAt: null },
  amounts: { subtotalMinor: 123000, shippingMinor: 5000, totalMinor: 128000, currency: "THB" },
  buyer: { name: "B", email: "b@x.test", phone: null },
  recipient: {
    fullName: "สมชาย ใจดี",
    phone: "081-234-5678",
    addressLine: "99/1 ถนนสุขุมวิท",
    subdistrict: "คลองเตย",
    district: "คลองเตย",
    province: "กรุงเทพมหานคร",
    postalCode: "10110",
    company: null,
    deliveryNote: null,
  },
  items: [
    { id: "i1", kind: "single", nameTh: "เสื้อ", sizeTh: "L", colorTh: "ดำ", quantity: 2, unitPriceMinor: 50000, lineTotalMinor: 100000, components: [] },
    { id: "i2", kind: "single", nameTh: "<script>alert(1)</script>", sizeTh: null, colorTh: null, quantity: 1, unitPriceMinor: 23000, lineTotalMinor: 23000, components: [] },
  ],
  productionInfoTh: null,
  shippingInfoTh: null,
  payment: {},
} as unknown as OrderDetail;

const SUPPORT = "แนะนำให้ถ่ายวิดีโอขณะแกะพัสดุ หากพบปัญหากรุณาติดต่อ pr@pharmacycouncil.org พร้อมแจ้งเลขคำสั่งซื้อและหลักฐาน";

test("formatBaht groups thousands with two decimals", () => {
  assert.equal(formatBaht(123450), "1,234.50");
  assert.equal(formatBaht(5000), "50.00");
});

test("paid email lists items, shipping, total, recipient, address and support copy", () => {
  const { subject, html } = renderPaidEmail(order);
  assert.equal(subject, "ยืนยันการชำระเงิน คำสั่งซื้อ EVT-M-000001");
  for (const s of ["EVT-M-000001", "เสื้อ (L / ดำ)", "x 2", "50.00", "1,280.00", "สมชาย ใจดี", "99/1 ถนนสุขุมวิท", "คลองเตย", "กรุงเทพมหานคร", "10110", SUPPORT]) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
});

test("shipped email shows carrier, tracking, recipient and support copy", () => {
  const { subject, html } = renderShippedEmail(order);
  assert.equal(subject, "จัดส่งสินค้าแล้ว คำสั่งซื้อ EVT-M-000001");
  for (const s of ["Kerry", "00123", "สมชาย ใจดี", SUPPORT]) assert.ok(html.includes(s), `missing ${s}`);
});

test("catalog and buyer strings are HTML-escaped", () => {
  const { html } = renderPaidEmail(order);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const shipped = renderShippedEmail({ ...order, shipping: { ...order.shipping, carrier: "<b>K</b>" } });
  assert.ok(!shipped.html.includes("<b>K</b>"));
});
