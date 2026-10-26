import assert from "node:assert/strict";
import test from "node:test";
import { toReceiptViewData, generateReceiptPdf, TICKET_RECEIPT_LABEL } from "./receiptPdf.js";
import { RECEIPT_REMARKS } from "./receipt/components/ReceiptFooter.js";

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

test("receipt view preserves long promo code exactly", () => {
  const promoCode = "V15BUSUPV15BUSUPV15BUSUPV15BUSUPV";
  const view = toReceiptViewData({
    orderNumber: "CONF-LONG-PROMO",
    paidAt: new Date("2026-08-26T10:00:00Z"),
    paymentChannel: "free",
    currency: "THB",
    items: [{ name: "Conference Ticket", type: "ticket", price: 500, quantity: 1 }],
    subtotal: 500,
    discount: 500,
    promoCode,
    fee: 0,
    total: 0,
    customerName: "Receipt User",
    customerEmail: "receipt@example.test",
  });

  assert.equal(view.promoCode, promoCode);
});

const orderOf = (items: { name: string; type: "ticket" | "addon"; price: number; quantity: number }[]) => ({
  orderNumber: "CONF-LABEL",
  paidAt: new Date("2026-09-20T13:11:00Z"),
  paymentChannel: "promptpay" as const,
  currency: "THB",
  items,
  subtotal: 1250,
  fee: 0,
  total: 1250,
  customerName: "Receipt User",
  customerEmail: "receipt@example.test",
});

test("every ticket type shows the registration fee label while add-ons keep their name", () => {
  const view = toReceiptViewData(
    orderOf([
      { name: "Early Bird", type: "ticket", price: 1000, quantity: 1 },
      { name: "Regular", type: "ticket", price: 1500, quantity: 2 },
      { name: "Workshop", type: "addon", price: 250, quantity: 1 },
    ]),
  );

  assert.deepEqual(
    view.items.map((i) => i.description),
    [TICKET_RECEIPT_LABEL, TICKET_RECEIPT_LABEL, "Workshop"],
  );
  assert.equal(
    TICKET_RECEIPT_LABEL.replace("\n", ""),
    "ค่าธรรมเนียมการลงทะเบียนเข้าร่วมงานประชุมวิชาการวิจัยและนวัตกรรมทางเภสัชกรรมระดับชาติ ประจำปี 2569 (PRIS 2026)",
  );
  assert.equal(TICKET_RECEIPT_LABEL.split("\n").length, 2);
  // Only the label changes; amounts still come from the real ticket price.
  assert.deepEqual(view.items.map((i) => i.amount), [1000, 3000, 250]);
});

test("ticket receipt label includes the registered attendee name when available", () => {
  const view = toReceiptViewData({
    ...orderOf([{ name: "Early Bird", type: "ticket", price: 1250, quantity: 1 }]),
    ticketOwnerName: "Ada Lovelace",
  });

  assert.equal(
    view.items[0].description,
    `${TICKET_RECEIPT_LABEL}\nชื่อผู้เข้าร่วม: Ada Lovelace`,
  );
});

test("ticket receipt label omits the attendee name when registration is unavailable", () => {
  const view = toReceiptViewData(
    orderOf([{ name: "Early Bird", type: "ticket", price: 1250, quantity: 1 }]),
  );

  assert.equal(view.items[0].description, TICKET_RECEIPT_LABEL);
});

test("receipt PDF renders on one page with the remarks", async () => {
  const stream = await generateReceiptPdf(
    {
      ...orderOf([{ name: "Early Bird", type: "ticket", price: 1250, quantity: 1 }]),
      participantName: "นายตัวอย่าง ทดสอบ",
    },
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const pdf = Buffer.concat(chunks);

  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length, 1);
  assert.equal(RECEIPT_REMARKS.length, 2);
});

test("ticket description uses the registration participant independently of buyer and tax recipient", () => {
  const view = toReceiptViewData({
    ...orderOf([
      { name: "Early Bird", type: "ticket", price: 1000, quantity: 1 },
      { name: "Workshop", type: "addon", price: 250, quantity: 1 },
    ]),
    participantName: "  สมชาย ใจดี  ",
    taxInvoice: { taxName: "หน่วยงานตัวอย่าง", taxId: null, taxFullAddress: null },
  });

  assert.equal(view.items[0].description, `${TICKET_RECEIPT_LABEL}\nชื่อผู้เข้าร่วมงาน : สมชาย ใจดี`);
  assert.equal(view.items[1].description, "Workshop");
  assert.equal(view.recipient.name, "หน่วยงานตัวอย่าง");
});

test("missing or blank registration name does not substitute the buyer name", () => {
  for (const participantName of [undefined, "", "   "]) {
    const view = toReceiptViewData({
      ...orderOf([{ name: "Early Bird", type: "ticket", price: 1250, quantity: 1 }]),
      participantName,
    });
    assert.equal(view.items[0].description, TICKET_RECEIPT_LABEL);
    assert.equal(view.recipient.name, "Receipt User");
  }
});
