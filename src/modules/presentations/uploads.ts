import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { dbNow, fail, requirePresentationOwner, rows, type PresentationDatabase, type PresentationTx } from './access.js';
import { digest, isBeforeClose } from './policy.js';
import { assertInitialReady } from './reconcile.js';
import { cleanupFailedAttempt, readUploadDto, storePresentationAttempt, type PresentationStorage } from './storage.js';
import { buildMailPayload } from './email-jobs.js';
import { renderPresentationEmail } from './email-template.js';
import type { PresentationActor, UploadDto } from './types.js';
import { validatePresentationFile } from './file-validation.js';

export type ValidatedFile = Awaited<ReturnType<typeof validatePresentationFile>>;
export type UploadGate = { targetId: string; eventId: number; abstractId: number; closesAt: Date; requestId: string | null };
export type AttemptReservation = { kind: 'reserved' | 'stored' | 'replay'; attemptId: string; claimToken: string;
  objectKey: string; upload: UploadDto | null };

export async function readUploadGate(tx: PresentationTx, actor: PresentationActor, abstractId: number,
  requestId: string | null): Promise<UploadGate> {
  const [event] = await rows<{ event_id: number }>(tx, sql`SELECT event_id FROM abstracts WHERE id=${abstractId}`);
  if (!event) fail('PRESENTATION_OWNER_REQUIRED', 403);
  const [setting] = await rows<{ closes_at: Date | string }>(tx,
    sql`SELECT closes_at FROM presentation_settings WHERE event_id=${event.event_id} FOR SHARE`);
  if (!setting) fail('PRESENTATION_RECONCILE_REQUIRED', 503);
  const owner = await requirePresentationOwner(tx, actor, abstractId, true);
  if (owner.presentationType !== 'poster') fail('PRESENTATION_NOT_ELIGIBLE');
  const [target] = await rows<{ id: string; current_upload_id: string | null }>(tx, sql`SELECT id,current_upload_id
    FROM presentation_targets WHERE event_id=${event.event_id} AND abstract_id=${abstractId} FOR UPDATE`);
  if (!target) fail('PRESENTATION_NOT_ELIGIBLE');
  let close = new Date(setting.closes_at);
  if (requestId) {
    const [request] = await rows<{ status: string; closes_at: Date | string }>(tx,
      sql`SELECT status,closes_at FROM presentation_revision_requests WHERE id=${requestId}::uuid AND target_id=${target.id}::uuid FOR UPDATE`);
    if (!request) fail('PRESENTATION_REQUEST_NOT_FOUND', 404);
    if (request.status === 'cancelled') fail('PRESENTATION_REQUEST_CANCELLED');
    if (request.status !== 'open') fail('PRESENTATION_REQUEST_CLOSED');
    close = new Date(request.closes_at);
  } else {
    if (target.current_upload_id) fail('PRESENTATION_ALREADY_SUBMITTED');
    await assertInitialReady(tx, target.id);
  }
  if (!isBeforeClose(await dbNow(tx), close)) fail(requestId ? 'PRESENTATION_REQUEST_EXPIRED' : 'PRESENTATION_DEADLINE_PASSED');
  return { targetId: target.id, eventId: event.event_id, abstractId, closesAt: close, requestId };
}

export async function reserveUploadAttempt(database: PresentationDatabase, actor: PresentationActor, abstractId: number,
  key: string, requestId: string | null, file: ValidatedFile): Promise<AttemptReservation> {
  requestId = requestId?.toLowerCase() ?? null;
  return database.transaction(async tx => {
    const owner = await requirePresentationOwner(tx, actor, abstractId);
    await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${owner.eventId} FOR SHARE`);
    await requirePresentationOwner(tx, actor, abstractId, true);
    const [target] = await rows<{ id: string }>(tx, sql`SELECT id FROM presentation_targets
      WHERE event_id=${owner.eventId} AND abstract_id=${abstractId} FOR UPDATE`);
    if (!target) fail('PRESENTATION_NOT_ELIGIBLE');
    if (requestId) await tx.execute(sql`SELECT id FROM presentation_revision_requests
      WHERE id=${requestId}::uuid AND target_id=${target.id}::uuid FOR UPDATE`);
    const fingerprint = digest({ abstractId, requestId, userId: actor.id, digest: file.digest,
      filename: file.filename, size: file.sizeBytes });
    const [old] = await rows<{ id: string; fingerprint: string; state: string; claim_token: string;
      object_key: string; lease_until: Date | string }>(tx,
      sql`SELECT * FROM presentation_upload_attempts WHERE target_id=${target.id}::uuid
        AND user_id=${actor.id} AND operation_key=${key}::uuid FOR UPDATE`);
    if (old) {
      if (old.fingerprint !== fingerprint) fail('PRESENTATION_IDEMPOTENCY_CONFLICT');
      const successful = await readBoundUpload(tx, actor, abstractId, requestId,
        { attemptId: old.id, claimToken: old.claim_token, objectKey: old.object_key });
      if (successful) return { kind: 'replay', attemptId: old.id, claimToken: old.claim_token, objectKey: old.object_key, upload: successful };
      if (!isBeforeClose(await dbNow(tx), new Date(old.lease_until))) fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
      if (old.state === 'stored') return { kind: 'stored', attemptId: old.id, claimToken: old.claim_token, objectKey: old.object_key, upload: null };
      fail(old.state === 'reserved' ? 'PRESENTATION_UPLOAD_IN_PROGRESS' : 'PRESENTATION_UPLOAD_RETRY_REQUIRED');
    }
    const gate = await readUploadGate(tx, actor, abstractId, requestId), id = randomUUID(), claimToken = randomUUID();
    const objectKey = `events/${gate.eventId}/presentations/${abstractId}/${id}.${file.extension}`;
    await tx.execute(sql`INSERT INTO presentation_upload_attempts(id,target_id,user_id,request_id,operation_key,fingerprint,
      object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token)
      VALUES(${id}::uuid,${gate.targetId}::uuid,${actor.id},${requestId}::uuid,${key}::uuid,${fingerprint},${objectKey},
        ${file.filename},${file.mimeType},${file.sizeBytes},${file.digest},clock_timestamp()+interval '5 minutes',${claimToken}::uuid)`);
    return { kind: 'reserved', attemptId: id, claimToken, objectKey, upload: null };
  });
}

// Bind recovery to the actual resource, including when the actor owns multiple abstracts.
async function readBoundUpload(tx: PresentationTx, actor: PresentationActor, abstractId: number,
  requestId: string | null, attempt: Pick<AttemptReservation, 'attemptId' | 'claimToken' | 'objectKey'>): Promise<UploadDto | null> {
  await requirePresentationOwner(tx, actor, abstractId, true);
  const [bound] = await rows<{ id: string }>(tx, sql`SELECT u.id FROM presentation_uploads u
    JOIN presentation_targets t ON t.id=u.target_id JOIN presentation_upload_attempts a ON a.id=u.attempt_id
    WHERE u.attempt_id=${attempt.attemptId}::uuid AND t.abstract_id=${abstractId} AND u.user_id=${actor.id}
      AND u.request_id IS NOT DISTINCT FROM ${requestId}::uuid AND a.user_id=${actor.id}
      AND a.request_id IS NOT DISTINCT FROM ${requestId}::uuid AND a.claim_token=${attempt.claimToken}::uuid
      AND a.object_key=${attempt.objectKey} AND u.object_key=a.object_key`);
  return bound ? readUploadDto(tx, bound.id) : null;
}

export async function finalizePresentationAttempt(database: PresentationDatabase, actor: PresentationActor, abstractId: number,
  requestId: string | null, attempt: AttemptReservation, storage: PresentationStorage): Promise<UploadDto> {
  requestId = requestId?.toLowerCase() ?? null;
  return database.transaction(async tx => {
    const owner = await requirePresentationOwner(tx, actor, abstractId);
    await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${owner.eventId} FOR SHARE`);
    await requirePresentationOwner(tx, actor, abstractId, true);
    const [target] = await rows<{ id: string }>(tx, sql`SELECT id FROM presentation_targets
      WHERE event_id=${owner.eventId} AND abstract_id=${abstractId} FOR UPDATE`);
    if (!target) fail('PRESENTATION_NOT_ELIGIBLE');
    if (requestId) await tx.execute(sql`SELECT id FROM presentation_revision_requests
      WHERE id=${requestId}::uuid AND target_id=${target.id}::uuid FOR UPDATE`);
    const [a] = await rows<{ id: string; target_id: string; user_id: number; request_id: string | null;
      claim_token: string; state: string; lease_until: Date | string; object_key: string; filename: string;
      mime_type: string; size_bytes: number; digest: string }>(tx,
      sql`SELECT * FROM presentation_upload_attempts WHERE id=${attempt.attemptId}::uuid FOR UPDATE`);
    if (!a || a.target_id !== target.id || a.user_id !== actor.id || a.request_id !== requestId ||
      a.claim_token !== attempt.claimToken || a.object_key !== attempt.objectKey) fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
    const existing = await readBoundUpload(tx, actor, abstractId, requestId, attempt);
    if (existing) return existing;
    const gate = await readUploadGate(tx, actor, abstractId, requestId);
    if (a.state !== 'stored' || !isBeforeClose(await dbNow(tx), new Date(a.lease_until))) fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
    const [count] = await rows<{ n: number }>(tx,
      sql`SELECT COALESCE(max(version),0)::int AS n FROM presentation_uploads WHERE target_id=${gate.targetId}::uuid`);
    const acceptedAt = await dbNow(tx);
    if (!isBeforeClose(acceptedAt, gate.closesAt)) fail(requestId ? 'PRESENTATION_REQUEST_EXPIRED' : 'PRESENTATION_DEADLINE_PASSED');
    const publicUrl = new URL(a.object_key, `${storage.publicBaseUrl.replace(/\/$/, '')}/`).toString();
    await tx.execute(sql`INSERT INTO presentation_uploads(id,target_id,attempt_id,request_id,version,user_id,object_key,
      public_url,filename,mime_type,size_bytes,digest,received_at)
      VALUES(${a.id}::uuid,${gate.targetId}::uuid,${a.id}::uuid,${requestId}::uuid,${count.n + 1},${actor.id},
        ${a.object_key},${publicUrl},${a.filename},${a.mime_type},${a.size_bytes},${a.digest},${acceptedAt.toISOString()}::timestamptz)`);
    await tx.execute(sql`UPDATE presentation_targets SET current_upload_id=${a.id}::uuid WHERE id=${gate.targetId}::uuid`);
    if (requestId) await tx.execute(sql`UPDATE presentation_revision_requests SET status='submitted',
      submitted_at=${acceptedAt.toISOString()}::timestamptz WHERE id=${requestId}::uuid AND target_id=${gate.targetId}::uuid AND status='open'`);
    await tx.execute(sql`UPDATE presentation_upload_attempts SET state='accepted',error_code=NULL WHERE id=${a.id}::uuid`);
    const upload = (await readUploadDto(tx, a.id))!;
    // SQL reads/inserts stay outside the pure renderer catch: database failures roll back acceptance.
    const payload = await buildMailPayload(tx, gate.targetId, 'receipt', requestId ?? undefined, a.id);
    let receipt;
    try { receipt = { ...renderPresentationEmail(payload), state: 'pending', errorCode: null }; }
    catch { receipt = { subject: 'ระบบได้รับไฟล์ Poster แล้ว', html: '', templateVersion: 'presentation-v1',
      state: 'failed', errorCode: 'PRESENTATION_RECEIPT_CONFIG_FAILED' }; }
    await tx.execute(sql`INSERT INTO presentation_email_jobs(target_id,kind,upload_id,request_id,automatic_receipt_for,
      payload,subject,html,template_version,state,error_code)
      VALUES(${gate.targetId}::uuid,'receipt',${a.id}::uuid,${requestId}::uuid,${a.id}::uuid,${JSON.stringify(payload)}::jsonb,
        ${receipt.subject},${receipt.html},${receipt.templateVersion},${receipt.state},${receipt.errorCode})`);
    return upload;
  });
}

export async function submitPresentationUpload(database: PresentationDatabase, actor: PresentationActor, abstractId: number,
  key: string, requestId: string | null, file: { buffer: Buffer; filename: string; mimetype: string },
  storage: PresentationStorage): Promise<{ upload: UploadDto; replayed: boolean }> {
  requestId = requestId?.toLowerCase() ?? null;
  await requirePresentationOwner(database, actor, abstractId);
  const validated = await validatePresentationFile(file);
  const attempt = await reserveUploadAttempt(database, actor, abstractId, key, requestId, validated);
  if (attempt.kind === 'replay') return { upload: attempt.upload!, replayed: true };
  try {
    if (attempt.kind === 'reserved') await storePresentationAttempt(database, attempt, validated, storage);
    return { upload: await finalizePresentationAttempt(database, actor, abstractId, requestId, attempt, storage), replayed: false };
  } catch (error) {
    let committed: UploadDto | null;
    try { committed = await database.transaction(tx => readBoundUpload(tx, actor, abstractId, requestId, attempt)); }
    catch { throw error; } // Unknown database outcome: leave the object recoverable, never delete blindly.
    if (committed) return { upload: committed, replayed: true };
    await database.execute(sql`UPDATE presentation_upload_attempts SET error_code='PRESENTATION_UPLOAD_FAILED'
      WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state IN ('reserved','stored')`).catch(() => undefined);
    await cleanupFailedAttempt(database, attempt.attemptId, storage).catch(() => undefined);
    throw error;
  }
}
