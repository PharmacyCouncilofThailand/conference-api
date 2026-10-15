import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  merchBanners,
  merchCategories,
  merchImages,
  merchProducts,
  merchStores,
} from "../../database/schema.js";
import { writeAudit } from "./audit.js";
import { toStoreDto } from "./catalog-read.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import type { AdminBannerDto, AdminCategoryDto, AdminStoreDto } from "./types.js";

export function versionConflict(currentVersion: number): MerchError {
  return new MerchError(409, "MERCH_VERSION_CONFLICT", "ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่", {
    currentVersion,
  });
}

const isoWithOffset = z.string().datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);
const linkUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "http(s) only");

export const storeInput = z.object({
  expectedVersion: z.number().int().min(0),
  enabled: z.boolean(),
  opensAt: isoWithOffset.nullable(),
  closesAt: isoWithOffset.nullable(),
  productionInfoTh: z.string().max(5000).nullable(),
  shippingInfoTh: z.string().max(5000).nullable(),
});
export const categoryCreateInput = z.object({
  nameTh: text(200),
  visible: z.boolean().optional(),
});
export const categoryPatchInput = z.object({
  expectedVersion: z.number().int().min(1),
  nameTh: text(200).optional(),
  visible: z.boolean().optional(),
});
export const bannerCreateInput = z.object({
  imageId: z.string().uuid(),
  linkUrl: linkUrl.nullable().optional(),
  active: z.boolean().optional(),
});
export const bannerPatchInput = z.object({
  expectedVersion: z.number().int().min(1),
  imageId: z.string().uuid().optional(),
  linkUrl: linkUrl.nullable().optional(),
  active: z.boolean().optional(),
});
export const orderInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

// ---- store ----

export async function getAdminStore(db: MerchDb, eventId: number): Promise<AdminStoreDto> {
  const dto = await toStoreDto(db, eventId, { includeHidden: true });
  const [row] = await db.select().from(merchStores).where(eq(merchStores.eventId, eventId)).limit(1);
  return { ...dto, enabled: row?.enabled ?? false, version: row?.version ?? 0 };
}

export async function putStore(
  db: MerchDb,
  admin: { id: number },
  eventId: number,
  input: z.infer<typeof storeInput>,
): Promise<AdminStoreDto> {
  const opensAt = input.opensAt ? new Date(input.opensAt) : null;
  const closesAt = input.closesAt ? new Date(input.closesAt) : null;
  if (opensAt && closesAt && opensAt.getTime() >= closesAt.getTime()) {
    throw new MerchError(422, "MERCH_STORE_WINDOW_INVALID", "เวลาเปิดต้องอยู่ก่อนเวลาปิด");
  }
  const values = {
    enabled: input.enabled,
    opensAt,
    closesAt,
    productionInfoTh: input.productionInfoTh,
    shippingInfoTh: input.shippingInfoTh,
  };

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as MerchDb;
    const [before] = await txDb
      .select()
      .from(merchStores)
      .where(eq(merchStores.eventId, eventId))
      .limit(1);
    let after: typeof before | undefined;
    if (input.expectedVersion === 0) {
      [after] = await txDb
        .insert(merchStores)
        .values({ eventId, ...values })
        .onConflictDoNothing()
        .returning();
    } else {
      [after] = await txDb
        .update(merchStores)
        .set({ ...values, version: sql`${merchStores.version} + 1`, updatedAt: sql`now()` })
        .where(
          and(eq(merchStores.eventId, eventId), eq(merchStores.version, input.expectedVersion)),
        )
        .returning();
    }
    if (!after) {
      const [current] = await txDb
        .select({ version: merchStores.version })
        .from(merchStores)
        .where(eq(merchStores.eventId, eventId))
        .limit(1);
      throw versionConflict(current?.version ?? 0);
    }
    const snapshot = (r: typeof after | undefined) =>
      r
        ? {
            enabled: r.enabled,
            opensAt: r.opensAt?.toISOString() ?? null,
            closesAt: r.closesAt?.toISOString() ?? null,
            productionInfoTh: r.productionInfoTh,
            shippingInfoTh: r.shippingInfoTh,
            version: r.version,
          }
        : null;
    await writeAudit(txDb, {
      eventId,
      entityType: "store",
      entityId: String(eventId),
      action: "store.update",
      actorId: admin.id,
      before: snapshot(before),
      after: snapshot(after),
    });
  });
  return getAdminStore(db, eventId);
}

// ---- categories ----

function toCategoryDto(r: typeof merchCategories.$inferSelect): AdminCategoryDto {
  return { id: r.id, nameTh: r.nameTh, sortOrder: r.sortOrder, visible: r.visible, version: r.version };
}

export async function listCategories(db: MerchDb, eventId: number): Promise<AdminCategoryDto[]> {
  const rows = await db
    .select()
    .from(merchCategories)
    .where(eq(merchCategories.eventId, eventId))
    .orderBy(asc(merchCategories.sortOrder), asc(merchCategories.createdAt), asc(merchCategories.id));
  return rows.map(toCategoryDto);
}

export async function createCategory(
  db: MerchDb,
  eventId: number,
  input: z.infer<typeof categoryCreateInput>,
): Promise<AdminCategoryDto> {
  const [max] = await db
    .select({ value: sql<number>`coalesce(max(${merchCategories.sortOrder}), -1)` })
    .from(merchCategories)
    .where(eq(merchCategories.eventId, eventId));
  const [row] = await db
    .insert(merchCategories)
    .values({
      eventId,
      nameTh: input.nameTh,
      visible: input.visible ?? true,
      sortOrder: Number(max.value) + 1,
    })
    .returning();
  return toCategoryDto(row);
}

export async function patchCategory(
  db: MerchDb,
  eventId: number,
  id: string,
  input: z.infer<typeof categoryPatchInput>,
): Promise<AdminCategoryDto> {
  const [row] = await db
    .update(merchCategories)
    .set({
      ...(input.nameTh !== undefined ? { nameTh: input.nameTh } : {}),
      ...(input.visible !== undefined ? { visible: input.visible } : {}),
      version: sql`${merchCategories.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(merchCategories.id, id),
        eq(merchCategories.eventId, eventId),
        eq(merchCategories.version, input.expectedVersion),
      ),
    )
    .returning();
  if (row) return toCategoryDto(row);
  const [current] = await db
    .select({ version: merchCategories.version })
    .from(merchCategories)
    .where(and(eq(merchCategories.id, id), eq(merchCategories.eventId, eventId)))
    .limit(1);
  if (!current) throw new MerchError(404, "MERCH_CATEGORY_NOT_FOUND", "ไม่พบหมวดหมู่");
  throw versionConflict(current.version);
}

export async function deleteCategory(db: MerchDb, eventId: number, id: string): Promise<void> {
  // merch_products.category_id is ON DELETE SET NULL
  const rows = await db
    .delete(merchCategories)
    .where(and(eq(merchCategories.id, id), eq(merchCategories.eventId, eventId)))
    .returning({ id: merchCategories.id });
  if (rows.length === 0) throw new MerchError(404, "MERCH_CATEGORY_NOT_FOUND", "ไม่พบหมวดหมู่");
}

export async function orderCategories(db: MerchDb, eventId: number, ids: string[]): Promise<void> {
  await applyOrder(db, merchCategories, eventId, ids);
}

// ---- banners ----

export async function assertEventImage(db: MerchDb, eventId: number, imageId: string): Promise<void> {
  const [img] = await db
    .select({ id: merchImages.id })
    .from(merchImages)
    .where(and(eq(merchImages.id, imageId), eq(merchImages.eventId, eventId)))
    .limit(1);
  if (!img) throw new MerchError(422, "MERCH_IMAGE_INVALID", "ไม่พบรูปภาพของงานนี้");
}

async function bannerDtos(db: MerchDb, eventId: number, id?: string): Promise<AdminBannerDto[]> {
  const rows = await db
    .select({ banner: merchBanners, image: merchImages })
    .from(merchBanners)
    .innerJoin(merchImages, eq(merchImages.id, merchBanners.imageId))
    .where(
      id
        ? and(eq(merchBanners.eventId, eventId), eq(merchBanners.id, id))
        : eq(merchBanners.eventId, eventId),
    )
    .orderBy(asc(merchBanners.sortOrder), asc(merchBanners.createdAt), asc(merchBanners.id));
  return rows.map(({ banner, image }) => ({
    id: banner.id,
    image: { id: image.id, url: image.publicUrl, width: image.width, height: image.height },
    linkUrl: banner.linkUrl,
    active: banner.active,
    sortOrder: banner.sortOrder,
    version: banner.version,
  }));
}

export const listBanners = (db: MerchDb, eventId: number) => bannerDtos(db, eventId);

export async function createBanner(
  db: MerchDb,
  eventId: number,
  input: z.infer<typeof bannerCreateInput>,
): Promise<AdminBannerDto> {
  await assertEventImage(db, eventId, input.imageId);
  const [max] = await db
    .select({ value: sql<number>`coalesce(max(${merchBanners.sortOrder}), -1)` })
    .from(merchBanners)
    .where(eq(merchBanners.eventId, eventId));
  const [row] = await db
    .insert(merchBanners)
    .values({
      eventId,
      imageId: input.imageId,
      linkUrl: input.linkUrl ?? null,
      active: input.active ?? true,
      sortOrder: Number(max.value) + 1,
    })
    .returning({ id: merchBanners.id });
  return (await bannerDtos(db, eventId, row.id))[0];
}

export async function patchBanner(
  db: MerchDb,
  eventId: number,
  id: string,
  input: z.infer<typeof bannerPatchInput>,
): Promise<AdminBannerDto> {
  if (input.imageId !== undefined) await assertEventImage(db, eventId, input.imageId);
  const [row] = await db
    .update(merchBanners)
    .set({
      ...(input.imageId !== undefined ? { imageId: input.imageId } : {}),
      ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      version: sql`${merchBanners.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(merchBanners.id, id),
        eq(merchBanners.eventId, eventId),
        eq(merchBanners.version, input.expectedVersion),
      ),
    )
    .returning({ id: merchBanners.id });
  if (row) return (await bannerDtos(db, eventId, id))[0];
  const [current] = await db
    .select({ version: merchBanners.version })
    .from(merchBanners)
    .where(and(eq(merchBanners.id, id), eq(merchBanners.eventId, eventId)))
    .limit(1);
  if (!current) throw new MerchError(404, "MERCH_BANNER_NOT_FOUND", "ไม่พบแบนเนอร์");
  throw versionConflict(current.version);
}

export async function deleteBanner(db: MerchDb, eventId: number, id: string): Promise<void> {
  const rows = await db
    .delete(merchBanners)
    .where(and(eq(merchBanners.id, id), eq(merchBanners.eventId, eventId)))
    .returning({ id: merchBanners.id });
  if (rows.length === 0) throw new MerchError(404, "MERCH_BANNER_NOT_FOUND", "ไม่พบแบนเนอร์");
}

export async function orderBanners(db: MerchDb, eventId: number, ids: string[]): Promise<void> {
  await applyOrder(db, merchBanners, eventId, ids);
}

// ---- shared ----

export async function applyOrder(
  db: MerchDb,
  table: typeof merchCategories | typeof merchBanners | typeof merchProducts,
  eventId: number,
  ids: string[],
): Promise<void> {
  if (new Set(ids).size !== ids.length) {
    throw new MerchError(422, "MERCH_ORDER_INVALID", "รายการเรียงลำดับไม่ถูกต้อง");
  }
  await db.transaction(async (tx) => {
    const found = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.eventId, eventId), inArray(table.id, ids)));
    if (found.length !== ids.length) {
      throw new MerchError(422, "MERCH_ORDER_INVALID", "รายการเรียงลำดับไม่ถูกต้อง");
    }
    for (const [index, id] of ids.entries()) {
      await tx
        .update(table)
        .set({ sortOrder: index, updatedAt: sql`now()` })
        .where(and(eq(table.id, id), eq(table.eventId, eventId)));
    }
  });
}
