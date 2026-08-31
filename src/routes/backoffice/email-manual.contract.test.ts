import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
const { buildManualAbstractResultContent } = await import("./email-manual.js");

const ctx = {
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

test("manual PRIS accepted content gets the rate notice but no confirmation action", () => {
  const content = buildManualAbstractResultContent({
    template: "abstract-accepted-oral",
    firstName: "Ada",
    lastName: "Lovelace",
    title: "Manual accepted sample",
    ctx,
    comment: "Manual accepted reviewer note",
    registrationRateNotice: notice,
  });

  assert.match(content.html, /IMPORTANT REGISTRATION RATE/);
  assert.match(content.html, /Reviewer Comments/);
  assert.match(content.html, /Manual accepted reviewer note/);
  assert.match(content.html, /1,250/);
  assert.doesNotMatch(content.html, /ACTION REQUIRED/);
  assert.equal(content.subject, "Congratulations! Abstract Accepted (Oral) - PRIS 2026");
});

test("manual PRIS rejected content uses the final reject subject and rate notice", () => {
  const content = buildManualAbstractResultContent({
    template: "abstract-rejected",
    firstName: "Ada",
    lastName: "Lovelace",
    title: "Manual rejected sample",
    ctx,
    comment: "Manual rejected reviewer note",
    registrationRateNotice: notice,
  });

  assert.equal(content.subject, "Abstract Review Result – PRIS 2026");
  assert.match(content.html, /Reviewer Comments/);
  assert.match(content.html, /Manual rejected reviewer note/);
  assert.match(content.html, /IMPORTANT REGISTRATION RATE/);
  assert.match(content.html, /1,250/);
});
