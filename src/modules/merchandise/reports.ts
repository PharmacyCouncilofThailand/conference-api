import { asc, desc, eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { events, merchOrderItems, merchOrders } from "../../database/schema.js";
import { orderFilterSql, type AdminOrderRow, type OrderFilters } from "./admin-orders.js";
import type { MerchDb } from "./db.js";
import { itemDto, paymentStatusOf, summaryOf } from "./orders.js";
import { openAttemptExistsSql } from "./payments/attempts.js";
import { readStore } from "./store-window.js";
import type { OrderItemDto, ProductionRow, Recipient } from "./types.js";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Text cell content: a leading `= + - @` would be read as a formula, so prefix `'` (§11). */
export function safeCell(value: string | null): string {
  if (value === null || value === undefined) return "";
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** `YYYY-MM-DD HH:mm` in Bangkok time (UTC+7, no DST); text so it reads the same everywhere. */
function bangkokText(iso: string | null): string {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

const baht = (minor: number) => minor / 100;

export async function eventCodeOf(db: MerchDb, eventId: number): Promise<string> {
  const [row] = await db.select({ code: events.eventCode }).from(events).where(eq(events.id, eventId)).limit(1);
  return row?.code ?? String(eventId);
}

/** Event code reduced to characters that are safe inside a quoted `filename=`. */
export function exportFilename(kind: "orders" | "production", eventCode: string): string {
  return `merch-${kind}-${eventCode.replace(/[^A-Za-z0-9._-]/g, "_")}.xlsx`;
}

// ---- orders ----

export type OrderReportRow = {
  order: AdminOrderRow;
  buyerPhone: string | null;
  recipient: Recipient;
  items: OrderItemDto[];
};

function optionsText(i: { sizeTh: string | null; colorTh: string | null }): string {
  return [i.sizeTh, i.colorTh].filter((v): v is string => !!v).join("/");
}

function componentsText(item: OrderItemDto): string {
  return item.components
    .map((c) => {
      const options = optionsText(c);
      return `${c.nameTh}${options ? ` (${options})` : ""} ×${c.quantityPerBundle}`;
    })
    .join(", ");
}

/** Every order matching the admin list filters (page/limit ignored), newest first. */
export async function orderReportRows(
  db: MerchDb,
  eventId: number,
  filters: Omit<OrderFilters, "page" | "limit">,
): Promise<OrderReportRow[]> {
  const { state, now } = await readStore(db, eventId);
  const where = orderFilterSql(eventId, filters, now, state);
  const orders = await db
    .select({ order: merchOrders, open: sql<boolean>`${openAttemptExistsSql(merchOrders.id, now)}` })
    .from(merchOrders)
    .where(where)
    .orderBy(desc(merchOrders.createdAt), desc(merchOrders.id));
  const items = await db
    .select({ item: merchOrderItems })
    .from(merchOrderItems)
    .innerJoin(merchOrders, eq(merchOrders.id, merchOrderItems.orderId))
    .where(where)
    .orderBy(asc(merchOrderItems.sortOrder), asc(merchOrderItems.id));
  const byOrder = new Map<string, OrderItemDto[]>();
  for (const { item } of items) {
    const list = byOrder.get(item.orderId) ?? [];
    list.push(itemDto(item));
    byOrder.set(item.orderId, list);
  }

  return orders.map(({ order, open }) => {
    const dtos = byOrder.get(order.id) ?? [];
    return {
      order: {
        ...summaryOf(order, paymentStatusOf(order, state, open)),
        buyerName: order.buyerName,
        buyerEmail: order.buyerEmail,
        itemsText: dtos
          .map((i) => `${i.nameTh}${optionsText(i) ? ` (${optionsText(i)})` : ""} ×${i.quantity}`)
          .join(", "),
      },
      buyerPhone: order.buyerPhone,
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
      items: dtos,
    };
  });
}

const PAYMENT_TH = { pending: "รอชำระ", paid: "ชำระแล้ว", expired: "หมดเวลา" } as const;
const SHIPPING_TH = { not_shipped: "ยังไม่จัดส่ง", shipped: "จัดส่งแล้ว" } as const;

function fullAddress(r: Recipient): string {
  return [r.company, r.addressLine, r.subdistrict, r.district, r.province, r.postalCode]
    .filter((v): v is string => !!v)
    .join(" ");
}

function styleSheet(ws: ExcelJS.Worksheet, widths: number[]) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

/** Adds a row of text cells, forced to string type so leading zeros survive. */
function addTextRow(ws: ExcelJS.Worksheet, values: (string | number)[], numeric: Set<number> = new Set()) {
  const row = ws.addRow(values);
  values.forEach((v, i) => {
    const cell = row.getCell(i + 1);
    if (typeof v === "string") {
      cell.value = v;
      cell.numFmt = "@";
    } else if (numeric.has(i)) {
      cell.numFmt = "#,##0.00";
    }
  });
}

export async function buildOrdersWorkbook(rows: OrderReportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const orders = wb.addWorksheet("ออเดอร์");
  orders.addRow([
    "เลขออเดอร์", "วันที่สร้าง", "ผู้ซื้อ", "อีเมล", "โทร", "ผู้รับ", "ที่อยู่เต็ม",
    "ค่าสินค้า", "ค่าส่ง", "ยอดรวม", "สถานะชำระ", "วันที่ชำระ", "สถานะส่ง", "ขนส่ง", "Tracking", "วันที่จัดส่ง",
  ]);
  const money = new Set([7, 8, 9]);
  for (const { order, buyerPhone, recipient } of rows) {
    addTextRow(
      orders,
      [
        safeCell(order.orderNumber),
        bangkokText(order.createdAt),
        safeCell(order.buyerName),
        safeCell(order.buyerEmail),
        safeCell(buyerPhone),
        safeCell(recipient.fullName),
        safeCell(fullAddress(recipient)),
        baht(order.amounts.subtotalMinor),
        baht(order.amounts.shippingMinor),
        baht(order.amounts.totalMinor),
        PAYMENT_TH[order.paymentStatus],
        bangkokText(order.paidAt),
        SHIPPING_TH[order.shipping.status],
        safeCell(order.shipping.carrier),
        safeCell(order.shipping.trackingId),
        bangkokText(order.shipping.shippedAt),
      ],
      money,
    );
  }
  styleSheet(orders, [22, 18, 22, 28, 14, 22, 50, 12, 10, 12, 14, 18, 14, 14, 18, 18]);

  const lines = wb.addWorksheet("รายการสินค้า");
  lines.addRow(["เลขออเดอร์", "สินค้า", "ไซซ์", "สี", "จำนวน", "ราคาต่อหน่วย", "รวม", "ส่วนประกอบ Bundle"]);
  for (const { order, items } of rows) {
    for (const item of items) {
      addTextRow(
        lines,
        [
          safeCell(order.orderNumber),
          safeCell(item.nameTh),
          safeCell(item.sizeTh),
          safeCell(item.colorTh),
          item.quantity,
          baht(item.unitPriceMinor),
          baht(item.lineTotalMinor),
          safeCell(componentsText(item)),
        ],
        new Set([5, 6]),
      );
    }
  }
  styleSheet(lines, [22, 30, 10, 12, 8, 14, 12, 50]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- production ----

type ProductionSqlRow = {
  product_id: string;
  name_th: string;
  size_th: string | null;
  color_th: string | null;
  single_quantity: number;
  bundle_quantity: number;
};

/**
 * Paid orders only (§11): singles count `quantity`; bundles expand `components` into
 * `quantity × quantityPerBundle`. Groups by snapshot (product, size, colour); the name is the
 * newest snapshot's. `COLLATE "C"` keeps the ordering independent of the database locale.
 */
export async function productionRows(db: MerchDb, eventId: number): Promise<ProductionRow[]> {
  const result = (await db.execute(sql`
    WITH paid_items AS (
      SELECT i.kind, i.product_id, i.name_th, i.size_th, i.color_th, i.quantity, i.components, o.created_at
      FROM merch_order_items i
      JOIN merch_orders o ON o.id = i.order_id
      WHERE o.event_id = ${eventId} AND o.payment_status = 'paid'
    ),
    lines AS (
      SELECT product_id, name_th, size_th, color_th, quantity AS single_quantity, 0 AS bundle_quantity, created_at
      FROM paid_items WHERE kind = 'single'
      UNION ALL
      SELECT (c.value ->> 'productId')::uuid, c.value ->> 'nameTh',
             NULLIF(c.value ->> 'sizeTh', ''), NULLIF(c.value ->> 'colorTh', ''),
             0, p.quantity * COALESCE((c.value ->> 'quantityPerBundle')::int, 1), p.created_at
      FROM paid_items p
      CROSS JOIN LATERAL jsonb_array_elements(p.components) AS c(value)
      WHERE p.kind = 'bundle'
    )
    SELECT product_id, (array_agg(name_th ORDER BY created_at DESC))[1] AS name_th, size_th, color_th,
           SUM(single_quantity)::int AS single_quantity, SUM(bundle_quantity)::int AS bundle_quantity
    FROM lines
    GROUP BY product_id, size_th, color_th
    ORDER BY (array_agg(name_th ORDER BY created_at DESC))[1] COLLATE "C",
             size_th COLLATE "C" NULLS FIRST, color_th COLLATE "C" NULLS FIRST`)) as unknown as ProductionSqlRow[];
  return result.map((r) => ({
    productId: r.product_id,
    nameTh: r.name_th,
    sizeTh: r.size_th,
    colorTh: r.color_th,
    singleQuantity: r.single_quantity,
    bundleQuantity: r.bundle_quantity,
    totalQuantity: r.single_quantity + r.bundle_quantity,
  }));
}

export async function buildProductionWorkbook(rows: ProductionRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ยอดผลิต");
  ws.addRow(["สินค้า", "ไซซ์", "สี", "ขายแยก", "ในชุด Bundle", "รวมผลิต"]);
  for (const r of rows) {
    addTextRow(ws, [safeCell(r.nameTh), safeCell(r.sizeTh), safeCell(r.colorTh), r.singleQuantity, r.bundleQuantity, r.totalQuantity]);
  }
  styleSheet(ws, [30, 10, 12, 10, 14, 10]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
