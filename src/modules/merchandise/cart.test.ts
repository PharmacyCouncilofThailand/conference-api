import assert from "node:assert/strict";
import { test } from "node:test";
import { cartVersion, selectionKey } from "./cart.js";

test("selectionKey is order-independent for bundle selections", () => {
  const a = selectionKey({
    variantId: null,
    bundleSelections: [
      { componentId: "c2", variantId: "v2" },
      { componentId: "c1", variantId: "v1" },
    ],
  });
  const b = selectionKey({
    variantId: null,
    bundleSelections: [
      { componentId: "c1", variantId: "v1" },
      { componentId: "c2", variantId: "v2" },
    ],
  });
  assert.equal(a, b);
  assert.equal(a, "v:-|c:c1=v1|c:c2=v2");
  assert.equal(selectionKey({ variantId: "x", bundleSelections: [] }), "v:x");
});

const line = (over: Partial<Parameters<typeof cartVersion>[0][number]> = {}) => ({
  id: "a",
  quantity: 1,
  selectionKey: "v:x",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  unitPriceMinor: 1000 as number | null,
  valid: true,
  ...over,
});

test("cartVersion changes with price, quantity and validity, stable across order", () => {
  const base = cartVersion([line(), line({ id: "b" })]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(base, cartVersion([line({ unitPriceMinor: 1100 }), line({ id: "b" })]));
  assert.notEqual(base, cartVersion([line({ quantity: 2 }), line({ id: "b" })]));
  assert.notEqual(base, cartVersion([line({ valid: false, unitPriceMinor: null }), line({ id: "b" })]));
  assert.equal(base, cartVersion([line({ id: "b" }), line()]));
});
