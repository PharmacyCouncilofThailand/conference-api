import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  merchCartItems,
  merchOrderItems,
  merchOrders,
  merchPaymentAttempts,
  merchStores,
} from "../../database/schema.js";
import type { Buyer } from "./access.js";
import { priceCart } from "./cart.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { SHIPPING_FEE_MINOR } from "./money.js";
import {
  derivePaymentView,
  hasOpenAttempt,
  issueQrForAttempt,
  loadAttempts,
  openAttemptExistsSql,
  type MerchContext,
} from "./payments/attempts.js";
import { dbNow, eventByCode, readStore, storeState, type StoreState } from "./store-window.js";
import type { Amounts, OrderDetail, OrderItemDto, OrderSummary, Recipient } from "./types.js";

type OrderRow = typeof merchOrders.$inferSelect;
type OrderItemRow = typeof merchOrderItems.$inferSelect;

const asTx = (tx: unknown) => tx as MerchDb;

export function orderNumberFor(eventCode: string, seq: number): string {
  return `${eventCode.toUpperCase().replace(/[^A-Z0-9]/g, "")}-M-${String(seq).padStart(6, "0")}`;
}

function fingerprintOf(cartVersion: string, recipient: Recipient): string {
  const sorted = Object.fromEntries(
    Object.keys(recipient)
      .sort()
      .map((k) => [k, recipient[k as keyof Recipient]]),
  );
  return createHash("sha256").update(JSON.stringify({ cartVersion, recipient: sorted })).digest("hex");
}

export function paymentStatusOf(
  order: Pick<OrderRow, "paymentStatus">,
  state: StoreState,
  openAttempt: boolean,
): "pending" | "paid" | "expired" {
  if (order.paymentStatus === "paid") return "paid";
  if ((state === "closed" || state === "disabled") && !openAttempt) return "expired";
  return "pending";
}

function amountsOf(order: OrderRow): Amounts {
  return {
    subtotalMinor: order.subtotal,
    shippingMinor: SHIPPING_FEE_MINOR,
    totalMinor: order.total,
    currency: "THB",
  };
}

export function summaryOf(order: OrderRow, paymentStatus: OrderSummary["paymentStatus"]): OrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt.toISOString(),
    paymentStatus,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    shipping: {
      status: order.shippingStatus as "not_shipped" | "shipped",
      carrier: order.carrier,
      trackingId: order.trackingId,
      shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
    },
    amounts: amountsOf(order),
  };
}

type StoredComponent = {
  nameTh?: unknown;
  sizeTh?: unknown;
  colorTh?: unknown;
  quantityPerBundle?: unknown;
};

function itemDto(item: OrderItemRow): OrderItemDto {
  const components = Array.isArray(item.components) ? (item.components as StoredComponent[]) : [];
  return {
    id: item.id,
    kind: item.kind as "single" | "bundle",
    nameTh: item.nameTh,
    sizeTh: item.sizeTh,
    colorTh: item.colorTh,
    quantity: item.quantity,
    unitPriceMinor: item.unitPrice,
    lineTotalMinor: item.lineTotal,
    components: components.map((c) => ({
      nameTh: typeof c.nameTh === "string" ? c.nameTh : "",
      sizeTh: typeof c.sizeTh === "string" ? c.sizeTh : null,
      colorTh: typeof c.colorTh === "string" ? c.colorTh : null,
      quantityPerBundle: typeof c.quantityPerBundle === "number" ? c.quantityPerBundle : 1,
    })),
  };
}

function orderNotFound(): MerchError {
  return new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
}

export async function readOrderDetail(
  ctx: MerchContext,
  orderId: string,
  opts: { ownerId: number | null },
): Promise<OrderDetail> {
  const where =
    opts.ownerId === null
      ? eq(merchOrders.id, orderId)
      : and(eq(merchOrders.id, orderId), eq(merchOrders.buyerUserId, opts.ownerId));
  const [order] = await ctx.db.select().from(merchOrders).where(where).limit(1);
  if (!order) throw orderNotFound();

  const items = await ctx.db
    .select()
    .from(merchOrderItems)
    .where(eq(merchOrderItems.orderId, order.id))
    .orderBy(asc(merchOrderItems.sortOrder), asc(merchOrderItems.id));
  const { row: store, state, now } = await readStore(ctx.db, order.eventId);
  const attempts = await loadAttempts(ctx.db, order.id);
  const payment = derivePaymentView(order, attempts, {
    forOwner: opts.ownerId !== null && opts.ownerId === order.buyerUserId,
    storeState: state,
    now,
    payloadKey: ctx.paysoConfig?.qrPayloadKey ?? null,
    log: ctx.log,
  });

  return {
    ...summaryOf(order, paymentStatusOf(order, state, hasOpenAttempt(attempts, now))),
    buyer: { name: order.buyerName, email: order.buyerEmail, phone: order.buyerPhone },
    recipient: {
      fullName: order.recipientName,
      phone: order.recipientPhone,
      addressLine: order.addressLine,
      subdistrict: order.subdistrict,
      district: order.district,
      province: order.province,
      postalCode: order.postalCode,
      company: order.company,
      deliveryNote: order.deliveryNote,
    },
    items: items.map(itemDto),
    productionInfoTh: store?.productionInfoTh ?? null,
    shippingInfoTh: store?.shippingInfoTh ?? null,
    payment,
  };
}

export async function listBuyerOrders(
  db: MerchDb,
  buyer: Buyer,
  eventId: number,
  page: number,
  limit: number,
): Promise<{ items: OrderSummary[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const where = and(eq(merchOrders.buyerUserId, buyer.id), eq(merchOrders.eventId, eventId));
  const [{ total }] = await db.select({ total: count() }).from(merchOrders).where(where);
  const { state, now } = await readStore(db, eventId);
  const rows = await db
    .select({ order: merchOrders, open: sql<boolean>`${openAttemptExistsSql(merchOrders.id, now)}` })
    .from(merchOrders)
    .where(where)
    .orderBy(desc(merchOrders.createdAt), desc(merchOrders.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return {
    items: rows.map((r) => summaryOf(r.order, paymentStatusOf(r.order, state, r.open))),
    pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
  };
}

/** Thrown inside the confirm transaction to roll it back when another request won the idempotency key. */
class IdempotencyConflict extends Error {}

async function findByKey(db: MerchDb, buyerId: number, key: string): Promise<OrderRow | undefined> {
  const [row] = await db
    .select()
    .from(merchOrders)
    .where(and(eq(merchOrders.buyerUserId, buyerId), eq(merchOrders.idempotencyKey, key)))
    .limit(1);
  return row;
}

async function replay(
  ctx: MerchContext,
  buyer: Buyer,
  existing: OrderRow,
  eventId: number,
  fingerprint: string,
): Promise<{ order: OrderDetail; replayed: boolean }> {
  if (existing.eventId !== eventId || existing.idempotencyFingerprint !== fingerprint) {
    throw new MerchError(
      422,
      "MERCH_IDEMPOTENCY_KEY_REUSED",
      "รหัสคำขอนี้ถูกใช้กับคำสั่งซื้ออื่นแล้ว กรุณาเริ่มทำรายการใหม่",
    );
  }
  return { order: await readOrderDetail(ctx, existing.id, { ownerId: buyer.id }), replayed: true };
}

/**
 * Confirms the buyer's cart as an order (§6.5). Concurrency:
 * - the `merch_stores` row is locked FOR UPDATE, serializing confirms per event;
 * - the idempotency key is re-checked after that lock and before the order number is
 *   taken, so a losing same-key request never consumes a number;
 * - the order insert still uses ON CONFLICT DO NOTHING on (buyer_user_id, idempotency_key)
 *   (covers a same-key request for another event); a conflict rolls the whole transaction
 *   back, so no number gap and no duplicate.
 * The provider is called only after commit.
 */
export async function confirmOrder(
  ctx: MerchContext,
  buyer: Buyer,
  eventCode: string,
  input: { idempotencyKey: string; cartVersion: string; recipient: Recipient },
): Promise<{ order: OrderDetail; replayed: boolean }> {
  const event = await eventByCode(ctx.db, eventCode);
  const fingerprint = fingerprintOf(input.cartVersion, input.recipient);
  const key = input.idempotencyKey;

  const existing = await findByKey(ctx.db, buyer.id, key);
  if (existing) return replay(ctx, buyer, existing, event.id, fingerprint);

  let outcome: { kind: "created"; orderId: string; attemptId: string } | { kind: "exists"; order: OrderRow };
  try {
    outcome = await ctx.db.transaction(async (rawTx) => {
      const tx = asTx(rawTx);
      const [store] = await tx
        .select()
        .from(merchStores)
        .where(eq(merchStores.eventId, event.id))
        .for("update")
        .limit(1);

      const winner = await findByKey(tx, buyer.id, key);
      if (winner) return { kind: "exists" as const, order: winner };

      const now = await dbNow(tx);
      const state = storeState(store ?? null, now);
      if (!store || state !== "open") {
        throw new MerchError(409, "MERCH_PREORDER_CLOSED", "ปิดรับพรีออเดอร์แล้ว");
      }

      // Lock the buyer's cart rows so a concurrent cart edit cannot slip between pricing and deletion.
      await tx
        .select({ id: merchCartItems.id })
        .from(merchCartItems)
        .where(and(eq(merchCartItems.userId, buyer.id), eq(merchCartItems.eventId, event.id)))
        .for("update");
      const priced = await priceCart(tx, buyer, event.id, state);
      if (priced.version !== input.cartVersion) {
        throw new MerchError(409, "MERCH_CART_CHANGED", "ตะกร้ามีการเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง");
      }
      if (priced.lines.length === 0) {
        throw new MerchError(422, "MERCH_CART_EMPTY", "ตะกร้าว่าง");
      }
      const invalid = priced.lines.filter((l) => !l.valid);
      if (invalid.length > 0 || priced.subtotalMinor === null) {
        throw new MerchError(422, "MERCH_CART_INVALID", "มีสินค้าในตะกร้าที่ไม่สามารถสั่งซื้อได้", {
          items: invalid.map((l) => ({ id: l.id, productId: l.productId, issueCodes: l.issueCodes })),
        });
      }
      const subtotal = priced.subtotalMinor;
      const total = subtotal + SHIPPING_FEE_MINOR;

      const seq = store.nextOrderSeq;
      await tx
        .update(merchStores)
        .set({ nextOrderSeq: seq + 1 })
        .where(eq(merchStores.eventId, event.id));

      const r = input.recipient;
      const [order] = await tx
        .insert(merchOrders)
        .values({
          eventId: event.id,
          orderNumber: orderNumberFor(event.eventCode, seq),
          buyerUserId: buyer.id,
          buyerName: buyer.fullName,
          buyerEmail: buyer.email,
          buyerPhone: buyer.phone,
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
          idempotencyKey: key,
          idempotencyFingerprint: fingerprint,
        })
        .onConflictDoNothing({ target: [merchOrders.buyerUserId, merchOrders.idempotencyKey] })
        .returning({ id: merchOrders.id });
      if (!order) throw new IdempotencyConflict();

      await tx.insert(merchOrderItems).values(
        priced.lines.map((l, index) => ({
          orderId: order.id,
          productId: l.productId,
          variantId: l.variantId,
          kind: l.snapshot.kind,
          nameTh: l.snapshot.nameTh,
          sizeTh: l.snapshot.sizeTh,
          colorTh: l.snapshot.colorTh,
          quantity: l.quantity,
          unitPrice: l.unitPriceMinor as number,
          lineTotal: l.lineTotalMinor as number,
          components: l.resolvedComponents.map((c) => ({
            productId: c.productId,
            variantId: c.variantId,
            nameTh: c.nameTh,
            sizeTh: c.sizeTh,
            colorTh: c.colorTh,
            quantityPerBundle: c.quantityPerBundle,
          })),
          sortOrder: index,
        })),
      );

      await tx.delete(merchCartItems).where(
        inArray(
          merchCartItems.id,
          priced.lines.map((l) => l.id),
        ),
      );

      const [attempt] = await tx
        .insert(merchPaymentAttempts)
        .values({
          orderId: order.id,
          referenceNo: sql`'7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0')`,
          amount: total,
          status: "creating",
          requestedAt: sql`clock_timestamp()`,
        })
        .returning({ id: merchPaymentAttempts.id });
      return { kind: "created" as const, orderId: order.id, attemptId: attempt.id };
    });
  } catch (error) {
    if (!(error instanceof IdempotencyConflict)) throw error;
    const winner = await findByKey(ctx.db, buyer.id, key);
    if (!winner) throw error;
    outcome = { kind: "exists", order: winner };
  }

  if (outcome.kind === "exists") return replay(ctx, buyer, outcome.order, event.id, fingerprint);

  await issueQrForAttempt(ctx, outcome.attemptId);
  return { order: await readOrderDetail(ctx, outcome.orderId, { ownerId: buyer.id }), replayed: false };
}
