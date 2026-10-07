import assert from 'node:assert/strict';
import test from 'node:test';
import { readOwnerPresentation, readPresentationList, readPresentationSettings, readPresentationDetail, presentationProgress } from './readers.js';
import { preparePresentationScenario } from './test-support.js';
import { reconcilePresentations } from './reconcile.js';
import { listQuerySchema } from './schemas.js';
import { PDFDocument } from 'pdf-lib';
import { randomUUID } from 'node:crypto';
import { submitPresentationUpload } from './uploads.js';
import type { PresentationStorage } from './storage.js';

test('scoped readers retain orphan/withdrawn rows, filter and protect private projections', async t=>{
 const {client:sql,database,fixture:f,announcement}=await preparePresentationScenario(t);
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';
 const missing={...announcement,id:2,trackingId:'MISSING',title:'Missing'};
 await reconcilePresentations(database,[announcement,missing,{...missing,id:3,presentationType:'highlighted-poster'},{...missing,id:4,presentationType:'oral'}]);
 let list=await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({pageSize:1}));
 assert.equal(list.total,4);assert.equal(list.items.length,1);assert.equal(list.counts.not_submitted,4);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({matchState:'missing'}))).total,3);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({search:'OWNER@EXAMPLE.INVALID'}))).total,1);
 const owner=await readOwnerPresentation(database,f.owner,f.abstractId);assert.equal(owner.canUpload,true);assert.ok(!JSON.stringify(owner).includes(f.owner.email));
 await assert.rejects(readOwnerPresentation(database,{...f.owner,id:999},f.abstractId),{statusCode:403});
 await sql`INSERT INTO backoffice_users(email,role) VALUES ('reviewer@example.invalid','reviewer')`;
 const reviewer={id:2,email:'reviewer@example.invalid',role:'reviewer'};
 await assert.rejects(readPresentationList(database,reviewer,f.eventId,listQuerySchema.parse({})),{statusCode:403});
 await sql`INSERT INTO staff_event_assignments VALUES (2,${f.eventId})`;
 await assert.rejects(readPresentationSettings(database,reviewer,f.eventId),{statusCode:403});
 assert.equal((await readPresentationList(database,reviewer,f.eventId,listQuerySchema.parse({}))).total,0);
 await assert.rejects(readPresentationDetail(database,reviewer,f.eventId,f.abstractId),{statusCode:404});
 await assert.rejects(readPresentationDetail(database,reviewer,999,f.abstractId),{statusCode:404});
 await assert.rejects(readPresentationDetail(database,reviewer,f.eventId,999),{statusCode:404});
 await sql`UPDATE backoffice_users SET role='organizer' WHERE id=2`;
 await assert.rejects(readPresentationSettings(database,reviewer,f.eventId),{statusCode:403});
 await reconcilePresentations(database,[announcement]);
 list=await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({matchState:'withdrawn'}));assert.equal(list.total,3);
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='false';assert.equal((await readOwnerPresentation(database,f.owner,f.abstractId)).canUpload,false);
});

test('current event and type assignments scope Organizer/Reviewer before counts, pagination and detail; poster covers Highlighted', async t => {
 const {client:sql,database,fixture:f,announcement}=await preparePresentationScenario(t,{type:'oral',round:2});
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';
 assert.equal((await readOwnerPresentation(database,f.owner,f.abstractId)).canUpload,true);
 const [poster]=await sql`INSERT INTO abstracts(event_id,category_id,user_id,tracking_id,title,presentation_type)
  VALUES(${f.eventId},${f.categoryId},${f.ownerId},'PRIS-2026-P002','Highlighted work','poster') RETURNING id`;
 await reconcilePresentations(database,[announcement,{...announcement,id:2,round:1,presentationType:'highlighted-poster',trackingId:'PRIS-2026-P002',title:'Highlighted work'}]);
 const storage:PresentationStorage={r2:()=>({publicBaseUrl:'https://test.r2.dev',putObject:async()=>{},deleteObject:async()=>{}}),drive:{
  rootFolderId:()=> 'root',generateId:async()=>randomUUID(),folder:async(_parent,name)=>name,
  write:async input=>({fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName}),delete:async()=>{},
 }};
 for(const [abstractId,pages] of [[f.abstractId,2],[poster.id,1]]){
  const pdf=await PDFDocument.create();for(let page=0;page<pages;page++)pdf.addPage();
  await submitPresentationUpload(database,f.owner,abstractId,randomUUID(),null,{buffer:Buffer.from(await pdf.save()),filename:'file.pdf',mimetype:'application/pdf'},storage);
 }
 const [staff]=await sql`INSERT INTO backoffice_users(email,role) VALUES ('scoped@example.invalid','organizer') RETURNING id`;
 await sql`INSERT INTO staff_event_assignments VALUES (${staff.id},${f.eventId})`;
 for(const role of ['organizer','reviewer']){
  await sql`UPDATE backoffice_users SET role=${role},assigned_presentation_types='[]' WHERE id=${staff.id}`;
  const actor={id:staff.id,email:'scoped@example.invalid',role};
  assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({}))).total,0);
  await assert.rejects(readPresentationDetail(database,actor,f.eventId,f.abstractId),{statusCode:404});
  for(const type of ['oral','poster']){
   await sql`UPDATE backoffice_users SET assigned_presentation_types=${JSON.stringify([type])}::jsonb WHERE id=${staff.id}`;
   const list=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({pageSize:1}));
   assert.equal(list.total,1);assert.equal(list.counts.submitted,1);
   assert.equal(list.items[0].abstractId,type==='oral'?f.abstractId:poster.id);
   assert.equal(list.items[0].announcement.presentationType,type==='oral'?'oral':'highlighted-poster');
   assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({pageSize:1,page:2}))).items.length,0);
   await readPresentationDetail(database,actor,f.eventId,type==='oral'?f.abstractId:poster.id);
   await assert.rejects(readPresentationDetail(database,actor,f.eventId,type==='oral'?poster.id:f.abstractId),{statusCode:404});
  }
  await sql`UPDATE backoffice_users SET assigned_presentation_types='["unknown"]' WHERE id=${staff.id}`;
  assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({}))).total,0);
  await sql`UPDATE backoffice_users SET is_active=false WHERE id=${staff.id}`;
  await assert.rejects(readPresentationList(database,actor,f.eventId,listQuerySchema.parse({})),{statusCode:403});
  await sql`UPDATE backoffice_users SET is_active=true WHERE id=${staff.id}`;
 }
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({}))).total,2);
 await sql`DELETE FROM staff_event_assignments WHERE staff_id=${staff.id}`;
 await assert.rejects(readPresentationList(database,{id:staff.id,email:'scoped@example.invalid',role:'reviewer'},f.eventId,listQuerySchema.parse({})),{statusCode:403});
});

test('progress derives expired/open revisions and revised/current files',()=>{
 const now=new Date('2026-10-07T00:00:00Z');
 const file={revisionRequestId:null} as any;
 assert.equal(presentationProgress(null,null,now),'not_submitted');assert.equal(presentationProgress(file,null,now),'submitted');
 assert.equal(presentationProgress({...file,revisionRequestId:'x'},null,now),'revised');
 assert.equal(presentationProgress(file,{status:'open',closesAt:'2026-10-08T00:00:00Z'} as any,now),'revision_pending');
 assert.equal(presentationProgress(file,{status:'open',closesAt:now.toISOString()} as any,now),'revision_expired');
});
