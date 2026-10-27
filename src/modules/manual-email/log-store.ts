import { and, count, desc, eq, ilike, inArray, max, or } from "drizzle-orm";
import { db } from "../../database/index.js";
import { backofficeUsers, manualEmailLogs } from "../../database/schema.js";
import type { LogWriter } from "./send-loop.js";

export const MANUAL_EMAIL_LOG_PAGE_SIZE = 50;

export type ManualEmailLogStatus = "sending" | "sent" | "failed" | "skipped";

export interface ManualEmailLogRow {
  id: number;
  batchId: string;
  template: string;
  recipientType: string;
  recipientId: number;
  recipientEmail: string | null;
  recipientName: string | null;
  subject: string | null;
  status: string;
  reason: string | null;
  triggeredBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export function createManualEmailLogWriter(ctx: {
  batchId: string;
  eventId: number;
  template: string;
  recipientType: string;
  triggeredBy: number | null;
}): LogWriter {
  const common = {
    batchId: ctx.batchId,
    eventId: ctx.eventId,
    template: ctx.template,
    recipientType: ctx.recipientType,
    triggeredBy: ctx.triggeredBy,
  };
  return {
    async insertSkipped(row) {
      await db.insert(manualEmailLogs).values({
        ...common,
        recipientId: row.recipientId,
        recipientEmail: row.email,
        recipientName: row.name,
        status: "skipped",
        reason: row.reason,
        finishedAt: new Date(),
      });
    },
    async insertSending(row) {
      const [inserted] = await db
        .insert(manualEmailLogs)
        .values({
          ...common,
          recipientId: row.recipientId,
          recipientEmail: row.email,
          recipientName: row.name,
          subject: row.subject,
          status: "sending",
        })
        .returning({ id: manualEmailLogs.id });
      return inserted.id;
    },
    async finish(logId, status, reason) {
      await db
        .update(manualEmailLogs)
        .set({ status, reason, finishedAt: new Date() })
        .where(eq(manualEmailLogs.id, logId));
    },
  };
}

/** Latest successful send per recipient for one event/template. */
export async function findLastSentAt(
  eventId: number,
  template: string,
  recipientIds: number[],
): Promise<Map<number, Date>> {
  if (recipientIds.length === 0) return new Map();
  const rows = await db
    .select({ recipientId: manualEmailLogs.recipientId, lastSentAt: max(manualEmailLogs.createdAt) })
    .from(manualEmailLogs)
    .where(
      and(
        eq(manualEmailLogs.eventId, eventId),
        eq(manualEmailLogs.template, template),
        eq(manualEmailLogs.status, "sent"),
        inArray(manualEmailLogs.recipientId, recipientIds),
      ),
    )
    .groupBy(manualEmailLogs.recipientId);
  return new Map(
    rows.filter((row) => row.lastSentAt).map((row) => [row.recipientId, new Date(row.lastSentAt!)]),
  );
}

export async function listManualEmailLogs(filter: {
  eventId: number;
  template?: string;
  status?: string;
  batchId?: string;
  q?: string;
  page: number;
}): Promise<{ logs: ManualEmailLogRow[]; total: number; summary: Record<ManualEmailLogStatus, number> }> {
  const scope = and(
    eq(manualEmailLogs.eventId, filter.eventId),
    filter.template ? eq(manualEmailLogs.template, filter.template) : undefined,
    filter.batchId ? eq(manualEmailLogs.batchId, filter.batchId) : undefined,
    filter.q
      ? or(
          ilike(manualEmailLogs.recipientEmail, `%${filter.q}%`),
          ilike(manualEmailLogs.recipientName, `%${filter.q}%`),
        )
      : undefined,
  );
  const where = and(scope, filter.status ? eq(manualEmailLogs.status, filter.status) : undefined);

  const logs = await db
    .select({
      id: manualEmailLogs.id,
      batchId: manualEmailLogs.batchId,
      template: manualEmailLogs.template,
      recipientType: manualEmailLogs.recipientType,
      recipientId: manualEmailLogs.recipientId,
      recipientEmail: manualEmailLogs.recipientEmail,
      recipientName: manualEmailLogs.recipientName,
      subject: manualEmailLogs.subject,
      status: manualEmailLogs.status,
      reason: manualEmailLogs.reason,
      triggeredBy: backofficeUsers.email,
      createdAt: manualEmailLogs.createdAt,
      finishedAt: manualEmailLogs.finishedAt,
    })
    .from(manualEmailLogs)
    .leftJoin(backofficeUsers, eq(manualEmailLogs.triggeredBy, backofficeUsers.id))
    .where(where)
    .orderBy(desc(manualEmailLogs.createdAt), desc(manualEmailLogs.id))
    .limit(MANUAL_EMAIL_LOG_PAGE_SIZE)
    .offset((filter.page - 1) * MANUAL_EMAIL_LOG_PAGE_SIZE);

  const statusCounts = await db
    .select({ status: manualEmailLogs.status, n: count() })
    .from(manualEmailLogs)
    .where(where)
    .groupBy(manualEmailLogs.status);

  const summary: Record<ManualEmailLogStatus, number> = { sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of statusCounts) {
    if (row.status in summary) summary[row.status as ManualEmailLogStatus] = Number(row.n);
  }
  const total = Object.values(summary).reduce((sum, n) => sum + n, 0);

  return { logs, total, summary };
}
