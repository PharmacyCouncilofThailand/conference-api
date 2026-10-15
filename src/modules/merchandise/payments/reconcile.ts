import { sql } from "drizzle-orm";
import type { MerchDb } from "../db.js";
import { dbNow } from "../store-window.js";
import { logMerchError, type MerchContext } from "./attempts.js";
import type { InquiryResult } from "./payso-client.js";
import { applyInquiryResult } from "./settlement.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ACTIVE_INTERVAL_MS = MINUTE_MS;
const AFTER_EXPIRY_MINUTES = [1, 5, 15, 60];
const STOP_AFTER_MS = 7 * DAY_MS;
const LEASE_SECONDS = 60;
const STALE_CREATING_SECONDS = 120;

/**
 * §7.8 schedule. `active` → every 60 s until the expiry. After expiry (or `create_unknown`)
 * → base + 1, 5, 15, 60 min, then daily, until 7 days after creation. `paid` /
 * `create_failed` → never. An `active` attempt already past its expiry follows the
 * after-expiry schedule.
 */
export function nextCheckAt(
  attempt: { status: string; createdAt: Date; expiresAt: Date | null },
  now: Date,
): Date | null {
  if (attempt.status === "paid" || attempt.status === "create_failed") return null;
  const nowMs = now.getTime();
  const expiresMs = attempt.expiresAt?.getTime() ?? null;
  if (attempt.status === "active" && expiresMs !== null && expiresMs > nowMs) {
    return new Date(Math.min(nowMs + ACTIVE_INTERVAL_MS, expiresMs));
  }
  const base = expiresMs ?? attempt.createdAt.getTime();
  const limit = attempt.createdAt.getTime() + STOP_AFTER_MS;
  let candidate: number | null = null;
  for (const minutes of AFTER_EXPIRY_MINUTES) {
    const at = base + minutes * MINUTE_MS;
    if (at > nowMs) {
      candidate = at;
      break;
    }
  }
  if (candidate === null) {
    const daily = base + 60 * MINUTE_MS;
    const k = Math.max(1, Math.floor((nowMs - daily) / DAY_MS) + 1);
    candidate = daily + k * DAY_MS;
  }
  return candidate > limit ? null : new Date(candidate);
}

type ClaimedRow = { id: string; reference_no: string; amount: number; due: string | null };

const CLAIMABLE = sql`status NOT IN ('paid', 'creating')`;

async function inquireAndApply(ctx: MerchContext, claimed: ClaimedRow): Promise<void> {
  let result: InquiryResult;
  if (!ctx.payso) {
    result = { kind: "error", code: "PAYMENT_NOT_CONFIGURED" };
  } else {
    try {
      result = await ctx.payso.inquire(claimed.reference_no, claimed.amount);
    } catch (error) {
      logMerchError(ctx.log, error, "merchandise inquiry failed");
      result = { kind: "error", code: "INQUIRY_CLIENT_ERROR" };
    }
  }
  await applyInquiryResult(ctx, claimed.id, result, { at: await dbNow(ctx.db), source: "inquiry" });

  const rows = (await ctx.db.execute(sql`
    SELECT status, created_at, expires_at, review_reason, clock_timestamp() AS now
    FROM merch_payment_attempts WHERE id = ${claimed.id}`)) as unknown as Array<{
    status: string;
    created_at: Date | string;
    expires_at: Date | string | null;
    review_reason: string | null;
    now: Date | string;
  }>;
  const row = rows[0];
  if (!row) return;
  const next =
    row.review_reason !== null
      ? null
      : nextCheckAt(
          {
            status: row.status,
            createdAt: new Date(row.created_at),
            expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
          },
          new Date(row.now),
        );
  // A postback that arrived while we were inquiring moved next_check_at; keep it.
  await ctx.db.execute(sql`
    UPDATE merch_payment_attempts
    SET next_check_at = CASE
          WHEN next_check_at IS DISTINCT FROM ${claimed.due}::timestamptz THEN next_check_at
          ELSE ${next ? next.toISOString() : null}::timestamptz
        END,
        claimed_until = NULL,
        updated_at = now()
    WHERE id = ${claimed.id}`);
}

/**
 * Inquires one attempt and applies the result. Takes the same 60 s lease as the worker, so
 * an attempt the worker (or another postback) is already checking is skipped.
 */
export async function reconcileAttempt(ctx: MerchContext, attemptId: string): Promise<void> {
  const rows = (await ctx.db.execute(sql`
    UPDATE merch_payment_attempts
    SET claimed_until = clock_timestamp() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id = ${attemptId} AND ${CLAIMABLE}
      AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
    RETURNING id, reference_no, amount, next_check_at::text AS due`)) as unknown as ClaimedRow[];
  const claimed = rows[0];
  if (claimed) await inquireAndApply(ctx, claimed);
}

/**
 * §7.8 housekeeping: `active` past expiry → `expired` without payload; `creating` older
 * than 2 minutes (the request was interrupted) → `create_unknown` with a 10-minute window
 * from the request and checked now; any payload left on a finished attempt is removed.
 */
export async function expireAttempts(db: MerchDb): Promise<{ expired: number; staleCreating: number }> {
  const expired = (await db.execute(sql`
    UPDATE merch_payment_attempts
    SET status = 'expired', qr_payload_enc = NULL, updated_at = now()
    WHERE status = 'active' AND expires_at <= clock_timestamp()
    RETURNING id`)) as unknown as unknown[];
  const stale = (await db.execute(sql`
    UPDATE merch_payment_attempts
    SET status = 'create_unknown',
        failure_code = 'CREATE_INTERRUPTED',
        expires_at = requested_at + interval '10 minutes',
        next_check_at = clock_timestamp(),
        updated_at = now()
    WHERE status = 'creating'
      AND requested_at < clock_timestamp() - make_interval(secs => ${STALE_CREATING_SECONDS})
    RETURNING id`)) as unknown as unknown[];
  await db.execute(sql`
    UPDATE merch_payment_attempts
    SET qr_payload_enc = NULL, updated_at = now()
    WHERE status <> 'active' AND qr_payload_enc IS NOT NULL`);
  return { expired: expired.length, staleCreating: stale.length };
}

/**
 * Claims due attempts (`FOR UPDATE SKIP LOCKED` + 60 s `claimed_until` lease, one
 * statement), inquires them with at most `concurrency` provider calls in flight, applies
 * each result and reschedules. Failures are logged (name/code) and left to the lease.
 */
export async function reconcileDue(
  ctx: MerchContext,
  opts: { limit: number; concurrency: number },
): Promise<{ checked: number }> {
  const claimed = (await ctx.db.execute(sql`
    UPDATE merch_payment_attempts
    SET claimed_until = clock_timestamp() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id IN (
      SELECT id FROM merch_payment_attempts
      WHERE next_check_at <= clock_timestamp()
        AND ${CLAIMABLE}
        AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
      ORDER BY next_check_at
      LIMIT ${opts.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, reference_no, amount, next_check_at::text AS due`)) as unknown as ClaimedRow[];

  let checked = 0;
  let index = 0;
  const worker = async () => {
    while (index < claimed.length) {
      const row = claimed[index];
      index += 1;
      try {
        await inquireAndApply(ctx, row);
        checked += 1;
      } catch (error) {
        logMerchError(ctx.log, error, "merchandise reconcile failed");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, claimed.length)) }, worker));
  return { checked };
}
