import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
const { buildManualAbstractResultContent, validateManualEmailPostBody, TEMPLATE_CONFIG } = await import("./email-manual.js");

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
  deadline: new Date("2026-10-30T10:29:00.000Z"),
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

test("post body rejects more than 50 unique ids after dedupe", () => {
  const ids = Array.from({ length: 51 }, (_, i) => i + 1);
  assert.deepEqual(
    validateManualEmailPostBody({ eventId: 1, template: "pris-pre-event", recipientIds: ids }),
    { ok: false, error: "recipientIds must contain at most 50 IDs per request" },
  );
  const deduped = validateManualEmailPostBody({
    eventId: 1,
    template: "pris-pre-event",
    recipientIds: [...ids.slice(0, 50), 1, 2, "x"],
  });
  assert.equal(deduped.ok, true);
  assert.ok(deduped.ok && deduped.ids.length === 50);
});

test("post body batchId: uppercase normalized, invalid rejected", () => {
  const ok = validateManualEmailPostBody({
    eventId: 1,
    template: "event-reminder",
    recipientIds: [1],
    batchId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
  });
  assert.ok(ok.ok && ok.batchId === "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.deepEqual(
    validateManualEmailPostBody({ eventId: 1, template: "event-reminder", recipientIds: [1], batchId: "nope" }),
    { ok: false, error: "batchId must be a UUID" },
  );
});

test("pris-pre-event template is registered as a registration template", () => {
  assert.equal(TEMPLATE_CONFIG["pris-pre-event"].recipientType, "registration");
  assert.equal(TEMPLATE_CONFIG["pris-pre-event"].label, "PRIS Pre-Event Preparation");
});
