import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { rows, fail, dbNow, requirePresentationStaff, type PresentationDatabase, type PresentationTx } from './access.js';
import { sendNipaMailHtml, sendNipaMailText } from '../../services/emailService.js';
import { renderPresentationEmail, PRESENTATION_TEXT_TEMPLATE_VERSION } from './email-template.js';
import type { MailKind, MailPayload, MailState, PresentationActor, UploadDto } from './types.js';
import { adminOperation, audit } from './operations.js';
import { digest, isBeforeClose } from './policy.js';
import { assertInitialReady } from './reconcile.js';
import { operationKeySchema, resendInputSchema } from './schemas.js';

export async function buildMailPayload(tx: Pick<PresentationDatabase, 'execute'>, targetId: string,
  kind: MailKind, requestId?: string, uploadId?: string): Promise<MailPayload> {
  const [work] = await rows<{ abstractId: number; userId: number; trackingId: string; title: string; submitterName: string;
    recipient: string; websiteOrigin: string; closesAt: string | Date }>(tx, sql`
    SELECT a.id AS "abstractId",a.user_id AS "userId",a.tracking_id AS "trackingId",a.title,
      concat_ws(' ',u.first_name,u.last_name) AS "submitterName",u.email AS recipient,
      e.website_url AS "websiteOrigin",s.closes_at AS "closesAt"
    FROM presentation_targets t JOIN abstracts a ON a.id=t.abstract_id JOIN users u ON u.id=a.user_id
    JOIN events e ON e.id=t.event_id JOIN presentation_settings s ON s.event_id=t.event_id
    WHERE t.id=${targetId}::uuid
  `);
  if (!work) fail('PRESENTATION_OWNER_MISSING');
  // Receipt rendering records configuration failure without losing an accepted file.
  if (kind !== 'receipt' && !z.string().email().safeParse(work.recipient).success) fail('PRESENTATION_OWNER_MISSING');
  let close = new Date(work.closesAt).toISOString(), details: string | null = null;
  if (requestId) {
    const [request] = await rows<{ details: string; closes_at: Date | string }>(tx, sql`
      SELECT details,closes_at FROM presentation_revision_requests
      WHERE id=${requestId}::uuid AND target_id=${targetId}::uuid
    `);
    if (!request) fail('PRESENTATION_REQUEST_NOT_FOUND', 404);
    close = new Date(request.closes_at).toISOString();
    details = request.details;
  }
  let upload: UploadDto | null = null;
  if (uploadId) {
    const [file] = await rows<UploadDto>(tx, sql`
      SELECT id,version,filename AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes",
        public_url AS "publicUrl",received_at AS "receivedAt",request_id AS "revisionRequestId"
      FROM presentation_uploads WHERE id=${uploadId}::uuid AND target_id=${targetId}::uuid
    `);
    if (!file) fail('PRESENTATION_UPLOAD_NOT_FOUND', 404);
    upload = { ...file, receivedAt: new Date(file.receivedAt).toISOString() };
  }
  const payload = { ...work, kind, closesAt: kind === 'receipt' ? null : close,
    revisionRequestId: requestId ?? upload?.revisionRequestId ?? null, revisionDetails: details, upload };
  if (kind === 'initial' || kind === 'reminder') {
    const readiness = await rows(tx, sql`SELECT source_row,verified_fingerprint FROM presentation_announcements
      WHERE target_id=${targetId}::uuid AND present ORDER BY source_key`);
    return { ...payload, readiness } as MailPayload;
  }
  return payload;
}

export type PresentationMailTransport = {
  send(input: { recipient: string; subject: string; html: string; text?: string }): Promise<{ providerMessageId?: string }>;
};

export const createPresentationMailTransport = (): PresentationMailTransport => ({
  async send(input) {
    if (input.text !== undefined) await sendNipaMailText(input.recipient, input.subject, input.text, true, { timeoutMs: 15_000 });
    else await sendNipaMailHtml(input.recipient, input.subject, input.html, true, { timeoutMs: 15_000 });
    return {};
  },
});

type ClaimedMail = { id: string; target_id: string; kind: MailKind; request_id: string | null;
  triggered_by: number | null; payload: MailPayload; subject: string; html: string;
  template_version: string; claim_token: string };

const errorCode = (error: unknown, fallback: string) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : fallback;

export async function runPresentationMailOnce(database: PresentationDatabase, transport: PresentationMailTransport): Promise<boolean> {
  if (process.env.PRESENTATION_EMAILS_ENABLED !== 'true') return false;
  const job = await database.transaction(async tx => {
    // Claim only the job here; commit before settings/target/request locks to avoid inversion.
    const [claimed] = await rows<ClaimedMail>(tx, sql`UPDATE presentation_email_jobs SET state='sending',
      claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '3 minutes',request_started_at=NULL
      WHERE id=(SELECT id FROM presentation_email_jobs WHERE state='pending' ORDER BY created_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    if (!claimed) return null;
    await tx.execute(sql`INSERT INTO presentation_email_attempts(job_id,claim_token,result,recipient,subject,html,template_version)
      VALUES(${claimed.id}::uuid,${claimed.claim_token}::uuid,'sending',${claimed.payload.recipient},
        ${claimed.subject},${claimed.html},${claimed.template_version})`);
    return claimed;
  });
  if (!job) return false;
  let state: 'sent' | 'failed' | 'unknown' | 'suppressed' = 'suppressed';
  let code: string | null = null, providerId: string | null = null;
  try {
    await database.transaction(async tx => {
      const [target] = await rows<{ event_id: number }>(tx,
        sql`SELECT event_id FROM presentation_targets WHERE id=${job.target_id}::uuid`);
      if (!target) fail('PRESENTATION_NOT_ELIGIBLE');
      await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${target.event_id} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM presentation_targets WHERE id=${job.target_id}::uuid FOR UPDATE`);
      if (job.kind !== 'receipt') {
        const [staff] = await rows<{ email: string }>(tx, sql`SELECT email FROM backoffice_users WHERE id=${job.triggered_by}`);
        if (!staff) fail('PRESENTATION_ACCESS_DENIED', 403);
        await requirePresentationStaff(tx, { id: job.triggered_by!, role: 'admin', email: staff.email }, target.event_id, true);
        const owner = await rows(tx, sql`SELECT u.id FROM presentation_targets t JOIN abstracts a ON a.id=t.abstract_id
          JOIN users u ON u.id=a.user_id WHERE t.id=${job.target_id}::uuid AND u.status='active'
          AND a.presentation_type='poster'`);
        if (!owner.length) fail('PRESENTATION_OWNER_MISSING');
      }
      if (job.kind === 'initial' || job.kind === 'reminder') {
        await assertInitialReady(tx, job.target_id);
        const current = await buildMailPayload(tx, job.target_id, job.kind);
        if ((await rows(tx, sql`SELECT id FROM presentation_uploads WHERE target_id=${job.target_id}::uuid LIMIT 1`)).length)
          fail('PRESENTATION_ALREADY_SUBMITTED');
        if (!isBeforeClose(await dbNow(tx), new Date(current.closesAt!))) fail('PRESENTATION_DEADLINE_PASSED');
        if (digest(current) !== digest(job.payload)) fail('PRESENTATION_PREVIEW_STALE');
      } else if (job.kind === 'revision') {
        const [request] = await rows<{ status: string; closes_at: Date | string }>(tx,
          sql`SELECT status,closes_at FROM presentation_revision_requests
            WHERE target_id=${job.target_id}::uuid AND id=${job.request_id}::uuid FOR UPDATE`);
        if (!request || request.status !== 'open' || !isBeforeClose(await dbNow(tx), new Date(request.closes_at)))
          fail('PRESENTATION_REQUEST_CLOSED');
        if (digest(await buildMailPayload(tx, job.target_id, 'revision', job.request_id!)) !== digest(job.payload))
          fail('PRESENTATION_PREVIEW_STALE');
      }
      // Receipts send the immutable successful version, regardless of later deadlines/source changes.
      const updated = await rows(tx, sql`UPDATE presentation_email_jobs SET request_started_at=clock_timestamp()
        WHERE id=${job.id}::uuid AND state='sending' AND claim_token=${job.claim_token}::uuid
          AND lease_until>clock_timestamp() RETURNING id`);
      if (!updated.length) fail('PRESENTATION_MAIL_CLAIM_LOST');
      await tx.execute(sql`UPDATE presentation_email_attempts SET request_started_at=clock_timestamp()
        WHERE job_id=${job.id}::uuid AND claim_token=${job.claim_token}::uuid`);
    });
  } catch (error) { code = errorCode(error, 'PRESENTATION_MAIL_PRECHECK_FAILED'); }
  if (!code) {
    try {
      const result = await transport.send({ recipient: job.payload.recipient, subject: job.subject, html: job.html,
        ...(job.template_version === PRESENTATION_TEXT_TEMPLATE_VERSION ? { text: job.html } : {}) });
      state = 'sent'; providerId = result.providerMessageId ?? null;
    } catch (error) {
      state = typeof error === 'object' && error !== null && 'deliveryState' in error && error.deliveryState === 'failed'
        ? 'failed' : 'unknown';
      code = errorCode(error, 'PRESENTATION_MAIL_TRANSPORT_UNKNOWN');
    }
  }
  await database.transaction(async tx => {
    const updated = await rows(tx, sql`UPDATE presentation_email_jobs SET state=${state},finished_at=clock_timestamp(),
      error_code=${code},provider_message_id=${providerId} WHERE id=${job.id}::uuid AND state='sending'
      AND claim_token=${job.claim_token}::uuid RETURNING id`);
    if (updated.length) await tx.execute(sql`UPDATE presentation_email_attempts SET result=${state},finished_at=clock_timestamp(),
      error_code=${code},provider_message_id=${providerId} WHERE job_id=${job.id}::uuid
      AND claim_token=${job.claim_token}::uuid AND result='sending'`);
  });
  return true;
}

export async function recoverPresentationJobs(database: PresentationDatabase): Promise<void> {
  await database.transaction(async tx => {
    const stale = await rows<{ id: string; claim_token: string; request_started_at: Date | null }>(tx,
      sql`SELECT id,claim_token,request_started_at FROM presentation_email_jobs WHERE state='sending'
        AND lease_until<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED`);
    for (const job of stale) {
      await tx.execute(sql`UPDATE presentation_email_jobs SET state=${job.request_started_at ? 'unknown' : 'pending'},
        error_code='PRESENTATION_WORKER_INTERRUPTED',claim_token=NULL,lease_until=NULL,request_started_at=NULL,
        finished_at=${job.request_started_at ? sql`clock_timestamp()` : sql`NULL`} WHERE id=${job.id}::uuid`);
      await tx.execute(sql`UPDATE presentation_email_attempts SET result=${job.request_started_at ? 'unknown' : 'failed'},
        error_code='PRESENTATION_WORKER_INTERRUPTED',finished_at=clock_timestamp()
        WHERE job_id=${job.id}::uuid AND claim_token=${job.claim_token}::uuid AND result='sending'`);
    }
  });
}

export async function enqueuePresentationMail(tx: PresentationTx, targetId: string, payload: MailPayload,
  triggeredBy: number | null, links: { requestId?: string; uploadId?: string; batchId?: string;
    automaticReceiptFor?: string; parentJobId?: string } = {}): Promise<string> {
  const id = randomUUID(), rendered = renderPresentationEmail(payload);
  await tx.execute(sql`
    INSERT INTO presentation_email_jobs(id,target_id,kind,request_id,upload_id,batch_id,automatic_receipt_for,
      triggered_by,parent_job_id,payload,subject,html,template_version)
    VALUES(${id}::uuid,${targetId}::uuid,${payload.kind},${links.requestId ?? null}::uuid,
      ${links.uploadId ?? null}::uuid,${links.batchId ?? null}::uuid,${links.automaticReceiptFor ?? null}::uuid,
      ${triggeredBy},${links.parentJobId ?? null}::uuid,${JSON.stringify(payload)}::jsonb,
      ${rendered.subject},${rendered.html},${rendered.templateVersion})
  `);
  return id;
}

export async function resendPresentationMail(database: PresentationDatabase, actor: PresentationActor, eventId: number,
  jobId: string, key: string, previewFingerprint: string): Promise<{ jobId: string }> {
  jobId = operationKeySchema.parse(jobId).toLowerCase();
  ({ previewFingerprint } = resendInputSchema.parse({ previewFingerprint }));
  return adminOperation(database, actor, eventId, 'mail_resend', key, { jobId, previewFingerprint }, async tx => {
    await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${eventId} FOR SHARE`);
    const [old] = await rows<{ target_id: string; kind: MailKind; request_id: string | null; upload_id: string | null; state: MailState }>(tx,
      sql`SELECT j.target_id,j.kind,j.request_id,j.upload_id,j.state FROM presentation_email_jobs j
        JOIN presentation_targets t ON t.id=j.target_id WHERE j.id=${jobId}::uuid AND t.event_id=${eventId}`);
    if (!old) fail('PRESENTATION_MAIL_NOT_FOUND', 404);
    await tx.execute(sql`SELECT id FROM presentation_targets WHERE id=${old.target_id}::uuid FOR UPDATE`);
    if (old.kind === 'revision') {
      const [request] = await rows<{ status: string; closes_at: string | Date }>(tx, sql`SELECT status,closes_at
        FROM presentation_revision_requests WHERE id=${old.request_id}::uuid AND target_id=${old.target_id}::uuid FOR UPDATE`);
      if (request?.status !== 'open' || !isBeforeClose(await dbNow(tx), new Date(request.closes_at))) fail('PRESENTATION_REQUEST_CLOSED');
    } else if (old.kind === 'initial' || old.kind === 'reminder') {
      await assertInitialReady(tx, old.target_id);
      if ((await rows(tx, sql`SELECT id FROM presentation_uploads WHERE target_id=${old.target_id}::uuid LIMIT 1`)).length) fail('PRESENTATION_ALREADY_SUBMITTED');
    }
    // Shared lock order: settings, target, request (when linked), then mail job.
    const [current] = await rows<{ state: MailState }>(tx, sql`SELECT state FROM presentation_email_jobs WHERE id=${jobId}::uuid FOR UPDATE`);
    if (current.state === 'pending' || current.state === 'sending') fail('PRESENTATION_MAIL_IN_PROGRESS');
    const payload = await buildMailPayload(tx, old.target_id, old.kind, old.request_id ?? undefined, old.upload_id ?? undefined);
    if ((old.kind === 'initial' || old.kind === 'reminder') && !isBeforeClose(await dbNow(tx), new Date(payload.closesAt!))) fail('PRESENTATION_DEADLINE_PASSED');
    if (digest([payload]) !== previewFingerprint) fail('PRESENTATION_PREVIEW_STALE');
    const newId = await enqueuePresentationMail(tx, old.target_id, payload, actor.id, {
      requestId: old.request_id ?? undefined, uploadId: old.upload_id ?? undefined, parentJobId: jobId });
    await audit(tx, eventId, payload.abstractId, actor.id, 'mail_resent', null, { jobId }, { jobId: newId });
    return { jobId: newId };
  });
}
