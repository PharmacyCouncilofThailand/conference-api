import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { posterValidationErrors } from './public.routes.js';
import type { PosterDatabase } from './access.js';
import type { PosterActor, PosterReconciliationDto } from './types.js';
import { fail, rows } from './access.js';
import { adminOperation, verifyAlias, changePosterSettings, previewPosterMail, createNotificationBatch } from './operations.js';
import { reconcilePosters } from './reconcile.js';
import { readPosterSettings, readPosterList, readPosterDetail, readPosterBatch } from './readers.js';
import { createPosterRevision, cancelPosterRevision } from './revisions.js';
import { resendPosterMail } from './email-jobs.js';
import { idSchema, operationKeySchema, listQuerySchema, verificationInputSchema, settingsInputSchema, mailPreviewInputSchema, batchInputSchema, createRevisionInputSchema, cancelInputSchema } from './schemas.js';
import type {FastifyPluginAsync,FastifyRequest} from 'fastify';
// Reuse the operation connection: a separate transaction can exhaust a bounded pool.
// Reconciliation uses savepoints and takes its event/settings/target locks after the operation key.
export async function recheckPosters(database:PosterDatabase,actor:PosterActor,eventId:number,key:string):Promise<PosterReconciliationDto>{
 let reconciliationFailed=false;
 let reconciliationVersion:string|null=null;
 try {
  return await adminOperation(database,actor,eventId,'reconciliation',key,{},async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(20261006,${eventId})`);
   const [settings]=await rows<{last_reconciled_at:string|null}>(tx,sql`SELECT last_reconciled_at FROM poster_settings WHERE event_id=${eventId}`);
   reconciliationVersion=settings?.last_reconciled_at??null;
   let result:PosterReconciliationDto;
   try { result=await reconcilePosters(tx); }
   catch { reconciliationFailed=true;return fail('POSTER_RECONCILE_FAILED',503); }
   if(result.eventId!==eventId)fail('POSTER_EVENT_NOT_FOUND',404);
   return result;
  });
 } catch(error) {
  // The operation rollback also rolls back reconciliation's marker. Persist it afterwards.
  // Permission and idempotency failures must never alter event readiness.
  if(reconciliationFailed)await database.transaction(async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(20261006,${eventId})`);
   // A successful reconciliation after our rollback takes precedence over this failure.
   await tx.execute(sql`UPDATE poster_settings SET reconcile_ready=false,reconcile_error='POSTER_RECONCILE_FAILED'
    WHERE event_id=${eventId} AND last_reconciled_at IS NOT DISTINCT FROM ${reconciliationVersion}::timestamptz`);
  }).catch(()=>undefined);
  throw error;
 }
}
export const posterBackofficeRoutes:FastifyPluginAsync<{database:PosterDatabase}>=async(app,{database})=>{
 posterValidationErrors(app);
 app.addHook('preValidation',async r=>{
  if(!r.routeOptions.url?.endsWith('/events/:eventId/poster-targets')||r.method!=='GET')z.object({}).strict().parse(r.query);
 });
 const params=(r:FastifyRequest)=>r.params as Record<string,string>;
 const event=(r:FastifyRequest)=>idSchema.parse(params(r).eventId);
 const actor=(r:FastifyRequest)=>r.user as PosterActor;
 const key=(r:FastifyRequest)=>operationKeySchema.parse(r.headers['idempotency-key']);
 app.get('/events/:eventId/poster-settings',async r=>({success:true,data:await readPosterSettings(database,actor(r),event(r))}));
 app.post('/events/:eventId/poster-reconciliations',async(r,reply)=>{
  z.object({}).strict().parse(r.body);
  return reply.code(201).send({success:true,data:await recheckPosters(database,actor(r),event(r),key(r))});
 });
 app.get('/events/:eventId/poster-targets',async r=>({success:true,data:await readPosterList(database,actor(r),event(r),listQuerySchema.parse(r.query))}));
 app.get('/events/:eventId/poster-targets/:abstractId',async r=>({success:true,data:await readPosterDetail(database,actor(r),event(r),idSchema.parse(params(r).abstractId))}));
 app.get('/events/:eventId/poster-notification-batches/:batchId',async r=>({success:true,data:await readPosterBatch(database,actor(r),event(r),z.string().uuid().parse(params(r).batchId))}));
 app.post('/events/:eventId/poster-verifications',async(r,reply)=>reply.code(201).send({success:true,data:await verifyAlias(database,actor(r),event(r),key(r),verificationInputSchema.parse(r.body))}));
 app.patch('/events/:eventId/poster-settings',async r=>({success:true,data:await changePosterSettings(database,actor(r),event(r),key(r),settingsInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-email-previews',async r=>({success:true,data:await previewPosterMail(database,actor(r),event(r),mailPreviewInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-notification-batches',async(r,reply)=>reply.code(202).send({success:true,data:await createNotificationBatch(database,actor(r),event(r),key(r),batchInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-targets/:abstractId/revision-requests',async(r,reply)=>reply.code(201).send({success:true,data:await createPosterRevision(database,actor(r),event(r),idSchema.parse(params(r).abstractId),key(r),createRevisionInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-revision-requests/:requestId/cancellations',async(r,reply)=>reply.code(201).send({success:true,data:await cancelPosterRevision(database,actor(r),event(r),z.string().uuid().parse(params(r).requestId),key(r),cancelInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-email-jobs/:jobId/resends',async(r,reply)=>{
  const {previewFingerprint}=z.object({previewFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(r.body);
  return reply.code(202).send({success:true,data:await resendPosterMail(database,actor(r),event(r),z.string().uuid().parse(params(r).jobId),key(r),previewFingerprint)});
 });
};
