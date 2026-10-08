import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { presentationValidationErrors } from './public.routes.js';
import type { PresentationDatabase } from './access.js';
import type { PresentationActor, PresentationReconciliationDto } from './types.js';
import { fail, rows } from './access.js';
import { adminOperation, verifyAlias, changePresentationSettings, previewPresentationMail, createNotificationBatch } from './operations.js';
import { reconcilePresentations } from './reconcile.js';
import { readPresentationSettings, readPresentationList, readPresentationDetail, readPresentationBatch } from './readers.js';
import { createPresentationRevision, cancelPresentationRevision } from './revisions.js';
import { resendPresentationMail } from './email-jobs.js';
import { idSchema, operationKeySchema, listQuerySchema, verificationInputSchema, settingsInputSchema, mailPreviewInputSchema, batchInputSchema, createRevisionInputSchema, cancelInputSchema } from './schemas.js';
import type {FastifyPluginAsync,FastifyRequest} from 'fastify';
// Reuse the operation connection: a separate transaction can exhaust a bounded pool.
// Reconciliation uses savepoints and takes its event/settings/target locks after the operation key.
export async function recheckPresentations(database:PresentationDatabase,actor:PresentationActor,eventId:number,key:string):Promise<PresentationReconciliationDto>{
 let reconciliationFailed=false;
 let reconciliationVersion:string|null=null;
 try {
  return await adminOperation(database,actor,eventId,'reconciliation',key,{},async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(20261006,${eventId})`);
   const [settings]=await rows<{last_reconciled_at:string|null}>(tx,sql`SELECT last_reconciled_at FROM presentation_settings WHERE event_id=${eventId}`);
   reconciliationVersion=settings?.last_reconciled_at??null;
   let result:PresentationReconciliationDto;
   try { result=await reconcilePresentations(tx); }
   catch { reconciliationFailed=true;return fail('PRESENTATION_RECONCILE_FAILED',503); }
   if(result.eventId!==eventId)fail('PRESENTATION_EVENT_NOT_FOUND',404);
   return result;
  });
 } catch(error) {
  // The operation rollback also rolls back reconciliation's marker. Persist it afterwards.
  // Permission and idempotency failures must never alter event readiness.
  if(reconciliationFailed)await database.transaction(async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(20261006,${eventId})`);
   // A successful reconciliation after our rollback takes precedence over this failure.
   await tx.execute(sql`UPDATE presentation_settings SET reconcile_ready=false,reconcile_error='PRESENTATION_RECONCILE_FAILED'
    WHERE event_id=${eventId} AND last_reconciled_at IS NOT DISTINCT FROM ${reconciliationVersion}::timestamptz`);
  }).catch(()=>undefined);
  throw error;
 }
}
export const presentationBackofficeRoutes:FastifyPluginAsync<{database:PresentationDatabase}>=async(app,{database})=>{
 presentationValidationErrors(app);
 app.addHook('preValidation',async r=>{
  if(!r.routeOptions.url?.endsWith('/events/:eventId/presentation-targets')||r.method!=='GET')z.object({}).strict().parse(r.query);
 });
 const params=(r:FastifyRequest)=>r.params as Record<string,string>;
 const event=(r:FastifyRequest)=>idSchema.parse(params(r).eventId);
 const actor=(r:FastifyRequest)=>r.user as PresentationActor;
 const key=(r:FastifyRequest)=>operationKeySchema.parse(r.headers['idempotency-key']);
 app.get('/events/:eventId/presentation-settings',async r=>({success:true,data:await readPresentationSettings(database,actor(r),event(r))}));
 app.post('/events/:eventId/presentation-reconciliations',async(r,reply)=>{
  z.object({}).strict().parse(r.body);
  return reply.code(201).send({success:true,data:await recheckPresentations(database,actor(r),event(r),key(r))});
 });
 app.get('/events/:eventId/presentation-targets',async r=>({success:true,data:await readPresentationList(database,actor(r),event(r),listQuerySchema.parse(r.query))}));
 app.get('/events/:eventId/presentation-targets/:abstractId',async r=>({success:true,data:await readPresentationDetail(database,actor(r),event(r),idSchema.parse(params(r).abstractId))}));
 app.get('/events/:eventId/presentation-notification-batches/:batchId',async r=>({success:true,data:await readPresentationBatch(database,actor(r),event(r),z.string().uuid().parse(params(r).batchId))}));
 app.post('/events/:eventId/presentation-verifications',async(r,reply)=>reply.code(201).send({success:true,data:await verifyAlias(database,actor(r),event(r),key(r),verificationInputSchema.parse(r.body))}));
 app.patch('/events/:eventId/presentation-settings',async r=>({success:true,data:await changePresentationSettings(database,actor(r),event(r),key(r),settingsInputSchema.parse(r.body))}));
 app.post('/events/:eventId/presentation-email-previews',async r=>({success:true,data:await previewPresentationMail(database,actor(r),event(r),mailPreviewInputSchema.parse(r.body))}));
 app.post('/events/:eventId/presentation-notification-batches',async(r,reply)=>reply.code(202).send({success:true,data:await createNotificationBatch(database,actor(r),event(r),key(r),batchInputSchema.parse(r.body))}));
 app.post('/events/:eventId/presentation-targets/:abstractId/revision-requests',async(r,reply)=>reply.code(201).send({success:true,data:await createPresentationRevision(database,actor(r),event(r),idSchema.parse(params(r).abstractId),key(r),createRevisionInputSchema.parse(r.body))}));
 app.post('/events/:eventId/presentation-revision-requests/:requestId/cancellations',async(r,reply)=>reply.code(201).send({success:true,data:await cancelPresentationRevision(database,actor(r),event(r),z.string().uuid().parse(params(r).requestId),key(r),cancelInputSchema.parse(r.body))}));
 app.post('/events/:eventId/presentation-email-jobs/:jobId/resends',async(r,reply)=>{
  const {previewFingerprint}=z.object({previewFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(r.body);
  return reply.code(202).send({success:true,data:await resendPresentationMail(database,actor(r),event(r),z.string().uuid().parse(params(r).jobId),key(r),previewFingerprint)});
 });
};
