import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { rows, type PresentationDatabase, type PresentationTx } from './access.js';
import { audit } from './operations.js';
import type { PresentationStorage } from './storage.js';
import type { StorageProvider } from './types.js';

export async function enqueueReplacedFileDeletions(tx: PresentationTx, targetId: string, replacementId: string): Promise<void> {
  await tx.execute(sql`INSERT INTO presentation_file_deletions(upload_id,target_id,replacement_upload_id)
    SELECT old.id,old.target_id,new.id FROM presentation_uploads old
    JOIN presentation_uploads new ON new.target_id=old.target_id
    WHERE new.id=${replacementId}::uuid AND old.target_id=${targetId}::uuid AND old.version<new.version
    ON CONFLICT(upload_id) DO NOTHING`);
}

type DeletionClaim = { upload_id: string; target_id: string; replacement_upload_id: string;
  claim_token: string; attempt_count: number; event_id: number; abstract_id: number;
  storage_provider: StorageProvider; object_key: string | null; drive_file_id: string | null; safe: boolean };

export async function claimReplacedFileDeletion(database: PresentationDatabase): Promise<DeletionClaim | null> {
  return database.transaction(async tx => {
    const [candidate] = await rows<{ upload_id: string; target_id: string; event_id: number }>(tx,
      sql`SELECT d.upload_id,d.target_id,t.event_id FROM presentation_file_deletions d
        JOIN presentation_targets t ON t.id=d.target_id
        WHERE (d.state='pending' AND d.next_attempt_at<=clock_timestamp())
          OR (d.state='deleting' AND d.lease_until<=clock_timestamp())
        ORDER BY d.next_attempt_at,d.created_at,d.upload_id LIMIT 1`);
    if (!candidate) return null;
    await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${candidate.event_id} FOR SHARE`);
    const locked = await rows(tx, sql`SELECT id FROM presentation_targets
      WHERE id=${candidate.target_id}::uuid FOR UPDATE SKIP LOCKED`);
    if (!locked.length) return null;
    const [job] = await rows<DeletionClaim>(tx, sql`SELECT d.*,t.event_id,t.abstract_id,u.storage_provider,u.object_key,u.drive_file_id,
      (t.current_upload_id IS NOT NULL AND t.current_upload_id<>u.id AND new.version>u.version
        AND old_attempt.state='accepted' AND new_attempt.state='accepted'
        AND NOT EXISTS(SELECT 1 FROM presentation_targets ct JOIN presentation_uploads cu ON cu.id=ct.current_upload_id
          WHERE cu.storage_provider=u.storage_provider AND
            ((u.object_key IS NOT NULL AND cu.object_key=u.object_key)
              OR (u.drive_file_id IS NOT NULL AND cu.drive_file_id=u.drive_file_id)))) AS safe
      FROM presentation_file_deletions d JOIN presentation_targets t ON t.id=d.target_id
      JOIN presentation_uploads u ON u.id=d.upload_id AND u.target_id=d.target_id
      JOIN presentation_uploads new ON new.id=d.replacement_upload_id AND new.target_id=d.target_id
      JOIN presentation_upload_attempts old_attempt ON old_attempt.id=u.attempt_id
      JOIN presentation_upload_attempts new_attempt ON new_attempt.id=new.attempt_id
      WHERE d.upload_id=${candidate.upload_id}::uuid AND
        ((d.state='pending' AND d.next_attempt_at<=clock_timestamp())
          OR (d.state='deleting' AND d.lease_until<=clock_timestamp())) FOR UPDATE OF d SKIP LOCKED`);
    if (!job) return null;
    const token = randomUUID();
    await tx.execute(sql`UPDATE presentation_file_deletions SET state='deleting',claim_token=${token}::uuid,
      lease_until=clock_timestamp()+interval '3 minutes',attempt_count=attempt_count+1 WHERE upload_id=${job.upload_id}::uuid`);
    return { ...job, claim_token: token, attempt_count: job.attempt_count + 1 };
  });
}

export async function finishReplacedFileDeletion(database: PresentationDatabase, job: DeletionClaim): Promise<void> {
  await database.transaction(async tx => {
    const changed = await rows(tx, sql`UPDATE presentation_file_deletions SET state='deleted',deleted_at=clock_timestamp(),
      claim_token=NULL,lease_until=NULL,error_code=NULL WHERE upload_id=${job.upload_id}::uuid
        AND state='deleting' AND claim_token=${job.claim_token}::uuid RETURNING upload_id`);
    if (changed.length) await audit(tx, job.event_id, job.abstract_id, null, 'file_deleted', null, null,
      { uploadId: job.upload_id, replacementUploadId: job.replacement_upload_id });
  });
}

async function retryDeletion(database: PresentationDatabase, job: DeletionClaim, code: string): Promise<void> {
  const seconds = Math.min(3600, 60 * 2 ** Math.min(job.attempt_count - 1, 6));
  await database.execute(sql`UPDATE presentation_file_deletions SET state='pending',claim_token=NULL,lease_until=NULL,
    next_attempt_at=clock_timestamp()+${seconds}*interval '1 second',error_code=${code}
    WHERE upload_id=${job.upload_id}::uuid AND state='deleting' AND claim_token=${job.claim_token}::uuid`);
}

export async function runReplacedFileDeletionOnce(database: PresentationDatabase, storage: PresentationStorage): Promise<boolean> {
  const job = await claimReplacedFileDeletion(database);
  if (!job) return false;
  if (!job.safe) {
    await retryDeletion(database, job, 'PRESENTATION_DELETE_UNSAFE');
    return true;
  }
  try {
    const signal = AbortSignal.timeout(15_000);
    if (job.storage_provider === 'drive') await storage.drive.delete(job.drive_file_id!, signal);
    else await storage.r2().deleteObject(job.object_key!, signal);
    await finishReplacedFileDeletion(database, job);
  } catch {
    // Unknown delete/COMMIT outcomes retry the same immutable identity; absence is success.
    await retryDeletion(database, job, 'PRESENTATION_DELETE_FAILED');
  }
  return true;
}
