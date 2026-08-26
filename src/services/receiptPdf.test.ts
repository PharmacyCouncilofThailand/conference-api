import assert from "node:assert/strict";
import test from "node:test";
import { toReceiptViewData } from "./receiptPdf.js";

test("free promo receipt shows free registration method and zero total", () => {
  const view = toReceiptViewData({
    orderNumber: "CONF-1",
    paidAt: new Date("2026-08-26T10:00:00Z"),
    paymentChannel: "free",
    currency: "THB",
    items: [{ name: "Conference Ticket", type: "ticket", price: 5000, quantity: 1 }],
    subtotal: 5000,
    discount: 5000,
    promoCode: "FREE100",
    fee: 0,
    total: 0,
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.test",
  });

  assert.equal(view.netTotal, 0);
  assert.equal(view.discount, 5000);
  assert.equal(view.promoCode, "FREE100");
  assert.equal(view.paymentMethod, "ยกเว้นค่าลงทะเบียน / Promo Code");
});
