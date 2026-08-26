import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { promoCodes, promoCodeUsages } from "../../database/schema.js";

test("promo codes expose percentage range check", () => {
  const config = getTableConfig(promoCodes);
  assert.ok(config.checks.some((value) => value.name === "promo_codes_percentage_discount_range_check"));
});

test("promo usages expose order uniqueness and active lookup indexes", () => {
  const config = getTableConfig(promoCodeUsages);
  const names = config.indexes.map((value) => value.config.name);
  assert.ok(names.includes("promo_code_usages_order_unique"));
  assert.ok(names.includes("promo_code_usages_active_promo_idx"));
  assert.ok(names.includes("promo_code_usages_active_user_idx"));
});
