import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displayPrice,
  effectiveVariantPrice,
  publishIssues,
  unavailableCodes,
  validateSelection,
  variantShapeValid,
  type CatalogSnapshot,
  type ComponentRow,
  type ProductRow,
  type VariantRow,
} from "./catalog-rules.js";

const now = new Date("2026-01-01T00:00:00Z");
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function product(o: Partial<ProductRow> = {}): ProductRow {
  return {
    id: id(), eventId: 1, kind: "single", nameTh: "เสื้อ", descriptionTh: null, sizeChartTh: null,
    imageIds: [id()], categoryId: null, sortOrder: 0, publishState: "published", saleEnabled: true,
    basePrice: null, version: 1, createdAt: now, updatedAt: now, ...o,
  };
}
function variant(productId: string, o: Partial<VariantRow> = {}): VariantRow {
  return {
    id: id(), productId, sizeTh: null, colorTh: null, price: null, saleEnabled: true,
    sortOrder: 0, version: 1, createdAt: now, updatedAt: now, ...o,
  };
}
function component(bundleId: string, productId: string, o: Partial<ComponentRow> = {}): ComponentRow {
  return {
    id: id(), bundleProductId: bundleId, componentProductId: productId, quantityPerBundle: 1,
    mode: "fixed", fixedVariantId: null, allowedVariantIds: [], sortOrder: 0,
    createdAt: now, updatedAt: now, ...o,
  };
}
function catalog(
  products: ProductRow[],
  variants: VariantRow[] = [],
  components: ComponentRow[] = [],
): CatalogSnapshot {
  const c: CatalogSnapshot = {
    products: new Map(products.map((p) => [p.id, p])),
    variantsByProduct: new Map(),
    componentsByBundle: new Map(),
  };
  for (const v of variants) c.variantsByProduct.set(v.productId, [...(c.variantsByProduct.get(v.productId) ?? []), v]);
  for (const k of components) c.componentsByBundle.set(k.bundleProductId, [...(c.componentsByBundle.get(k.bundleProductId) ?? []), k]);
  return c;
}

test("effectiveVariantPrice", () => {
  const p = product({ basePrice: 100 });
  assert.equal(effectiveVariantPrice(p, variant(p.id, { price: 50 })), 50);
  assert.equal(effectiveVariantPrice(p, variant(p.id)), 100);
  assert.equal(effectiveVariantPrice(product(), variant(p.id)), null);
});

test("variantShapeValid", () => {
  assert.equal(variantShapeValid([{ sizeTh: null, colorTh: null }]), true);
  assert.equal(variantShapeValid([{ sizeTh: "S", colorTh: null }, { sizeTh: "M", colorTh: null }]), true);
  assert.equal(variantShapeValid([{ sizeTh: null, colorTh: null }, { sizeTh: "S", colorTh: null }]), false);
  assert.equal(variantShapeValid([{ sizeTh: null, colorTh: null }, { sizeTh: null, colorTh: null }]), false);
});

test("publishIssues single", () => {
  const p = product({ nameTh: "", imageIds: [], publishState: "draft" });
  assert.deepEqual(publishIssues(p.id, catalog([p], [variant(p.id)])), ["NAME_REQUIRED", "IMAGE_REQUIRED", "VARIANT_PRICE_REQUIRED"]);
  const q = product({ basePrice: 100 });
  assert.deepEqual(publishIssues(q.id, catalog([q], [variant(q.id, { saleEnabled: false })])), ["ENABLED_VARIANT_REQUIRED"]);
  assert.deepEqual(publishIssues(q.id, catalog([q], [variant(q.id)])), []);
  assert.deepEqual(
    publishIssues(q.id, catalog([q], [variant(q.id), variant(q.id, { sizeTh: "S" })])),
    ["VARIANT_SHAPE_MIXED"],
  );
});

test("publishIssues bundle", () => {
  const b = product({ kind: "bundle" });
  assert.deepEqual(publishIssues(b.id, catalog([b])), ["BUNDLE_PRICE_REQUIRED", "COMPONENT_REQUIRED"]);

  const s = product({ basePrice: 100 });
  const sv = variant(s.id);
  const other = product({ basePrice: 100 });
  const ov = variant(other.id);
  const b2 = product({ kind: "bundle", basePrice: 500 });
  const nested = product({ kind: "bundle", basePrice: 500 });
  assert.deepEqual(
    publishIssues(b2.id, catalog([b2, s, nested], [sv], [component(b2.id, nested.id, { fixedVariantId: sv.id })])),
    ["COMPONENT_NOT_SINGLE", "FIXED_VARIANT_INVALID"],
  );
  assert.deepEqual(
    publishIssues(b2.id, catalog([b2, s, other], [sv, ov], [component(b2.id, s.id, { fixedVariantId: ov.id })])),
    ["FIXED_VARIANT_INVALID"],
  );
  assert.deepEqual(
    publishIssues(b2.id, catalog([b2, s], [sv], [component(b2.id, s.id, { mode: "selectable", allowedVariantIds: [] })])),
    ["ALLOWED_VARIANTS_REQUIRED"],
  );
  assert.deepEqual(
    publishIssues(b2.id, catalog([b2, s], [sv], [component(b2.id, s.id, { fixedVariantId: sv.id })])),
    [],
  );
});

test("bundle availability follows component state", () => {
  const s = product({ basePrice: 100 });
  const sv = variant(s.id);
  const b = product({ kind: "bundle", basePrice: 500 });
  const k = component(b.id, s.id, { fixedVariantId: sv.id });
  const c = catalog([b, s], [sv], [k]);
  assert.deepEqual(unavailableCodes(b.id, c, "open"), []);
  s.saleEnabled = false;
  assert.deepEqual(unavailableCodes(b.id, c, "open"), ["COMPONENT_UNAVAILABLE"]);
  s.saleEnabled = true;
  assert.deepEqual(unavailableCodes(b.id, c, "open"), []);
  sv.saleEnabled = false;
  assert.deepEqual(unavailableCodes(b.id, c, "open"), ["COMPONENT_UNAVAILABLE"]);
});

test("unavailableCodes store and product state", () => {
  const p = product({ basePrice: 100 });
  const c = catalog([p], [variant(p.id)]);
  assert.deepEqual(unavailableCodes(p.id, c, "closed"), ["STORE_NOT_OPEN"]);
  assert.deepEqual(unavailableCodes(p.id, c, "not_open"), ["STORE_NOT_OPEN"]);
  p.saleEnabled = false;
  assert.deepEqual(unavailableCodes(p.id, c, "open"), ["PRODUCT_DISABLED"]);
  p.saleEnabled = true;
  c.variantsByProduct.get(p.id)![0].saleEnabled = false;
  assert.deepEqual(unavailableCodes(p.id, c, "open"), ["VARIANT_DISABLED"]);
});

test("displayPrice", () => {
  const p = product();
  assert.deepEqual(displayPrice(p.id, catalog([p], [variant(p.id, { price: 250, sizeTh: "S" }), variant(p.id, { price: 250, sizeTh: "M" })])), { kind: "exact", amountBaht: 250 });
  assert.deepEqual(displayPrice(p.id, catalog([p], [variant(p.id, { price: 250, sizeTh: "S" }), variant(p.id, { price: 300, sizeTh: "M" })])), { kind: "from", amountBaht: 250 });
  const b = product({ kind: "bundle", basePrice: 900 });
  assert.deepEqual(displayPrice(b.id, catalog([b])), { kind: "exact", amountBaht: 900 });
});

test("validateSelection single", () => {
  const p = product({ basePrice: 100 });
  const v = variant(p.id, { sizeTh: "S" });
  const c = catalog([p], [v]);
  assert.deepEqual(validateSelection(p.id, { variantId: null, bundleSelections: [] }, c, "open").issueCodes, ["VARIANT_REQUIRED"]);
  const ok = validateSelection(p.id, { variantId: v.id, bundleSelections: [] }, c, "open");
  assert.deepEqual(ok, { unitPriceBaht: 100, issueCodes: [], resolvedComponents: [] });
  assert.deepEqual(validateSelection(p.id, { variantId: v.id, bundleSelections: [] }, c, "closed").issueCodes, ["STORE_NOT_OPEN"]);
});

test("validateSelection bundle", () => {
  const shirt = product({ basePrice: 100, nameTh: "เสื้อ" });
  const sS = variant(shirt.id, { sizeTh: "S" });
  const sM = variant(shirt.id, { sizeTh: "M" });
  const sL = variant(shirt.id, { sizeTh: "L" });
  const mug = product({ basePrice: 50, nameTh: "แก้ว" });
  const mv = variant(mug.id, { colorTh: "แดง" });
  const b = product({ kind: "bundle", basePrice: 120 });
  const sel = component(b.id, shirt.id, { mode: "selectable", allowedVariantIds: [sS.id, sM.id] });
  const fixed = component(b.id, mug.id, { fixedVariantId: mv.id, quantityPerBundle: 2 });
  const c = catalog([b, shirt, mug], [sS, sM, sL, mv], [sel, fixed]);

  assert.deepEqual(validateSelection(b.id, { variantId: null, bundleSelections: [] }, c, "open").issueCodes, ["SELECTION_INCOMPLETE"]);
  assert.deepEqual(
    validateSelection(b.id, { variantId: null, bundleSelections: [{ componentId: sel.id, variantId: sL.id }] }, c, "open").issueCodes,
    ["VARIANT_NOT_ALLOWED"],
  );
  const ok = validateSelection(b.id, { variantId: null, bundleSelections: [{ componentId: sel.id, variantId: sM.id }] }, c, "open");
  assert.equal(ok.unitPriceBaht, 120);
  assert.deepEqual(ok.issueCodes, []);
  assert.deepEqual(ok.resolvedComponents, [
    { productId: shirt.id, variantId: sM.id, quantityPerBundle: 1, nameTh: "เสื้อ", sizeTh: "M", colorTh: null },
    { productId: mug.id, variantId: mv.id, quantityPerBundle: 2, nameTh: "แก้ว", sizeTh: null, colorTh: "แดง" },
  ]);
});

test("validateSelection never returns null price without an issue code", () => {
  const p = product({ basePrice: null });
  const bad = variant(p.id, { sizeTh: "S", price: 0 });
  const nullPrice = variant(p.id, { sizeTh: "M" });
  const good = variant(p.id, { sizeTh: "L", price: 100 });
  const c = catalog([p], [bad, nullPrice, good]);
  for (const v of [bad, nullPrice]) {
    const r = validateSelection(p.id, { variantId: v.id, bundleSelections: [] }, c, "open");
    assert.ok(r.issueCodes.includes("VARIANT_DISABLED"));
    assert.equal(r.unitPriceBaht, null);
  }
  const okR = validateSelection(p.id, { variantId: good.id, bundleSelections: [] }, c, "open");
  assert.deepEqual(okR.issueCodes, []);
  assert.equal(okR.unitPriceBaht, 100);

  const shirt = product({ basePrice: 100 });
  const sv = variant(shirt.id, { sizeTh: "S" });
  const b = product({ kind: "bundle", basePrice: 0 });
  const k = component(b.id, shirt.id, { fixedVariantId: sv.id });
  const r = validateSelection(b.id, { variantId: null, bundleSelections: [] }, catalog([b, shirt], [sv], [k]), "open");
  assert.deepEqual(r.issueCodes, ["PRODUCT_DISABLED"]);
  assert.equal(r.unitPriceBaht, null);
});

test("validateSelection rejects foreign variant and disabled component variant", () => {
  const p = product({ basePrice: 100 });
  const other = product({ basePrice: 100 });
  const ov = variant(other.id);
  const c = catalog([p, other], [variant(p.id, { sizeTh: "S" }), ov]);
  assert.deepEqual(validateSelection(p.id, { variantId: ov.id, bundleSelections: [] }, c, "open").issueCodes, ["VARIANT_NOT_ALLOWED"]);

  const shirt = product({ basePrice: 100 });
  const sS = variant(shirt.id, { sizeTh: "S", saleEnabled: false });
  const sM = variant(shirt.id, { sizeTh: "M" });
  const b = product({ kind: "bundle", basePrice: 120 });
  const sel = component(b.id, shirt.id, { mode: "selectable", allowedVariantIds: [sS.id, sM.id] });
  const r = validateSelection(
    b.id,
    { variantId: null, bundleSelections: [{ componentId: sel.id, variantId: sS.id }] },
    catalog([b, shirt], [sS, sM], [sel]),
    "open",
  );
  assert.deepEqual(r.issueCodes, ["VARIANT_DISABLED"]);
  assert.equal(r.unitPriceBaht, null);
});
