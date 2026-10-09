import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify, {type FastifyError} from 'fastify';
import type {PresentationActor} from './types.js';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { ApiError } from '../../errors/ApiError.js';
import { presentationAnnouncementRoutes, presentationOwnerRoutes } from './public.routes.js';
import { presentationBackofficeRoutes } from './backoffice.routes.js';
import { preparePresentationScenario } from './test-support.js';
import { reconcilePresentations } from './reconcile.js';
import { MAX_ORAL_BYTES, MAX_POSTER_BYTES } from './policy.js';

function form(buffer:Buffer,filename='poster.pdf',type='application/pdf',extra='',files=1){
 const boundary='poster-test-boundary';
 const parts=[];
 for(let i=0;i<files;i++)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),buffer,Buffer.from('\r\n'));
 if(extra)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${extra}\r\n`));
 parts.push(Buffer.from(`--${boundary}--\r\n`));
 return {payload:Buffer.concat(parts),headers:{'content-type':`multipart/form-data; boundary=${boundary}`}};
}

test('all 15 approved REST paths, replay statuses and security use isolated JWT/multipart/fake storage',{timeout:30000},async t=>{
 const {client:sql,database,fixture:f,announcement}=await preparePresentationScenario(t);
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';
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
 app.register(presentationAnnouncementRoutes,{prefix:'/api/events'});
 const objects=new Map<string,Buffer>();
 app.register(async protectedApp=>{
  protectedApp.addHook('preHandler',async(r,reply)=>{try{await r.jwtVerify();}catch{return reply.code(401).send({success:false,code:'AUTH_UNAUTHORIZED',error:'Unauthorized'});}});
  protectedApp.register(presentationOwnerRoutes,{prefix:'/api/abstracts',database:routeDatabase,storage:{r2:()=>({publicBaseUrl:'https://test.r2.dev',putObject:async i=>{objects.set(i.key,i.body);},deleteObject:async key=>{objects.delete(key);}}),drive:{rootFolderId:()=>{throw Error('Unexpected Drive');},generateId:async()=>{throw Error('Unexpected Drive');},folder:async()=>{throw Error('Unexpected Drive');},write:async()=>{throw Error('Unexpected Drive');},delete:async()=>{throw Error('Unexpected Drive');}}}});
  protectedApp.register(presentationBackofficeRoutes,{prefix:'/api/backoffice',database:routeDatabase});
 });
 await app.ready();
 const auth=(actor:PresentationActor)=>({authorization:`Bearer ${app.jwt.sign(actor)}`});
 const admin=auth(f.admin),owner=auth(f.owner),other=auth({...f.owner,id:999});
 const base=`/api/backoffice/events/${f.eventId}`;
 const ownerUrl=`/api/abstracts/${f.abstractId}/presentation`;
 const uploadUrl=`/api/abstracts/${f.abstractId}/presentation-uploads`;
 const get=async(url:string,headers:Record<string,string>=admin,status=200)=>{const r=await app.inject({method:'GET',url,headers});assert.equal(r.statusCode,status,r.body);return r.json().data;};
 const send=async(method:'POST'|'PATCH',url:string,payload:unknown,status:number,headers=admin,key=randomUUID(),replay=false)=>{
  const input={method,url,headers:{...headers,'idempotency-key':key},payload:payload as any};
  const r=await app.inject(input);assert.equal(r.statusCode,status,r.body);
  if(status>=400){assert.equal(r.json().success,false);assert.equal(typeof r.json().code,'string');assert.equal(typeof r.json().error,'string');}
  if(replay){const repeated=await app.inject(input);assert.equal(repeated.statusCode,status,repeated.body);assert.deepEqual(repeated.json(),r.json());}
  return r.json().data;
 };
 const publicRows=await get('/api/events/PRIS-2026/approved-abstracts',{});
 await get(`/api/abstracts/${f.abstractId}/poster`,owner,404);
 await get(base+'/poster-targets',admin,404);
 assert.deepEqual(Object.keys(publicRows[0]).sort(),['affiliation','categoryId','categoryName','id','presentationType','round','sequence','submitterName','title','trackingId'].sort());
 assert.ok(!JSON.stringify(publicRows).includes(f.owner.email));await get('/api/events/OTHER/approved-abstracts',{},404);
 await get(ownerUrl,{},401);await get(ownerUrl,other,403);await get(ownerUrl,admin,403);
 assert.equal((await app.inject({url:ownerUrl,headers:other})).body.includes(f.owner.email),false);
 await sql`UPDATE users SET status='inactive' WHERE id=${f.ownerId}`;await get(ownerUrl,owner,403);
 await sql`UPDATE users SET status='active',role='general' WHERE id=${f.ownerId}`;await get(ownerUrl,owner,403);
 await sql`UPDATE users SET role='pharmacist' WHERE id=${f.ownerId}`;
 await get(base+'/presentation-settings',auth({...f.admin,email:'attacker@example.invalid'}),403);
 await get(ownerUrl+'?email=attacker@example.invalid',owner,400);await get(ownerUrl+'?requestId=bad',owner,400);
 await get(ownerUrl+'?requestId='+randomUUID(),owner,404);assert.equal((await get(ownerUrl,owner)).canUpload,true);
 await get(base+'/presentation-targets');await get(base+`/presentation-targets/${f.abstractId}`);await get(base+'/presentation-settings');
 await get(base+'/presentation-targets?pageSize=101',admin,400);await get(base+'/presentation-targets?ownerId=1',admin,400);
 await get('/api/backoffice/events/999/presentation-settings',admin,404);await get(base+'/presentation-targets/999',admin,404);
 await get(base+'/presentation-settings',owner,403); // owner/staff numeric ID collision
 await sql`INSERT INTO backoffice_users(email,role) VALUES ('reviewer@example.invalid','reviewer')`;
 const reviewer=auth({id:2,email:'reviewer@example.invalid',role:'reviewer'});
 await get(base+'/presentation-settings',reviewer,403);await sql`INSERT INTO staff_event_assignments VALUES (2,${f.eventId})`;
 await get(base+'/presentation-settings',reviewer,403);
 assert.equal((await get(base+'/presentation-targets',reviewer)).total,0);
 await get(base+`/presentation-targets/${f.abstractId}`,reviewer,404);
 const writeCases:Array<['POST'|'PATCH',string,unknown]>=[
 ['POST','/presentation-reconciliations',{}],['POST','/presentation-verifications',{sourceKey:'1:1',fingerprint:'a'.repeat(64),reason:'Checked'}],
 ['PATCH','/presentation-settings',{closesAt:new Date(Date.now()+3600000).toISOString(),reason:'Change',version:1}],
 ['POST','/presentation-email-previews',{kind:'initial',abstractIds:[f.abstractId]}],
 ['POST','/presentation-notification-batches',{kind:'initial',abstractIds:[f.abstractId],previewFingerprint:'a'.repeat(64)}],
 ['POST',`/presentation-targets/${f.abstractId}/revision-requests`,{requestId:randomUUID(),details:'Fix',closesAt:new Date(Date.now()+3600000).toISOString(),previewFingerprint:'a'.repeat(64)}],
 ['POST',`/presentation-revision-requests/${randomUUID()}/cancellations`,{reason:'Cancel'}],
 ['POST',`/presentation-email-jobs/${randomUUID()}/resends`,{previewFingerprint:'a'.repeat(64)}]];
 for(const [method,path,payload]of writeCases)await send(method,base+path,payload,403,reviewer);
 await sql`UPDATE backoffice_users SET role='organizer' WHERE id=2`;
 await get(base+'/presentation-settings',reviewer,403);
 const organizer=auth({id:2,email:'reviewer@example.invalid',role:'organizer'});
 await get(base+'/presentation-settings',organizer,403);for(const [method,path,payload]of writeCases)await send(method,base+path,payload,403,organizer);
 await sql`UPDATE backoffice_users SET is_active=false WHERE id=2`;await get(base+'/presentation-settings',organizer,403);
 await send('POST',base+'/presentation-reconciliations',{rows:[]},400);
 await send('PATCH',base+'/presentation-settings',{closesAt:new Date(Date.now()+3600000).toISOString(),version:1,reason:'Adjust',extra:true},400);
 const close=new Date(Date.now()+7200000).toISOString();
 await send('PATCH',base+'/presentation-settings',{closesAt:close,version:1,reason:'Adjust'},200,admin,randomUUID(),true);
 assert.equal((await get(base+'/presentation-settings')).history.length,1);
 await send('PATCH',base+'/presentation-settings',{closesAt:close,version:1,reason:'Stale'},409);
 // Alias verification fixture exercises the real service rather than replacing handlers.
 await sql`UPDATE abstracts SET tracking_id='PRIS-2026-P099' WHERE id=${f.abstractId}`;
 await sql`INSERT INTO abstract_tracking_identifiers VALUES ('PRIS-2026-P001',${f.abstractId},${f.eventId})`;
 await reconcilePresentations(database,[announcement]);
 const [ann]=await sql`SELECT match_fingerprint FROM presentation_announcements WHERE source_key='1:1'`;
 const verification={sourceKey:'1:1',fingerprint:ann.match_fingerprint,reason:'Original identifier confirmed'};
 await send('POST',base+'/presentation-verifications',{...verification,fingerprint:'0'.repeat(64)},409);
 const verifyKey=randomUUID();await send('POST',base+'/presentation-verifications',verification,201,admin,verifyKey,true);
 await send('POST',base+'/presentation-verifications',{...verification,reason:'Changed'},409,admin,verifyKey);
 const beforeJobs=(await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n;
 const preview=await send('POST',base+'/presentation-email-previews',{kind:'initial',abstractIds:[f.abstractId]},200);
 assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n,beforeJobs);
 assert.equal(typeof preview.messages[0].templateVersion,'string');
 const batch=await send('POST',base+'/presentation-notification-batches',{kind:'initial',abstractIds:[f.abstractId],previewFingerprint:preview.fingerprint},202,admin,randomUUID(),true);
 assert.equal((await get(base+`/presentation-notification-batches/${batch.batchId}`)).jobs.length,1);
 await get(base+`/presentation-notification-batches/${randomUUID()}`,admin,404);
 await get(base+'/presentation-notification-batches/invalid',admin,400);
 await sql`UPDATE presentation_email_jobs SET state='failed',error_code='TEST' WHERE id=${batch.jobIds[0]}`;
 const resendPreview=await send('POST',base+'/presentation-email-previews',{kind:'resend',jobId:batch.jobIds[0]},200);
 await send('POST',base+`/presentation-email-jobs/${batch.jobIds[0]}/resends`,{previewFingerprint:resendPreview.fingerprint},202,admin,randomUUID(),true);
 const document=await PDFDocument.create();document.addPage();const pdf=Buffer.from(await document.save());
 const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
 const upload=async(buffer:Buffer,status:number,options:{files?:number;filename?:string;type?:string;requestId?:string;key?:string;headers?:object}={})=>{
  const body=form(buffer,options.filename,options.type,options.requestId,options.files);
  const r=await app.inject({method:'POST',url:uploadUrl,...body,headers:{...owner,...body.headers,'idempotency-key':options.key??randomUUID(),...options.headers}});assert.equal(r.statusCode,status,r.body);
  if(status===413)assert.equal(r.json().code,'PRESENTATION_FILE_TOO_LARGE');return r.json();
 };
 await upload(pdf,400,{key:'invalid'});await upload(pdf,422,{files:0});await upload(Buffer.alloc(0),422);await upload(pdf,422,{files:2});await upload(Buffer.alloc(MAX_POSTER_BYTES+1),413);
 await upload(Buffer.from('%PDF-1.7 invalid'),422);await upload(pdf,415,{filename:'poster.jpg'});await upload(pdf,415,{type:'text/plain'});
 await upload(png,415,{filename:'poster.png',type:'application/pdf'});await upload(png,415);assert.equal(objects.size,0);
 await upload(pdf,400,{requestId:'invalid'});await upload(pdf,403,{headers:other});
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='false';await upload(pdf,503);await get(ownerUrl,owner);await get(base+'/presentation-settings');await get('/api/events/PRIS-2026/approved-abstracts',{});
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';const uploadKey=randomUUID();const uploaded=await upload(png,201,{key:uploadKey,filename:'poster.png',type:'image/png'});const replayed=await upload(png,201,{key:uploadKey,filename:'poster.png',type:'image/png'});
 assert.equal(uploaded.data.upload.mimeType,'image/png');assert.match(uploaded.data.upload.fileUrl,/\.png$/);assert.deepEqual([...objects.values()][0],png);
 assert.deepEqual(replayed.data.upload,uploaded.data.upload);assert.equal(replayed.data.replayed,true);assert.equal(objects.size,1);await upload(pdf,409);
 const details='Improve labels';const revisionPreview=await send('POST',base+'/presentation-email-previews',{kind:'revision',abstractId:f.abstractId,details,closesAt:close},200);
 const revision=await send('POST',base+`/presentation-targets/${f.abstractId}/revision-requests`,{requestId:revisionPreview.requestId,details,closesAt:close,previewFingerprint:revisionPreview.fingerprint},201,admin,randomUUID(),true);
 assert.equal((await get(ownerUrl+'?requestId='+revision.request.id.toUpperCase(),owner)).mode,'revision');
 await sql`UPDATE abstracts SET presentation_type='oral' WHERE id=${f.abstractId}`;
 await upload(pdf,422,{requestId:revision.request.id});
 await sql`UPDATE abstracts SET presentation_type='poster' WHERE id=${f.abstractId}`;
 await send('POST',base+`/presentation-revision-requests/${revision.request.id}/cancellations`,{reason:'Replace request'},201,admin,randomUUID(),true);
 assert.equal((await get(ownerUrl+'?requestId='+revision.request.id,owner)).blockCode,'PRESENTATION_REQUEST_CANCELLED');
 await upload(pdf,409,{requestId:revision.request.id});
 const expiredId=randomUUID();
 await sql`INSERT INTO presentation_revision_requests(id,target_id,details,closes_at,requested_by)
 SELECT ${expiredId}::uuid,id,'Expired fixture',clock_timestamp()-interval '1 second',${f.adminId} FROM presentation_targets WHERE abstract_id=${f.abstractId}`;
 const expiredOwner=await get(ownerUrl+'?requestId='+expiredId,owner);
 assert.equal(expiredOwner.blockCode,'PRESENTATION_REQUEST_EXPIRED');assert.equal(expiredOwner.canUpload,false);
 await upload(pdf,409,{requestId:expiredId});
 assert.equal((await get(base+'/presentation-targets?status=revision_expired')).total,1);
 await sql`INSERT INTO presentation_email_attempts(job_id,claim_token,result,recipient,subject,html,template_version) VALUES(${batch.jobIds[0]},${randomUUID()},'failed',${f.owner.email},'Test subject','Test html','presentation-v1')`;
 const detail=await get(base+`/presentation-targets/${f.abstractId}`);assert.equal(detail.uploads.length,1);assert.equal(detail.requests.length,2);assert.ok(detail.emailJobs.length>=4);
 assert.ok(detail.audit.every((a:{created_at:string})=>a.created_at.endsWith('Z')));
 assert.ok(detail.emailJobs.find((j:{id:string})=>j.id===batch.jobIds[0]).attempts[0].started_at.endsWith('Z'));
 const [before]=await sql`SELECT closes_at,version FROM presentation_settings`;
 const jobs=(await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n;
 await sql.unsafe(`CREATE FUNCTION fail_presentation_recheck() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reconciliation failure'; END $$;
 CREATE TRIGGER fail_presentation_recheck BEFORE UPDATE ON presentation_announcements FOR EACH ROW EXECUTE FUNCTION fail_presentation_recheck();`);
 await send('POST',base+'/presentation-reconciliations',{},503);
 assert.equal((await get(base+'/presentation-settings')).settings.reconcileReady,false);
 assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n,jobs);
 await sql.unsafe('DROP TRIGGER fail_presentation_recheck ON presentation_announcements;');
 await reconcilePresentations(database,[announcement]);
 await sql.unsafe('CREATE TRIGGER fail_presentation_recheck BEFORE UPDATE ON presentation_announcements FOR EACH ROW EXECUTE FUNCTION fail_presentation_recheck();');
 afterRollback=async()=>{
  await sql.unsafe('DROP TRIGGER fail_presentation_recheck ON presentation_announcements;');
  await reconcilePresentations(database,[announcement]);
 };
 await send('POST',base+'/presentation-reconciliations',{},503);
 assert.equal((await get(base+'/presentation-settings')).settings.reconcileReady,true,'older failure must not mask interleaved successful reconciliation');
 await sql.unsafe('DROP FUNCTION fail_presentation_recheck();');
 await send('POST',base+'/presentation-reconciliations',{},201,admin,randomUUID(),true);
 assert.equal((await get(base+'/presentation-settings')).settings.reconcileReady,true);
 assert.deepEqual((await sql`SELECT closes_at,version FROM presentation_settings`)[0],before);
 assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_email_jobs`)[0].n,jobs);
 assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_uploads`)[0].n,1);
 assert.equal((await sql`SELECT count(*)::int AS n FROM presentation_revision_requests`)[0].n,2);
 assert.equal((await get(base+'/presentation-settings')).history.length,1);
});

test('Oral route buffers at most 50 MB, rejects client type/provider and accepts multi-page PDF using Drive', {timeout:30000}, async t=>{
 const {database,fixture:f}=await preparePresentationScenario(t,{type:'oral'});
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';
 let writes=0;
 const app=Fastify({logger:false});t.after(()=>app.close());
 await app.register(jwt,{secret:'presentation-oral-route-test'});await app.register(multipart);
 app.setErrorHandler((error,_request,reply)=>error instanceof ApiError
  ?reply.code(error.statusCode).send(error.toJSON()):reply.code((error as FastifyError).statusCode??500).send({success:false,code:(error as FastifyError).code??'INTERNAL_ERROR'}));
 app.addHook('preHandler',async request=>{await request.jwtVerify();});
 app.register(presentationOwnerRoutes,{prefix:'/api/abstracts',database,storage:{r2:()=>assert.fail('Oral used R2'),drive:{
  rootFolderId:()=> 'root',generateId:async()=>randomUUID(),folder:async(_parent,name)=>name,
  write:async input=>{writes++;return {fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName};},delete:async()=>{},
 }}});await app.ready();
 const headers={authorization:`Bearer ${app.jwt.sign(f.owner)}`,'idempotency-key':randomUUID()};
 const url=`/api/abstracts/${f.abstractId}/presentation-uploads`;
 const send=async(buffer:Buffer,status:number,extraField?:string)=>{
  const body=form(buffer,'slides.pdf');
  if(extraField){const last=Buffer.from('--poster-test-boundary--\r\n');body.payload=Buffer.concat([body.payload.subarray(0,body.payload.length-last.length),
   Buffer.from(`--poster-test-boundary\r\nContent-Disposition: form-data; name="${extraField}"\r\n\r\noral\r\n`),last]);}
  const response=await app.inject({method:'POST',url,...body,headers:{...headers,...body.headers}});
  assert.equal(response.statusCode,status,response.body);
  if(status===413)assert.equal(response.json().code,'PRESENTATION_FILE_TOO_LARGE');return response.json();
 };
 await send(Buffer.alloc(MAX_ORAL_BYTES+1),413);
 const document=await PDFDocument.create();document.addPage();
 await send(Buffer.from(await document.save()),422);
 document.addPage();const bytes=Buffer.from(await document.save());
 await send(bytes,422,'presentationType');await send(bytes,422,'storageProvider');assert.equal(writes,0);
 const ceiling=Buffer.concat([bytes,Buffer.alloc(MAX_ORAL_BYTES-bytes.length,32)]);
 const accepted=await send(ceiling,201);assert.equal(accepted.data.upload.storageProvider,'drive');assert.equal(accepted.data.upload.sizeBytes,MAX_ORAL_BYTES);
 assert.equal(writes,1);
});
