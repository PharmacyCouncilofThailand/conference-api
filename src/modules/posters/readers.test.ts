import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PosterDatabase } from './access.js';
import { readPosterList, readPosterDetail, readPosterSettings, readPosterBatch } from './readers.js';
import { listQuerySchema } from './schemas.js';

// Isolated reader fixtures: no runtime database, storage or email providers.
function fixture(role:string,templateVersion='poster-text-v2') {
 const now='2026-10-07T00:00:00.000Z';
 const upload={id:'file-1',targetId:'target-1',version:1,fileName:'poster.pdf',mimeType:'application/pdf',sizeBytes:100,
  publicUrl:'https://example.invalid/poster.pdf',receivedAt:now,revisionRequestId:null};
 const announcement={round:1,categoryId:1,trackingId:'P001',title:'Poster',presentationType:'poster',submitterName:'Owner'};
 const roster=[1,2,3].map(id=>({source_key:`1:${id}`,source_row:{...announcement,id},abstract_id:id,target_id:`target-${id}`,
  current_upload_id:id===2?null:upload.id,submitter_email:'owner@example.invalid',present:true,match_state:'conflict',
  match_fingerprint:'private-fingerprint',verified_fingerprint:'private-fingerprint',verified_by:99,verified_at:now,
  verification_reason:'private-certification',match_snapshot:{candidates:[{email:'private-candidate@example.invalid'}],match:{problems:['TITLE_MISMATCH']}}}));
 const audits=['match_changed','alias_verified','source_withdrawn','mail_resent','revision_created','revision_cancelled'].map(action=>({action,
  actor_id:1,created_at:now,after_state:action==='revision_created'?{request:{details:'Fix title'},emailJobId:'private-job'}:{status:'cancelled'}}));
 const queries:string[]=[];
 const dialect=new PgDialect();
 const database={execute:async(statement:SQL)=>{
  const {sql,params}=dialect.sqlToQuery(statement); queries.push(sql);
  if(sql.includes('FROM backoffice_users'))return [{role}];
  if(sql.includes('FROM events'))return [{id:42}];
  if(sql.includes('FROM staff_event_assignments'))return [{ok:1}];
  if(sql.includes('clock_timestamp() AS now'))return [{now}];
  if(sql.includes('FROM poster_announcements'))return roster;
  if(sql.includes('FROM poster_targets WHERE'))return [{id:`target-${params[1]}`}];
  if(sql.includes('FROM poster_uploads u JOIN'))return [upload];
  if(sql.includes('SELECT id FROM poster_uploads'))return [{id:upload.id}];
  if(sql.includes('FROM poster_uploads WHERE'))return [upload];
  if(sql.includes('FROM poster_revision_requests'))return [];
  if(sql.includes('FROM poster_email_attempts'))return [];
  if(sql.includes('FROM poster_email_jobs'))return [{targetId:'target-1',id:'private-job',kind:'initial',state:'sent',createdAt:now,
   recipient:'private-recipient@example.invalid',subject:'private-subject',html:'private-html',templateVersion,finishedAt:null}];
  if(sql.includes('FROM poster_settings'))return [{eventId:42,closesAt:now,closes_at:now,version:1,reconcileReady:true,reconcile_ready:true,reconciledAt:now}];
  if(sql.includes("action='deadline_changed'"))return [];
  if(sql.includes('FROM poster_audit_events'))return sql.includes('AND action IN')?audits.filter(a=>['revision_created','revision_cancelled'].includes(a.action)):audits;
  throw new Error(`Unexpected reader query: ${sql}`);
 }} as unknown as PosterDatabase;
 return {database,actor:{id:1,email:'staff@example.invalid',role},queries};
}

test('organizer/reviewer receive only uploaded works before pagination and no verification/email data',async()=>{
 for(const role of ['organizer','reviewer']){
  const {database,actor,queries}=fixture(role);
  const list=await readPosterList(database,actor,42,listQuerySchema.parse({pageSize:1,page:2,matchState:'ready'}));
  assert.equal(list.total,2);assert.equal(list.items.length,1);assert.equal(list.items[0].abstractId,3);
  assert.equal(list.counts.not_submitted,0);assert.equal(list.counts.submitted,2);
  const detail=await readPosterDetail(database,actor,42,1);
  assert.deepEqual(detail.emailJobs,[]);assert.equal(detail.capabilities.manage,false);
  assert.deepEqual(detail.audit.map(a=>(a as {action:string}).action),['revision_created','revision_cancelled']);
  for(const row of [list.items[0],detail.row]){
   assert.equal(row.matchState,null);assert.equal(row.matchFingerprint,'');assert.equal(row.snapshot,null);
   assert.deepEqual(row.problems,[]);assert.equal(row.verifiedBy,null);assert.equal(row.verifiedAt,null);
   assert.equal(row.verificationReason,null);assert.equal(row.lastEmail,null);assert.equal(row.canNotify,false);
  }
  assert.equal(JSON.stringify(detail).includes('private-'),false);
  assert.equal(queries.some(q=>q.includes('SELECT id,kind,state,payload')),false);
  assert.equal(queries.some(q=>q.includes('FROM poster_email_attempts')),false);
  await assert.rejects(readPosterDetail(database,actor,42,2),{statusCode:404});
  await assert.rejects(readPosterSettings(database,actor,42),{statusCode:403});
  await assert.rejects(readPosterBatch(database,actor,42,'batch'),{statusCode:403});
 }
});

test('admin retains complete roster, verification, email and audit reads with optional received filtering',async()=>{
 const {database,actor}=fixture('admin');
 const list=await readPosterList(database,actor,42,listQuerySchema.parse({}));
 assert.equal(list.total,3);assert.equal(list.counts.not_submitted,1);
 assert.equal(list.items[0].matchState,'conflict');assert.ok(list.items[0].lastEmail);
 assert.equal((await readPosterList(database,actor,42,listQuerySchema.parse({received:'true'}))).total,2);
 const detail=await readPosterDetail(database,actor,42,1);
 assert.equal(detail.emailJobs.length,1);assert.equal(detail.audit.length,6);assert.equal(detail.capabilities.manage,true);
 assert.equal(detail.emailJobs[0].text,detail.emailJobs[0].html);
 const legacy=fixture('admin','poster-v1');
 assert.equal((await readPosterDetail(legacy.database,legacy.actor,42,1)).emailJobs[0].text,undefined);
 assert.ok((await readPosterDetail(database,actor,42,2)).row);
 assert.equal((await readPosterSettings(database,actor,42)).capabilities.manage,true);
 assert.equal((await readPosterBatch(database,actor,42,'batch')).jobs.length,1);
});
