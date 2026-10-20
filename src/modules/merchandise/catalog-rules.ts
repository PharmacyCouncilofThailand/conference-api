import type { merchBundleComponents, merchProducts, merchVariants } from "../../database/schema.js";
import type { StoreState } from "./store-window.js";
import type { BundleSelection } from "./types.js";

export type ProductRow = typeof merchProducts.$inferSelect;
export type VariantRow = typeof merchVariants.$inferSelect;
export type ComponentRow = typeof merchBundleComponents.$inferSelect;

export interface CatalogSnapshot {
  products: Map<string, ProductRow>;
  variantsByProduct: Map<string, VariantRow[]>;
  componentsByBundle: Map<string, ComponentRow[]>;
}

export type ResolvedComponent = {
  productId: string;
  variantId: string;
  quantityPerBundle: number;
  nameTh: string;
  sizeTh: string | null;
  colorTh: string | null;
};

export function effectiveVariantPrice(product: ProductRow, variant: VariantRow): number | null {
  return variant.price ?? product.basePrice ?? null;
}

export function variantShapeValid(variants: Pick<VariantRow, "sizeTh" | "colorTh">[]): boolean {
  const defaults = variants.filter((v) => v.sizeTh === null && v.colorTh === null).length;
  if (defaults === 0) return true;
  return variants.length === 1;
}

function usablePrice(product: ProductRow, variant: VariantRow): number | null {
  const price = effectiveVariantPrice(product, variant);
  return price !== null && price > 0 ? price : null;
}

function bundleUnitPrice(product: ProductRow): number | null {
  return product.basePrice !== null && product.basePrice > 0 ? product.basePrice : null;
}

function isSellable(product: ProductRow | undefined): product is ProductRow {
  return !!product && product.publishState === "published" && product.saleEnabled;
}

function sellableVariants(product: ProductRow, catalog: CatalogSnapshot): VariantRow[] {
  return (catalog.variantsByProduct.get(product.id) ?? []).filter(
    (v) => v.saleEnabled && usablePrice(product, v) !== null,
  );
}

export function publishIssues(productId: string, catalog: CatalogSnapshot): string[] {
  const product = catalog.products.get(productId);
  if (!product) return ["NAME_REQUIRED"];
  const issues: string[] = [];
  if (!product.nameTh || product.nameTh.trim() === "") issues.push("NAME_REQUIRED");
  if (product.imageIds.length === 0) issues.push("IMAGE_REQUIRED");

  if (product.kind === "single") {
    const variants = catalog.variantsByProduct.get(productId) ?? [];
    const enabled = variants.filter((v) => v.saleEnabled);
    if (enabled.length === 0) issues.push("ENABLED_VARIANT_REQUIRED");
    if (enabled.some((v) => usablePrice(product, v) === null)) issues.push("VARIANT_PRICE_REQUIRED");
    if (!variantShapeValid(variants)) issues.push("VARIANT_SHAPE_MIXED");
    return issues;
  }

  if (bundleUnitPrice(product) === null) issues.push("BUNDLE_PRICE_REQUIRED");
  const components = catalog.componentsByBundle.get(productId) ?? [];
  if (components.length === 0) issues.push("COMPONENT_REQUIRED");
  if (components.some((c) => catalog.products.get(c.componentProductId)?.kind !== "single")) {
    issues.push("COMPONENT_NOT_SINGLE");
  }
  const belongs = (c: ComponentRow, variantId: string) =>
    (catalog.variantsByProduct.get(c.componentProductId) ?? []).some((v) => v.id === variantId);
  if (
    components.some(
      (c) => c.mode === "fixed" && (!c.fixedVariantId || !belongs(c, c.fixedVariantId)),
    )
  ) {
    issues.push("FIXED_VARIANT_INVALID");
  }
  if (
    components.some(
      (c) =>
        c.mode === "selectable" &&
        (c.allowedVariantIds.length === 0 || !c.allowedVariantIds.every((id) => belongs(c, id))),
    )
  ) {
    issues.push("ALLOWED_VARIANTS_REQUIRED");
  }
  return issues;
}

function componentUsable(c: ComponentRow, catalog: CatalogSnapshot): boolean {
  const product = catalog.products.get(c.componentProductId);
  if (!isSellable(product)) return false;
  const usable = new Set(sellableVariants(product, catalog).map((v) => v.id));
  if (c.mode === "fixed") return !!c.fixedVariantId && usable.has(c.fixedVariantId);
  return c.allowedVariantIds.some((id) => usable.has(id));
}

export function unavailableCodes(
  productId: string,
  catalog: CatalogSnapshot,
  state: StoreState,
): string[] {
  const codes: string[] = [];
  if (state !== "open") codes.push("STORE_NOT_OPEN");
  const product = catalog.products.get(productId);
  if (!isSellable(product)) {
    codes.push("PRODUCT_DISABLED");
    return codes;
  }
  if (product.kind === "single") {
    if (sellableVariants(product, catalog).length === 0) codes.push("VARIANT_DISABLED");
  } else {
    const components = catalog.componentsByBundle.get(productId) ?? [];
    if (components.length === 0 || components.some((c) => !componentUsable(c, catalog))) {
      codes.push("COMPONENT_UNAVAILABLE");
    }
  }
  return codes;
}

export function displayPrice(
  productId: string,
  catalog: CatalogSnapshot,
): { kind: "exact" | "from"; amountBaht: number } | null {
  const product = catalog.products.get(productId);
  if (!product) return null;
  if (product.kind === "bundle") {
    return product.basePrice === null ? null : { kind: "exact", amountBaht: product.basePrice };
  }
  const prices = sellableVariants(product, catalog).map((v) => usablePrice(product, v) as number);
  if (prices.length === 0) return null;
  const min = Math.min(...prices);
  return { kind: prices.every((p) => p === min) ? "exact" : "from", amountBaht: min };
}

export function validateSelection(
  productId: string,
  input: { variantId: string | null; bundleSelections: BundleSelection[] },
  catalog: CatalogSnapshot,
  state: StoreState,
): { unitPriceBaht: number | null; issueCodes: string[]; resolvedComponents: ResolvedComponent[] } {
  const issues = new Set<string>(unavailableCodes(productId, catalog, state));
  const resolvedComponents: ResolvedComponent[] = [];
  const product = catalog.products.get(productId);
  let unit: number | null = null;

  if (product?.kind === "single") {
    if (input.bundleSelections.length > 0) issues.add("VARIANT_NOT_ALLOWED");
    if (input.variantId === null) {
      issues.add("VARIANT_REQUIRED");
    } else {
      const variant = (catalog.variantsByProduct.get(productId) ?? []).find((v) => v.id === input.variantId);
      if (!variant) issues.add("VARIANT_NOT_ALLOWED");
      else if (!variant.saleEnabled) issues.add("VARIANT_DISABLED");
      else {
        unit = usablePrice(product, variant);
        if (unit === null) issues.add("VARIANT_DISABLED");
      }
    }
  } else if (product?.kind === "bundle") {
    if (input.variantId !== null) issues.add("VARIANT_NOT_ALLOWED");
    const components = catalog.componentsByBundle.get(productId) ?? [];
    const known = new Set(components.filter((c) => c.mode === "selectable").map((c) => c.id));
    if (input.bundleSelections.some((s) => !known.has(s.componentId))) issues.add("VARIANT_NOT_ALLOWED");
    for (const c of components) {
      const componentProduct = catalog.products.get(c.componentProductId);
      if (!componentProduct) continue;
      let variantId: string | null = null;
      if (c.mode === "fixed") {
        variantId = c.fixedVariantId;
      } else {
        const sel = input.bundleSelections.find((s) => s.componentId === c.id);
        if (!sel) {
          issues.add("SELECTION_INCOMPLETE");
          continue;
        }
        if (!c.allowedVariantIds.includes(sel.variantId)) {
          issues.add("VARIANT_NOT_ALLOWED");
          continue;
        }
        variantId = sel.variantId;
      }
      const variant = (catalog.variantsByProduct.get(c.componentProductId) ?? []).find(
        (v) => v.id === variantId,
      );
      if (!variant) {
        issues.add("COMPONENT_UNAVAILABLE");
        continue;
      }
      if (!variant.saleEnabled) issues.add("VARIANT_DISABLED");
      resolvedComponents.push({
        productId: c.componentProductId,
        variantId: variant.id,
        quantityPerBundle: c.quantityPerBundle,
        nameTh: componentProduct.nameTh,
        sizeTh: variant.sizeTh,
        colorTh: variant.colorTh,
      });
    }
    unit = bundleUnitPrice(product);
    if (unit === null) issues.add("PRODUCT_DISABLED");
  }

  const issueCodes = [...issues];
  return {
    unitPriceBaht: issueCodes.length === 0 ? unit : null,
    issueCodes,
    resolvedComponents,
  };
}
