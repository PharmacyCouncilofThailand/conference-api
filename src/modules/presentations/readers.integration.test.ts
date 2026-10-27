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
import { previewPresentationMail } from './operations.js';
import { createPresentationRevision } from './revisions.js';

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
 const [posterCategory]=await sql`INSERT INTO abstract_categories(event_id,name) VALUES (${f.eventId},'Poster category') RETURNING id`;
 const [poster]=await sql`INSERT INTO abstracts(event_id,category_id,user_id,tracking_id,title,presentation_type)
  VALUES(${f.eventId},${posterCategory.id},${f.ownerId},'PRIS-2026-P002','Highlighted work','poster') RETURNING id`;
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
  await sql`UPDATE backoffice_users SET role=${role},assigned_categories='["สาขาตัวอย่าง","Poster category"]',assigned_presentation_types='[]' WHERE id=${staff.id}`;
  const actor={id:staff.id,email:'scoped@example.invalid',role};
  assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({}))).total,0);
  await assert.rejects(readPresentationDetail(database,actor,f.eventId,f.abstractId),{statusCode:404});
  for(const type of ['oral','poster']){
   await sql`UPDATE backoffice_users SET assigned_presentation_types=${JSON.stringify([type])}::jsonb WHERE id=${staff.id}`;
   const list=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({pageSize:1}));
   assert.equal(list.total,1);assert.equal(list.counts.submitted,1);
   assert.equal(list.categories.length,2);
   const deniedCategory=type==='oral'?posterCategory.id:f.categoryId;
   const denied=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({categoryId:deniedCategory,pageSize:1}));
   assert.equal(denied.total,0);assert.equal(denied.counts.submitted,0);
   assert.equal(list.items[0].abstractId,type==='oral'?f.abstractId:poster.id);
   assert.equal(list.items[0].announcement.presentationType,type==='oral'?'oral':'highlighted-poster');
   assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({pageSize:1,page:2}))).items.length,0);
   await readPresentationDetail(database,actor,f.eventId,type==='oral'?f.abstractId:poster.id);
   await assert.rejects(readPresentationDetail(database,actor,f.eventId,type==='oral'?poster.id:f.abstractId),{statusCode:404});
  }
  await sql`UPDATE backoffice_users SET assigned_presentation_types='["oral","poster"]',assigned_categories='["สาขาตัวอย่าง"]' WHERE id=${staff.id}`;
  const categoryScoped=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({pageSize:1,page:2}));
  assert.equal(categoryScoped.total,1);assert.equal(categoryScoped.counts.submitted,1);assert.equal(categoryScoped.items.length,0);
  assert.deepEqual([...categoryScoped.categories],[{id:f.categoryId,name:'สาขาตัวอย่าง'}]);
  await assert.rejects(readPresentationDetail(database,actor,f.eventId,poster.id),{statusCode:404});
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

test('an upload under the Round 2 roster is reported as Round 2, not the withdrawn Round 1 row on the same target', async t=>{
 const {database,fixture:f,announcement}=await preparePresentationScenario(t);
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';
 await reconcilePresentations(database,[{...announcement,id:75,round:2}]);
 const storage:PresentationStorage={r2:()=>({publicBaseUrl:'https://test.r2.dev',putObject:async()=>{},deleteObject:async()=>{}}),drive:{
  rootFolderId:()=> 'root',generateId:async()=>randomUUID(),folder:async(_parent,name)=>name,
  write:async input=>({fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName}),delete:async()=>{},
 }};
 const pdf=await PDFDocument.create();pdf.addPage();
 await submitPresentationUpload(database,f.owner,f.abstractId,randomUUID(),null,{buffer:Buffer.from(await pdf.save()),filename:'file.pdf',mimetype:'application/pdf'},storage);
 const received=await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({received:'true'}));
 assert.deepEqual(received.items.map(r=>[r.sourceKey,r.announcement.round]),[['2:75',2]]);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({round:'1'}))).total,0);
 assert.equal((await readPresentationDetail(database,f.admin,f.eventId,f.abstractId)).row.announcement.round,2);
});

test('viewer keeps only accepted current file after replacement while admin retains history', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true';
  const storage: PresentationStorage = {
    r2: () => ({ publicBaseUrl: 'https://test.r2.dev', putObject: async () => {}, deleteObject: async () => {} }),
    drive: {
      rootFolderId: () => 'root', generateId: async () => randomUUID(),
      folder: async (_parent, name) => name,
      write: async input => ({ fileId: input.fileId, fileUrl: `https://drive.google.com/file/d/${input.fileId}/view`, storedFileName: input.fileName }),
      delete: async () => {},
    },
  };
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const first = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null,
    { buffer: bytes, filename: 'original.pdf', mimetype: 'application/pdf' }, storage);
  const [staff] = await sql`INSERT INTO backoffice_users(email,role,assigned_presentation_types,assigned_categories)
    VALUES ('latest-viewer@example.invalid','organizer','["poster"]'::jsonb,'["สาขาตัวอย่าง"]'::jsonb) RETURNING id`;
  await sql`INSERT INTO staff_event_assignments VALUES (${staff.id},${f.eventId})`;
  const preview = await previewPresentationMail(database, f.admin, f.eventId, {
    kind: 'revision', abstractId: f.abstractId, details: 'private-revision-details',
    closesAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const created = await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), {
    requestId: preview.requestId!, details: 'private-revision-details',
    closesAt: preview.closesAt!, previewFingerprint: preview.fingerprint,
  });
  const before = await readPresentationDetail(database,
    { id: staff.id, email: 'latest-viewer@example.invalid', role: 'organizer' }, f.eventId, f.abstractId);
  assert.equal(before.row.currentUpload?.id, first.upload.id);
  assert.deepEqual(before.requests, []);
  const second = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), created.request.id,
    { buffer: bytes, filename: 'latest.pdf', mimetype: 'application/pdf' }, storage);
  for (const role of ['organizer', 'reviewer']) {
    await sql`UPDATE backoffice_users SET role=${role} WHERE id=${staff.id}`;
    const actor = { id: staff.id, email: 'latest-viewer@example.invalid', role };
    const detail = await readPresentationDetail(database, actor, f.eventId, f.abstractId);
    assert.deepEqual(detail.uploads.map(file => file.id), [second.upload.id]);
    assert.equal(detail.row.currentUpload?.id, second.upload.id);
    assert.equal(detail.uploads[0].revisionRequestId, null);
    assert.equal(detail.row.progress, 'submitted');
    assert.equal(detail.row.activeRequest, null);
    assert.deepEqual(detail.requests, []); assert.deepEqual(detail.audit, []);
    assert.deepEqual(detail.emailJobs, []);
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes(first.upload.id), false);
    assert.equal(serialized.includes(created.request.id), false);
    assert.equal(serialized.includes('private-revision-details'), false);
    for (const status of ['revision_pending', 'revision_expired', 'not_submitted', 'revised']) {
      const list = await readPresentationList(database, actor, f.eventId,
        listQuerySchema.parse({ status, pageSize: 1 }));
      assert.equal(list.total, 1); assert.equal(list.counts.submitted, 1);
    }
  }
  const admin = await readPresentationDetail(database, f.admin, f.eventId, f.abstractId);
  assert.equal(admin.uploads.length, 2);
  assert.ok(admin.requests.some(request => request.id === created.request.id));
  assert.ok(admin.audit.length > 0); assert.ok(admin.emailJobs.length > 0);
});

test('category scope uses current DB grants and actual Abstract category, with independent options and Admin filtering', async t=>{
 const {client:sql,database,fixture:f,announcement}=await preparePresentationScenario(t);
 process.env.PRESENTATION_SUBMISSIONS_ENABLED='true';
 const [other]=await sql`INSERT INTO abstract_categories(event_id,name) VALUES (${f.eventId},'Other category') RETURNING id`;
 const [otherEvent]=await sql`INSERT INTO events(event_code) VALUES ('OTHER') RETURNING id`;
 const [foreign]=await sql`INSERT INTO abstract_categories(event_id,name) VALUES (${otherEvent.id},'สาขาตัวอย่าง') RETURNING id`;
 const storage:PresentationStorage={r2:()=>({publicBaseUrl:'https://test.r2.dev',putObject:async()=>{},deleteObject:async()=>{}}),drive:{
  rootFolderId:()=> 'root',generateId:async()=>randomUUID(),folder:async(_parent,name)=>name,
  write:async input=>({fileId:input.fileId,fileUrl:`https://drive.google.com/file/d/${input.fileId}/view`,storedFileName:input.fileName}),delete:async()=>{},
 }};
 const pdf=await PDFDocument.create();pdf.addPage();
 await submitPresentationUpload(database,f.owner,f.abstractId,randomUUID(),null,{buffer:Buffer.from(await pdf.save()),filename:'file.pdf',mimetype:'application/pdf'},storage);
 // Forge only the announcement snapshot: it cannot grant access or satisfy categoryId.
 await sql`UPDATE presentation_announcements SET source_row=source_row || ${JSON.stringify({categoryId:other.id,categoryName:'Other category'})}::jsonb`;
 const [staff]=await sql`INSERT INTO backoffice_users(email,role,assigned_presentation_types) VALUES ('category@example.invalid','organizer','["poster"]') RETURNING id`;
 await sql`INSERT INTO staff_event_assignments VALUES (${staff.id},${f.eventId})`;
 for(const role of ['organizer','reviewer']){
  await sql`UPDATE backoffice_users SET role=${role} WHERE id=${staff.id}`;
  const actor={id:staff.id,email:'category@example.invalid',role,assignedCategories:['สาขาตัวอย่าง','Other category']};
  for(const invalid of [[],null,{},'สาขาตัวอย่าง',[null,17,'','  '],['Other category']]){
   await sql`UPDATE backoffice_users SET assigned_categories=${JSON.stringify(invalid)}::jsonb WHERE id=${staff.id}`;
   const list=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({}));
   assert.equal(list.total,0);assert.equal(list.counts.submitted,0);
   assert.deepEqual([...list.categories],Array.isArray(invalid)&&invalid.includes('Other category')?[{id:other.id,name:'Other category'}]:[]);
   await assert.rejects(readPresentationDetail(database,actor,f.eventId,f.abstractId),{statusCode:404});
  }
  await sql`UPDATE backoffice_users SET assigned_categories='["สาขาตัวอย่าง",null,17,"", "Other category"]' WHERE id=${staff.id}`;
  const list=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({pageSize:1}));
  assert.equal(list.total,1);assert.equal(list.counts.submitted,1);assert.equal(list.items[0].abstractId,f.abstractId);
  const options=[{id:f.categoryId,name:'สาขาตัวอย่าง'},{id:other.id,name:'Other category'}];
  assert.deepEqual([...list.categories].sort((a,b)=>a.id-b.id),options);
  const empty=await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({page:2,search:'missing',presentationType:'oral',categoryId:other.id}));
  assert.equal(empty.total,0);assert.deepEqual(empty.categories,list.categories);
  for(const categoryId of [other.id,foreign.id,2147483000])assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({categoryId}))).total,0);
  assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({categoryId:f.categoryId}))).total,1);
  await readPresentationDetail(database,actor,f.eventId,f.abstractId);
  await sql`UPDATE backoffice_users SET assigned_categories='["Other category"]' WHERE id=${staff.id}`;
  assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({categoryId:f.categoryId}))).total,0);
  await assert.rejects(readPresentationDetail(database,actor,f.eventId,f.abstractId),{statusCode:404});
  // Even an assigned name on another Event cannot authorize an inconsistent Abstract link.
  await sql`UPDATE abstracts SET category_id=${foreign.id} WHERE id=${f.abstractId}`;
  await sql`UPDATE backoffice_users SET assigned_categories='["สาขาตัวอย่าง"]' WHERE id=${staff.id}`;
  assert.equal((await readPresentationList(database,actor,f.eventId,listQuerySchema.parse({}))).total,0);
  await sql`UPDATE abstracts SET category_id=${f.categoryId} WHERE id=${f.abstractId}`;
 }
 const admin=await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({}));
 assert.equal(admin.total,1);assert.equal(admin.categories.length,2);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({categoryId:other.id}))).total,0);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({categoryId:f.categoryId}))).total,1);
 await reconcilePresentations(database,[announcement,{...announcement,id:2,trackingId:'MISSING'}]);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({}))).total,2);
 assert.equal((await readPresentationList(database,f.admin,f.eventId,listQuerySchema.parse({categoryId:f.categoryId}))).total,1);
});
