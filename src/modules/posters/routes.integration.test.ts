import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify, {type FastifyError} from 'fastify';
import type {PosterActor} from './types.js';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { ApiError } from '../../errors/ApiError.js';
import { posterAnnouncementRoutes, posterOwnerRoutes } from './public.routes.js';
import { posterBackofficeRoutes } from './backoffice.routes.js';
import { preparePosterScenario } from './test-support.js';
import { reconcilePosters } from './reconcile.js';
import { MAX_POSTER_BYTES } from './policy.js';

function form(buffer:Buffer,filename='poster.png',type='image/png',extra='',files=1){
 const boundary='poster-test-boundary';
 const parts=[];
 for(let i=0;i<files;i++)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),buffer,Buffer.from('\r\n'));
 if(extra)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${extra}\r\n`));
 parts.push(Buffer.from(`--${boundary}--\r\n`));
 return {payload:Buffer.concat(parts),headers:{'content-type':`multipart/form-data; boundary=${boundary}`}};
}

test('all 15 approved REST paths, replay statuses and security use isolated JWT/multipart/fake storage',{timeout:30000},async t=>{
 const {client:sql,database,fixture:f,announcement}=await preparePosterScenario(t);
 process.env.POSTER_SUBMISSIONS_ENABLED='true';
 let afterRollback:(()=>Promise<void>)|null=null;
 const routeDatabase=new Proxy(database,{get(target,property){
  if(property==='transaction')return async(...args:unknown[])=>{
   try{return await Reflect.apply(target.transaction,target,args);}
   catch(error){const recover=afterRollback;afterRollback=null;if(recover)await recover();throw error;}
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const app=Fastify({logger:false});t.after(()=>app.close());
 await app.register(jwt,{secret:'poster-integration-test-only-secret'});await app.register(multipart);
 app.setErrorHandler((error,request,reply)=>{
  if(error instanceof ApiError)return reply.code(error.statusCode).send(error.toJSON());
  const failure=error as FastifyError;
  return reply.code(failure.statusCode??500).send({success:false,code:failure.code??'INTERNAL_ERROR',error:'Request failed'});
 });
 app.register(posterAnnouncementRoutes,{prefix:'/api/events'});
 const objects=new Map<string,Buffer>();
 app.register(async protectedApp=>{
  protectedApp.addHook('preHandler',async(r,reply)=>{try{await r.jwtVerify();}catch{return reply.code(401).send({success:false,code:'AUTH_UNAUTHORIZED',error:'Unauthorized'});}});
  protectedApp.register(posterOwnerRoutes,{prefix:'/api/abstracts',database:routeDatabase,storage:{publicBaseUrl:'https://test.r2.dev',putObject:async i=>{objects.set(i.key,i.body);},deleteObject:async key=>{objects.delete(key);}}});
  protectedApp.register(posterBackofficeRoutes,{prefix:'/api/backoffice',database:routeDatabase});
 });
 await app.ready();
 const auth=(actor:PosterActor)=>({authorization:`Bearer ${app.jwt.sign(actor)}`});
 const admin=auth(f.admin),owner=auth(f.owner),other=auth({...f.owner,id:999});
 const base=`/api/backoffice/events/${f.eventId}`;
 const ownerUrl=`/api/abstracts/${f.abstractId}/poster`;
 const uploadUrl=`/api/abstracts/${f.abstractId}/poster-uploads`;
 const get=async(url:string,headers:Record<string,string>=admin,status=200)=>{const r=await app.inject({method:'GET',url,headers});assert.equal(r.statusCode,status,r.body);return r.json().data;};
 const send=async(method:'POST'|'PATCH',url:string,payload:unknown,status:number,headers=admin,key=randomUUID(),replay=false)=>{
  const input={method,url,headers:{...headers,'idempotency-key':key},payload:payload as any};
  const r=await app.inject(input);assert.equal(r.statusCode,status,r.body);
  if(status>=400){assert.equal(r.json().success,false);assert.equal(typeof r.json().code,'string');assert.equal(typeof r.json().error,'string');}
  if(replay){const repeated=await app.inject(input);assert.equal(repeated.statusCode,status,repeated.body);assert.deepEqual(repeated.json(),r.json());}
  return r.json().data;
 };
 const publicRows=await get('/api/events/PRIS-2026/approved-abstracts',{});
 assert.deepEqual(Object.keys(publicRows[0]).sort(),['affiliation','categoryId','categoryName','id','presentationType','round','sequence','submitterName','title','trackingId'].sort());
 assert.ok(!JSON.stringify(publicRows).includes(f.owner.email));await get('/api/events/OTHER/approved-abstracts',{},404);
 await get(ownerUrl,{},401);await get(ownerUrl,other,403);await get(ownerUrl,admin,403);
 assert.equal((await app.inject({url:ownerUrl,headers:other})).body.includes(f.owner.email),false);
 await sql`UPDATE users SET status='inactive' WHERE id=${f.ownerId}`;await get(ownerUrl,owner,403);
 await sql`UPDATE users SET status='active',role='general' WHERE id=${f.ownerId}`;await get(ownerUrl,owner,403);
 await sql`UPDATE users SET role='pharmacist' WHERE id=${f.ownerId}`;
 await get(base+'/poster-settings',auth({...f.admin,email:'attacker@example.invalid'}),403);
 await get(ownerUrl+'?email=attacker@example.invalid',owner,400);await get(ownerUrl+'?requestId=bad',owner,400);
 await get(ownerUrl+'?requestId='+randomUUID(),owner,404);assert.equal((await get(ownerUrl,owner)).canUpload,true);
 await get(base+'/poster-targets');await get(base+`/poster-targets/${f.abstractId}`);await get(base+'/poster-settings');
 await get(base+'/poster-targets?pageSize=101',admin,400);await get(base+'/poster-targets?ownerId=1',admin,400);
 await get('/api/backoffice/events/999/poster-settings',admin,404);await get(base+'/poster-targets/999',admin,404);
 await get(base+'/poster-settings',owner,403); // owner/staff numeric ID collision
 await sql`INSERT INTO backoffice_users(email,role) VALUES ('reviewer@example.invalid','reviewer')`;
 const reviewer=auth({id:2,email:'reviewer@example.invalid',role:'reviewer'});
 await get(base+'/poster-settings',reviewer,403);await sql`INSERT INTO staff_event_assignments VALUES (2,${f.eventId})`;
 assert.equal((await get(base+'/poster-settings',reviewer)).capabilities.manage,false);
 const writeCases:Array<['POST'|'PATCH',string,unknown]>=[
 ['POST','/poster-reconciliations',{}],['POST','/poster-verifications',{sourceKey:'1:1',fingerprint:'a'.repeat(64),reason:'Checked'}],
 ['PATCH','/poster-settings',{closesAt:new Date(Date.now()+3600000).toISOString(),reason:'Change',version:1}],
 ['POST','/poster-email-previews',{kind:'initial',abstractIds:[f.abstractId]}],
 ['POST','/poster-notification-batches',{kind:'initial',abstractIds:[f.abstractId],previewFingerprint:'a'.repeat(64)}],
 ['POST',`/poster-targets/${f.abstractId}/revision-requests`,{requestId:randomUUID(),details:'Fix',closesAt:new Date(Date.now()+3600000).toISOString(),previewFingerprint:'a'.repeat(64)}],
 ['POST',`/poster-revision-requests/${randomUUID()}/cancellations`,{reason:'Cancel'}],
 ['POST',`/poster-email-jobs/${randomUUID()}/resends`,{previewFingerprint:'a'.repeat(64)}]];
 for(const [method,path,payload]of writeCases)await send(method,base+path,payload,403,reviewer);
 await sql`UPDATE backoffice_users SET role='organizer' WHERE id=2`;
 await get(base+'/poster-settings',reviewer,403);
 const organizer=auth({id:2,email:'reviewer@example.invalid',role:'organizer'});
 await get(base+'/poster-settings',organizer);for(const [method,path,payload]of writeCases)await send(method,base+path,payload,403,organizer);
 await sql`UPDATE backoffice_users SET is_active=false WHERE id=2`;await get(base+'/poster-settings',organizer,403);
 await send('POST',base+'/poster-reconciliations',{rows:[]},400);
 await send('PATCH',base+'/poster-settings',{closesAt:new Date(Date.now()+3600000).toISOString(),version:1,reason:'Adjust',extra:true},400);
 const close=new Date(Date.now()+7200000).toISOString();
 await send('PATCH',base+'/poster-settings',{closesAt:close,version:1,reason:'Adjust'},200,admin,randomUUID(),true);
 assert.equal((await get(base+'/poster-settings')).history.length,1);
 await send('PATCH',base+'/poster-settings',{closesAt:close,version:1,reason:'Stale'},409);
 // Alias verification fixture exercises the real service rather than replacing handlers.
 await sql`UPDATE abstracts SET tracking_id='PRIS-2026-P099' WHERE id=${f.abstractId}`;
 await sql`INSERT INTO abstract_tracking_identifiers VALUES ('PRIS-2026-P001',${f.abstractId},${f.eventId})`;
 await reconcilePosters(database,[announcement]);
 const [ann]=await sql`SELECT match_fingerprint FROM poster_announcements WHERE source_key='1:1'`;
 const verification={sourceKey:'1:1',fingerprint:ann.match_fingerprint,reason:'Original identifier confirmed'};
 await send('POST',base+'/poster-verifications',{...verification,fingerprint:'0'.repeat(64)},409);
 const verifyKey=randomUUID();await send('POST',base+'/poster-verifications',verification,201,admin,verifyKey,true);
 await send('POST',base+'/poster-verifications',{...verification,reason:'Changed'},409,admin,verifyKey);
 const beforeJobs=(await sql`SELECT count(*)::int AS n FROM poster_email_jobs`)[0].n;
 const preview=await send('POST',base+'/poster-email-previews',{kind:'initial',abstractIds:[f.abstractId]},200);
 assert.equal((await sql`SELECT count(*)::int AS n FROM poster_email_jobs`)[0].n,beforeJobs);
 assert.equal(typeof preview.messages[0].templateVersion,'string');
 const batch=await send('POST',base+'/poster-notification-batches',{kind:'initial',abstractIds:[f.abstractId],previewFingerprint:preview.fingerprint},202,admin,randomUUID(),true);
 assert.equal((await get(base+`/poster-notification-batches/${batch.batchId}`)).jobs.length,1);
 await get(base+`/poster-notification-batches/${randomUUID()}`,admin,404);
 await get(base+'/poster-notification-batches/invalid',admin,400);
 await sql`UPDATE poster_email_jobs SET state='failed',error_code='TEST' WHERE id=${batch.jobIds[0]}`;
 const resendPreview=await send('POST',base+'/poster-email-previews',{kind:'resend',jobId:batch.jobIds[0]},200);
 await send('POST',base+`/poster-email-jobs/${batch.jobIds[0]}/resends`,{previewFingerprint:resendPreview.fingerprint},202,admin,randomUUID(),true);
 const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
 const upload=async(buffer:Buffer,status:number,options:{files?:number;filename?:string;type?:string;requestId?:string;key?:string;headers?:object}={})=>{
  const body=form(buffer,options.filename,options.type,options.requestId,options.files);
  const r=await app.inject({method:'POST',url:uploadUrl,...body,headers:{...owner,...body.headers,'idempotency-key':options.key??randomUUID(),...options.headers}});assert.equal(r.statusCode,status,r.body);return r.json();
 };
 await upload(png,400,{key:'invalid'});await upload(png,422,{files:0});await upload(Buffer.alloc(0),422);await upload(png,422,{files:2});await upload(Buffer.alloc(MAX_POSTER_BYTES+1),413);
 await upload(Buffer.from('invalid png'),422);await upload(png,415,{filename:'poster.jpg'});await upload(png,415,{type:'text/plain'});
 await upload(png,400,{requestId:'invalid'});await upload(png,403,{headers:other});
 process.env.POSTER_SUBMISSIONS_ENABLED='false';await upload(png,503);await get(ownerUrl,owner);await get(base+'/poster-settings');await get('/api/events/PRIS-2026/approved-abstracts',{});
 process.env.POSTER_SUBMISSIONS_ENABLED='true';const uploadKey=randomUUID();const uploaded=await upload(png,201,{key:uploadKey});const replayed=await upload(png,201,{key:uploadKey});
 assert.deepEqual(replayed.data.upload,uploaded.data.upload);assert.equal(replayed.data.replayed,true);assert.equal(objects.size,1);await upload(png,409);
 const details='Improve labels';const revisionPreview=await send('POST',base+'/poster-email-previews',{kind:'revision',abstractId:f.abstractId,details,closesAt:close},200);
 const revision=await send('POST',base+`/poster-targets/${f.abstractId}/revision-requests`,{requestId:revisionPreview.requestId,details,closesAt:close,previewFingerprint:revisionPreview.fingerprint},201,admin,randomUUID(),true);
 assert.equal((await get(ownerUrl+'?requestId='+revision.request.id.toUpperCase(),owner)).mode,'revision');
 await sql`UPDATE abstracts SET presentation_type='oral' WHERE id=${f.abstractId}`;assert.equal((await get(ownerUrl+'?requestId='+revision.request.id,owner)).canUpload,false);
 await sql`UPDATE abstracts SET presentation_type='poster' WHERE id=${f.abstractId}`;
 await send('POST',base+`/poster-revision-requests/${revision.request.id}/cancellations`,{reason:'Replace request'},201,admin,randomUUID(),true);
 assert.equal((await get(ownerUrl+'?requestId='+revision.request.id,owner)).blockCode,'POSTER_REQUEST_CANCELLED');
 await upload(png,409,{requestId:revision.request.id});
 const expiredId=randomUUID();
 await sql`INSERT INTO poster_revision_requests(id,target_id,details,closes_at,requested_by)
 SELECT ${expiredId}::uuid,id,'Expired fixture',clock_timestamp()-interval '1 second',${f.adminId} FROM poster_targets WHERE abstract_id=${f.abstractId}`;
 const expiredOwner=await get(ownerUrl+'?requestId='+expiredId,owner);
 assert.equal(expiredOwner.blockCode,'POSTER_REQUEST_EXPIRED');assert.equal(expiredOwner.canUpload,false);
 await upload(png,409,{requestId:expiredId});
 assert.equal((await get(base+'/poster-targets?status=revision_expired')).total,1);
 await sql`INSERT INTO poster_email_attempts(job_id,claim_token,result,recipient,subject,html,template_version) VALUES(${batch.jobIds[0]},${randomUUID()},'failed',${f.owner.email},'Test subject','Test html','poster-v1')`;
 const detail=await get(base+`/poster-targets/${f.abstractId}`);assert.equal(detail.uploads.length,1);assert.equal(detail.requests.length,2);assert.ok(detail.emailJobs.length>=4);
 assert.ok(detail.audit.every((a:{created_at:string})=>a.created_at.endsWith('Z')));
 assert.ok(detail.emailJobs.find((j:{id:string})=>j.id===batch.jobIds[0]).attempts[0].started_at.endsWith('Z'));
 const [before]=await sql`SELECT closes_at,version FROM poster_settings`;
 const jobs=(await sql`SELECT count(*)::int AS n FROM poster_email_jobs`)[0].n;
 await sql.unsafe(`CREATE FUNCTION fail_poster_recheck() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reconciliation failure'; END $$;
 CREATE TRIGGER fail_poster_recheck BEFORE UPDATE ON poster_announcements FOR EACH ROW EXECUTE FUNCTION fail_poster_recheck();`);
 await send('POST',base+'/poster-reconciliations',{},503);
 assert.equal((await get(base+'/poster-settings')).settings.reconcileReady,false);
 assert.equal((await sql`SELECT count(*)::int AS n FROM poster_email_jobs`)[0].n,jobs);
 await sql.unsafe('DROP TRIGGER fail_poster_recheck ON poster_announcements;');
 await reconcilePosters(database,[announcement]);
 await sql.unsafe('CREATE TRIGGER fail_poster_recheck BEFORE UPDATE ON poster_announcements FOR EACH ROW EXECUTE FUNCTION fail_poster_recheck();');
 afterRollback=async()=>{
  await sql.unsafe('DROP TRIGGER fail_poster_recheck ON poster_announcements;');
  await reconcilePosters(database,[announcement]);
 };
 await send('POST',base+'/poster-reconciliations',{},503);
 assert.equal((await get(base+'/poster-settings')).settings.reconcileReady,true,'older failure must not mask interleaved successful reconciliation');
 await sql.unsafe('DROP FUNCTION fail_poster_recheck();');
 await send('POST',base+'/poster-reconciliations',{},201,admin,randomUUID(),true);
 assert.equal((await get(base+'/poster-settings')).settings.reconcileReady,true);
 assert.deepEqual((await sql`SELECT closes_at,version FROM poster_settings`)[0],before);
 assert.equal((await sql`SELECT count(*)::int AS n FROM poster_email_jobs`)[0].n,jobs);
 assert.equal((await sql`SELECT count(*)::int AS n FROM poster_uploads`)[0].n,1);
 assert.equal((await sql`SELECT count(*)::int AS n FROM poster_revision_requests`)[0].n,2);
 assert.equal((await get(base+'/poster-settings')).history.length,1);
});
