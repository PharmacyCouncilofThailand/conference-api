import { sql } from 'drizzle-orm';
import { createR2ImageStorage, readR2ImageConfig } from '../lucky-wheel/images.js';
import { dbNow, fail, rows, type PresentationDatabase } from './access.js';
import { isBeforeClose } from './policy.js';
import type { DriveLocation, StorageProvider, UploadDto } from './types.js';
import type { AttemptReservation, ValidatedFile } from './uploads.js';
import { ApiError } from '../../errors/ApiError.js';
import { generatePresentationDriveFileId, getOrCreatePresentationDriveFolder, writePresentationDriveFile,
  deleteFromGoogleDrive, type DriveWriteInput } from '../../services/googleDrive.js';

export type R2PresentationStorage = {
  publicBaseUrl: string;
  putObject(input: { key: string; body: Buffer; contentType: string; cacheControl: string; signal?: AbortSignal }): Promise<void>;
  deleteObject(key: string): Promise<void>;
};
export type DrivePresentationStorage = { rootFolderId(): string; generateId(): Promise<string>;
  folder(parentId: string, name: string): Promise<string>;
  write(input: DriveWriteInput): Promise<{ fileId: string; fileUrl: string; storedFileName: string }>;
  delete(fileId: string): Promise<void> };
export type PresentationStorage = { r2: () => R2PresentationStorage; drive: DrivePresentationStorage };

export function createPresentationStorage(): PresentationStorage {
  return { r2: () => { try {
    const config = readR2ImageConfig();
    if (!new URL(config.publicBaseUrl).hostname.endsWith('.r2.dev')) fail('PRESENTATION_STORAGE_CONFIG', 503);
    return { publicBaseUrl: config.publicBaseUrl, ...createR2ImageStorage(config) };
  } catch { return fail('PRESENTATION_STORAGE_CONFIG', 503); } },
  drive: {
    rootFolderId: () => { const id = process.env.GOOGLE_DRIVE_FOLDER_ABSTRACTS?.trim();
      if (!id) return fail('PRESENTATION_STORAGE_CONFIG', 503); return id; },
    generateId: () => generatePresentationDriveFileId(), folder: (parent, name) => getOrCreatePresentationDriveFolder(parent, name),
    write: input => writePresentationDriveFile(input), delete: async id => {
      try { await deleteFromGoogleDrive(id); }
      catch (error) { if ((error as { code?: number }).code !== 404) throw error; }
    },
  } };
}

export async function readUploadDto(q: Pick<PresentationDatabase, 'execute'>, id: string): Promise<UploadDto | null> {
  const [upload] = await rows<UploadDto>(q, sql`SELECT id,version,original_filename AS "fileName",stored_filename AS "storedFileName",mime_type AS "mimeType",
    size_bytes AS "sizeBytes",file_url AS "fileUrl",storage_provider AS "storageProvider",drive_file_id AS "driveFileId",
    received_at AS "receivedAt",request_id AS "revisionRequestId"
    FROM presentation_uploads WHERE id=${id}::uuid`);
  return upload ? { ...upload, receivedAt: new Date(upload.receivedAt).toISOString() } : null;
}

async function resolveOralFolder(database: PresentationDatabase, location: DriveLocation, storage: PresentationStorage): Promise<string> {
  let parent = storage.drive.rootFolderId();
  for (const name of [location.eventCode, 'Oral', 'Presentation Oral', location.categoryName, location.trackingId]) {
    const currentParent = parent;
    parent = await database.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`presentation-folder:${currentParent}:${name}`},0))`);
      return storage.drive.folder(currentParent, name);
    });
  }
  return parent;
}

export async function storePresentationAttempt(database: PresentationDatabase, attempt: AttemptReservation,
  file: ValidatedFile, storage: PresentationStorage): Promise<void> {
  const [claim] = await rows<{ id: string }>(database, sql`SELECT id FROM presentation_upload_attempts
    WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state='reserved' AND lease_until>clock_timestamp()`);
  if (!claim) fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
  try {
    if (attempt.identity.storageProvider === 'drive') {
      if (!attempt.location) return fail('PRESENTATION_STORAGE_CONTEXT_INVALID');
      if (!attempt.identity.driveFileId) {
        const folderId = await resolveOralFolder(database, attempt.location, storage);
        const fileId = await storage.drive.generateId();
        const [identity] = await rows<{ driveFileId: string; driveFolderId: string }>(database, sql`
          UPDATE presentation_upload_attempts SET drive_file_id=${fileId},drive_folder_id=${folderId}
          WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state='reserved'
            AND lease_until>clock_timestamp() AND drive_file_id IS NULL AND drive_folder_id IS NULL
          RETURNING drive_file_id AS "driveFileId",drive_folder_id AS "driveFolderId"`);
        if (!identity) fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
        attempt.identity.driveFileId = identity.driveFileId;
        attempt.identity.driveFolderId = identity.driveFolderId;
      }
      if (!attempt.identity.driveFolderId) return fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
      const written = await storage.drive.write({ fileId: attempt.identity.driveFileId!, parentId: attempt.identity.driveFolderId,
        fileName: attempt.identity.storedFileName, buffer: file.buffer, digest: file.digest, md5Checksum: file.md5Checksum, attemptId: attempt.attemptId });
      attempt.identity.fileUrl = written.fileUrl;
    } else {
      await storage.r2().putObject({ key: attempt.identity.objectKey!, body: file.buffer, contentType: file.mimeType,
        cacheControl: 'public, max-age=31536000, immutable', signal: AbortSignal.timeout(60_000) });
    }
  } catch (error) {
    if (error instanceof ApiError || (error as { storageOutcome?: string }).storageOutcome === 'unknown') throw error;
    return fail('PRESENTATION_STORAGE_FAILED', 503);
  }
  const stored = await rows<{ id: string }>(database, sql`UPDATE presentation_upload_attempts SET state='stored'
    WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state='reserved'
      AND lease_until>clock_timestamp() RETURNING id`);
  if (!stored.length) fail('PRESENTATION_UPLOAD_RETRY_REQUIRED');
}

export async function cleanupFailedAttempt(database: PresentationDatabase, attemptId: string, storage: PresentationStorage): Promise<void> {
  const attempt = await database.transaction(async tx => {
    const [context] = await rows<{ target_id: string; event_id: number }>(tx, sql`SELECT a.target_id,t.event_id
      FROM presentation_upload_attempts a JOIN presentation_targets t ON t.id=a.target_id WHERE a.id=${attemptId}::uuid`);
    if (!context) return null;
    await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${context.event_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM presentation_targets WHERE id=${context.target_id}::uuid FOR UPDATE`);
    const [locked] = await rows<{ storage_provider: StorageProvider; object_key: string | null; drive_file_id: string | null;
      state: string; lease_until: Date | string; error_code: string | null }>(tx,
      sql`SELECT storage_provider,object_key,drive_file_id,state,lease_until,error_code FROM presentation_upload_attempts WHERE id=${attemptId}::uuid FOR UPDATE`);
    if (!locked || locked.state === 'accepted' || locked.state === 'cleaned') return null;
    // Protect every successful version, including history and references by object key.
    const used = await rows(tx, sql`SELECT id FROM presentation_uploads
      WHERE attempt_id=${attemptId}::uuid OR (storage_provider=${locked.storage_provider}
        AND (object_key=${locked.object_key} OR drive_file_id=${locked.drive_file_id}))`);
    if (used.length) return null;
    if (locked.state !== 'cleanup_pending' && !locked.error_code &&
      isBeforeClose(await dbNow(tx), new Date(locked.lease_until))) return null;
    // Terminal claim commits before deletion; a stale finalizer cannot accept this attempt.
    await tx.execute(sql`UPDATE presentation_upload_attempts SET state='cleanup_pending' WHERE id=${attemptId}::uuid`);
    return locked;
  });
  if (!attempt) return;
  try {
    if (attempt.storage_provider === 'drive') {
      if (attempt.drive_file_id) await storage.drive.delete(attempt.drive_file_id);
    } else await storage.r2().deleteObject(attempt.object_key!);
    await database.execute(sql`UPDATE presentation_upload_attempts SET state='cleaned'
      WHERE id=${attemptId}::uuid AND state='cleanup_pending'`);
  } catch {
    await database.execute(sql`UPDATE presentation_upload_attempts SET error_code='PRESENTATION_CLEANUP_FAILED'
      WHERE id=${attemptId}::uuid AND state='cleanup_pending'`);
  }
}
