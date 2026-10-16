import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { merchOrderItems, merchOrders, merchStores } from "../../database/schema.js";
import { readAdminOrderDetail } from "./admin-orders.js";
import { versionConflict } from "./admin-store.js";
import { writeAudit } from "./audit.js";
import { quantitySchema, selectionsSchema } from "./cart.js";
import { loadCatalog } from "./catalog-read.js";
import { validateSelection, type CatalogSnapshot } from "./catalog-rules.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { assertOrderTotalAllowed, SHIPPING_FEE_MINOR } from "./money.js";
import { editBlockingAttemptExistsSql, type MerchContext } from "./payments/attempts.js";
import { recipientSchema } from "./recipient.js";
import { dbNow, storeState } from "./store-window.js";
import type { AdminOrderDetail, BundleSelection, Recipient } from "./types.js";

type OrderRow = typeof merchOrders.$inferSelect;
type OrderItemRow = typeof merchOrderItems.$inferSelect;
type NewItem = Omit<typeof merchOrderItems.$inferInsert, "id" | "orderId" | "createdAt" | "updatedAt">;

const uuid = z.string().uuid();

const sourceLine = z.object({ sourceItemId: uuid, quantity: quantitySchema }).strict();
const newLine = z
  .object({
    productId: uuid,
    variantId: uuid.nullable(),
    bundleSelections: selectionsSchema,
    quantity: quantitySchema,
  })
  .strict();

export const orderEditInput = z
  .object({
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(1).max(1000),
    contactConfirmed: z.boolean().optional(),
    contactNote: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => (v ? v : undefined)),
    recipient: recipientSchema.optional(),
    lines: z.array(z.union([sourceLine, newLine])).max(200).optional(),
  })
  .strict();

export type OrderEditInput = {
  expectedVersion: number;
  reason: string;
  contactConfirmed?: boolean;
  contactNote?: string;
  recipient?: Recipient;
  lines?: (
    | { sourceItemId: string; quantity: number }
    | { productId: string; variantId: string | null; bundleSelections: BundleSelection[]; quantity: number }
  )[];
};

const asTx = (tx: unknown) => tx as MerchDb;

function lineInvalid(message: string, details?: Record<string, unknown>): MerchError {
  return new MerchError(422, "MERCH_ORDER_LINE_INVALID", message, details);
}

function recipientOf(order: OrderRow): Recipient {
  return {
    fullName: order.recipientName,
    phone: order.recipientPhone,
    addressLine: order.addressLine,
    subdistrict: order.subdistrict,
    district: order.district,
    province: order.province,
    postalCode: order.postalCode,
    company: order.company,
    deliveryNote: order.deliveryNote,
  };
}

function snapshot(order: { version: number; subtotal: number; shippingFee: number; total: number }, recipient: Recipient, items: NewItem[]) {
  return {
    version: order.version,
    recipient,
    items: items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId ?? null,
      kind: i.kind,
      nameTh: i.nameTh,
      sizeTh: i.sizeTh ?? null,
      colorTh: i.colorTh ?? null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      components: i.components ?? [],
    })),
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    total: order.total,
  };
}

function keepItem(item: OrderItemRow, quantity: number): NewItem {
  return {
    productId: item.productId,
    variantId: item.variantId,
    kind: item.kind,
    nameTh: item.nameTh,
    sizeTh: item.sizeTh,
    colorTh: item.colorTh,
    quantity,
    unitPrice: item.unitPrice,
    lineTotal: item.unitPrice * quantity,
    components: item.components,
  };
}

/**
 * Prices a new line from the current catalog. Admin edits are allowed in any store state,
 * so `STORE_NOT_OPEN` is ignored; every other issue rejects the line.
 */
function priceNewLine(
  line: { productId: string; variantId: string | null; bundleSelections: BundleSelection[]; quantity: number },
  index: number,
  catalog: CatalogSnapshot,
  state: ReturnType<typeof storeState>,
): NewItem {
  const selection = { variantId: line.variantId, bundleSelections: line.bundleSelections };
  const checked = validateSelection(line.productId, selection, catalog, state);
  const issueCodes = checked.issueCodes.filter((c) => c !== "STORE_NOT_OPEN");
  // STORE_NOT_OPEN alone nulls the price; re-price as if open (the store state affects nothing else).
  const unit =
    issueCodes.length === 0
      ? (checked.unitPriceMinor ?? validateSelection(line.productId, selection, catalog, "open").unitPriceMinor)
      : null;
  if (unit === null) {
    throw new MerchError(422, "MERCH_SELECTION_INVALID", "ตัวเลือกสินค้าไม่ถูกต้อง", { index, issueCodes });
  }
  const product = catalog.products.get(line.productId)!;
  const kind = product.kind as "single" | "bundle";
  const variant =
    kind === "single"
      ? (catalog.variantsByProduct.get(product.id) ?? []).find((v) => v.id === line.variantId)
      : undefined;
  return {
    productId: product.id,
    variantId: kind === "single" ? line.variantId : null,
    kind,
    nameTh: product.nameTh,
    sizeTh: variant?.sizeTh ?? null,
    colorTh: variant?.colorTh ?? null,
    quantity: line.quantity,
    unitPrice: unit,
    lineTotal: unit * line.quantity,
    components: checked.resolvedComponents.map((c) => ({
      productId: c.productId,
      variantId: c.variantId,
      nameTh: c.nameTh,
      sizeTh: c.sizeTh,
      colorTh: c.colorTh,
      quantityPerBundle: c.quantityPerBundle,
    })),
  };
}

/**
 * Admin order edit (§6.6). One transaction with the order row locked FOR UPDATE; the unpaid
 * vs paid rules are decided from `payment_status` read under that lock (R11).
 * - unpaid: no `creating` attempt and no `active`/`expired` attempt with `expires_at` within the
 *   last 120 s or later (DB now), else 409
 * - paid: `contactConfirmed: true` + `contactNote` required, and the new total must equal the old
 * Existing lines keep their stored `unit_price`; new lines are priced from the current catalog.
 */
export async function editOrder(
  ctx: MerchContext,
  admin: { id: number },
  eventId: number,
  orderId: string,
  input: OrderEditInput,
): Promise<AdminOrderDetail> {
  await ctx.db.transaction(async (rawTx) => {
    const tx = asTx(rawTx);
    const [order] = await tx
      .select()
      .from(merchOrders)
      .where(and(eq(merchOrders.id, orderId), eq(merchOrders.eventId, eventId)))
      .for("update")
      .limit(1);
    if (!order) throw new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
    if (order.version !== input.expectedVersion) throw versionConflict(order.version);

    const paid = order.paymentStatus === "paid";
    if (paid) {
      if (input.contactConfirmed !== true || !input.contactNote) {
        throw new MerchError(
          422,
          "MERCH_CONTACT_REQUIRED",
          "ออเดอร์ที่ชำระแล้วต้องยืนยันการติดต่อลูกค้าและบันทึกรายละเอียดการติดต่อ",
        );
      }
    } else {
      const rows = (await tx.execute(
        sql`SELECT ${editBlockingAttemptExistsSql(sql`${orderId}::uuid`, sql`clock_timestamp()`)} AS open`,
      )) as unknown as Array<{ open: boolean }>;
      if (rows[0]?.open) {
        throw new MerchError(
          409,
          "MERCH_ORDER_HAS_ACTIVE_QR",
          "ออเดอร์นี้มี QR ที่ยังใช้งานได้ กรุณารอให้หมดอายุก่อนแก้ไข",
        );
      }
    }

    const existing = await tx
      .select()
      .from(merchOrderItems)
      .where(eq(merchOrderItems.orderId, orderId))
      .orderBy(asc(merchOrderItems.sortOrder), asc(merchOrderItems.id));
    const beforeItems = existing.map((i) => keepItem(i, i.quantity));

    let afterItems = beforeItems;
    if (input.lines !== undefined) {
      if (input.lines.length === 0) {
        throw new MerchError(422, "MERCH_ORDER_EMPTY", "ออเดอร์ต้องมีสินค้าอย่างน้อย 1 รายการ");
      }
      const byId = new Map(existing.map((i) => [i.id, i]));
      const used = new Set<string>();
      const needsCatalog = input.lines.some((l) => !("sourceItemId" in l));
      let catalog: CatalogSnapshot | null = null;
      let state: ReturnType<typeof storeState> = "open";
      if (needsCatalog) {
        catalog = await loadCatalog(tx, eventId, { includeDrafts: false });
        const [store] = await tx.select().from(merchStores).where(eq(merchStores.eventId, eventId)).limit(1);
        state = storeState(store ?? null, await dbNow(tx));
      }
      afterItems = input.lines.map((line, index) => {
        if ("sourceItemId" in line) {
          const item = byId.get(line.sourceItemId);
          if (!item || used.has(item.id)) {
            throw lineInvalid("ไม่พบรายการสินค้าเดิมที่ระบุ หรือระบุซ้ำ", { index });
          }
          used.add(item.id);
          return keepItem(item, line.quantity);
        }
        return priceNewLine(line, index, catalog!, state);
      });
    }

    const subtotal = afterItems.reduce((sum, i) => sum + i.lineTotal, 0);
    const total = subtotal + SHIPPING_FEE_MINOR;
    assertOrderTotalAllowed(total);
    if (paid && total !== order.total) {
      throw new MerchError(422, "MERCH_PAID_TOTAL_MUST_MATCH", "ยอดรวมใหม่ของออเดอร์ที่ชำระแล้วต้องเท่ากับยอดเดิม", {
        currentTotalMinor: order.total,
        newTotalMinor: total,
      });
    }

    const beforeRecipient = recipientOf(order);
    const r = input.recipient ?? beforeRecipient;

    if (input.lines !== undefined) {
      await tx.delete(merchOrderItems).where(eq(merchOrderItems.orderId, orderId));
      await tx
        .insert(merchOrderItems)
        .values(afterItems.map((item, index) => ({ ...item, orderId, sortOrder: index })));
    }
    const [updated] = await tx
      .update(merchOrders)
      .set({
        recipientName: r.fullName,
        recipientPhone: r.phone,
        addressLine: r.addressLine,
        subdistrict: r.subdistrict,
        district: r.district,
        province: r.province,
        postalCode: r.postalCode,
        company: r.company,
        deliveryNote: r.deliveryNote,
        subtotal,
        shippingFee: SHIPPING_FEE_MINOR,
        total,
        version: sql`${merchOrders.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(merchOrders.id, orderId))
      .returning();

    await writeAudit(tx, {
      eventId,
      entityType: "order",
      entityId: orderId,
      action: "order.edit",
      actorId: admin.id,
      reason: input.reason,
      contactConfirmed: input.contactConfirmed ?? null,
      contactNote: input.contactNote ?? null,
      before: snapshot(order, beforeRecipient, beforeItems),
      after: snapshot(updated, recipientOf(updated), afterItems),
    });
  });
  return readAdminOrderDetail(ctx, eventId, orderId);
}
