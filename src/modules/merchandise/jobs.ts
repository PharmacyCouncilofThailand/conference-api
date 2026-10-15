import { sql } from "drizzle-orm";
import type { MerchDb } from "./db.js";
import type { MerchContext } from "./payments/attempts.js";
import { expireAttempts, reconcileDue } from "./payments/reconcile.js";

/** Provider calls in flight at once (§7.8; constant until the real limit is known). */
const RECONCILE_CONCURRENCY = 2;
const RECONCILE_BATCH = 20;

export interface MerchandiseJobDeps {
  sendEmails?: (db: MerchDb) => Promise<{ sent: number }>;
}

export async function runMerchandiseJobsOnce(
  ctx: MerchContext,
  deps: MerchandiseJobDeps = {},
): Promise<{ expired: number; staleCreating: number; checked: number; emails: number }> {
  const { expired, staleCreating } = await expireAttempts(ctx.db);
  const { checked } = await reconcileDue(ctx, { limit: RECONCILE_BATCH, concurrency: RECONCILE_CONCURRENCY });
  const { sent } = deps.sendEmails ? await deps.sendEmails(ctx.db) : { sent: 0 };
  return { expired, staleCreating, checked, emails: sent };
}

/** Used by `--healthcheck`: never calls the provider; only DB reachability can fail it. */
export async function merchandiseWorkerHealth(ctx: MerchContext): Promise<{ configured: boolean; databaseOk: boolean }> {
  const configured = ctx.payso !== null && ctx.paysoConfig !== null;
  let databaseOk = false;
  try {
    await ctx.db.execute(sql`SELECT 1`);
    databaseOk = true;
  } catch {
    databaseOk = false;
  }
  return { configured, databaseOk };
}
