import { sql } from 'drizzle-orm';
import { createR2ImageStorage, readR2ImageConfig } from '../lucky-wheel/images.js';
import { dbNow, fail, rows, type PosterDatabase } from './access.js';
import { isBeforeClose } from './policy.js';
import type { UploadDto } from './types.js';
import type { AttemptReservation, ValidatedFile } from './uploads.js';

export type PosterStorage = {
  publicBaseUrl: string;
  putObject(input: { key: string; body: Buffer; contentType: string; cacheControl: string; signal?: AbortSignal }): Promise<void>;
  deleteObject(key: string): Promise<void>;
};

export function createPosterStorage(): PosterStorage {
  try {
    const config = readR2ImageConfig();
    if (!new URL(config.publicBaseUrl).hostname.endsWith('.r2.dev')) fail('POSTER_STORAGE_CONFIG', 503);
    return { publicBaseUrl: config.publicBaseUrl, ...createR2ImageStorage(config) };
  } catch { return fail('POSTER_STORAGE_CONFIG', 503); }
}

export async function readUploadDto(q: Pick<PosterDatabase, 'execute'>, id: string): Promise<UploadDto | null> {
  const [upload] = await rows<UploadDto>(q, sql`SELECT id,version,filename AS "fileName",mime_type AS "mimeType",
    size_bytes AS "sizeBytes",public_url AS "publicUrl",received_at AS "receivedAt",request_id AS "revisionRequestId"
    FROM poster_uploads WHERE id=${id}::uuid`);
  return upload ? { ...upload, receivedAt: new Date(upload.receivedAt).toISOString() } : null;
}

export async function storePosterAttempt(database: PosterDatabase, attempt: AttemptReservation,
  file: ValidatedFile, storage: PosterStorage): Promise<void> {
  try {
    await storage.putObject({ key: attempt.objectKey, body: file.buffer, contentType: file.mimeType,
      cacheControl: 'public, max-age=31536000, immutable', signal: AbortSignal.timeout(60_000) });
  } catch { return fail('POSTER_STORAGE_FAILED', 503); }
  const stored = await rows<{ id: string }>(database, sql`UPDATE poster_upload_attempts SET state='stored'
    WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state='reserved'
      AND lease_until>clock_timestamp() RETURNING id`);
  if (!stored.length) fail('POSTER_UPLOAD_RETRY_REQUIRED');
}

export async function cleanupFailedAttempt(database: PosterDatabase, attemptId: string, storage: PosterStorage): Promise<void> {
  const attempt = await database.transaction(async tx => {
    const [context] = await rows<{ target_id: string; event_id: number }>(tx, sql`SELECT a.target_id,t.event_id
      FROM poster_upload_attempts a JOIN poster_targets t ON t.id=a.target_id WHERE a.id=${attemptId}::uuid`);
    if (!context) return null;
    await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${context.event_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM poster_targets WHERE id=${context.target_id}::uuid FOR UPDATE`);
    const [locked] = await rows<{ object_key: string; state: string; lease_until: Date | string; error_code: string | null }>(tx,
      sql`SELECT object_key,state,lease_until,error_code FROM poster_upload_attempts WHERE id=${attemptId}::uuid FOR UPDATE`);
    if (!locked || locked.state === 'accepted' || locked.state === 'cleaned') return null;
    // Protect every successful version, including history and references by object key.
    const used = await rows(tx, sql`SELECT id FROM poster_uploads
      WHERE attempt_id=${attemptId}::uuid OR object_key=${locked.object_key}`);
    if (used.length) return null;
    if (locked.state !== 'cleanup_pending' && !locked.error_code &&
      isBeforeClose(await dbNow(tx), new Date(locked.lease_until))) return null;
    // Terminal claim commits before deletion; a stale finalizer cannot accept this attempt.
    await tx.execute(sql`UPDATE poster_upload_attempts SET state='cleanup_pending' WHERE id=${attemptId}::uuid`);
    return locked;
  });
  if (!attempt) return;
  try {
    await storage.deleteObject(attempt.object_key);
    await database.execute(sql`UPDATE poster_upload_attempts SET state='cleaned'
      WHERE id=${attemptId}::uuid AND state='cleanup_pending'`);
  } catch {
    await database.execute(sql`UPDATE poster_upload_attempts SET error_code='POSTER_CLEANUP_FAILED'
      WHERE id=${attemptId}::uuid AND state='cleanup_pending'`);
  }
}
