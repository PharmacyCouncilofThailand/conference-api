import { desc, eq, sql, and } from "drizzle-orm";
import { merchOrders, merchPaymentAttempts } from "../../../database/schema.js";
import type { MerchDb } from "../db.js";
import { MerchError } from "../errors.js";
import { dbNow, type StoreState } from "../store-window.js";
import type { MerchRouteOptions, PaymentView } from "../types.js";
import { decryptPayload, encryptPayload } from "./payload-crypto.js";
import type { CreateQrResult, PaysoClient, PaysoConfig } from "./payso-client.js";
import { computeExpiresAt, productDetailFor, sanitizeProviderText } from "./payso-parse.js";

export interface MerchContext {
  db: MerchDb;
  payso: PaysoClient | null;
  paysoConfig: PaysoConfig | null;
  nodeEnv: string;
}

export function contextFrom(options: MerchRouteOptions): MerchContext {
  return {
    db: options.database,
    payso: options.payso,
    paysoConfig: options.paysoConfig,
    nodeEnv: options.nodeEnv,
  };
}

const QR_LIFETIME_MS = 10 * 60_000;
const VERIFYING_WINDOW_MS = 120_000;
const ACTIVE_CHECK_INTERVAL_MS = 60_000;

type AttemptRow = typeof merchPaymentAttempts.$inferSelect;

/**
 * Asks the provider for a QR for a `creating` attempt and records the outcome (§7.1).
 * The provider call runs outside any transaction; every write is guarded by
 * `status = 'creating'` so a concurrent change to the attempt is never overwritten.
 */
export async function issueQrForAttempt(ctx: MerchContext, attemptId: string): Promise<void> {
  const [row] = await ctx.db
    .select({
      attempt: merchPaymentAttempts,
      orderNumber: merchOrders.orderNumber,
      buyerName: merchOrders.buyerName,
      buyerEmail: merchOrders.buyerEmail,
    })
    .from(merchPaymentAttempts)
    .innerJoin(merchOrders, eq(merchOrders.id, merchPaymentAttempts.orderId))
    .where(eq(merchPaymentAttempts.id, attemptId))
    .limit(1);
  if (!row || row.attempt.status !== "creating") return;

  const whereCreating = and(eq(merchPaymentAttempts.id, attemptId), eq(merchPaymentAttempts.status, "creating"));

  if (!ctx.payso || !ctx.paysoConfig) {
    await ctx.db
      .update(merchPaymentAttempts)
      .set({ status: "create_failed", failureCode: "PAYMENT_NOT_CONFIGURED", updatedAt: sql`now()` })
      .where(whereCreating);
    return;
  }

  const requestedAt = await dbNow(ctx.db);
  let result: CreateQrResult;
  try {
    result = await ctx.payso.createQr({
      referenceNo: row.attempt.referenceNo,
      amountMinor: row.attempt.amount,
      productDetail: productDetailFor(row.orderNumber),
      customerName: sanitizeProviderText(row.buyerName, 100),
      customerEmail: row.buyerEmail,
    });
  } catch {
    result = { kind: "unknown", code: "QR_CLIENT_ERROR" };
  }

  if (result.kind === "issued") {
    const issued = result;
    let encrypted: Buffer | null = null;
    try {
      encrypted = encryptPayload(issued.payload, ctx.paysoConfig.qrPayloadKey);
    } catch {
      result = { kind: "unknown", code: "QR_PAYLOAD_KEY_INVALID" };
    }
    if (encrypted) {
      const { expiresAt, fallback } = computeExpiresAt({
        createdRaw: issued.createdRaw,
        expiresRaw: issued.expiresRaw,
        requestedAt,
      });
      await ctx.db
        .update(merchPaymentAttempts)
        .set({
          status: "active",
          qrPayloadEnc: encrypted,
          providerOrderNo: issued.providerOrderNo,
          providerCreatedRaw: issued.createdRaw,
          providerExpiresRaw: issued.expiresRaw,
          requestedAt,
          expiresAt,
          failureCode: fallback ? "EXPIRY_FALLBACK" : null,
          nextCheckAt: new Date(requestedAt.getTime() + ACTIVE_CHECK_INTERVAL_MS),
          updatedAt: sql`now()`,
        })
        .where(whereCreating);
      return;
    }
  }

  if (result.kind === "definitive_failure") {
    await ctx.db
      .update(merchPaymentAttempts)
      .set({ status: "create_failed", failureCode: result.code, requestedAt, updatedAt: sql`now()` })
      .where(whereCreating);
    return;
  }

  if (result.kind === "unknown") {
    await ctx.db
      .update(merchPaymentAttempts)
      .set({
        status: "create_unknown",
        failureCode: result.code,
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + QR_LIFETIME_MS),
        nextCheckAt: sql`clock_timestamp()`,
        updatedAt: sql`now()`,
      })
      .where(whereCreating);
  }
}

function attemptDto(attempt: AttemptRow, qrPayload: string | null): NonNullable<PaymentView["attempt"]> {
  return {
    id: attempt.id,
    referenceNo: attempt.referenceNo,
    expiresAt: attempt.expiresAt ? attempt.expiresAt.toISOString() : null,
    qrPayload,
  };
}

function isOpenAttempt(attempt: AttemptRow, now: Date): boolean {
  if (attempt.status === "creating") return true;
  return attempt.status === "active" && attempt.expiresAt !== null && attempt.expiresAt.getTime() > now.getTime();
}

/** True when the order has an attempt being created or an active QR that has not expired. */
export function hasOpenAttempt(attempts: AttemptRow[], now: Date): boolean {
  return attempts.some((a) => isOpenAttempt(a, now));
}

export async function loadAttempts(db: MerchDb, orderId: string): Promise<AttemptRow[]> {
  return db
    .select()
    .from(merchPaymentAttempts)
    .where(eq(merchPaymentAttempts.orderId, orderId))
    .orderBy(desc(merchPaymentAttempts.createdAt), desc(merchPaymentAttempts.id));
}

/** Pure state derivation for §7.5; `attempts` newest first. */
export function derivePaymentView(
  order: { paymentStatus: string; paidAttemptId: string | null },
  attempts: AttemptRow[],
  opts: { forOwner: boolean; storeState: StoreState; now: Date; payloadKey: string | null },
): PaymentView {
  const { now } = opts;
  const storeOpen = opts.storeState === "open";
  const view = (
    state: PaymentView["state"],
    attempt: AttemptRow | undefined,
    flags: { canRequestNewQr?: boolean; canCheck?: boolean; retryAfterSeconds?: number | null; qrPayload?: string | null },
  ): PaymentView => ({
    state,
    attempt: attempt ? attemptDto(attempt, flags.qrPayload ?? null) : null,
    canRequestNewQr: flags.canRequestNewQr ?? false,
    canCheck: flags.canCheck ?? false,
    retryAfterSeconds: flags.retryAfterSeconds ?? null,
    serverNow: now.toISOString(),
  });

  if (order.paymentStatus === "paid") {
    const paid = attempts.find((a) => a.id === order.paidAttemptId) ?? attempts.find((a) => a.status === "paid");
    return view("paid", paid, {});
  }

  const latest = attempts[0];
  if (attempts.some((a) => a.reviewReason !== null && a.reviewResolvedAt === null)) {
    return view("review", latest, {});
  }
  if (!latest) {
    return storeOpen ? view("awaiting_qr", undefined, { canRequestNewQr: true }) : view("qr_expired_closed", undefined, {});
  }
  if (latest.status === "creating") {
    return view("awaiting_qr", latest, {});
  }

  const expiresMs = latest.expiresAt?.getTime() ?? null;
  if (latest.status === "active" && expiresMs !== null && expiresMs > now.getTime()) {
    let qrPayload: string | null = null;
    if (opts.forOwner && opts.payloadKey && latest.qrPayloadEnc) {
      try {
        qrPayload = decryptPayload(Buffer.from(latest.qrPayloadEnc), opts.payloadKey);
      } catch {
        qrPayload = null;
      }
    }
    return view("qr_active", latest, { canCheck: true, qrPayload });
  }

  const wasActive = latest.status === "active" || latest.status === "expired";
  if (wasActive && expiresMs !== null && now.getTime() - expiresMs < VERIFYING_WINDOW_MS) {
    const remaining = VERIFYING_WINDOW_MS - (now.getTime() - expiresMs);
    return view("verifying", latest, { canCheck: true, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) });
  }

  const checkable = wasActive || latest.status === "create_unknown";
  if (latest.lastCheckResult === "error") {
    return view("check_failed", latest, { canCheck: true, canRequestNewQr: storeOpen });
  }
  if (!storeOpen) return view("qr_expired_closed", latest, { canCheck: checkable });
  if (wasActive) return view("qr_expired_open", latest, { canCheck: true, canRequestNewQr: true });
  return view("awaiting_qr", latest, { canCheck: checkable, canRequestNewQr: true });
}

/** Reads the order's payment state from the DB only; never calls the provider. */
export async function buildPaymentView(
  db: MerchDb,
  orderId: string,
  opts: { forOwner: boolean; storeState: StoreState; now: Date; payloadKey: string | null },
): Promise<PaymentView> {
  const [order] = await db
    .select({ paymentStatus: merchOrders.paymentStatus, paidAttemptId: merchOrders.paidAttemptId })
    .from(merchOrders)
    .where(eq(merchOrders.id, orderId))
    .limit(1);
  if (!order) throw new MerchError(404, "MERCH_ORDER_NOT_FOUND", "ไม่พบคำสั่งซื้อ");
  return derivePaymentView(order, await loadAttempts(db, orderId), opts);
}
