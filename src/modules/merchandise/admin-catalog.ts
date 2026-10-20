import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  merchBundleComponents,
  merchCategories,
  merchProducts,
  merchVariants,
} from "../../database/schema.js";
import { assertEventImage, applyOrder, versionConflict } from "./admin-store.js";
import { writeAudit } from "./audit.js";
import { publishIssues, variantShapeValid, type ProductRow } from "./catalog-rules.js";
import { loadCatalog, loadImages, toAdminProductDto, toProductDto, toStoreDto } from "./catalog-read.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { readStore } from "./store-window.js";
import type { AdminProductDto, BatchRowResult, ProductDto, StoreDto } from "./types.js";

type Admin = { id: number };

const text = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid();
const MAX_PRICE = 1_000_000; // whole baht

const productFields = {
  descriptionTh: z.string().trim().max(10000).nullable().optional(),
  sizeChartTh: z.string().trim().max(10000).nullable().optional(),
  imageIds: z.array(uuid).max(20).optional(),
  categoryId: uuid.nullable().optional(),
  saleEnabled: z.boolean().optional(),
  basePriceBaht: z.number().int().min(0).max(MAX_PRICE).nullable().optional(),
};

export const productCreateInput = z
  .object({ kind: z.enum(["single", "bundle"]), nameTh: text(300), ...productFields })
  .strict();
export const productPatchInput = z
  .object({ expectedVersion: z.number().int().min(1), nameTh: text(300).optional(), ...productFields })
  .strict();
export const productListQuery = z.object({
  status: z.enum(["draft", "published"]).optional(),
  kind: z.enum(["single", "bundle"]).optional(),
  categoryId: uuid.optional(),
  search: z.string().trim().max(200).optional(),
});

const variantItem = z
  .object({
    id: uuid.optional(),
    sizeTh: text(100).nullable().optional(),
    colorTh: text(100).nullable().optional(),
    priceBaht: z.number().int().min(0).max(MAX_PRICE).nullable().optional(),
    saleEnabled: z.boolean().optional(),
  })
  .strict();
const variantList = z.array(variantItem).min(1).max(200);
export const variantsInput = z.preprocess(
  (v) => (Array.isArray(v) ? { variants: v } : v),
  z.object({ expectedVersion: z.number().int().min(1).optional(), variants: variantList }).strict(),
);

const componentItem = z
  .object({
    id: uuid.optional(),
    componentProductId: uuid,
    quantityPerBundle: z.number().int().min(1).max(9999).optional(),
    mode: z.enum(["fixed", "selectable"]),
    fixedVariantId: uuid.nullable().optional(),
    allowedVariantIds: z.array(uuid).max(200).optional(),
  })
  .strict();
export const componentsInput = z.preprocess(
  (v) => (Array.isArray(v) ? { components: v } : v),
  z
    .object({
      expectedVersion: z.number().int().min(1).optional(),
      components: z.array(componentItem).max(50),
    })
    .strict(),
);

export const transitionInput = z
  .object({ expectedVersion: z.number().int().min(1).optional() })
  .strict();

export const productOrderInput = z.object({ ids: z.array(uuid).min(1).max(1000) });

export const bulkInput = z
  .object({
    ids: z.array(uuid).min(1).max(200),
    change: z.union([
      z.object({ saleEnabled: z.boolean() }).strict(),
      z.object({ categoryId: uuid.nullable() }).strict(),
    ]),
  })
  .strict();

const notFound = () => new MerchError(404, "MERCH_PRODUCT_NOT_FOUND", "ไม่พบสินค้า");

// ---- reads ----

async function readCatalog(db: MerchDb, eventId: number) {
  const catalog = await loadCatalog(db, eventId, { includeDrafts: true });
  const images = await loadImages(
    db,
    [...catalog.products.values()].flatMap((p) => p.imageIds),
  );
  return { catalog, images };
}

export async function listAdminProducts(
  db: MerchDb,
  eventId: number,
  query: z.infer<typeof productListQuery>,
): Promise<AdminProductDto[]> {
  const { catalog, images } = await readCatalog(db, eventId);
  const { state } = await readStore(db, eventId);
  const needle = query.search?.toLowerCase();
  return [...catalog.products.values()]
    .filter(
      (p) =>
        (!query.status || p.publishState === query.status) &&
        (!query.kind || p.kind === query.kind) &&
        (!query.categoryId || p.categoryId === query.categoryId) &&
        (!needle || p.nameTh.toLowerCase().includes(needle)),
    )
    .map((p) => toAdminProductDto(p.id, catalog, state, images));
}

export async function getAdminProduct(
  db: MerchDb,
  eventId: number,
  id: string,
): Promise<AdminProductDto> {
  const { catalog, images } = await readCatalog(db, eventId);
  if (!catalog.products.has(id)) throw notFound();
  const { state } = await readStore(db, eventId);
  return toAdminProductDto(id, catalog, state, images);
}

export async function previewStore(
  db: MerchDb,
  eventId: number,
): Promise<{ store: StoreDto; products: ProductDto[] }> {
  const store = await toStoreDto(db, eventId, { includeHidden: false });
  const { catalog, images } = await readCatalog(db, eventId);
  return {
    store,
    products: [...catalog.products.keys()].map((id) => toProductDto(id, catalog, "open", images)),
  };
}

export async function previewProduct(db: MerchDb, eventId: number, id: string): Promise<ProductDto> {
  const { catalog, images } = await readCatalog(db, eventId);
  if (!catalog.products.has(id)) throw notFound();
  return toProductDto(id, catalog, "open", images);
}

// ---- helpers ----

const asTx = (tx: unknown) => tx as MerchDb;

async function lockProduct(
  tx: MerchDb,
  eventId: number,
  id: string,
  expectedVersion?: number,
): Promise<ProductRow> {
  const [row] = await tx
    .select()
    .from(merchProducts)
    .where(and(eq(merchProducts.id, id), eq(merchProducts.eventId, eventId)))
    .limit(1)
    .for("update");
  if (!row) throw notFound();
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw versionConflict(row.version);
  }
  return row;
}

async function bumpProduct(tx: MerchDb, id: string, set: Partial<typeof merchProducts.$inferInsert> = {}) {
  const [row] = await tx
    .update(merchProducts)
    .set({ ...set, version: sql`${merchProducts.version} + 1`, updatedAt: sql`now()` })
    .where(eq(merchProducts.id, id))
    .returning();
  return row;
}

async function assertCategory(db: MerchDb, eventId: number, categoryId: string): Promise<void> {
  const [row] = await db
    .select({ id: merchCategories.id })
    .from(merchCategories)
    .where(and(eq(merchCategories.id, categoryId), eq(merchCategories.eventId, eventId)))
    .limit(1);
  if (!row) throw new MerchError(422, "MERCH_CATEGORY_INVALID", "ไม่พบหมวดหมู่ของงานนี้");
}

async function assertImages(db: MerchDb, eventId: number, imageIds: string[]): Promise<void> {
  if (new Set(imageIds).size !== imageIds.length) {
    throw new MerchError(422, "MERCH_IMAGE_INVALID", "รูปภาพซ้ำกัน");
  }
  for (const id of imageIds) await assertEventImage(db, eventId, id);
}

const snapshot = (p: ProductRow) => ({
  nameTh: p.nameTh,
  descriptionTh: p.descriptionTh,
  sizeChartTh: p.sizeChartTh,
  imageIds: p.imageIds,
  categoryId: p.categoryId,
  saleEnabled: p.saleEnabled,
  basePrice: p.basePrice,
  publishState: p.publishState,
  version: p.version,
});

// ---- products ----

export async function createProduct(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  input: z.infer<typeof productCreateInput>,
): Promise<AdminProductDto> {
  if (input.imageIds) await assertImages(db, eventId, input.imageIds);
  if (input.categoryId) await assertCategory(db, eventId, input.categoryId);
  const id = await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const [max] = await txDb
      .select({ value: sql<number>`coalesce(max(${merchProducts.sortOrder}), -1)` })
      .from(merchProducts)
      .where(eq(merchProducts.eventId, eventId));
    const [row] = await txDb
      .insert(merchProducts)
      .values({
        eventId,
        kind: input.kind,
        nameTh: input.nameTh,
        descriptionTh: input.descriptionTh ?? null,
        sizeChartTh: input.sizeChartTh ?? null,
        imageIds: input.imageIds ?? [],
        categoryId: input.categoryId ?? null,
        saleEnabled: input.saleEnabled ?? false,
        basePrice: input.basePriceBaht ?? null,
        sortOrder: Number(max.value) + 1,
      })
      .returning();
    if (input.kind === "single") {
      await txDb.insert(merchVariants).values({ productId: row.id });
    }
    await writeAudit(txDb, {
      eventId,
      entityType: "product",
      entityId: row.id,
      action: "product.create",
      actorId: admin.id,
      after: { kind: row.kind, ...snapshot(row) },
    });
    return row.id;
  });
  return getAdminProduct(db, eventId, id);
}

export async function updateProduct(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  id: string,
  input: z.infer<typeof productPatchInput>,
): Promise<AdminProductDto> {
  if (input.imageIds) await assertImages(db, eventId, input.imageIds);
  if (input.categoryId) await assertCategory(db, eventId, input.categoryId);
  await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const before = await lockProduct(txDb, eventId, id, input.expectedVersion);
    const after = await bumpProduct(txDb, id, {
      ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}),
      ...(input.descriptionTh !== undefined ? { descriptionTh: input.descriptionTh } : {}),
      ...(input.sizeChartTh !== undefined ? { sizeChartTh: input.sizeChartTh } : {}),
      ...(input.imageIds !== undefined ? { imageIds: input.imageIds } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.saleEnabled !== undefined ? { saleEnabled: input.saleEnabled } : {}),
      ...(input.basePriceBaht !== undefined ? { basePrice: input.basePriceBaht } : {}),
    });
    await writeAudit(txDb, {
      eventId,
      entityType: "product",
      entityId: id,
      action: "product.update",
      actorId: admin.id,
      before: snapshot(before),
      after: snapshot(after),
    });
  });
  return getAdminProduct(db, eventId, id);
}

export async function orderProducts(db: MerchDb, eventId: number, ids: string[]): Promise<void> {
  const total = await db
    .select({ id: merchProducts.id })
    .from(merchProducts)
    .where(eq(merchProducts.eventId, eventId));
  if (total.length !== ids.length) {
    throw new MerchError(422, "MERCH_ORDER_INVALID", "รายการเรียงลำดับไม่ถูกต้อง");
  }
  await applyOrder(db, merchProducts, eventId, ids);
}

// ---- variants ----

export async function replaceVariants(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  productId: string,
  input: z.infer<typeof variantsInput>,
): Promise<AdminProductDto> {
  await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const product = await lockProduct(txDb, eventId, productId, input.expectedVersion);
    if (product.kind !== "single") {
      throw new MerchError(422, "MERCH_PRODUCT_KIND_INVALID", "สินค้าแบบชุดไม่มีตัวเลือก");
    }
    const existing = await txDb
      .select()
      .from(merchVariants)
      .where(eq(merchVariants.productId, productId));
    const existingById = new Map(existing.map((v) => [v.id, v]));

    const rows = input.variants.map((v, index) => ({
      id: v.id,
      sizeTh: v.sizeTh ?? null,
      colorTh: v.colorTh ?? null,
      price: v.priceBaht ?? null,
      saleEnabled: v.saleEnabled ?? true,
      sortOrder: index,
    }));
    const givenIds = rows.flatMap((r) => (r.id ? [r.id] : []));
    if (new Set(givenIds).size !== givenIds.length || givenIds.some((id) => !existingById.has(id))) {
      throw new MerchError(422, "MERCH_VARIANT_INVALID", "ไม่พบตัวเลือกสินค้าที่ระบุ");
    }
    if (!variantShapeValid(rows)) {
      throw new MerchError(
        422,
        "MERCH_VARIANT_SHAPE_MIXED",
        "สินค้าต้องมีตัวเลือกเริ่มต้นตัวเดียว หรือทุกตัวเลือกต้องมีไซซ์หรือสี",
      );
    }
    const keys = rows.map((r) => `${r.sizeTh ?? ""}\u0000${r.colorTh ?? ""}`);
    if (new Set(keys).size !== keys.length) {
      throw new MerchError(422, "MERCH_VARIANT_DUPLICATE", "มีตัวเลือกไซซ์/สีซ้ำกัน");
    }

    const given = new Set(givenIds);
    const removed = existing.filter((v) => !given.has(v.id)).map((v) => v.id);
    if (removed.length > 0) {
      const removedSet = new Set(removed);
      const refs = await txDb
        .select()
        .from(merchBundleComponents)
        .where(eq(merchBundleComponents.componentProductId, productId));
      const used = refs.some(
        (c) =>
          (c.fixedVariantId !== null && removedSet.has(c.fixedVariantId)) ||
          c.allowedVariantIds.some((id) => removedSet.has(id)),
      );
      if (used) {
        throw new MerchError(
          422,
          "MERCH_VARIANT_IN_BUNDLE",
          "ตัวเลือกนี้ถูกใช้ในสินค้าแบบชุด ไม่สามารถลบได้",
        );
      }
      await txDb.delete(merchVariants).where(inArray(merchVariants.id, removed));
    }

    const changed = rows.filter((r) => {
      const old = r.id ? existingById.get(r.id) : undefined;
      return (
        old &&
        (old.sizeTh !== r.sizeTh ||
          old.colorTh !== r.colorTh ||
          old.price !== r.price ||
          old.saleEnabled !== r.saleEnabled ||
          old.sortOrder !== r.sortOrder)
      );
    });
    // Park re-keyed rows on unique temporary values so swaps cannot collide mid-way.
    for (const r of changed) {
      const old = existingById.get(r.id as string)!;
      if (old.sizeTh !== r.sizeTh || old.colorTh !== r.colorTh) {
        await txDb
          .update(merchVariants)
          .set({ sizeTh: `__tmp__${r.id}`, colorTh: null })
          .where(eq(merchVariants.id, r.id as string));
      }
    }
    for (const r of changed) {
      await txDb
        .update(merchVariants)
        .set({
          sizeTh: r.sizeTh,
          colorTh: r.colorTh,
          price: r.price,
          saleEnabled: r.saleEnabled,
          sortOrder: r.sortOrder,
          version: sql`${merchVariants.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(merchVariants.id, r.id as string));
    }
    const added = rows.filter((r) => !r.id);
    if (added.length > 0) {
      await txDb.insert(merchVariants).values(
        added.map((r) => ({
          productId,
          sizeTh: r.sizeTh,
          colorTh: r.colorTh,
          price: r.price,
          saleEnabled: r.saleEnabled,
          sortOrder: r.sortOrder,
        })),
      );
    }

    const after = await bumpProduct(txDb, productId);
    const summary = (v: { sizeTh: string | null; colorTh: string | null; price: number | null; saleEnabled: boolean }) => ({
      sizeTh: v.sizeTh, colorTh: v.colorTh, price: v.price, saleEnabled: v.saleEnabled,
    });
    await writeAudit(txDb, {
      eventId,
      entityType: "product",
      entityId: productId,
      action: "product.variants.replace",
      actorId: admin.id,
      before: { version: product.version, variants: existing.map(summary) },
      after: { version: after.version, variants: rows.map(summary) },
    });
  });
  return getAdminProduct(db, eventId, productId);
}

// ---- components ----

const componentInvalid = (message: string) =>
  new MerchError(422, "MERCH_COMPONENT_INVALID", message);

export async function replaceComponents(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  bundleId: string,
  input: z.infer<typeof componentsInput>,
): Promise<AdminProductDto> {
  await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const bundle = await lockProduct(txDb, eventId, bundleId, input.expectedVersion);
    if (bundle.kind !== "bundle") {
      throw new MerchError(422, "MERCH_PRODUCT_KIND_INVALID", "เฉพาะสินค้าแบบชุดเท่านั้นที่มีส่วนประกอบ");
    }
    const existing = await txDb
      .select()
      .from(merchBundleComponents)
      .where(eq(merchBundleComponents.bundleProductId, bundleId));
    const existingIds = new Set(existing.map((c) => c.id));
    const givenIds = input.components.flatMap((c) => (c.id ? [c.id] : []));
    if (new Set(givenIds).size !== givenIds.length || givenIds.some((id) => !existingIds.has(id))) {
      throw componentInvalid("ไม่พบส่วนประกอบที่ระบุ");
    }

    const productIds = [...new Set(input.components.map((c) => c.componentProductId))];
    const products = productIds.length
      ? await txDb
          .select({ id: merchProducts.id, kind: merchProducts.kind })
          .from(merchProducts)
          .where(and(eq(merchProducts.eventId, eventId), inArray(merchProducts.id, productIds)))
      : [];
    const kindById = new Map(products.map((p) => [p.id, p.kind]));
    const variants = productIds.length
      ? await txDb
          .select({ id: merchVariants.id, productId: merchVariants.productId })
          .from(merchVariants)
          .where(inArray(merchVariants.productId, productIds))
      : [];
    const variantProduct = new Map(variants.map((v) => [v.id, v.productId]));

    const rows = input.components.map((c, index) => {
      if (c.componentProductId === bundleId || kindById.get(c.componentProductId) !== "single") {
        throw componentInvalid("ส่วนประกอบต้องเป็นสินค้าเดี่ยวของงานนี้");
      }
      const belongs = (variantId: string) => variantProduct.get(variantId) === c.componentProductId;
      let fixedVariantId: string | null = null;
      let allowedVariantIds: string[] = [];
      if (c.mode === "fixed") {
        if (!c.fixedVariantId || !belongs(c.fixedVariantId)) {
          throw componentInvalid("ต้องระบุตัวเลือกของสินค้าที่เป็นส่วนประกอบ");
        }
        fixedVariantId = c.fixedVariantId;
      } else {
        const allowed = [...new Set(c.allowedVariantIds ?? [])];
        if (allowed.length === 0 || !allowed.every(belongs)) {
          throw componentInvalid("ต้องระบุตัวเลือกที่เลือกได้อย่างน้อย 1 ตัวของสินค้านั้น");
        }
        allowedVariantIds = allowed;
      }
      return {
        id: c.id,
        componentProductId: c.componentProductId,
        quantityPerBundle: c.quantityPerBundle ?? 1,
        mode: c.mode,
        fixedVariantId,
        allowedVariantIds,
        sortOrder: index,
      };
    });

    const given = new Set(givenIds);
    const removed = existing.filter((c) => !given.has(c.id)).map((c) => c.id);
    if (removed.length > 0) {
      await txDb.delete(merchBundleComponents).where(inArray(merchBundleComponents.id, removed));
    }
    for (const r of rows.filter((x) => x.id)) {
      await txDb
        .update(merchBundleComponents)
        .set({
          componentProductId: r.componentProductId,
          quantityPerBundle: r.quantityPerBundle,
          mode: r.mode,
          fixedVariantId: r.fixedVariantId,
          allowedVariantIds: r.allowedVariantIds,
          sortOrder: r.sortOrder,
          updatedAt: sql`now()`,
        })
        .where(eq(merchBundleComponents.id, r.id as string));
    }
    const added = rows.filter((r) => !r.id);
    if (added.length > 0) {
      await txDb.insert(merchBundleComponents).values(
        added.map(({ id: _id, ...r }) => ({ bundleProductId: bundleId, ...r })),
      );
    }

    const after = await bumpProduct(txDb, bundleId);
    const summary = (c: {
      componentProductId: string; quantityPerBundle: number; mode: string;
      fixedVariantId: string | null; allowedVariantIds: string[];
    }) => ({
      componentProductId: c.componentProductId,
      quantityPerBundle: c.quantityPerBundle,
      mode: c.mode,
      fixedVariantId: c.fixedVariantId,
      allowedVariantIds: c.allowedVariantIds,
    });
    await writeAudit(txDb, {
      eventId,
      entityType: "product",
      entityId: bundleId,
      action: "product.components.replace",
      actorId: admin.id,
      before: { version: bundle.version, components: existing.map(summary) },
      after: { version: after.version, components: rows.map(summary) },
    });
  });
  return getAdminProduct(db, eventId, bundleId);
}

// ---- publish ----

export async function publishProduct(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  id: string,
  expectedVersion?: number,
): Promise<AdminProductDto> {
  await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const before = await lockProduct(txDb, eventId, id, expectedVersion);
    const catalog = await loadCatalog(txDb, eventId, { includeDrafts: true });
    const issues = publishIssues(id, catalog);
    if (issues.length > 0) {
      throw new MerchError(422, "MERCH_PUBLISH_INCOMPLETE", "ข้อมูลสินค้ายังไม่ครบสำหรับการเผยแพร่", {
        issues,
      });
    }
    const after = await bumpProduct(txDb, id, { publishState: "published" });
    await writeAudit(txDb, {
      eventId,
      entityType: "product",
      entityId: id,
      action: "product.publish",
      actorId: admin.id,
      before: { publishState: before.publishState, version: before.version },
      after: { publishState: after.publishState, version: after.version },
    });
  });
  return getAdminProduct(db, eventId, id);
}

export async function unpublishProduct(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  id: string,
  expectedVersion?: number,
): Promise<AdminProductDto> {
  await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const before = await lockProduct(txDb, eventId, id, expectedVersion);
    const after = await bumpProduct(txDb, id, { publishState: "draft" });
    await writeAudit(txDb, {
      eventId,
      entityType: "product",
      entityId: id,
      action: "product.unpublish",
      actorId: admin.id,
      before: { publishState: before.publishState, version: before.version },
      after: { publishState: after.publishState, version: after.version },
    });
  });
  return getAdminProduct(db, eventId, id);
}

// ---- bulk ----

export async function bulkUpdateProducts(
  db: MerchDb,
  admin: Admin,
  eventId: number,
  input: z.infer<typeof bulkInput>,
): Promise<BatchRowResult[]> {
  const change = input.change;
  if ("categoryId" in change && change.categoryId) {
    await assertCategory(db, eventId, change.categoryId);
  }
  const results: BatchRowResult[] = [];
  for (const id of new Set(input.ids)) {
    try {
      await db.transaction(async (tx) => {
        const txDb = asTx(tx);
        const before = await lockProduct(txDb, eventId, id);
        const after = await bumpProduct(
          txDb,
          id,
          "saleEnabled" in change
            ? { saleEnabled: change.saleEnabled }
            : { categoryId: change.categoryId },
        );
        await writeAudit(txDb, {
          eventId,
          entityType: "product",
          entityId: id,
          action: "product.bulk",
          actorId: admin.id,
          before: { saleEnabled: before.saleEnabled, categoryId: before.categoryId, version: before.version },
          after: { saleEnabled: after.saleEnabled, categoryId: after.categoryId, version: after.version },
        });
      });
      results.push({ id, ok: true, code: null, error: null });
    } catch (error) {
      if (!(error instanceof MerchError)) throw error;
      results.push({ id, ok: false, code: error.code, error: error.message });
    }
  }
  return results;
}
