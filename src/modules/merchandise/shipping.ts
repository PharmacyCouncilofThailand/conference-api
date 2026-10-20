import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { merchEmailOutbox, merchOrders } from "../../database/schema.js";
import { versionConflict } from "./admin-store.js";
import { writeAudit } from "./audit.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { summaryOf } from "./orders.js";
import type { BatchRowResult, OrderSummary } from "./types.js";

const carrierSchema = z.string().trim().min(1).max(100);
const trackingSchema = z.string().trim().min(1).max(100);
const versionSchema = z.number().int().min(1);

export const shipmentInput = z
  .object({
    expectedVersion: versionSchema,
    carrier: carrierSchema,
    trackingId: trackingSchema,
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const bulkShipmentInput = z
  .object({
    rows: z
      .array(
        z
          .object({
            orderId: z.string().uuid(),
            expectedVersion: versionSchema,
            carrier: carrierSchema,
            trackingId: trackingSchema,
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type ShipmentInput = z.infer<typeof shipmentInput>;
export type BulkShipmentRow = z.infer<typeof bulkShipmentInput>["rows"][number];

const asTx = (tx: unknown) => tx as MerchDb;

const shippingSnapshot = (o: typeof merchOrders.$inferSelect) => ({
  shippingStatus: o.shippingStatus,
  carrier: o.carrier,
  trackingId: o.trackingId,
  shippedAt: o.shippedAt ? o.shippedAt.toISOString() : null,
  version: o.version,
});

/**
 * Records or edits an order's shipment (§5.3, §8.4). One transaction, order locked FOR UPDATE.
 * First shipment queues the `shipped` email once; later edits require a reason and send nothing.
 */
export async function setShipment(
  db: MerchDb,
  admin: { id: number },
  eventId: number,
  orderId: string,
  input: { expectedVersion: number; carrier: string; trackingId: string; reason?: string },
): Promise<OrderSummary> {
  const carrier = carrierSchema.parse(input.carrier);
  const trackingId = trackingSchema.parse(input.trackingId);
  const reason = input.reason?.trim() || undefined;
  return db.transaction(async (rawTx) => {
    const tx = asTx(rawTx);
    const [order] = await tx
      .select()
      .from(merchOrders)
      .where(and(eq(merchOrders.id, orderId), eq(merchOrders.eventId, eventId)))
      .for("update")
      .limit(1);
    if (!order) throw new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
    if (order.paymentStatus !== "paid") {
      throw new MerchError(422, "MERCH_ORDER_NOT_PAID", "ออเดอร์ยังไม่ได้ชำระเงิน ไม่สามารถบันทึกการจัดส่งได้");
    }
    if (order.version !== input.expectedVersion) throw versionConflict(order.version);
    const first = order.shippingStatus !== "shipped";
    if (!first && !reason) {
      throw new MerchError(422, "MERCH_REASON_REQUIRED", "การแก้ไขข้อมูลการจัดส่งต้องระบุเหตุผล");
    }

    const [updated] = await tx
      .update(merchOrders)
      .set({
        shippingStatus: "shipped",
        carrier,
        trackingId,
        shippedAt: first ? sql`clock_timestamp()` : order.shippedAt,
        version: sql`${merchOrders.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(merchOrders.id, orderId))
      .returning();

    if (first) {
      await tx.insert(merchEmailOutbox).values({ orderId, type: "shipped" }).onConflictDoNothing();
    }
    await writeAudit(tx, {
      eventId,
      entityType: "order",
      entityId: orderId,
      action: first ? "shipment.set" : "shipment.update",
      actorId: admin.id,
      reason: reason ?? null,
      before: shippingSnapshot(order),
      after: shippingSnapshot(updated),
    });
    return summaryOf(updated, "paid");
  });
}

/** Each row commits in its own transaction; only `MerchError`s are reported per row. */
export async function bulkShipments(
  db: MerchDb,
  admin: { id: number },
  eventId: number,
  rows: BulkShipmentRow[],
): Promise<BatchRowResult[]> {
  if (rows.length > 500) throw new MerchError(400, "VALIDATION_ERROR", "ส่งได้ครั้งละไม่เกิน 500 รายการ");
  const results: BatchRowResult[] = [];
  for (const row of rows) {
    try {
      await setShipment(db, admin, eventId, row.orderId, row);
      results.push({ id: row.orderId, ok: true, code: null, error: null });
    } catch (error) {
      if (!(error instanceof MerchError)) throw error;
      results.push({ id: row.orderId, ok: false, code: error.code, error: error.message });
    }
  }
  return results;
}
