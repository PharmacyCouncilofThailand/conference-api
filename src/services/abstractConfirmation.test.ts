import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

const {
  buildConfirmationUrl,
  getConfirmationLocaleForEvent,
} = await import("./abstractConfirmation.js");

test("PRIS 2026 confirmation links use the Thai locale", () => {
  const locale = getConfirmationLocaleForEvent("PRIS 2026");
  const url = buildConfirmationUrl(
    "sample-token",
    locale,
    "https://pris.pharmacycouncil.org/",
  );

  assert.equal(locale, "th");
  assert.equal(
    url,
    "https://pris.pharmacycouncil.org/th/abstracts/confirm?token=sample-token",
  );
});

test("non-PRIS confirmation links preserve the English locale", () => {
  const locale = getConfirmationLocaleForEvent("OTHER");
  const url = buildConfirmationUrl(
    "sample-token",
    locale,
    "https://conference.example.test/",
  );

  assert.equal(locale, "en");
  assert.equal(
    url,
    "https://conference.example.test/en/abstracts/confirm?token=sample-token",
  );
});
