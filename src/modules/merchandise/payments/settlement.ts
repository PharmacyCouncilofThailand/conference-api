import { and, eq, sql } from "drizzle-orm";
import {
  merchEmailOutbox,
  merchOrders,
  merchPaymentAttempts,
  merchPaymentEvents,
  merchStores,
} from "../../../database/schema.js";
import type { MerchDb } from "../db.js";
import { MerchError } from "../errors.js";
import { dbNow, readStore, storeState } from "../store-window.js";
import type { PaymentView } from "../types.js";
import {
  buildPaymentView,
  hasOpenAttempt,
  issueQrForAttempt,
  loadAttempts,
  logMerchError,
  type MerchContext,
} from "./attempts.js";
import type { InquiryEvidence, InquiryResult } from "./payso-client.js";
import { isTestMarker } from "./payso-parse.js";

export type SettlementOutcome = "settled" | "duplicate" | "review" | "noop" | "recorded";

const asTx = (tx: unknown) => tx as MerchDb;

const CHECK_COALESCE_SECONDS = 5;
const VERIFYING_WINDOW_SECONDS = 120;
const CHECKABLE_STATUSES = new Set(["active", "expired", "create_unknown"]);

function unavailable(): MerchError {
  return new MerchError(503, "MERCH_PAYMENT_UNAVAILABLE", "ระบบชำระเงินยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง");
}

function orderNotFound(): MerchError {
  return new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
}

/** Only the fields §14 allows in `merch_payment_events.sanitized`. */
function sanitizedEvidence(evidence: InquiryEvidence, reason?: string): Record<string, unknown> {
  return {
    referenceNo: evidence.referenceNo,
    orderNo: evidence.orderNo,
    merchantId: evidence.merchantId,
    status: evidence.status,
    totalBaht: evidence.totalBaht,
    currencyCode: evidence.currencyCode,
    paidAt: evidence.paidAt ? evidence.paidAt.toISOString() : null,
    fieldNames: evidence.fieldNames,
    ...(reason ? { reason } : {}),
  };
}

/** Defense in depth for N5: a test status never settles outside development/test. */
function guardTestStatus(ctx: MerchContext, result: InquiryResult): InquiryResult {
  if (result.kind !== "paid" || !isTestMarker(result.evidence)) return result;
  const env = ctx.nodeEnv.trim().toLowerCase();
  if (env === "development" || env === "test") return result;
  return { kind: "mismatch", reason: "test_status_in_production", evidence: result.evidence };
}

/**
 * Applies one inquiry result to an attempt (§7.4). One transaction; the order row is locked
 * FOR UPDATE first, then the attempt row (the same order everywhere, so no deadlock).
 * - attempt already `paid` → `noop` (idempotent)
 * - `paid` on an attempt with an unresolved review → recorded, still held for review → `review`
 * - `paid` while the order is pending but its total no longer equals the attempt amount
 *   (admin edit after the QR was issued) → `amount_mismatch` review, nothing settled → `review`
 * - `paid` and order pending → attempt + order paid, payload removed, outbox `paid` queued → `settled`
 * - `paid` and order paid by another attempt → attempt paid + `duplicate_payment` review → `duplicate`
 * - `mismatch` → review reason set, order untouched → `review`
 * - anything else → check bookkeeping only → `recorded`
 * Accepted regardless of store state or QR expiry.
 */
export async function applyInquiryResult(
  ctx: MerchContext,
  attemptId: string,
  rawResult: InquiryResult,
  seen: { at: Date; source: "inquiry" | "postback" },
): Promise<SettlementOutcome> {
  const result = guardTestStatus(ctx, rawResult);
  return ctx.db.transaction(async (rawTx) => {
    const tx = asTx(rawTx);
    const [ref] = await tx
      .select({ orderId: merchPaymentAttempts.orderId })
      .from(merchPaymentAttempts)
      .where(eq(merchPaymentAttempts.id, attemptId))
      .limit(1);
    if (!ref) return "noop";
    const [order] = await tx
      .select({
        id: merchOrders.id,
        paymentStatus: merchOrders.paymentStatus,
        paidAttemptId: merchOrders.paidAttemptId,
        total: merchOrders.total,
      })
      .from(merchOrders)
      .where(eq(merchOrders.id, ref.orderId))
      .for("update")
      .limit(1);
    const [attempt] = await tx
      .select()
      .from(merchPaymentAttempts)
      .where(eq(merchPaymentAttempts.id, attemptId))
      .for("update")
      .limit(1);
    if (!order || !attempt) return "noop";

    if (result.kind === "paid" || result.kind === "mismatch" || result.kind === "not_paid_status") {
      await tx.insert(merchPaymentEvents).values({
        attemptId,
        kind: "inquiry",
        referenceNo: attempt.referenceNo,
        receivedAt: seen.at,
        sanitized: sanitizedEvidence(result.evidence, result.kind === "mismatch" ? result.reason : undefined),
        result: result.kind,
      });
    }

    if (attempt.status === "paid") return "noop";

    const checked = {
      lastCheckAt: sql`clock_timestamp()`,
      lastCheckResult: result.kind,
      checkCount: sql`${merchPaymentAttempts.checkCount} + 1`,
      updatedAt: sql`now()`,
    };
    const whereAttempt = eq(merchPaymentAttempts.id, attemptId);

    const holdForReview = async (reason: string | null, evidence: InquiryEvidence) => {
      await tx
        .update(merchPaymentAttempts)
        .set({
          reviewReason: reason === null ? merchPaymentAttempts.reviewReason : sql`coalesce(${merchPaymentAttempts.reviewReason}, ${reason})`,
          providerOrderNo: evidence.orderNo ?? attempt.providerOrderNo,
          transactionId: evidence.transactionId ?? attempt.transactionId,
          nextCheckAt: null,
          ...checked,
        })
        .where(whereAttempt);
    };

    if (result.kind === "paid") {
      const evidence = result.evidence;
      // An attempt already held for review never settles automatically (record only).
      if (attempt.reviewReason !== null && attempt.reviewResolvedAt === null) {
        await holdForReview(null, evidence);
        return "review";
      }
      // The order total changed after this QR was issued (§6.6 accepted limitation).
      if (order.paymentStatus !== "paid" && attempt.amount !== order.total) {
        await holdForReview("amount_mismatch", evidence);
        return "review";
      }
      let paidAt: Date;
      let paidAtSource: "provider" | "first_seen";
      if (evidence.paidAt) {
        paidAt = evidence.paidAt;
        paidAtSource = "provider";
      } else {
        const [first] = await tx
          .select({ at: sql<Date | string | null>`min(${merchPaymentEvents.receivedAt})` })
          .from(merchPaymentEvents)
          .where(and(eq(merchPaymentEvents.attemptId, attemptId), eq(merchPaymentEvents.kind, "postback")));
        const postbackAt = first?.at ? new Date(first.at) : null;
        paidAt = postbackAt && postbackAt.getTime() < seen.at.getTime() ? postbackAt : seen.at;
        paidAtSource = "first_seen";
      }
      const paidFields = {
        status: "paid",
        qrPayloadEnc: null,
        paidAt,
        paidAtSource,
        providerOrderNo: evidence.orderNo ?? attempt.providerOrderNo,
        transactionId: evidence.transactionId ?? attempt.transactionId,
        nextCheckAt: null,
        ...checked,
      };

      if (order.paymentStatus === "paid" && order.paidAttemptId !== attemptId) {
        await tx
          .update(merchPaymentAttempts)
          .set({ ...paidFields, reviewReason: "duplicate_payment" })
          .where(whereAttempt);
        return "duplicate";
      }

      await tx.update(merchPaymentAttempts).set(paidFields).where(whereAttempt);
      if (order.paymentStatus !== "paid") {
        await tx
          .update(merchOrders)
          .set({ paymentStatus: "paid", paidAt, paidAtSource, paidAttemptId: attemptId, updatedAt: sql`now()` })
          .where(eq(merchOrders.id, order.id));
      }
      await tx.insert(merchEmailOutbox).values({ orderId: order.id, type: "paid" }).onConflictDoNothing();
      return "settled";
    }

    if (result.kind === "mismatch") {
      await holdForReview(result.reason, result.evidence);
      return "review";
    }

    await tx.update(merchPaymentAttempts).set(checked).where(whereAttempt);
    return "recorded";
  });
}

/**
 * Inquires every unfinished attempt of the order (`active`, `expired`, `create_unknown`
 * without a review) and applies each result (§7.6). Coalesced: when any attempt of the
 * order was checked less than 5 seconds ago (DB time) the provider is not called and the
 * stored results are reported instead.
 */
export async function checkOrderPayments(ctx: MerchContext, orderId: string): Promise<{ anyError: boolean }> {
  const attempts = await loadAttempts(ctx.db, orderId);
  const candidates = attempts.filter((a) => CHECKABLE_STATUSES.has(a.status) && a.reviewReason === null);
  if (candidates.length === 0) return { anyError: false };

  const rows = (await ctx.db.execute(sql`
    SELECT coalesce(max(last_check_at) > clock_timestamp() - make_interval(secs => ${CHECK_COALESCE_SECONDS}), false) AS recent
    FROM merch_payment_attempts WHERE order_id = ${orderId}`)) as unknown as Array<{ recent: boolean }>;
  if (rows[0]?.recent) {
    return { anyError: candidates.some((a) => a.lastCheckResult === "error") };
  }

  const payso = ctx.payso;
  if (!payso) throw unavailable();
  let anyError = false;
  for (const attempt of candidates) {
    let result: InquiryResult;
    try {
      result = await payso.inquire(attempt.referenceNo, attempt.amount);
    } catch (error) {
      logMerchError(ctx.log, error, "merchandise inquiry failed");
      result = { kind: "error", code: "INQUIRY_CLIENT_ERROR" };
    }
    if (result.kind === "error") anyError = true;
    await applyInquiryResult(ctx, attempt.id, result, { at: await dbNow(ctx.db), source: "inquiry" });
  }
  return { anyError };
}

async function loadOrder(db: MerchDb, orderId: string) {
  const [order] = await db
    .select({ id: merchOrders.id, eventId: merchOrders.eventId, paymentStatus: merchOrders.paymentStatus })
    .from(merchOrders)
    .where(eq(merchOrders.id, orderId))
    .limit(1);
  if (!order) throw orderNotFound();
  return order;
}

/** The owner's payment view, read from the DB only. */
export async function ownerPaymentView(ctx: MerchContext, orderId: string): Promise<PaymentView> {
  const order = await loadOrder(ctx.db, orderId);
  const { state, now } = await readStore(ctx.db, order.eventId);
  return buildPaymentView(ctx.db, orderId, {
    forOwner: true,
    storeState: state,
    now,
    payloadKey: ctx.paysoConfig?.qrPayloadKey ?? null,
    log: ctx.log,
  });
}

/**
 * Issues a new QR on the same order (§7.6 steps 1–4). The caller has verified ownership.
 * The provider is inquired outside any lock; the new attempt is inserted under the order
 * lock after re-checking, and `createQr` runs after commit.
 */
export async function requestNewQr(ctx: MerchContext, orderId: string): Promise<PaymentView> {
  const order = await loadOrder(ctx.db, orderId);
  if (order.paymentStatus === "paid") return ownerPaymentView(ctx, orderId);
  if (!ctx.payso || !ctx.paysoConfig) throw unavailable();

  if (hasOpenAttempt(await loadAttempts(ctx.db, orderId), await dbNow(ctx.db))) {
    return ownerPaymentView(ctx, orderId);
  }

  const { anyError } = await checkOrderPayments(ctx, orderId);
  const checked = await loadOrder(ctx.db, orderId);
  if (checked.paymentStatus === "paid") return ownerPaymentView(ctx, orderId);
  if (anyError) {
    throw new MerchError(503, "MERCH_PAYMENT_CHECK_FAILED", "ตรวจสอบการชำระเงินไม่สำเร็จ กรุณาลองอีกครั้ง");
  }
  const attempts = await loadAttempts(ctx.db, orderId);
  if (attempts.some((a) => a.reviewReason !== null && a.reviewResolvedAt === null)) {
    return ownerPaymentView(ctx, orderId);
  }

  const now = await dbNow(ctx.db);
  const lastShown = attempts.find((a) => (a.status === "active" || a.status === "expired") && a.expiresAt !== null);
  if (lastShown?.expiresAt) {
    const sinceExpiry = (now.getTime() - lastShown.expiresAt.getTime()) / 1000;
    if (sinceExpiry < VERIFYING_WINDOW_SECONDS) {
      throw new MerchError(409, "MERCH_PAYMENT_VERIFYING", "กำลังตรวจสอบการชำระ กรุณารอสักครู่", {
        retryAfterSeconds: Math.max(1, Math.ceil(VERIFYING_WINDOW_SECONDS - sinceExpiry)),
      });
    }
  }

  const closed = () => new MerchError(409, "MERCH_PREORDER_CLOSED", "ปิดรับพรีออเดอร์แล้ว");
  const { state } = await readStore(ctx.db, order.eventId);
  if (state !== "open") throw closed();

  const newAttemptId = await ctx.db.transaction(async (rawTx) => {
    const tx = asTx(rawTx);
    const [locked] = await tx
      .select({ paymentStatus: merchOrders.paymentStatus, total: merchOrders.total })
      .from(merchOrders)
      .where(eq(merchOrders.id, orderId))
      .for("update")
      .limit(1);
    if (!locked || locked.paymentStatus === "paid") return null;
    const [store] = await tx.select().from(merchStores).where(eq(merchStores.eventId, order.eventId)).limit(1);
    const txNow = await dbNow(tx);
    if (storeState(store ?? null, txNow) !== "open") throw closed();
    if (hasOpenAttempt(await loadAttempts(tx, orderId), txNow)) return null;

    await tx
      .update(merchPaymentAttempts)
      .set({ status: "expired", qrPayloadEnc: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(merchPaymentAttempts.orderId, orderId),
          eq(merchPaymentAttempts.status, "active"),
          sql`${merchPaymentAttempts.expiresAt} <= clock_timestamp()`,
        ),
      );
    const [attempt] = await tx
      .insert(merchPaymentAttempts)
      .values({
        orderId,
        referenceNo: sql`'7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0')`,
        amount: locked.total,
        status: "creating",
        requestedAt: sql`clock_timestamp()`,
      })
      .returning({ id: merchPaymentAttempts.id });
    return attempt.id;
  });

  if (newAttemptId) await issueQrForAttempt(ctx, newAttemptId);
  return ownerPaymentView(ctx, orderId);
}
