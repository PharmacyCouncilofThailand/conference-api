import { sql } from "drizzle-orm";
import { z } from "zod";
import { digest } from "./policy.js";
import { rows, fail, requirePosterStaff, type PosterDatabase, type PosterTx } from "./access.js";
import type { PosterActor, PosterPreviewDto } from "./types.js";
import { randomUUID } from 'node:crypto';
import { matchAnnouncement, isBeforeClose } from './policy.js';
import { dbNow } from './access.js';
import { readCandidates, assertInitialReady } from './reconcile.js';
import { buildMailPayload, enqueuePosterMail } from './email-jobs.js';
import { renderPosterEmail } from './email-template.js';
import { verificationInputSchema, settingsInputSchema, mailPreviewInputSchema, batchInputSchema } from './schemas.js';
import type { Announcement, MailKind, MailState, MailPayload } from './types.js';

export async function adminOperation<T>(database: PosterDatabase, actor: PosterActor, eventId: number,
  action: string, key: string, input: unknown, work: (tx: PosterTx) => Promise<T>): Promise<T> {
  if (!z.string().uuid().safeParse(key).success) fail("POSTER_IDEMPOTENCY_KEY_INVALID", 400);
  const operationKey = key.toLowerCase();
  const fingerprint = digest(input);
  return database.transaction(async tx => {
    await requirePosterStaff(tx, actor, eventId, true);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${actor.id}:${action}:${operationKey}`},0))`);
    // Permissions may have changed while this operation waited for a replay's lock.
    await requirePosterStaff(tx, actor, eventId, true);
    const [previous] = await rows<{ fingerprint: string; result: T }>(tx, sql`
      SELECT fingerprint,result FROM poster_operations
      WHERE event_id=${eventId} AND actor_id=${actor.id} AND action=${action} AND operation_key=${operationKey}::uuid
    `);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("POSTER_IDEMPOTENCY_CONFLICT");
      return previous.result;
    }
    const result = await work(tx);
    await tx.execute(sql`
      INSERT INTO poster_operations(event_id,actor_id,action,operation_key,fingerprint,result)
      VALUES (${eventId},${actor.id},${action},${operationKey}::uuid,${fingerprint},${JSON.stringify(result)}::jsonb)
    `);
    return result;
  });
}

export async function audit(tx: PosterTx, eventId: number, abstractId: number | null, actorId: number | null,
  action: string, reason: string | null, before: unknown, after: unknown): Promise<void> {
  await tx.execute(sql`
    INSERT INTO poster_audit_events(event_id,abstract_id,actor_id,action,reason,before_state,after_state)
    VALUES (${eventId},${abstractId},${actorId},${action},${reason},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb)
  `);
}

export async function verifyAlias(database: PosterDatabase, actor: PosterActor, eventId: number, key: string,
  input: z.infer<typeof verificationInputSchema>) {
  input = verificationInputSchema.parse(input);
  return adminOperation(database, actor, eventId, 'verify', key, input, async tx => {
    const [settings] = await rows<{ ready: boolean }>(tx, sql`SELECT reconcile_ready AS ready FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
    if (!settings?.ready) fail('POSTER_RECONCILE_REQUIRED', 503);
    const [ann] = await rows<{ target_id: string | null; present: boolean }>(tx,
      sql`SELECT target_id,present FROM poster_announcements WHERE event_id=${eventId} AND source_key=${input.sourceKey}`);
    if (!ann?.present || !ann.target_id) fail('POSTER_NOT_ELIGIBLE');
    const [target] = await rows<{ abstract_id: number }>(tx, sql`SELECT abstract_id FROM poster_targets WHERE id=${ann.target_id}::uuid FOR UPDATE`);
    const [fresh] = await rows<{ source_row: Announcement; target_id: string; present: boolean; match_state: string; match_snapshot: unknown }>(tx,
      sql`SELECT source_row,target_id,present,match_state,match_snapshot FROM poster_announcements WHERE event_id=${eventId} AND source_key=${input.sourceKey} FOR UPDATE`);
    if (!fresh?.present || fresh.target_id !== ann.target_id || fresh.match_state !== 'alias_pending') fail('POSTER_ROSTER_CONFLICT');
    const candidates = await readCandidates(tx, eventId);
    const match = matchAnnouncement(fresh.source_row, candidates, false);
    const siblings = await rows(tx, sql`SELECT source_key FROM poster_announcements WHERE target_id=${ann.target_id}::uuid AND present`);
    if (siblings.length !== 1 || match.state !== 'alias_pending' || match.abstractId !== target.abstract_id || match.fingerprint !== input.fingerprint) fail('POSTER_ROSTER_CONFLICT');
    await tx.execute(sql`UPDATE poster_announcements SET verified_fingerprint=${match.fingerprint},verified_by=${actor.id},
      verified_at=clock_timestamp(),verification_reason=${input.reason},match_state='ready' WHERE event_id=${eventId} AND source_key=${input.sourceKey}`);
    await tx.execute(sql`UPDATE poster_targets SET initial_enabled=NOT EXISTS(SELECT 1 FROM poster_uploads WHERE target_id=${ann.target_id}::uuid AND request_id IS NULL) WHERE id=${ann.target_id}::uuid`);
    await audit(tx, eventId, match.abstractId, actor.id, 'alias_verified', input.reason, fresh.match_snapshot,
      { announcement: fresh.source_row, candidates: candidates.filter(c => c.abstractId === match.abstractId), match });
    return { abstractId: match.abstractId, state: 'ready' as const };
  });
}

export async function changePosterSettings(database: PosterDatabase, actor: PosterActor, eventId: number, key: string,
  input: z.infer<typeof settingsInputSchema>) {
  input = settingsInputSchema.parse(input);
  return adminOperation(database, actor, eventId, 'settings', key, input, async tx => {
    const [before] = await rows<{ closes_at: Date; version: number }>(tx, sql`SELECT closes_at,version FROM poster_settings WHERE event_id=${eventId} FOR UPDATE`);
    if (!before || before.version !== input.version) fail('POSTER_SETTINGS_STALE');
    const [after] = await rows<{ closesAt: Date | string; version: number }>(tx, sql`UPDATE poster_settings SET closes_at=${input.closesAt}::timestamptz,
      version=version+1 WHERE event_id=${eventId} RETURNING closes_at AS "closesAt",version`);
    await audit(tx, eventId, null, actor.id, 'deadline_changed', input.reason, before, after);
    return { ...after, closesAt: new Date(after.closesAt).toISOString() };
  });
}

async function initialMail(q: Pick<PosterDatabase, 'execute'>, targetId: string, kind: 'initial' | 'reminder') {
  await assertInitialReady(q, targetId);
  const payload = await buildMailPayload(q, targetId, kind);
  const used = await rows(q, sql`SELECT id FROM poster_uploads WHERE target_id=${targetId}::uuid LIMIT 1`);
  if (used.length) fail('POSTER_ALREADY_SUBMITTED');
  if (!isBeforeClose(await dbNow(q), new Date(payload.closesAt!))) fail('POSTER_DEADLINE_PASSED');
  return payload;
}

export async function previewPosterMail(database: PosterDatabase, actor: PosterActor, eventId: number,
  input: z.infer<typeof mailPreviewInputSchema>): Promise<PosterPreviewDto> {
  input = mailPreviewInputSchema.parse(input);
  await requirePosterStaff(database, actor, eventId, true);
  const result = (payloads: MailPayload[]) => ({ fingerprint: digest(payloads), messages: payloads.map(p =>
    ({ abstractId: p.abstractId, recipient: p.recipient, ...renderPosterEmail(p) })) });
  if (input.kind === 'resend') {
    const [job] = await rows<{ target_id: string; kind: MailKind; request_id: string | null; upload_id: string | null; state: MailState }>(database,
      sql`SELECT j.target_id,j.kind,j.request_id,j.upload_id,j.state FROM poster_email_jobs j JOIN poster_targets t ON t.id=j.target_id WHERE j.id=${input.jobId}::uuid AND t.event_id=${eventId}`);
    if (!job) fail('POSTER_MAIL_NOT_FOUND', 404);
    if (job.state === 'pending' || job.state === 'sending') fail('POSTER_MAIL_IN_PROGRESS');
    let payload: MailPayload;
    if (job.kind === 'initial' || job.kind === 'reminder') payload = await initialMail(database, job.target_id, job.kind);
    else {
      payload = await buildMailPayload(database, job.target_id, job.kind, job.request_id ?? undefined, job.upload_id ?? undefined);
      if (job.kind === 'revision') {
        const [request] = await rows<{ status: string }>(database, sql`SELECT status FROM poster_revision_requests WHERE id=${job.request_id}::uuid AND target_id=${job.target_id}::uuid`);
        if (request?.status !== 'open' || !isBeforeClose(await dbNow(database), new Date(payload.closesAt!))) fail('POSTER_REQUEST_CLOSED');
      }
    }
    return result([payload]);
  }
  if (input.kind === 'revision' || input.kind === 'receipt') {
    const [target] = await rows<{ id: string; current_upload_id: string | null }>(database,
      sql`SELECT id,current_upload_id FROM poster_targets WHERE event_id=${eventId} AND abstract_id=${input.abstractId}`);
    if (!target) fail('POSTER_NOT_ELIGIBLE', 404);
    if (input.kind === 'receipt') return result([await buildMailPayload(database, target.id, 'receipt', undefined, input.uploadId)]);
    if (!target.current_upload_id) fail('POSTER_NOT_SUBMITTED');
    const now = await dbNow(database);
    let payload: MailPayload, requestId: string;
    if (input.requestId) {
      payload = await buildMailPayload(database, target.id, 'revision', input.requestId);
      const [request] = await rows<{ status: string }>(database, sql`SELECT status FROM poster_revision_requests WHERE id=${input.requestId}::uuid AND target_id=${target.id}::uuid`);
      if (request?.status !== 'open' || !isBeforeClose(now, new Date(payload.closesAt!))) fail('POSTER_REQUEST_CLOSED');
      if (input.details !== payload.revisionDetails || new Date(input.closesAt).toISOString() !== payload.closesAt) fail('POSTER_REQUEST_IMMUTABLE');
      requestId = input.requestId;
    } else {
      const open = await rows(database, sql`SELECT id FROM poster_revision_requests WHERE target_id=${target.id}::uuid AND status='open' AND closes_at>clock_timestamp()`);
      if (open.length) fail('POSTER_ACTIVE_REQUEST_EXISTS');
      const closesAt = new Date(input.closesAt).toISOString();
      if (!isBeforeClose(now, new Date(closesAt))) fail('POSTER_DEADLINE_INVALID');
      requestId = randomUUID();
      payload = { ...await buildMailPayload(database, target.id, 'revision'), revisionRequestId: requestId, revisionDetails: input.details, closesAt };
    }
    return { ...result([payload]), requestId, closesAt: payload.closesAt! };
  }
  const payloads: MailPayload[] = [];
  for (const abstractId of [...new Set(input.abstractIds)].sort((a, b) => a - b)) {
    const [target] = await rows<{ id: string }>(database, sql`SELECT id FROM poster_targets WHERE event_id=${eventId} AND abstract_id=${abstractId}`);
    if (!target) fail('POSTER_NOT_ELIGIBLE');
    payloads.push(await initialMail(database, target.id, input.kind));
  }
  return result(payloads);
}

export async function createNotificationBatch(database: PosterDatabase, actor: PosterActor, eventId: number, key: string,
  input: z.infer<typeof batchInputSchema>) {
  input = batchInputSchema.parse(input);
  return adminOperation(database, actor, eventId, 'notification', key, input, async tx => {
    await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
    const ids = [...new Set(input.abstractIds)].sort((a, b) => a - b);
    const targets = await rows<{ id: string; abstract_id: number }>(tx, sql`SELECT id,abstract_id FROM poster_targets
      WHERE event_id=${eventId} AND abstract_id IN (SELECT value::int FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY id FOR UPDATE`);
    if (targets.length !== ids.length) fail('POSTER_NOT_ELIGIBLE');
    const payloads: MailPayload[] = [];
    for (const abstractId of ids) payloads.push(await initialMail(tx, targets.find(t => t.abstract_id === abstractId)!.id, input.kind));
    if (digest(payloads) !== input.previewFingerprint) fail('POSTER_PREVIEW_STALE');
    const batchId = randomUUID(), jobs: string[] = [];
    for (const payload of payloads) jobs.push(await enqueuePosterMail(tx, targets.find(t => t.abstract_id === payload.abstractId)!.id, payload, actor.id, { batchId }));
    await audit(tx, eventId, null, actor.id, 'notification_batch', null, null, { batchId, kind: input.kind, abstractIds: ids, jobs });
    return { batchId, queued: jobs.length, jobIds: jobs };
  });
}
