import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { backofficeUsers, registrations, sessions, sessionInvitations, registrationSessionGrantItems, sessionInvitationResendRequests } from "../../database/schema.js";
import { renderInvitationEmail } from "./email-template.js";
import { effectiveDeadline } from "./invitation-policy.js";
import { decryptInvitationToken, hashInvitationToken, parseInvitationFrontendOrigin, readInvitationEncryptionKey } from "./invitation-token.js";
import { canonicalResendInput, resendDisabledReason } from "./resend-policy.js";
import { buildResendSnapshot, readResendCandidates } from "./resend-readers.js";
import { resendInvitationSchema } from "./schemas.js";
import type { ResendCandidate, ResendInput, ResendPreviewDto, ResendResult, ResendSkip } from "./resend-types.js";
import { GrantError, type GrantDatabase, type GrantTransaction } from "./types.js";

function canonicalInput(input: ResendInput): ResendInput {
  const parsed = resendInvitationSchema.safeParse({ sessionId: input.sessionId, invitationIds: input.invitationIds });
  if (!parsed.success) throw new GrantError(400, "INVALID_RESEND_REQUEST", "Invalid invitation resend request");
  return canonicalResendInput(parsed.data);
}

async function databaseTime(tx: GrantTransaction): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  return new Date(row!.now);
}

// Validate credentials in memory only; callers never return the decrypted token.
function renderCandidate(candidate: ResendCandidate, key: Buffer) {
  if (JSON.stringify(candidate.notificationSnapshot).length > 65536 || JSON.stringify(candidate.tokenCiphertext).length > 1024) throw new Error("payload");
  const snapshot = buildResendSnapshot(candidate);
  if (!candidate.tokenCiphertext || !candidate.recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.recipientEmail)
    || typeof snapshot.responseOrigin !== "string") throw new Error("payload");
  parseInvitationFrontendOrigin(snapshot.responseOrigin, process.env.NODE_ENV);
  const token = decryptInvitationToken(candidate.invitationId, candidate.tokenCiphertext, key);
  if (hashInvitationToken(token) !== candidate.tokenHash) throw new Error("payload");
  return renderInvitationEmail(snapshot, "https://preview.invalid/", effectiveDeadline(candidate.expiresAt, candidate.sessionStartTime).toISOString());
}

function evaluate(input: ResendInput, candidates: ResendCandidate[], now: Date) {
  const byId = new Map(candidates.map(candidate => [candidate.invitationId, candidate]));
  const eligible: { candidate: ResendCandidate; rendered: ReturnType<typeof renderInvitationEmail> }[] = [];
  const skipped: ResendSkip[] = [];
  let key: Buffer | undefined;
  for (const invitationId of input.invitationIds) {
    const candidate = byId.get(invitationId);
    if (!candidate) { skipped.push({ invitationId, reasonCode: "INVITATION_NOT_FOUND" }); continue; }
    const reason = resendDisabledReason(candidate, now);
    if (reason) { skipped.push(reason); continue; }
    key ??= readInvitationEncryptionKey(process.env);
    try { eligible.push({ candidate, rendered: renderCandidate(candidate, key) }); }
    catch { skipped.push({ invitationId, reasonCode: "INVITATION_PAYLOAD_INVALID" }); }
  }
  return { eligible, skipped };
}

export async function previewInvitationResends(database: GrantDatabase, input: ResendInput): Promise<ResendPreviewDto> {
  const canonical = canonicalInput(input);
  return database.transaction(async tx => {
    const [session] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, canonical.sessionId)).limit(1);
    if (!session) throw new GrantError(404, "SESSION_NOT_FOUND", "Session not found");
    const now = await databaseTime(tx);
    const { eligible, skipped } = evaluate(canonical, await readResendCandidates(tx, canonical), now);
    return { emails: eligible.map(({ candidate, rendered }) => ({ invitationId: candidate.invitationId,
      registrationId: candidate.registrationId, name: candidate.name ?? "", recipient: candidate.recipientEmail!,
      subject: rendered.subject, html: rendered.html })), skipped };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function queueInvitationResends(database: GrantDatabase, input: ResendInput & { actorId: number; idempotencyKey: string }): Promise<{ replayed: boolean; result: ResendResult }> {
  const canonical = canonicalInput(input);
  const idempotencyKey = input.idempotencyKey.toLowerCase();
  const hash = createHash("sha256").update(JSON.stringify({ operation: "invitation-resend", ...canonical })).digest("hex");
  return database.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.actorId}:invitation-resend:${idempotencyKey}`}, 0))`);
    const [existing] = await tx.select().from(sessionInvitationResendRequests).where(and(eq(sessionInvitationResendRequests.actorId, input.actorId), eq(sessionInvitationResendRequests.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) {
      if (existing.requestHash !== hash) throw new GrantError(409, "IDEMPOTENCY_KEY_MISMATCH", "Idempotency key was already used with a different request");
      return { replayed: true, result: existing.result as ResendResult };
    }
    const [actor] = await tx.select({ id: backofficeUsers.id }).from(backofficeUsers).where(eq(backofficeUsers.id, input.actorId)).limit(1);
    if (!actor) throw new GrantError(403, "ACTOR_NOT_FOUND", "Admin actor not found");
    const [session] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, canonical.sessionId)).for("update");
    if (!session) throw new GrantError(404, "SESSION_NOT_FOUND", "Session not found");
    const scope = and(eq(sessionInvitations.sessionId, canonical.sessionId), inArray(sessionInvitations.id, canonical.invitationIds));
    const originals = await tx.select({ registrationId: sessionInvitations.registrationId, invitationId: sessionInvitations.id, itemId: sessionInvitations.grantItemId }).from(sessionInvitations).innerJoin(registrationSessionGrantItems, eq(sessionInvitations.grantItemId, registrationSessionGrantItems.id)).where(and(scope, eq(registrationSessionGrantItems.outcome, "invited")));
    if (originals.length) {
      await tx.select({ id: registrations.id }).from(registrations).where(inArray(registrations.id, originals.map(row => row.registrationId))).orderBy(asc(registrations.id)).for("update");
      await tx.select({ id: sessionInvitations.id }).from(sessionInvitations).where(inArray(sessionInvitations.id, originals.map(row => row.invitationId))).orderBy(asc(sessionInvitations.id)).for("update");
      await tx.select({ id: registrationSessionGrantItems.id }).from(registrationSessionGrantItems).where(inArray(registrationSessionGrantItems.id, originals.map(row => row.itemId))).orderBy(asc(registrationSessionGrantItems.id)).for("update");
    }
    const now = await databaseTime(tx);
    const { eligible, skipped } = evaluate(canonical, await readResendCandidates(tx, canonical), now);
    const result: ResendResult = { requestId: randomUUID(), sessionId: canonical.sessionId, requestedCount: canonical.invitationIds.length,
      queued: eligible.map(({ candidate }) => ({ invitationId: candidate.invitationId, itemId: candidate.itemId })), skipped };
    await tx.insert(sessionInvitationResendRequests).values({ id: result.requestId, actorId: input.actorId, sessionId: canonical.sessionId, idempotencyKey, requestHash: hash, result });
    if (eligible.length) await tx.update(registrationSessionGrantItems).set({ emailStatus: "pending", nextTrigger: "admin", nextTriggeredBy: input.actorId,
      nextEmailPurpose: "resend", nextResendRequestId: result.requestId, lastResendQueuedAt: now, claimToken: null, claimedUntil: null, lastErrorCode: null,
    }).where(inArray(registrationSessionGrantItems.id, result.queued.map(row => row.itemId)));
    return { replayed: false, result };
  });
}
