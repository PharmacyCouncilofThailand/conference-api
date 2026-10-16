import { createHash } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { merchCartItems } from "../../database/schema.js";
import type { Buyer } from "./access.js";
import { loadCatalog, loadImages, toProductDto } from "./catalog-read.js";
import {
  unavailableCodes,
  validateSelection,
  type CatalogSnapshot,
  type ResolvedComponent,
} from "./catalog-rules.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { SHIPPING_FEE_BAHT } from "./money.js";
import { readStore, type StoreState } from "./store-window.js";
import type { Amounts, BundleSelection, CartDto, CartLine, ImageAsset } from "./types.js";

export type PricedLine = CartLine & {
  selectionKey: string;
  resolvedComponents: ResolvedComponent[];
  snapshot: { kind: "single" | "bundle"; nameTh: string; sizeTh: string | null; colorTh: string | null };
};

type CartRow = typeof merchCartItems.$inferSelect;

const MAX_QUANTITY = 9999;
const uuid = z.string().uuid();
export const selectionsSchema = z
  .array(z.object({ componentId: uuid, variantId: uuid }).strict())
  .max(50)
  .refine((list) => new Set(list.map((s) => s.componentId)).size === list.length, "duplicate component");
export const quantitySchema = z.number().int().min(1).max(MAX_QUANTITY);

export const addCartItemInput = z
  .object({
    productId: uuid,
    variantId: uuid.nullable().default(null),
    bundleSelections: selectionsSchema.default([]),
    quantity: quantitySchema,
  })
  .strict();

export const updateCartItemInput = z
  .object({
    quantity: quantitySchema.optional(),
    variantId: uuid.nullable().optional(),
    bundleSelections: selectionsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "empty update");

export type AddCartItemInput = z.infer<typeof addCartItemInput>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemInput>;

const asTx = (tx: unknown) => tx as MerchDb;

export function selectionKey(input: { variantId: string | null; bundleSelections: BundleSelection[] }): string {
  const parts = [...input.bundleSelections]
    .sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0))
    .map((s) => `c:${s.componentId}=${s.variantId}`);
  return [`v:${input.variantId ?? "-"}`, ...parts].join("|");
}

export function cartVersion(
  lines: {
    id: string;
    quantity: number;
    selectionKey: string;
    updatedAt: Date;
    unitPriceBaht: number | null;
    valid: boolean;
  }[],
): string {
  const text = [...lines]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(
      (l) =>
        `${l.id}:${l.quantity}:${l.selectionKey}:${l.updatedAt.toISOString()}:${l.unitPriceBaht ?? "null"}:${l.valid}`,
    )
    .join("\n");
  return createHash("sha256").update(text).digest("hex");
}

function parseSelections(value: unknown): BundleSelection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const s = v as Partial<BundleSelection> | null;
    return s && typeof s.componentId === "string" && typeof s.variantId === "string"
      ? [{ componentId: s.componentId, variantId: s.variantId }]
      : [];
  });
}

function snapshotOf(row: CartRow, catalog: CatalogSnapshot) {
  const product = catalog.products.get(row.productId);
  if (!product) return { kind: "single" as const, nameTh: "", sizeTh: null, colorTh: null };
  const kind = product.kind as "single" | "bundle";
  const variant =
    kind === "single"
      ? (catalog.variantsByProduct.get(product.id) ?? []).find((v) => v.id === row.variantId)
      : undefined;
  return { kind, nameTh: product.nameTh, sizeTh: variant?.sizeTh ?? null, colorTh: variant?.colorTh ?? null };
}

export async function priceCart(
  db: MerchDb,
  buyer: Buyer,
  eventId: number,
  state: StoreState,
): Promise<{ lines: PricedLine[]; version: string; subtotalBaht: number | null }> {
  const rows = await db
    .select()
    .from(merchCartItems)
    .where(and(eq(merchCartItems.userId, buyer.id), eq(merchCartItems.eventId, eventId)))
    .orderBy(asc(merchCartItems.createdAt), asc(merchCartItems.id));
  const catalog = await loadCatalog(db, eventId, { includeDrafts: false });
  const images: Map<string, ImageAsset> = await loadImages(
    db,
    rows.flatMap((r) => catalog.products.get(r.productId)?.imageIds ?? []),
  );

  const lines: PricedLine[] = rows.map((row) => {
    const bundleSelections = parseSelections(row.bundleSelections);
    const known = catalog.products.has(row.productId);
    const checked = known
      ? validateSelection(row.productId, { variantId: row.variantId, bundleSelections }, catalog, state)
      : { unitPriceBaht: null, issueCodes: ["PRODUCT_DISABLED"], resolvedComponents: [] };
    const unit = checked.unitPriceBaht;
    return {
      id: row.id,
      productId: row.productId,
      variantId: row.variantId,
      bundleSelections,
      quantity: row.quantity,
      product: known ? toProductDto(row.productId, catalog, state, images) : null,
      unitPriceBaht: unit,
      lineTotalBaht: unit === null ? null : unit * row.quantity,
      valid: checked.issueCodes.length === 0 && unit !== null,
      issueCodes: checked.issueCodes,
      selectionKey: row.selectionKey,
      resolvedComponents: checked.resolvedComponents,
      snapshot: snapshotOf(row, catalog),
    };
  });

  const version = cartVersion(
    lines.map((l, i) => ({
      id: l.id,
      quantity: l.quantity,
      selectionKey: l.selectionKey,
      updatedAt: rows[i].updatedAt,
      unitPriceBaht: l.unitPriceBaht,
      valid: l.valid,
    })),
  );
  const subtotalBaht =
    lines.length > 0 && lines.every((l) => l.valid)
      ? lines.reduce((sum, l) => sum + (l.lineTotalBaht as number), 0)
      : null;
  return { lines, version, subtotalBaht };
}

export async function readCart(db: MerchDb, buyer: Buyer, eventId: number): Promise<CartDto> {
  const { state, now } = await readStore(db, eventId);
  const priced = await priceCart(db, buyer, eventId, state);
  const amounts: Amounts | null =
    priced.subtotalBaht === null
      ? null
      : {
          subtotalBaht: priced.subtotalBaht,
          shippingBaht: SHIPPING_FEE_BAHT,
          totalBaht: priced.subtotalBaht + SHIPPING_FEE_BAHT,
          currency: "THB",
        };
  return {
    cartVersion: priced.version,
    items: priced.lines.map(
      ({ selectionKey: _key, resolvedComponents: _resolved, snapshot: _snapshot, ...line }) => line,
    ),
    amounts,
    buyerDefaults: { fullName: buyer.fullName, phone: buyer.phone, email: buyer.email },
    serverNow: now.toISOString(),
  };
}

function quantityExceeded(): MerchError {
  return new MerchError(400, "MERCH_CART_QUANTITY_LIMIT", `จำนวนต่อรายการต้องไม่เกิน ${MAX_QUANTITY}`);
}

async function checkSelection(
  db: MerchDb,
  eventId: number,
  productId: string,
  input: { variantId: string | null; bundleSelections: BundleSelection[] },
): Promise<void> {
  const { state } = await readStore(db, eventId);
  const catalog = await loadCatalog(db, eventId, { includeDrafts: false });
  const result = validateSelection(productId, input, catalog, state);
  if (result.issueCodes.length === 0) return;
  const details = { issueCodes: result.issueCodes };
  if (unavailableCodes(productId, catalog, state).length > 0) {
    throw new MerchError(422, "MERCH_PRODUCT_UNAVAILABLE", "สินค้านี้ไม่พร้อมจำหน่าย", details);
  }
  throw new MerchError(422, "MERCH_SELECTION_INVALID", "ตัวเลือกสินค้าไม่ถูกต้อง", details);
}

export async function addCartItem(
  db: MerchDb,
  buyer: Buyer,
  eventId: number,
  input: AddCartItemInput,
): Promise<CartDto> {
  await checkSelection(db, eventId, input.productId, input);
  const key = selectionKey(input);
  const [row] = await db
    .insert(merchCartItems)
    .values({
      eventId,
      userId: buyer.id,
      productId: input.productId,
      variantId: input.variantId,
      bundleSelections: input.bundleSelections,
      selectionKey: key,
      quantity: input.quantity,
    })
    .onConflictDoUpdate({
      target: [
        merchCartItems.userId,
        merchCartItems.eventId,
        merchCartItems.productId,
        merchCartItems.selectionKey,
      ],
      set: { quantity: sql`${merchCartItems.quantity} + excluded.quantity`, updatedAt: sql`now()` },
      setWhere: sql`${merchCartItems.quantity} + excluded.quantity <= ${MAX_QUANTITY}`,
    })
    .returning({ id: merchCartItems.id });
  if (!row) throw quantityExceeded();
  return readCart(db, buyer, eventId);
}

function notFound(): MerchError {
  return new MerchError(404, "MERCH_CART_ITEM_NOT_FOUND", "ไม่พบรายการในตะกร้า");
}

export async function updateCartItem(
  db: MerchDb,
  buyer: Buyer,
  eventId: number,
  itemId: string,
  input: UpdateCartItemInput,
): Promise<CartDto> {
  await db.transaction(async (tx) => {
    const txDb = asTx(tx);
    const [item] = await txDb
      .select()
      .from(merchCartItems)
      .where(
        and(
          eq(merchCartItems.id, itemId),
          eq(merchCartItems.userId, buyer.id),
          eq(merchCartItems.eventId, eventId),
        ),
      )
      .for("update")
      .limit(1);
    if (!item) throw notFound();

    const next = {
      variantId: input.variantId !== undefined ? input.variantId : item.variantId,
      bundleSelections:
        input.bundleSelections !== undefined ? input.bundleSelections : parseSelections(item.bundleSelections),
    };
    const quantity = input.quantity ?? item.quantity;
    await checkSelection(txDb, eventId, item.productId, next);
    const key = selectionKey(next);

    const [other] =
      key === item.selectionKey
        ? []
        : await txDb
            .select()
            .from(merchCartItems)
            .where(
              and(
                eq(merchCartItems.userId, buyer.id),
                eq(merchCartItems.eventId, eventId),
                eq(merchCartItems.productId, item.productId),
                eq(merchCartItems.selectionKey, key),
                ne(merchCartItems.id, item.id),
              ),
            )
            .for("update")
            .limit(1);
    if (other) {
      if (other.quantity + quantity > MAX_QUANTITY) throw quantityExceeded();
      await txDb.delete(merchCartItems).where(eq(merchCartItems.id, item.id));
      await txDb
        .update(merchCartItems)
        .set({ quantity: other.quantity + quantity, updatedAt: sql`now()` })
        .where(eq(merchCartItems.id, other.id));
      return;
    }
    await txDb
      .update(merchCartItems)
      .set({
        variantId: next.variantId,
        bundleSelections: next.bundleSelections,
        selectionKey: key,
        quantity,
        updatedAt: sql`now()`,
      })
      .where(eq(merchCartItems.id, item.id));
  });
  return readCart(db, buyer, eventId);
}

export async function removeCartItem(
  db: MerchDb,
  buyer: Buyer,
  eventId: number,
  itemId: string,
): Promise<CartDto> {
  const removed = await db
    .delete(merchCartItems)
    .where(
      and(
        eq(merchCartItems.id, itemId),
        eq(merchCartItems.userId, buyer.id),
        eq(merchCartItems.eventId, eventId),
      ),
    )
    .returning({ id: merchCartItems.id });
  if (removed.length === 0) throw notFound();
  return readCart(db, buyer, eventId);
}
