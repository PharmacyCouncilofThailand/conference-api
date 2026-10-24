import { and, eq, sql } from "drizzle-orm";
import { merchEmailOutbox, merchOrders } from "../../database/schema.js";
import { NipaMailTransportError, sendNipaMailHtml } from "../../services/emailService.js";
import { writeAudit } from "./audit.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";
import { readOrderDetail } from "./orders.js";
import type { OrderDetail } from "./types.js";

export type EmailType = "paid" | "shipped";
export type SendMail = (recipient: string, subject: string, html: string) => Promise<unknown>;

/** Per-send NipaMail timeout; a timeout ends as `unknown` (the message may have been sent). */
export const EMAIL_SEND_TIMEOUT_MS = 15_000;

/** Wraps `sendNipaMailHtml` (or a stand-in) so every send has a timeout. */
export function nipaSendWithTimeout(
  sendImpl: (
    recipient: string,
    subject: string,
    html: string,
    retryOnAuth: boolean,
    options: { timeoutMs: number },
  ) => Promise<unknown> = sendNipaMailHtml,
): SendMail {
  return (recipient, subject, html) => sendImpl(recipient, subject, html, true, { timeoutMs: EMAIL_SEND_TIMEOUT_MS });
}

const defaultSendMail: SendMail = nipaSendWithTimeout();

const MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 5;
/** Backoff in minutes after failure number n (attempts after increment), n = 1..4. */
const BACKOFF_MINUTES = [1, 5, 15, 60];

const SUPPORT_COPY =
  "แนะนำให้ถ่ายวิดีโอขณะแกะพัสดุ หากพบปัญหากรุณาติดต่อ pr@pharmacycouncil.org พร้อมแจ้งเลขคำสั่งซื้อและหลักฐาน";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Whole baht to "1,234.00". */
export function formatBaht(baht: number): string {
  return baht.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const e = escapeHtml;

function variantLabel(sizeTh: string | null, colorTh: string | null): string {
  const parts = [sizeTh, colorTh].filter((p): p is string => !!p);
  return parts.length > 0 ? ` (${parts.join(" / ")})` : "";
}

function itemsHtml(order: OrderDetail): string {
  const cell = "padding:8px 10px;border:1px solid #ddd";
  const head = `${cell};background:#f5f5f5;font-weight:bold`;
  const rows = order.items
    .map((item) => {
      const components = item.components
        .map((c) => `<li>${e(c.nameTh)}${e(variantLabel(c.sizeTh, c.colorTh))} x ${c.quantityPerBundle}</li>`)
        .join("");
      return (
        `<tr><td style="${cell}">${e(item.nameTh)}${e(variantLabel(item.sizeTh, item.colorTh))}` +
        `${components ? `<ul style="margin:4px 0 0;padding-left:18px">${components}</ul>` : ""}</td>` +
        `<td style="${cell};text-align:center">${item.quantity}</td>` +
        `<td style="${cell};text-align:right">${formatBaht(item.lineTotalBaht)}</td></tr>`
      );
    })
    .join("");
  return (
    `<table style="width:100%;max-width:560px;border-collapse:collapse">` +
    `<tr><th style="${head};text-align:left">สินค้า</th>` +
    `<th style="${head};text-align:center;width:60px">จำนวน</th>` +
    `<th style="${head};text-align:right;width:100px">ราคา (บาท)</th></tr>${rows}</table>`
  );
}

function recipientHtml(order: OrderDetail): string {
  const r = order.recipient;
  const lines = [
    r.company ? e(r.company) : null,
    e(r.fullName),
    e(r.phone),
    `${e(r.addressLine)} ${e(r.subdistrict)} ${e(r.district)} ${e(r.province)} ${e(r.postalCode)}`,
  ].filter((l): l is string => !!l);
  return `<p>${lines.join("<br>")}</p>`;
}

function wrap(body: string): string {
  return `<div style="font-family:sans-serif;font-size:14px;color:#222">${body}<p>${e(SUPPORT_COPY)}</p></div>`;
}

export function renderPaidEmail(order: OrderDetail): { subject: string; html: string } {
  const html = wrap(
    `<p>เรียน ${e(order.recipient.fullName)}</p>` +
      `<p>เราได้รับการชำระเงินสำหรับคำสั่งซื้อ ${e(order.orderNumber)} เรียบร้อยแล้ว</p>` +
      itemsHtml(order) +
      `<p>ค่าจัดส่ง: ${formatBaht(order.amounts.shippingBaht)} บาท<br>` +
      `ยอดรวมทั้งสิ้น: ${formatBaht(order.amounts.totalBaht)} บาท</p>` +
      `<p><strong>ที่อยู่จัดส่ง</strong></p>${recipientHtml(order)}`,
  );
  return { subject: `ยืนยันการชำระเงิน คำสั่งซื้อ ${order.orderNumber}`, html };
}

export function renderShippedEmail(order: OrderDetail): { subject: string; html: string } {
  const html = wrap(
    `<p>เรียน ${e(order.recipient.fullName)}</p>` +
      `<p>คำสั่งซื้อ ${e(order.orderNumber)} ได้จัดส่งแล้ว</p>` +
      `<p>ขนส่ง: ${e(order.shipping.carrier ?? "-")}<br>` +
      `เลขพัสดุ: ${e(order.shipping.trackingId ?? "-")}</p>` +
      itemsHtml(order) +
      `<p><strong>ที่อยู่จัดส่ง</strong></p>${recipientHtml(order)}`,
  );
  return { subject: `จัดส่งสินค้าแล้ว คำสั่งซื้อ ${order.orderNumber}`, html };
}

type Claimed = { id: string; order_id: string; type: EmailType; attempts: number };

async function markFailed(db: MerchDb, row: Claimed, code: string): Promise<void> {
  const minutes = BACKOFF_MINUTES[row.attempts - 1];
  // next_attempt_at is NOT NULL; once attempts are exhausted the claim query ignores the row.
  await db.execute(sql`
    UPDATE merch_email_outbox
    SET status = 'failed', last_error_code = ${code}, claimed_until = NULL,
        next_attempt_at = ${
          minutes === undefined ? sql`next_attempt_at` : sql`clock_timestamp() + make_interval(mins => ${minutes})`
        },
        updated_at = now()
    WHERE id = ${row.id} AND status = 'sending'`);
}

async function markUnknown(db: MerchDb, row: Claimed, code: string): Promise<void> {
  await db.execute(sql`
    UPDATE merch_email_outbox
    SET status = 'unknown', last_error_code = ${code}, claimed_until = NULL, updated_at = now()
    WHERE id = ${row.id} AND status = 'sending'`);
}

/** §10: claim due rows, send each, record the outcome. Never throws for per-row failures. */
export async function sendDueEmails(
  db: MerchDb,
  send: SendMail = defaultSendMail,
  opts: { limit: number } = { limit: 20 },
): Promise<{ sent: number; failed: number; unknown: number }> {
  await db.execute(sql`
    UPDATE merch_email_outbox
    SET status = 'unknown', last_error_code = 'LEASE_EXPIRED', claimed_until = NULL, updated_at = now()
    WHERE status = 'sending' AND claimed_until < clock_timestamp()`);

  const claimed = (await db.execute(sql`
    UPDATE merch_email_outbox
    SET status = 'sending',
        claimed_until = clock_timestamp() + make_interval(mins => ${LEASE_MINUTES}),
        attempts = attempts + 1,
        updated_at = now()
    WHERE id IN (
      SELECT id FROM merch_email_outbox
      WHERE status IN ('queued', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${opts.limit})
    RETURNING id, order_id, type, attempts`)) as unknown as Claimed[];

  const ctx = { db, payso: null, paysoConfig: null, nodeEnv: "" };
  const result = { sent: 0, failed: 0, unknown: 0 };
  for (const row of claimed) {
    let message: { subject: string; html: string };
    let recipient: string;
    try {
      const order = await readOrderDetail(ctx, row.order_id, { ownerId: null });
      message = row.type === "paid" ? renderPaidEmail(order) : renderShippedEmail(order);
      recipient = order.buyer.email;
    } catch {
      await markFailed(db, row, "RENDER_FAILED");
      result.failed += 1;
      continue;
    }
    try {
      await send(recipient, message.subject, message.html);
    } catch (error) {
      if (error instanceof NipaMailTransportError && error.deliveryState === "failed") {
        await markFailed(db, row, error.code);
        result.failed += 1;
      } else {
        await markUnknown(db, row, error instanceof NipaMailTransportError ? error.code : "SEND_UNKNOWN");
        result.unknown += 1;
      }
      continue;
    }
    await db.execute(sql`
      UPDATE merch_email_outbox
      SET status = 'sent', sent_at = clock_timestamp(), last_error_code = NULL, claimed_until = NULL, updated_at = now()
      WHERE id = ${row.id} AND status = 'sending'`);
    result.sent += 1;
  }
  return result;
}

/** Admin resend (§10): only `failed` or `unknown` notifications go back to `queued`. */
export async function resendNotification(
  db: MerchDb,
  admin: { id: number },
  eventId: number,
  orderId: string,
  type: EmailType,
  reason: string,
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as MerchDb;
    const [order] = await tx
      .select({ id: merchOrders.id })
      .from(merchOrders)
      .where(and(eq(merchOrders.id, orderId), eq(merchOrders.eventId, eventId)))
      .limit(1);
    if (!order) throw new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
    const [row] = await tx
      .select()
      .from(merchEmailOutbox)
      .where(and(eq(merchEmailOutbox.orderId, orderId), eq(merchEmailOutbox.type, type)))
      .for("update")
      .limit(1);
    if (!row) throw new MerchError(404, "MERCH_NOTIFICATION_NOT_FOUND", "ไม่พบการแจ้งเตือนนี้");
    if (row.status !== "failed" && row.status !== "unknown") {
      throw new MerchError(409, "MERCH_NOTIFICATION_NOT_RESENDABLE", "ไม่สามารถส่งอีเมลนี้ซ้ำได้ในสถานะปัจจุบัน");
    }
    await tx
      .update(merchEmailOutbox)
      .set({
        status: "queued",
        attempts: 0,
        nextAttemptAt: sql`clock_timestamp()`,
        claimedUntil: null,
        updatedAt: sql`now()`,
      })
      .where(eq(merchEmailOutbox.id, row.id));
    await writeAudit(tx, {
      eventId,
      entityType: "order",
      entityId: orderId,
      action: "notification.resend",
      actorId: admin.id,
      reason,
      before: { type, status: row.status, attempts: row.attempts, lastErrorCode: row.lastErrorCode },
      after: { type, status: "queued" },
    });
  });
}
