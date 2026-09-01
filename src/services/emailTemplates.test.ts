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

test("PRIS accepted oral email keeps its subject and uses the approved body", () => {
  const result = buildEventAbstractAcceptedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    "oral",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026", websiteUrl: "https://pris.pharmacycouncil.org/" },
    "Please strengthen the discussion section before presentation.",
    {
      confirmUrl: "https://pris.pharmacycouncil.org/th/abstracts/confirm?token=test-token",
      deadline: new Date("2026-09-05T16:59:00.000Z"),
    },
    earlyBirdNotice,
  );

  assert.equal(result.subject, "Congratulations! Abstract Accepted (Oral) - PRIS 2026");
  assert.match(result.html, /Congratulations! We are pleased to inform you that your abstract, titled <em>&quot;A useful pharmacy abstract&quot;<\/em>, has been <strong>accepted as an Oral Presentation<\/strong> at PRIS 2026\./);
  assert.match(result.html, /<strong>Conference Details<\/strong>/);
  assert.match(result.html, /October 29–30, 2026/);
  assert.match(result.html, /Impact Challenger, Jupiter Room 4–13/);
  assert.match(result.html, /padding-left: 2em/);
  assert.match(result.html, /<p>Dear Ada Lovelace,<\/p>/);
  assert.match(result.html, /<strong>Reviewer Comments<\/strong>/);
  assert.match(result.html, /Please strengthen the discussion section before presentation\./);
  assert.match(
    result.html,
    /Impact Challenger, Jupiter Room 4–13<\/div>\s*<p><strong>Reviewer Comments<\/strong><\/p>\s*<p>Please strengthen the discussion section before presentation\.<\/p>\s*<p>All oral presenters/,
  );
  assert.match(result.html, /All oral presenters are required to register for the meeting in order to present\./);
  assert.match(result.html, /href="https:\/\/pris\.pharmacycouncil\.org\/th\/registration"/);
  assert.match(result.html, /ACTION REQUIRED \/ กรุณายืนยันการเข้าร่วม/);
  assert.match(result.html, /th\/abstracts\/confirm\?token=test-token<br><\/div><br>\s*<div>=== IMPORTANT REGISTRATION RATE/);
  assert.match(result.html, /1,250/);
  assert.match(result.html, /2,500/);
  assert.match(result.html, /15 September 2026/);
  assert.match(result.html, /15 กันยายน 2569/);
  assert.match(result.html, /already completed registration\/payment/i);
  assert.match(result.html, /โปรดละเว้นข้อความส่วนการชำระเงินนี้/);
  assert.match(result.html, /href="mailto:pr@pharmacycouncil\.org"/);
  assert.match(result.html, /<p>Sincerely,<\/p><p>The Pharmacy Council of Thailand<\/p>/);
});

test("PRIS accepted poster email keeps poster wording", () => {
  const result = buildEventAbstractAcceptedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    "poster",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026", websiteUrl: "https://pris.pharmacycouncil.org/" },
  );

  assert.equal(result.subject, "Congratulations! Abstract Accepted (Poster) - PRIS 2026");
  assert.match(result.html, /accepted as a Poster Presentation/);
  assert.match(result.html, /All poster presenters are required to register/);
  assert.doesNotMatch(result.html, /All oral presenters/);
  assert.doesNotMatch(result.html, /Reviewer Comments/);
});

test("PRIS rejected abstract email uses the approved subject, body, and optional Early Bird notice", () => {
  const result = buildEventAbstractRejectedEmailContent(
    "Ada",
    "Lovelace",
    "A useful pharmacy abstract",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026" },
    "The study is outside the current presentation scope.",
    earlyBirdNotice,
  );

  assert.equal(result.subject, "Abstract Review Result – PRIS 2026");
  assert.match(
    result.html,
    /Thank you for submitting your abstract for consideration in poster or oral presentation at PRIS 2026\. After careful review, and due to the high number of quality submissions relative to limited presentation slots, we regret to inform you that your abstract has not been accepted for presentation this year\./,
  );
  assert.match(result.html, /Abstract Title: A useful pharmacy abstract/);
  assert.match(result.html, /<strong>Reviewer Comments<\/strong>/);
  assert.match(result.html, /The study is outside the current presentation scope\./);
  assert.match(
    result.html,
    /Abstract Title: A useful pharmacy abstract<\/p>\s*<p><strong>Reviewer Comments<\/strong><\/p>\s*<p>The study is outside the current presentation scope\.<\/p>\s*<p>For registration information, please visit: <a href="https:\/\/pris\.pharmacycouncil\.org\/th\/registration">https:\/\/pris\.pharmacycouncil\.org\/th\/registration<\/a><\/p>\s*<div>=== IMPORTANT REGISTRATION RATE/,
  );
  assert.match(result.html, /href="https:\/\/pris\.pharmacycouncil\.org\/th\/registration"/);
  assert.match(result.html, /1,250/);
  assert.match(result.html, /2,500/);
  assert.match(result.html, /15 September 2026/);
  assert.match(result.html, /15 กันยายน 2569/);
  assert.match(result.html, /already completed registration\/payment/i);
  assert.match(result.html, /โปรดละเว้นข้อความส่วนการชำระเงินนี้/);
  assert.match(result.html, /Thank you so much again for your submission\. Looking forward to your abstract at next year's conference\./);
  assert.match(result.html, /<p>Sincerely,<\/p><p>The Pharmacy Council of Thailand<\/p>/);
});

test("PRIS rejected email escapes dynamic recipient name, abstract title, and reviewer comment", () => {
  const result = buildEventAbstractRejectedEmailContent(
    '<img src=x onerror=alert(1)>',
    "A & B",
    '<script>alert("x")</script> & Pharmacy',
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026" },
    '<svg onload=alert("review")>Reviewer & note</svg>',
    earlyBirdNotice,
  );

  assert.doesNotMatch(result.html, /<script>/);
  assert.doesNotMatch(result.html, /<img src=x/);
  assert.doesNotMatch(result.html, /<svg onload=/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /A &amp; B/);
  assert.match(result.html, /&amp; Pharmacy/);
  assert.match(result.html, /&lt;svg onload=alert\(&quot;review&quot;\)&gt;Reviewer &amp; note&lt;\/svg&gt;/);
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

test("manual PRIS reminder keeps its subject and uses the approved reminder body", () => {
  const result = buildPris2026EarlyBirdReminderEmailContent(
    "Ada",
    "Lovelace",
    { ...ctx, shortName: "PRIS 2026", eventName: "PRIS 2026" },
    earlyBirdNotice,
  );

  assert.equal(result.subject, "PRIS 2026 Early Bird Registration Reminder - Payment by 15 September 2026");
  assert.match(result.html, /Dear Ada Lovelace,/);
  assert.match(
    result.html,
    /This is a reminder regarding your PRIS 2026 registration\. You are eligible for the Early Bird registration rate, as both your user account and your PRIS 2026 abstract submission were created before 31 August 2026, 23:59 \(Bangkok time\)\. Please note that this eligibility is based solely on submission timing and is independent of your abstract's acceptance or rejection status\./,
  );
  assert.match(result.html, /IMPORTANT REGISTRATION RATE \/ ข้อมูลสำคัญเรื่องค่าลงทะเบียน/);
  assert.match(result.html, /1,250/);
  assert.match(result.html, /2,500/);
  assert.match(result.html, /15 September 2026/);
  assert.match(result.html, /15 กันยายน 2569/);
  assert.match(result.html, /already completed registration\/payment/i);
  assert.match(result.html, /โปรดละเว้นข้อความส่วนการชำระเงินนี้/);
  assert.match(result.html, /For registration details, please visit:/);
  assert.match(result.html, /href="https:\/\/pris\.pharmacycouncil\.org\/th\/registration"/);
  assert.match(result.html, /Should you have any questions, please feel free to contact us\./);
  assert.match(result.html, /<p>Sincerely,<\/p><p>The Pharmacy Council of Thailand<\/p>/);
});
