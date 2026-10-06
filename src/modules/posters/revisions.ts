import { sql } from 'drizzle-orm';
import { rows, fail, dbNow, type PosterDatabase } from './access.js';
import { adminOperation, audit } from './operations.js';
import { buildMailPayload, enqueuePosterMail } from './email-jobs.js';
import { digest, isBeforeClose } from './policy.js';
import { createRevisionInputSchema, cancelInputSchema, operationKeySchema } from './schemas.js';
import type { PosterActor, RevisionDto } from './types.js';

async function readRevision(database: Pick<PosterDatabase, 'execute'>, requestId: string): Promise<RevisionDto> {
  const [r] = await rows<RevisionDto>(database, sql`SELECT id,details,closes_at AS "closesAt",status,
    created_at AS "createdAt",requested_by AS "requestedBy",submitted_at AS "submittedAt",
    cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",cancellation_reason AS "cancellationReason"
    FROM poster_revision_requests WHERE id=${requestId}::uuid`);
  return { ...r, closesAt: new Date(r.closesAt).toISOString(), createdAt: new Date(r.createdAt).toISOString(),
    submittedAt: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
    cancelledAt: r.cancelledAt ? new Date(r.cancelledAt).toISOString() : null };
}

export async function createPosterRevision(database: PosterDatabase, actor: PosterActor, eventId: number,
  abstractId: number, key: string, input: { requestId: string; details: string; closesAt: string; previewFingerprint: string }):
  Promise<{ request: RevisionDto; emailJobId: string }> {
  input = createRevisionInputSchema.parse(input);
  input = { ...input, requestId: input.requestId.toLowerCase(), closesAt: new Date(input.closesAt).toISOString() };
  return adminOperation(database, actor, eventId, 'revision_create', key, { abstractId, ...input }, async tx => {
    await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
    const [target] = await rows<{ id: string; current_upload_id: string | null }>(tx, sql`SELECT id,current_upload_id
      FROM poster_targets WHERE event_id=${eventId} AND abstract_id=${abstractId} FOR UPDATE`);
    if (!target?.current_upload_id) fail('POSTER_REVISION_REQUIRES_UPLOAD');
    if (!isBeforeClose(await dbNow(tx), new Date(input.closesAt))) fail('POSTER_DEADLINE_PASSED');
    await tx.execute(sql`UPDATE poster_revision_requests SET status='expired'
      WHERE target_id=${target.id}::uuid AND status='open' AND closes_at<=clock_timestamp()`);
    const open = await rows(tx, sql`SELECT id FROM poster_revision_requests WHERE target_id=${target.id}::uuid AND status='open'`);
    if (open.length) fail('POSTER_ACTIVE_REQUEST_EXISTS');
    if ((await rows(tx, sql`SELECT id FROM poster_revision_requests WHERE id=${input.requestId}::uuid`)).length) fail('POSTER_REQUEST_CLOSED');
    const payload = { ...await buildMailPayload(tx, target.id, 'revision'), revisionRequestId: input.requestId,
      revisionDetails: input.details, closesAt: input.closesAt };
    if (digest([payload]) !== input.previewFingerprint) fail('POSTER_PREVIEW_STALE');
    await tx.execute(sql`INSERT INTO poster_revision_requests(id,target_id,details,closes_at,requested_by)
      VALUES(${input.requestId}::uuid,${target.id}::uuid,${input.details},${input.closesAt}::timestamptz,${actor.id})`);
    const emailJobId = await enqueuePosterMail(tx, target.id, payload, actor.id, { requestId: input.requestId });
    const request = await readRevision(tx, input.requestId);
    await audit(tx, eventId, abstractId, actor.id, 'revision_created', input.details, null, { request, emailJobId });
    return { request, emailJobId };
  });
}

export async function cancelPosterRevision(database: PosterDatabase, actor: PosterActor, eventId: number,
  requestId: string, key: string, input: { reason: string }): Promise<RevisionDto> {
  requestId = operationKeySchema.parse(requestId).toLowerCase();
  input = cancelInputSchema.parse(input);
  return adminOperation(database, actor, eventId, 'revision_cancel', key, { requestId, ...input }, async tx => {
    await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
    const [target] = await rows<{ id: string; abstract_id: number }>(tx, sql`SELECT t.id,t.abstract_id FROM poster_targets t
      JOIN poster_revision_requests r ON r.target_id=t.id WHERE t.event_id=${eventId} AND r.id=${requestId}::uuid FOR UPDATE OF t`);
    if (!target) fail('POSTER_REQUEST_NOT_FOUND', 404);
    await tx.execute(sql`SELECT id FROM poster_revision_requests WHERE id=${requestId}::uuid FOR UPDATE`);
    const before = await readRevision(tx, requestId);
    if (before.status !== 'open' || !isBeforeClose(await dbNow(tx), new Date(before.closesAt))) fail('POSTER_REQUEST_CLOSED');
    await tx.execute(sql`UPDATE poster_revision_requests SET status='cancelled',cancelled_by=${actor.id},
      cancelled_at=clock_timestamp(),cancellation_reason=${input.reason} WHERE id=${requestId}::uuid`);
    const after = await readRevision(tx, requestId);
    await audit(tx, eventId, target.abstract_id, actor.id, 'revision_cancelled', input.reason, before, after);
    return after;
  });
}
