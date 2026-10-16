import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  merchAuditLog,
  merchEmailOutbox,
  merchOrderItems,
  merchOrders,
  merchPaymentAttempts,
} from "../../database/schema.js";
import { writeAudit } from "./audit.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { paymentStatusOf, readOrderDetail, summaryOf } from "./orders.js";
import { loadAttempts, openAttemptExistsSql, type MerchContext } from "./payments/attempts.js";
import { readStore, type StoreState } from "./store-window.js";
import type { AdminOrderDetail, OrderSummary, PaymentReviewDto } from "./types.js";

const asTx = (tx: unknown) => tx as MerchDb;

const bangkokDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "invalid date");

export const orderFilterSchema = z.object({
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
  createdFrom: bangkokDate.optional(),
  createdTo: bangkokDate.optional(),
  paymentStatus: z.enum(["pending", "paid", "expired"]).optional(),
  shippingStatus: z.enum(["not_shipped", "shipped"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type OrderFilters = z.infer<typeof orderFilterSchema>;

/** Escapes `\`, `%` and `_` so the text matches literally inside `ILIKE ... ESCAPE '\'`. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * WHERE clause for the admin order list (§8.4). Dates are Bangkok calendar days:
 * `createdFrom` 00:00+07 inclusive to `createdTo + 1 day` 00:00+07 exclusive.
 * `expired` = not paid, store `closed`/`disabled` and no open QR (as `paymentStatusOf`).
 */
export function orderFilterSql(
  eventId: number,
  filters: Omit<OrderFilters, "page" | "limit">,
  now: Date,
  storeState: StoreState,
): SQL {
  const parts: SQL[] = [sql`${merchOrders.eventId} = ${eventId}`];
  if (filters.search) {
    const pattern = likePattern(filters.search);
    parts.push(
      sql`(${merchOrders.orderNumber} ILIKE ${pattern} ESCAPE '\\' OR ${merchOrders.buyerName} ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (filters.createdFrom) {
    parts.push(sql`${merchOrders.createdAt} >= (${filters.createdFrom}::date::timestamp AT TIME ZONE 'Asia/Bangkok')`);
  }
  if (filters.createdTo) {
    parts.push(
      sql`${merchOrders.createdAt} < ((${filters.createdTo}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`,
    );
  }
  if (filters.shippingStatus) {
    parts.push(sql`${merchOrders.shippingStatus} = ${filters.shippingStatus}`);
  }
  if (filters.paymentStatus) {
    const canExpire = storeState === "closed" || storeState === "disabled";
    const open = openAttemptExistsSql(merchOrders.id, now);
    if (filters.paymentStatus === "paid") {
      parts.push(sql`${merchOrders.paymentStatus} = 'paid'`);
    } else if (filters.paymentStatus === "pending") {
      parts.push(canExpire ? sql`${merchOrders.paymentStatus} = 'pending' AND ${open}` : sql`${merchOrders.paymentStatus} = 'pending'`);
    } else {
      parts.push(canExpire ? sql`${merchOrders.paymentStatus} = 'pending' AND NOT ${open}` : sql`false`);
    }
  }
  return sql.join(parts, sql` AND `);
}

export type AdminOrderRow = OrderSummary & { buyerName: string; buyerEmail: string; itemsText: string };

type OrderRow = typeof merchOrders.$inferSelect;
type OrderItemRow = typeof merchOrderItems.$inferSelect;

export function optionsText(item: { sizeTh: string | null; colorTh: string | null }): string {
  return [item.sizeTh, item.colorTh].filter((v): v is string => !!v).join("/");
}

export function itemText(item: Pick<OrderItemRow, "nameTh" | "sizeTh" | "colorTh" | "quantity">): string {
  const options = optionsText(item);
  return `${item.nameTh}${options ? ` (${options})` : ""} ×${item.quantity}`;
}

/**
 * Orders matching the list filters (optionally one page) with their items, newest first.
 * Items are fetched by the ids the order query returned, so the two always agree.
 */
export async function queryAdminOrders(
  db: MerchDb,
  eventId: number,
  filters: Omit<OrderFilters, "page" | "limit">,
  paging?: { limit: number; offset: number },
): Promise<{ total: number; rows: { order: OrderRow; items: OrderItemRow[]; row: AdminOrderRow }[] }> {
  const { state, now } = await readStore(db, eventId);
  const where = orderFilterSql(eventId, filters, now, state);
  const [{ total }] = await db.select({ total: count() }).from(merchOrders).where(where);
  const base = db
    .select({ order: merchOrders, open: sql<boolean>`${openAttemptExistsSql(merchOrders.id, now)}` })
    .from(merchOrders)
    .where(where)
    .orderBy(desc(merchOrders.createdAt), desc(merchOrders.id));
  const orders = paging ? await base.limit(paging.limit).offset(paging.offset) : await base;

  const byOrder = new Map<string, OrderItemRow[]>();
  if (orders.length > 0) {
    const items = await db
      .select()
      .from(merchOrderItems)
      .where(
        inArray(
          merchOrderItems.orderId,
          orders.map((r) => r.order.id),
        ),
      )
      .orderBy(asc(merchOrderItems.sortOrder), asc(merchOrderItems.id));
    for (const item of items) {
      const list = byOrder.get(item.orderId) ?? [];
      list.push(item);
      byOrder.set(item.orderId, list);
    }
  }

  return {
    total: Number(total),
    rows: orders.map(({ order, open }) => {
      const items = byOrder.get(order.id) ?? [];
      return {
        order,
        items,
        row: {
          ...summaryOf(order, paymentStatusOf(order, state, open)),
          buyerName: order.buyerName,
          buyerEmail: order.buyerEmail,
          itemsText: items.map(itemText).join(", "),
        },
      };
    }),
  };
}

export async function listAdminOrders(
  db: MerchDb,
  eventId: number,
  filters: OrderFilters,
): Promise<{ items: AdminOrderRow[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const { page, limit } = filters;
  const { total, rows } = await queryAdminOrders(db, eventId, filters, { limit, offset: (page - 1) * limit });
  return {
    items: rows.map((r) => r.row),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

function orderNotFound(): MerchError {
  return new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
}

/** 404 unless the order belongs to the event. */
export async function assertEventOrder(db: MerchDb, eventId: number, orderId: string): Promise<void> {
  const [row] = await db
    .select({ id: merchOrders.id })
    .from(merchOrders)
    .where(and(eq(merchOrders.id, orderId), eq(merchOrders.eventId, eventId)))
    .limit(1);
  if (!row) throw orderNotFound();
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function readAdminOrderDetail(
  ctx: MerchContext,
  eventId: number,
  orderId: string,
): Promise<AdminOrderDetail> {
  const [row] = await ctx.db
    .select({ version: merchOrders.version })
    .from(merchOrders)
    .where(and(eq(merchOrders.id, orderId), eq(merchOrders.eventId, eventId)))
    .limit(1);
  if (!row) throw orderNotFound();
  const base = await readOrderDetail(ctx, orderId, { ownerId: null });
  const attempts = await loadAttempts(ctx.db, orderId);
  const notifications = await ctx.db
    .select()
    .from(merchEmailOutbox)
    .where(eq(merchEmailOutbox.orderId, orderId))
    .orderBy(asc(merchEmailOutbox.createdAt), asc(merchEmailOutbox.id));
  const audit = await ctx.db
    .select()
    .from(merchAuditLog)
    .where(
      and(
        eq(merchAuditLog.eventId, eventId),
        eq(merchAuditLog.entityType, "order"),
        eq(merchAuditLog.entityId, orderId),
      ),
    )
    .orderBy(desc(merchAuditLog.createdAt), desc(merchAuditLog.id));

  return {
    ...base,
    version: row.version,
    attempts: attempts.map((a) => ({
      id: a.id,
      referenceNo: a.referenceNo,
      providerOrderNo: a.providerOrderNo,
      transactionId: a.transactionId,
      amountMinor: a.amount,
      status: a.status,
      requestedAt: a.requestedAt.toISOString(),
      expiresAt: iso(a.expiresAt),
      paidAt: iso(a.paidAt),
      lastCheckAt: iso(a.lastCheckAt),
      lastCheckResult: a.lastCheckResult,
      reviewReason: a.reviewReason,
      reviewResolvedAt: iso(a.reviewResolvedAt),
    })),
    notifications: notifications.map((n) => ({
      type: n.type as "paid" | "shipped",
      status: n.status,
      attempts: n.attempts,
      lastErrorCode: n.lastErrorCode,
      sentAt: iso(n.sentAt),
    })),
    audit: audit.map((a) => ({
      action: a.action,
      actorId: a.actorBackofficeUserId,
      reason: a.reason,
      contactNote: a.contactNote,
      createdAt: a.createdAt.toISOString(),
      before: a.before,
      after: a.after,
    })),
  };
}

// ---- payment reviews ----

export const resolveReviewInput = z.object({ note: z.string().trim().min(1).max(1000) }).strict();
export const reviewListQuery = z.object({
  resolved: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const reviewColumns = {
  attemptId: merchPaymentAttempts.id,
  orderId: merchPaymentAttempts.orderId,
  orderNumber: merchOrders.orderNumber,
  referenceNo: merchPaymentAttempts.referenceNo,
  amount: merchPaymentAttempts.amount,
  reviewReason: merchPaymentAttempts.reviewReason,
  createdAt: merchPaymentAttempts.createdAt,
  resolvedAt: merchPaymentAttempts.reviewResolvedAt,
  note: merchPaymentAttempts.reviewNote,
};

type ReviewRow = {
  attemptId: string;
  orderId: string;
  orderNumber: string;
  referenceNo: string;
  amount: number;
  reviewReason: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  note: string | null;
};

function reviewDto(r: ReviewRow): PaymentReviewDto {
  return {
    attemptId: r.attemptId,
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    referenceNo: r.referenceNo,
    amountMinor: r.amount,
    reviewReason: r.reviewReason ?? "",
    createdAt: r.createdAt.toISOString(),
    resolvedAt: iso(r.resolvedAt),
    note: r.note,
  };
}

export async function listPaymentReviews(db: MerchDb, eventId: number, resolved: boolean): Promise<PaymentReviewDto[]> {
  const rows = await db
    .select(reviewColumns)
    .from(merchPaymentAttempts)
    .innerJoin(merchOrders, eq(merchOrders.id, merchPaymentAttempts.orderId))
    .where(
      and(
        eq(merchOrders.eventId, eventId),
        isNotNull(merchPaymentAttempts.reviewReason),
        resolved ? isNotNull(merchPaymentAttempts.reviewResolvedAt) : isNull(merchPaymentAttempts.reviewResolvedAt),
      ),
    )
    .orderBy(desc(merchPaymentAttempts.createdAt), desc(merchPaymentAttempts.id));
  return rows.map(reviewDto);
}

export async function resolveReview(
  db: MerchDb,
  admin: { id: number },
  eventId: number,
  attemptId: string,
  note: string,
): Promise<PaymentReviewDto> {
  return db.transaction(async (rawTx) => {
    const tx = asTx(rawTx);
    const [row] = await tx
      .select(reviewColumns)
      .from(merchPaymentAttempts)
      .innerJoin(merchOrders, eq(merchOrders.id, merchPaymentAttempts.orderId))
      .where(and(eq(merchPaymentAttempts.id, attemptId), eq(merchOrders.eventId, eventId)))
      .for("update", { of: merchPaymentAttempts })
      .limit(1);
    if (!row || row.reviewReason === null) {
      throw new MerchError(404, "MERCH_REVIEW_NOT_FOUND", "ไม่พบรายการที่รอตรวจสอบ");
    }
    if (row.resolvedAt !== null) {
      throw new MerchError(409, "MERCH_REVIEW_ALREADY_RESOLVED", "รายการนี้ได้รับการตรวจสอบแล้ว");
    }
    const [updated] = await tx
      .update(merchPaymentAttempts)
      .set({
        reviewResolvedAt: sql`clock_timestamp()`,
        reviewResolvedBy: admin.id,
        reviewNote: note,
        updatedAt: sql`now()`,
      })
      .where(eq(merchPaymentAttempts.id, attemptId))
      .returning({ resolvedAt: merchPaymentAttempts.reviewResolvedAt });
    const after = { ...row, resolvedAt: updated.resolvedAt, note };
    await writeAudit(tx, {
      eventId,
      entityType: "payment_attempt",
      entityId: attemptId,
      action: "review.resolve",
      actorId: admin.id,
      reason: note,
      before: { reviewReason: row.reviewReason, resolvedAt: null, note: row.note },
      after: { reviewReason: row.reviewReason, resolvedAt: iso(updated.resolvedAt), note },
    });
    return reviewDto(after);
  });
}
