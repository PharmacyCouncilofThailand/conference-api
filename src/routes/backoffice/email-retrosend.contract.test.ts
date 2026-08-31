import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
const {
  buildRetrosendAbstractResultContent,
  buildRetrosendPreviewConfirmation,
} = await import("./email-retrosend.js");

const prisCtx = {
  eventName: "PRIS 2026",
  shortName: "PRIS 2026",
  dates: "",
  venue: "",
  websiteUrl: "https://pris.pharmacycouncil.org/",
};

const notice = {
  rateAmount: 1250,
  currency: "THB" as const,
  deadline: new Date("2026-09-15T16:59:00.000Z"),
  regularAmount: 2500,
};

test("retrosend preview confirmation is non-persistent preview-only content", () => {
  const confirmation = buildRetrosendPreviewConfirmation(
    prisCtx,
    new Date("2026-09-01T00:00:00.000Z"),
  );

  assert.match(confirmation.confirmUrl, /PREVIEW-ONLY/);
  assert.ok(confirmation.deadline > new Date("2026-09-01T00:00:00.000Z"));
});

test("retrosend PRIS accepted preview has action block and rate notice", () => {
  const accepted = buildRetrosendAbstractResultContent({
    status: "accepted",
    presentationType: "oral",
    firstName: "Ada",
    lastName: "Lovelace",
    title: "Retrosend accepted sample",
    ctx: prisCtx,
    comment: "Retrosend accepted reviewer note",
    registrationRateNotice: notice,
    confirmation: buildRetrosendPreviewConfirmation(
      prisCtx,
      new Date("2026-09-01T00:00:00.000Z"),
    ),
  });

  assert.match(accepted.html, /Reviewer Comments/);
  assert.match(accepted.html, /Retrosend accepted reviewer note/);
  assert.match(accepted.html, /ACTION REQUIRED/);
  assert.match(accepted.html, /PREVIEW-ONLY/);
  assert.match(accepted.html, /IMPORTANT REGISTRATION RATE/);
});

test("retrosend PRIS rejected preview uses final subject and rate notice", () => {
  const rejected = buildRetrosendAbstractResultContent({
    status: "rejected",
    presentationType: null,
    firstName: "Ada",
    lastName: "Lovelace",
    title: "Retrosend rejected sample",
    ctx: prisCtx,
    comment: "Retrosend rejected reviewer note",
    registrationRateNotice: notice,
  });

  assert.equal(rejected.subject, "Abstract Review Result – PRIS 2026");
  assert.match(rejected.html, /Reviewer Comments/);
  assert.match(rejected.html, /Retrosend rejected reviewer note/);
  assert.match(rejected.html, /IMPORTANT REGISTRATION RATE/);
});

test("retrosend non-PRIS rejected preview keeps the generic subject", () => {
  const rejected = buildRetrosendAbstractResultContent({
    status: "rejected",
    presentationType: null,
    firstName: "Ada",
    lastName: "Lovelace",
    title: "Generic rejected sample",
    ctx: {
      eventName: "Another Conference",
      shortName: "OTHER",
      dates: "",
      venue: "",
      websiteUrl: "https://example.test/",
    },
  });

  assert.equal(rejected.subject, "Abstract Submission Update - OTHER");
});
