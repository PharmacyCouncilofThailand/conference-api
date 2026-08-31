import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventAbstractAcceptedEmailContent,
  buildEventAbstractRejectedEmailContent,
  buildEventPaymentReceiptEmailContent,
  buildPris2026EarlyBirdReminderEmailContent,
} from "./emailTemplates.js";

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

const earlyBirdNotice = {
  rateAmount: 1250,
  currency: "THB" as const,
  deadline: new Date("2026-09-15T16:59:00.000Z"),
  regularAmount: 2500,
};

test("accepted abstract email can include shared PRIS Early Bird notice", () => {
  const result = buildEventAbstractAcceptedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    "poster",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026" },
    undefined,
    undefined,
    earlyBirdNotice,
  );

  assert.match(result.html, /1,250/);
  assert.match(result.html, /2,500/);
  assert.match(result.html, /15 September 2026/);
  assert.match(result.html, /15 กันยายน 2569/);
  assert.match(result.html, /already completed registration\/payment/i);
  assert.match(result.html, /โปรดละเว้นข้อความส่วนการชำระเงินนี้/);
});

test("rejected abstract email uses the same optional PRIS Early Bird notice", () => {
  const result = buildEventAbstractRejectedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026" },
    undefined,
    earlyBirdNotice,
  );

  assert.match(result.html, /1,250/);
  assert.match(result.html, /2,500/);
  assert.match(result.html, /15 September 2026/);
  assert.match(result.html, /15 กันยายน 2569/);
  assert.match(result.html, /already completed registration\/payment/i);
  assert.match(result.html, /โปรดละเว้นข้อความส่วนการชำระเงินนี้/);
});

test("abstract result emails keep old content when no pricing notice is supplied", () => {
  const accepted = buildEventAbstractAcceptedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    "oral",
    ctx,
  );
  const rejected = buildEventAbstractRejectedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    ctx,
  );

  assert.doesNotMatch(accepted.html, /IMPORTANT REGISTRATION RATE/);
  assert.doesNotMatch(rejected.html, /IMPORTANT REGISTRATION RATE/);
});

test("manual PRIS reminder explains cutoff qualification rather than approval status", () => {
  const result = buildPris2026EarlyBirdReminderEmailContent(
    "Ada",
    "Lovelace",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026" },
    earlyBirdNotice,
  );

  assert.match(result.subject, /Payment by 15 September 2026/);
  assert.match(result.html, /account and your PRIS 2026 abstract submission existed before 31 August 2026/i);
  assert.match(result.html, /not created by an abstract approval or rejection result/i);
  assert.match(result.html, /1,250/);
  assert.match(result.html, /2,500/);
  assert.match(result.html, /15 September 2026/);
});
