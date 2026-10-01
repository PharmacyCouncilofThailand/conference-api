import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  registrationSessionGrantBatches,
  registrationSessionGrantEmailAttempts,
  registrationSessionGrantItems,
  registrationSessions,
  registrations,
} from "../../database/schema.js";
import { sendNipaMailHtml } from "../../services/emailService.js";
import { renderGrantEmail, type GrantNotificationSnapshot } from "./email-template.js";
import type { GrantDatabase } from "./types.js";

const CLAIM_LEASE_MS = 180_000;

export interface GrantMailTransport {
  send(input: {
    recipient: string;
    subject: string;
    html: string;
  }): Promise<{ providerMessageId?: string }>;
}

export function createNipaMailGrantTransport(timeoutMs = 15_000): GrantMailTransport {
  return {
    async send(input) {
      await sendNipaMailHtml(input.recipient, input.subject, input.html, true, { timeoutMs });
      return {};
    },
  };
}

function fakeTransportFailure(
  message: string,
  code: string,
  deliveryState: "failed" | "unknown",
): GrantMailTransportFailure {
  return Object.assign(new Error(message), { code, deliveryState });
}

export function createFakeGrantMailTransport(
  fakeMailUrl: string,
  timeoutMs = 15_000,
): GrantMailTransport {
  const origin = new URL(fakeMailUrl);
  if (origin.origin !== "http://fake-mail:8025" || origin.pathname !== "/") {
    throw new Error("SESSION_GRANTS_FAKE_MAIL_URL must use the isolated fake-mail service");
  }

  return {
    async send(input) {
      try {
        const response = await fetch(new URL("/messages", origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw fakeTransportFailure(
            `Fake mail rejected request with HTTP ${response.status}`,
            `FAKE_MAIL_HTTP_${response.status}`,
            "failed",
          );
        }
        const payload = await response.json() as { messageId?: unknown };
        return {
          providerMessageId: typeof payload.messageId === "string"
            ? payload.messageId
            : undefined,
        };
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "deliveryState" in error
        ) {
          throw error;
        }
        throw fakeTransportFailure(
          "Fake mail delivery outcome is unknown",
          error instanceof Error && error.name === "TimeoutError"
            ? "FAKE_MAIL_TIMEOUT"
            : "FAKE_MAIL_TRANSPORT_UNKNOWN",
          "unknown",
        );
      }
    },
  };
}

export function createGrantMailTransport(
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): GrantMailTransport {
  const fakeMailUrl = environment.SESSION_GRANTS_FAKE_MAIL_URL?.trim();
  if (!fakeMailUrl) return createNipaMailGrantTransport(timeoutMs);
  if (environment.NODE_ENV !== "test") {
    throw new Error("SESSION_GRANTS_FAKE_MAIL_URL is allowed only when NODE_ENV=test");
  }
  return createFakeGrantMailTransport(fakeMailUrl, timeoutMs);
}

export interface GrantMailTransportFailure extends Error {
  code?: string;
  deliveryState?: "failed" | "unknown";
}

interface ClaimedMail {
  itemId: string;
  attemptId: string;
  attemptNo: number;
  claimToken: string;
  registrationSessionId: number | null;
  recipient: string;
  subject: string;
  html: string;
}

export function classifyGrantMailFailure(error: unknown): {
  state: "failed" | "unknown";
  code: string;
  message: string;
} {
  const failure = error as GrantMailTransportFailure;
  return {
    state: failure?.deliveryState === "failed" ? "failed" : "unknown",
    code: typeof failure?.code === "string" && failure.code.length > 0
      ? failure.code.slice(0, 100)
      : "MAIL_TRANSPORT_UNKNOWN",
    message: error instanceof Error
      ? error.message.slice(0, 500)
      : "Mail transport outcome is unknown",
  };
}

async function recoverOneExpiredClaim(database: GrantDatabase, now: Date): Promise<"pending" | "unknown" | null> {
  return database.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: registrationSessionGrantItems.id,
        claimToken: registrationSessionGrantItems.claimToken,
      })
      .from(registrationSessionGrantItems)
      .where(and(
        eq(registrationSessionGrantItems.emailStatus, "sending"),
        lt(registrationSessionGrantItems.claimedUntil, now),
      ))
      .orderBy(asc(registrationSessionGrantItems.claimedUntil), asc(registrationSessionGrantItems.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!item?.claimToken) return null;

    const [attempt] = await tx
      .select({
        id: registrationSessionGrantEmailAttempts.id,
        requestStartedAt: registrationSessionGrantEmailAttempts.requestStartedAt,
      })
      .from(registrationSessionGrantEmailAttempts)
      .where(and(
        eq(registrationSessionGrantEmailAttempts.itemId, item.id),
        eq(registrationSessionGrantEmailAttempts.claimToken, item.claimToken),
      ))
      .orderBy(desc(registrationSessionGrantEmailAttempts.attemptNo))
      .limit(1);

    if (attempt && !attempt.requestStartedAt) {
      await tx.update(registrationSessionGrantEmailAttempts).set({
        result: "failed",
        finishedAt: now,
        errorCode: "PRE_SEND_WORKER_INTERRUPTED",
        errorMessage: "Worker stopped before provider request started",
      }).where(eq(registrationSessionGrantEmailAttempts.id, attempt.id));
      await tx.update(registrationSessionGrantItems).set({
        emailStatus: "pending",
        claimToken: null,
        claimedUntil: null,
        lastErrorCode: "PRE_SEND_WORKER_INTERRUPTED",
      }).where(and(
        eq(registrationSessionGrantItems.id, item.id),
        eq(registrationSessionGrantItems.claimToken, item.claimToken),
      ));
      return "pending";
    }

    if (attempt) {
      await tx.update(registrationSessionGrantEmailAttempts).set({
        result: "unknown",
        finishedAt: now,
        errorCode: "WORKER_INTERRUPTED_AFTER_REQUEST_START",
        errorMessage: "Provider request started before worker interruption; delivery outcome is unknown",
      }).where(eq(registrationSessionGrantEmailAttempts.id, attempt.id));
    }
    await tx.update(registrationSessionGrantItems).set({
      emailStatus: "unknown",
      claimToken: null,
      claimedUntil: null,
      lastErrorCode: "WORKER_INTERRUPTED_AFTER_REQUEST_START",
    }).where(and(
      eq(registrationSessionGrantItems.id, item.id),
      eq(registrationSessionGrantItems.claimToken, item.claimToken),
    ));
    return "unknown";
  });
}

async function claimOne(database: GrantDatabase, now: Date): Promise<ClaimedMail | null> {
  return database.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: registrationSessionGrantItems.id,
        registrationSessionId: registrationSessionGrantItems.registrationSessionId,
        recipient: registrationSessionGrantItems.recipientEmailSnapshot,
        notificationSnapshot: registrationSessionGrantItems.notificationSnapshot,
        attemptCount: registrationSessionGrantItems.attemptCount,
        nextTrigger: registrationSessionGrantItems.nextTrigger,
        nextTriggeredBy: registrationSessionGrantItems.nextTriggeredBy,
      })
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.emailStatus, "pending"))
      .orderBy(asc(registrationSessionGrantItems.createdAt), asc(registrationSessionGrantItems.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!item) return null;

    const attemptNo = item.attemptCount + 1;
    const claimToken = randomUUID();
    const attemptId = randomUUID();
    let rendered: ReturnType<typeof renderGrantEmail>;
    try {
      if (!item.recipient || !item.notificationSnapshot) throw new Error("Missing durable recipient/template snapshot");
      rendered = renderGrantEmail(item.notificationSnapshot as unknown as GrantNotificationSnapshot);
    } catch (error) {
      await tx.update(registrationSessionGrantItems).set({
        emailStatus: "failed",
        attemptCount: attemptNo,
        lastAttemptAt: now,
        lastErrorCode: "TEMPLATE_INVALID",
        claimToken: null,
        claimedUntil: null,
      }).where(eq(registrationSessionGrantItems.id, item.id));
      await tx.insert(registrationSessionGrantEmailAttempts).values({
        id: attemptId,
        itemId: item.id,
        attemptNo,
        claimToken,
        trigger: item.nextTrigger,
        triggeredBy: item.nextTriggeredBy,
        recipientEmail: item.recipient ?? "invalid@example.invalid",
        templateVersion: "session-grant-v1",
        subjectSnapshot: "ไม่สามารถสร้างข้อความแจ้งเตือนได้",
        result: "failed",
        startedAt: now,
        finishedAt: now,
        errorCode: "TEMPLATE_INVALID",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Invalid template snapshot",
      });
      return null;
    }

    await tx.update(registrationSessionGrantItems).set({
      emailStatus: "sending",
      attemptCount: attemptNo,
      lastAttemptAt: now,
      claimToken,
      claimedUntil: new Date(now.getTime() + CLAIM_LEASE_MS),
      lastErrorCode: null,
    }).where(eq(registrationSessionGrantItems.id, item.id));
    await tx.insert(registrationSessionGrantEmailAttempts).values({
      id: attemptId,
      itemId: item.id,
      attemptNo,
      claimToken,
      trigger: item.nextTrigger,
      triggeredBy: item.nextTriggeredBy,
      recipientEmail: item.recipient!,
      templateVersion: rendered.templateVersion,
      subjectSnapshot: rendered.subject,
      result: "sending",
      startedAt: now,
    });

    return {
      itemId: item.id,
      attemptId,
      attemptNo,
      claimToken,
      registrationSessionId: item.registrationSessionId,
      recipient: item.recipient!,
      subject: rendered.subject,
      html: rendered.html,
    };
  });
}

async function relationStillActive(database: GrantDatabase, claim: ClaimedMail): Promise<boolean> {
  if (!claim.registrationSessionId) return false;
  const [row] = await database
    .select({ id: registrationSessions.id })
    .from(registrationSessions)
    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
    .where(and(
      eq(registrationSessions.id, claim.registrationSessionId),
      eq(registrations.status, "confirmed"),
    ))
    .limit(1);
  return Boolean(row);
}

async function finalize(
  database: GrantDatabase,
  claim: ClaimedMail,
  now: Date,
  state: "sent" | "failed" | "unknown" | "suppressed",
  details: { errorCode?: string; errorMessage?: string; providerMessageId?: string } = {},
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select({ claimToken: registrationSessionGrantItems.claimToken })
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.id, claim.itemId))
      .limit(1)
      .for("update");
    if (!current || current.claimToken !== claim.claimToken) return false;

    await tx.update(registrationSessionGrantEmailAttempts).set({
      result: state,
      finishedAt: now,
      errorCode: details.errorCode ?? null,
      errorMessage: details.errorMessage ?? null,
      providerMessageId: details.providerMessageId ?? null,
    }).where(eq(registrationSessionGrantEmailAttempts.id, claim.attemptId));
    await tx.update(registrationSessionGrantItems).set({
      emailStatus: state,
      sentAt: state === "sent" ? now : null,
      lastErrorCode: details.errorCode ?? null,
      claimToken: null,
      claimedUntil: null,
    }).where(and(
      eq(registrationSessionGrantItems.id, claim.itemId),
      eq(registrationSessionGrantItems.claimToken, claim.claimToken),
    ));
    return true;
  });
}

export async function runGrantEmailsOnce(
  database: GrantDatabase,
  transport: GrantMailTransport,
  now: Date,
): Promise<{ claimed: number; sent: number; failed: number; unknown: number; suppressed: number }> {
  const stats = { claimed: 0, sent: 0, failed: 0, unknown: 0, suppressed: 0 };
  const recovered = await recoverOneExpiredClaim(database, now);
  if (recovered === "unknown") stats.unknown += 1;

  const claim = await claimOne(database, now);
  if (!claim) return stats;
  stats.claimed = 1;

  if (!(await relationStillActive(database, claim))) {
    if (await finalize(database, claim, now, "suppressed", {
      errorCode: "ENTITLEMENT_NOT_ACTIVE",
      errorMessage: "Registration/session entitlement is no longer active",
    })) stats.suppressed = 1;
    return stats;
  }

  const requestMarked = await database.transaction(async (tx) => {
    const [current] = await tx
      .select({ claimToken: registrationSessionGrantItems.claimToken })
      .from(registrationSessionGrantItems)
      .where(eq(registrationSessionGrantItems.id, claim.itemId))
      .limit(1)
      .for("update");
    if (!current || current.claimToken !== claim.claimToken) return false;
    await tx.update(registrationSessionGrantEmailAttempts).set({
      requestStartedAt: now,
    }).where(eq(registrationSessionGrantEmailAttempts.id, claim.attemptId));
    return true;
  });
  if (!requestMarked) return stats;

  try {
    const result = await transport.send({
      recipient: claim.recipient,
      subject: claim.subject,
      html: claim.html,
    });
    if (await finalize(database, claim, now, "sent", { providerMessageId: result.providerMessageId })) {
      stats.sent = 1;
    }
  } catch (error) {
    const failure = classifyGrantMailFailure(error);
    if (await finalize(database, claim, now, failure.state, {
      errorCode: failure.code,
      errorMessage: failure.message,
    })) {
      stats[failure.state] = 1;
    }
  }
  return stats;
}

export async function getGrantMailBacklogHealth(database: GrantDatabase, now: Date) {
  const [row] = await database
    .select({
      pending: sql<number>`count(*) filter (where ${registrationSessionGrantItems.emailStatus} = 'pending')::int`,
      sending: sql<number>`count(*) filter (where ${registrationSessionGrantItems.emailStatus} = 'sending')::int`,
      expiredSending: sql<number>`count(*) filter (where ${registrationSessionGrantItems.emailStatus} = 'sending' and ${registrationSessionGrantItems.claimedUntil} < ${now.toISOString()})::int`,
      unknown: sql<number>`count(*) filter (where ${registrationSessionGrantItems.emailStatus} = 'unknown')::int`,
      oldestPendingAt: sql<Date | null>`min(${registrationSessionGrantItems.createdAt}) filter (where ${registrationSessionGrantItems.emailStatus} = 'pending')`,
    })
    .from(registrationSessionGrantItems);
  const oldestPendingAt = row.oldestPendingAt instanceof Date
    ? row.oldestPendingAt
    : row.oldestPendingAt
      ? new Date(row.oldestPendingAt)
      : null;
  return {
    pending: row.pending,
    sending: row.sending,
    expiredSending: row.expiredSending,
    unknown: row.unknown,
    oldestPendingAgeMs: oldestPendingAt ? Math.max(0, now.getTime() - oldestPendingAt.getTime()) : 0,
  };
}

export async function retryGrantEmails(
  database: GrantDatabase,
  input: { actorId: number; batchId: string; itemIds: string[]; acknowledgeUnknown: boolean },
): Promise<{ queued: string[]; skipped: Array<{ itemId: string; reasonCode: string }> }> {
  const requestedIds = [...new Set(input.itemIds)].sort();
  return database.transaction(async (tx) => {
    const rows = requestedIds.length > 0
      ? await tx
        .select({
          id: registrationSessionGrantItems.id,
          emailStatus: registrationSessionGrantItems.emailStatus,
          registrationSessionId: registrationSessionGrantItems.registrationSessionId,
        })
        .from(registrationSessionGrantItems)
        .innerJoin(
          registrationSessionGrantBatches,
          eq(registrationSessionGrantItems.batchId, registrationSessionGrantBatches.id),
        )
        .where(and(
          eq(registrationSessionGrantItems.batchId, input.batchId),
          inArray(registrationSessionGrantItems.id, requestedIds),
        ))
        .orderBy(asc(registrationSessionGrantItems.id))
        .for("update")
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const queued: string[] = [];
    const skipped: Array<{ itemId: string; reasonCode: string }> = [];

    for (const itemId of requestedIds) {
      const item = byId.get(itemId);
      if (!item) {
        skipped.push({ itemId, reasonCode: "ITEM_NOT_FOUND" });
        continue;
      }
      if (item.emailStatus === "pending" || item.emailStatus === "sending") {
        skipped.push({ itemId, reasonCode: "EMAIL_BUSY" });
        continue;
      }
      if (item.emailStatus === "unknown" && !input.acknowledgeUnknown) {
        skipped.push({ itemId, reasonCode: "UNKNOWN_ACK_REQUIRED" });
        continue;
      }
      if (item.emailStatus !== "failed" && item.emailStatus !== "unknown") {
        skipped.push({ itemId, reasonCode: "EMAIL_NOT_RETRYABLE" });
        continue;
      }
      if (!item.registrationSessionId) {
        skipped.push({ itemId, reasonCode: "ENTITLEMENT_NOT_ACTIVE" });
        continue;
      }
      const [active] = await tx
        .select({ id: registrationSessions.id })
        .from(registrationSessions)
        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
        .where(and(
          eq(registrationSessions.id, item.registrationSessionId),
          eq(registrations.status, "confirmed"),
        ))
        .limit(1);
      if (!active) {
        skipped.push({ itemId, reasonCode: "ENTITLEMENT_NOT_ACTIVE" });
        continue;
      }
      await tx.update(registrationSessionGrantItems).set({
        emailStatus: "pending",
        claimToken: null,
        claimedUntil: null,
        lastErrorCode: null,
        nextTrigger: "admin",
        nextTriggeredBy: input.actorId,
      }).where(eq(registrationSessionGrantItems.id, itemId));
      queued.push(itemId);
    }
    return { queued, skipped };
  });
}
