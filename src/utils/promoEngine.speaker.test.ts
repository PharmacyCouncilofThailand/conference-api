import assert from "node:assert/strict";
import test, { mock } from "node:test";

test("existing promo rules accept the configured Speaker ticket and reject other tickets", async (t) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/speaker_test";
  const { db, closeDatabase } = await import("../database/index.js");
  const { validatePromoCode } = await import("./promoEngine.js");
  const { promoCodes, promoCodeUsages, promoCodeRuleSets, promoCodeRuleItems } = await import("../database/schema.js");
  t.after(async () => {
    mock.restoreAll();
    await closeDatabase();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });
  mock.method(db, "update", () => ({ set: () => ({ where: async () => [] }) }));
  mock.method(db, "select", () => ({ from: (table: unknown) => ({ where: () => {
    const rows = table === promoCodes ? [{
      id: 1, eventId: 1, isActive: true, validFrom: null, validUntil: null,
      maxUses: 100, maxUsesPerUser: 1, minPurchase: 0,
      discountType: "percentage", discountValue: "100", maxDiscount: null,
    }] : table === promoCodeUsages ? [{ total: 0 }]
      : table === promoCodeRuleSets ? [{ id: 1, matchType: "any" }]
      : table === promoCodeRuleItems ? [{ ticketTypeId: 53 }] : [];
    return Object.assign(Promise.resolve(rows), { limit: async () => rows });
  } }) }));
  const valid = await validatePromoCode("SPEAKER", 1, 1, "THB", 500, [53]);
  assert.equal(valid.valid, true);
  assert.equal(valid.netAmount, 0);
  const rejected = await validatePromoCode("SPEAKER", 1, 1, "THB", 500, [54]);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.error, "Promo code does not apply to selected tickets");
});
