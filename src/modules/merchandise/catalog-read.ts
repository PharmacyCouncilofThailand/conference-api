import { and, asc, eq, inArray } from "drizzle-orm";
import {
  events,
  merchBanners,
  merchBundleComponents,
  merchCategories,
  merchImages,
  merchProducts,
  merchVariants,
} from "../../database/schema.js";
import {
  displayPrice,
  effectiveVariantPrice,
  publishIssues,
  unavailableCodes,
  type CatalogSnapshot,
  type ProductRow,
  type VariantRow,
} from "./catalog-rules.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { readStore, type StoreState } from "./store-window.js";
import type {
  AdminProductDto,
  BundleComponentDto,
  ImageAsset,
  ProductDto,
  StoreDto,
  VariantDto,
} from "./types.js";

export async function loadCatalog(
  db: MerchDb,
  eventId: number,
  opts: { includeDrafts: boolean },
): Promise<CatalogSnapshot> {
  const where = opts.includeDrafts
    ? eq(merchProducts.eventId, eventId)
    : and(eq(merchProducts.eventId, eventId), eq(merchProducts.publishState, "published"));
  const rows = await db
    .select()
    .from(merchProducts)
    .where(where)
    .orderBy(asc(merchProducts.sortOrder), asc(merchProducts.createdAt), asc(merchProducts.id));
  const catalog: CatalogSnapshot = {
    products: new Map(rows.map((p) => [p.id, p])),
    variantsByProduct: new Map(),
    componentsByBundle: new Map(),
  };
  if (rows.length === 0) return catalog;
  const ids = rows.map((p) => p.id);
  const variants = await db
    .select()
    .from(merchVariants)
    .where(inArray(merchVariants.productId, ids))
    .orderBy(asc(merchVariants.sortOrder), asc(merchVariants.createdAt), asc(merchVariants.id));
  for (const v of variants) {
    const list = catalog.variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    catalog.variantsByProduct.set(v.productId, list);
  }
  const components = await db
    .select()
    .from(merchBundleComponents)
    .where(inArray(merchBundleComponents.bundleProductId, ids))
    .orderBy(
      asc(merchBundleComponents.sortOrder),
      asc(merchBundleComponents.createdAt),
      asc(merchBundleComponents.id),
    );
  for (const c of components) {
    const list = catalog.componentsByBundle.get(c.bundleProductId) ?? [];
    list.push(c);
    catalog.componentsByBundle.set(c.bundleProductId, list);
  }
  return catalog;
}

export async function loadImages(db: MerchDb, ids: string[]): Promise<Map<string, ImageAsset>> {
  const unique = [...new Set(ids)];
  const map = new Map<string, ImageAsset>();
  if (unique.length === 0) return map;
  const rows = await db.select().from(merchImages).where(inArray(merchImages.id, unique));
  for (const r of rows) {
    map.set(r.id, { id: r.id, url: r.publicUrl, width: r.width, height: r.height });
  }
  return map;
}

function toVariantDto(product: ProductRow, variant: VariantRow): VariantDto {
  return {
    id: variant.id,
    sizeTh: variant.sizeTh,
    colorTh: variant.colorTh,
    priceMinor: effectiveVariantPrice(product, variant),
    saleEnabled: variant.saleEnabled,
  };
}

function productImages(imageIds: string[], images: Map<string, ImageAsset>): ImageAsset[] {
  return imageIds.flatMap((id) => {
    const image = images.get(id);
    return image ? [image] : [];
  });
}

export function toProductDto(
  productId: string,
  catalog: CatalogSnapshot,
  state: StoreState,
  images: Map<string, ImageAsset>,
): ProductDto {
  const product = catalog.products.get(productId);
  if (!product) throw new MerchError(404, "MERCH_PRODUCT_NOT_FOUND", "ไม่พบสินค้า");
  const variantRows = catalog.variantsByProduct.get(productId) ?? [];
  const components: BundleComponentDto[] = (catalog.componentsByBundle.get(productId) ?? []).map(
    (c) => {
      const componentProduct = catalog.products.get(c.componentProductId);
      const componentVariants = catalog.variantsByProduct.get(c.componentProductId) ?? [];
      const dto = (id: string): VariantDto | null => {
        const row = componentVariants.find((v) => v.id === id);
        return row && componentProduct ? toVariantDto(componentProduct, row) : null;
      };
      return {
        id: c.id,
        productId: c.componentProductId,
        nameTh: componentProduct?.nameTh ?? "",
        quantityPerBundle: c.quantityPerBundle,
        mode: c.mode as "fixed" | "selectable",
        fixedVariant: c.fixedVariantId ? dto(c.fixedVariantId) : null,
        allowedVariants: c.allowedVariantIds.flatMap((id) => {
          const v = dto(id);
          return v ? [v] : [];
        }),
      };
    },
  );
  const codes = unavailableCodes(productId, catalog, state);
  const hasOptions =
    product.kind === "single"
      ? variantRows.some((v) => v.sizeTh !== null || v.colorTh !== null)
      : components.some((c) => c.mode === "selectable");
  return {
    id: product.id,
    kind: product.kind as "single" | "bundle",
    nameTh: product.nameTh,
    descriptionTh: product.descriptionTh,
    sizeChartTh: product.sizeChartTh,
    images: productImages(product.imageIds, images),
    categoryId: product.categoryId,
    sortOrder: product.sortOrder,
    hasOptions,
    variants: variantRows.map((v) => toVariantDto(product, v)),
    components,
    price: displayPrice(productId, catalog),
    purchasable: codes.length === 0,
    unavailableCodes: codes,
  };
}

export function toAdminProductDto(
  productId: string,
  catalog: CatalogSnapshot,
  state: StoreState,
  images: Map<string, ImageAsset>,
): AdminProductDto {
  const product = catalog.products.get(productId);
  if (!product) throw new MerchError(404, "MERCH_PRODUCT_NOT_FOUND", "ไม่พบสินค้า");
  const codes = unavailableCodes(productId, catalog, state);
  return {
    id: product.id,
    kind: product.kind as "single" | "bundle",
    nameTh: product.nameTh,
    descriptionTh: product.descriptionTh,
    sizeChartTh: product.sizeChartTh,
    images: productImages(product.imageIds, images),
    categoryId: product.categoryId,
    sortOrder: product.sortOrder,
    publishState: product.publishState as "draft" | "published",
    saleEnabled: product.saleEnabled,
    basePriceMinor: product.basePrice,
    version: product.version,
    variants: (catalog.variantsByProduct.get(productId) ?? []).map((v) => ({
      ...toVariantDto(product, v),
      sortOrder: v.sortOrder,
      version: v.version,
    })),
    components: (catalog.componentsByBundle.get(productId) ?? []).map((c) => ({
      id: c.id,
      componentProductId: c.componentProductId,
      quantityPerBundle: c.quantityPerBundle,
      mode: c.mode as "fixed" | "selectable",
      fixedVariantId: c.fixedVariantId,
      allowedVariantIds: c.allowedVariantIds,
      sortOrder: c.sortOrder,
    })),
    publishIssues: publishIssues(productId, catalog),
    purchasable: codes.length === 0,
    unavailableCodes: codes,
  };
}

export async function toStoreDto(
  db: MerchDb,
  eventId: number,
  opts: { includeHidden: boolean },
): Promise<StoreDto> {
  const [event] = await db
    .select({ eventCode: events.eventCode })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) throw new MerchError(404, "MERCH_EVENT_NOT_FOUND", "ไม่พบงานที่ระบุ");
  const { row, state, now } = await readStore(db, eventId);
  const categoryWhere = opts.includeHidden
    ? eq(merchCategories.eventId, eventId)
    : and(eq(merchCategories.eventId, eventId), eq(merchCategories.visible, true));
  const categories = await db
    .select()
    .from(merchCategories)
    .where(categoryWhere)
    .orderBy(asc(merchCategories.sortOrder), asc(merchCategories.createdAt), asc(merchCategories.id));
  const banners = await db
    .select({ banner: merchBanners, image: merchImages })
    .from(merchBanners)
    .innerJoin(merchImages, eq(merchImages.id, merchBanners.imageId))
    .where(and(eq(merchBanners.eventId, eventId), eq(merchBanners.active, true)))
    .orderBy(asc(merchBanners.sortOrder), asc(merchBanners.createdAt), asc(merchBanners.id));
  return {
    eventId,
    eventCode: event.eventCode,
    state,
    opensAt: row?.opensAt?.toISOString() ?? null,
    closesAt: row?.closesAt?.toISOString() ?? null,
    productionInfoTh: row?.productionInfoTh ?? null,
    shippingInfoTh: row?.shippingInfoTh ?? null,
    shippingMinor: 5000,
    currency: "THB",
    serverNow: now.toISOString(),
    categories: categories.map((c) => ({ id: c.id, nameTh: c.nameTh, sortOrder: c.sortOrder })),
    banners: banners.map(({ banner, image }) => ({
      id: banner.id,
      image: { id: image.id, url: image.publicUrl, width: image.width, height: image.height },
      linkUrl: banner.linkUrl,
    })),
  };
}
