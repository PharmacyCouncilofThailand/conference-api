import assert from "node:assert/strict";
import test from "node:test";

test("promo reservation conflict exposes stable 409 API metadata", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = originalDatabaseUrl || "postgresql://test:test@localhost/conference_test";

  try {
    const { PromoReservationConflict } = await import("./promo-usage.service.js");
    const error = new PromoReservationConflict("PROMO_USAGE_LIMIT_REACHED", "Promo code usage limit reached");
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "PROMO_USAGE_LIMIT_REACHED");
    assert.equal(error.message, "Promo code usage limit reached");
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
