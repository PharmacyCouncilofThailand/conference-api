import assert from "node:assert/strict";
import test from "node:test";
import { buildEventPaymentReceiptEmailContent } from "./emailTemplates.js";

const ctx = {
  eventName: "Test Conference",
  shortName: "TEST",
  dates: "August 26, 2026",
  venue: "Test Venue",
  websiteUrl: "https://example.test",
};

test("zero-total promo email names free registration and shows discount", () => {
  const result = buildEventPaymentReceiptEmailContent(
    "Ada",
    "Lovelace",
    "CONF-1",
    new Date("2026-08-26T10:00:00Z"),
    "free",
    [{ name: "Conference Ticket", type: "ticket", price: 5000 }],
    5000,
    0,
    0,
    "THB",
    "https://api.example.test/receipt/1",
    ctx,
    undefined,
    "REG-1",
    { discount: 5000, promoCode: "FREE100" },
  );

  assert.match(result.html, /Payment Method: Free registration \/ Promo code/);
  assert.match(result.html, /Discount \(FREE100\):/);
  assert.match(result.html, /5,000/);
  assert.match(result.html, /Total Paid:/);
});

test("free ticket without promo uses the generic free registration label", () => {
  const result = buildEventPaymentReceiptEmailContent(
    "Ada",
    "Lovelace",
    "CONF-2",
    new Date("2026-08-26T10:00:00Z"),
    "free",
    [{ name: "Free Ticket", type: "ticket", price: 0 }],
    0,
    0,
    0,
    "THB",
    "https://api.example.test/receipt/2",
    ctx,
  );

  assert.match(result.html, /Payment Method: Free registration/);
  assert.doesNotMatch(result.html, /Credit\/Debit Card/);
});
