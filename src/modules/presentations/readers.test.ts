import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PresentationDatabase } from './access.js';
import type { UploadDto, RevisionDto } from './types.js';
import { readPresentationList, readPresentationDetail, readPresentationSettings, readPresentationBatch, currentRosterRecords } from './readers.js';
import { listQuerySchema } from './schemas.js';

// Isolated reader fixtures: no runtime database, storage or email providers.
function fixture(role:string,templateVersion='presentation-initial-v1') {
 const now='2026-10-07T00:00:00.000Z';
 const upload={id:'file-1',targetId:'target-1',version:1,fileName:'poster.pdf',mimeType:'application/pdf',sizeBytes:100,
  storedFileName:'poster.pdf',fileUrl:'https://example.invalid/poster.pdf',storageProvider:'r2',driveFileId:null,receivedAt:now,revisionRequestId:null};
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
  if(sql.includes('FROM backoffice_users'))return [{role,assignedPresentationTypes:['poster']}];
  if(sql.includes('FROM events'))return [{id:42}];
  if(sql.includes('FROM staff_event_assignments'))return [{ok:1}];
  if(sql.includes('clock_timestamp() AS now'))return [{now}];
  if(sql.includes('FROM presentation_announcements'))return roster;
  if(sql.includes('FROM presentation_targets WHERE'))return [{id:`target-${params[1]}`}];
  if(sql.includes('FROM presentation_upload_files u JOIN'))return [upload];
  if(sql.includes('SELECT id FROM presentation_uploads'))return [{id:upload.id}];
  if(sql.includes('FROM presentation_upload_files WHERE'))return [upload];
  if(sql.includes('FROM presentation_revision_requests'))return [];
  if(sql.includes('FROM presentation_email_attempts'))return [];
  if(sql.includes('FROM presentation_email_jobs'))return [{targetId:'target-1',id:'private-job',kind:'initial',state:'sent',createdAt:now,
   recipient:'private-recipient@example.invalid',subject:'private-subject',html:'private-html',templateVersion,finishedAt:null}];
  if(sql.includes('FROM presentation_settings'))return [{eventId:42,closesAt:now,closes_at:now,version:1,reconcileReady:true,reconcile_ready:true,reconciledAt:now}];
  if(sql.includes("action='deadline_changed'"))return [];
  if(sql.includes('FROM presentation_audit_events'))return sql.includes('AND action IN')?audits.filter(a=>['revision_created','revision_cancelled'].includes(a.action)):audits;
  throw new Error(`Unexpected reader query: ${sql}`);
 }} as unknown as PresentationDatabase;
 return {database,actor:{id:1,email:'staff@example.invalid',role},queries,roster};
}

test('participant groups filter before pagination/counts, preserve legacy general and intersect other filters',async()=>{
 const {database,actor,roster}=fixture('admin');
 Object.assign(roster[2].source_row,{participantGroup:'student'});
 const student=await readPresentationList(database,actor,42,listQuerySchema.parse({participantGroup:'student',pageSize:1}));
 assert.equal(student.total,1);assert.equal(student.items[0].abstractId,3);assert.equal(student.counts.submitted,1);
 const general=await readPresentationList(database,actor,42,listQuerySchema.parse({participantGroup:'general',pageSize:1,page:2}));
 assert.equal(general.total,2);assert.equal(general.items[0].abstractId,2);
 assert.equal(general.counts.submitted,1);assert.equal(general.counts.not_submitted,1);
 for(const extra of [{round:'2'},{presentationType:'oral'},{status:'not_submitted'},{search:'not found'}]){
  const empty=await readPresentationList(database,actor,42,listQuerySchema.parse({participantGroup:'student',...extra}));
  assert.equal(empty.total,0);assert.equal(empty.items.length,0);
 }
 assert.equal((await readPresentationList(database,actor,42,listQuerySchema.parse({}))).total,3);
 assert.equal(listQuerySchema.safeParse({participantGroup:'invalid'}).success,false);
});

test('student filtering retains received-only viewer access and private data projection',async()=>{
 const {database,actor,roster}=fixture('reviewer');
 Object.assign(roster[1].source_row,{participantGroup:'student'});
 Object.assign(roster[2].source_row,{participantGroup:'student'});
 const result=await readPresentationList(database,actor,42,listQuerySchema.parse({participantGroup:'student'}));
 assert.equal(result.total,1);assert.equal(result.items[0].abstractId,3);
 assert.equal(result.items[0].announcement.participantGroup,'student');
 assert.equal(result.items[0].canNotify,false);assert.equal(result.items[0].snapshot,null);
 assert.deepEqual(result.items[0].problems,[]);
});

test('organizer/reviewer receive only uploaded works before pagination and no verification/email data',async()=>{
 for(const role of ['organizer','reviewer']){
  const {database,actor,queries}=fixture(role);
  const list=await readPresentationList(database,actor,42,listQuerySchema.parse({pageSize:1,page:2,matchState:'ready'}));
  assert.equal(list.total,2);assert.equal(list.items.length,1);assert.equal(list.items[0].abstractId,3);
  assert.equal(list.counts.not_submitted,0);assert.equal(list.counts.submitted,2);
  const detail=await readPresentationDetail(database,actor,42,1);
  assert.deepEqual(detail.emailJobs,[]);assert.equal(detail.capabilities.manage,false);
  assert.deepEqual(detail.audit,[]);assert.deepEqual(detail.requests,[]);
  for(const row of [list.items[0],detail.row]){
   assert.equal(row.matchState,null);assert.equal(row.matchFingerprint,'');assert.equal(row.snapshot,null);
   assert.deepEqual(row.problems,[]);assert.equal(row.verifiedBy,null);assert.equal(row.verifiedAt,null);
   assert.equal(row.verificationReason,null);assert.equal(row.lastEmail,null);assert.equal(row.canNotify,false);
  }
  assert.equal(JSON.stringify(detail).includes('private-'),false);
  assert.equal(queries.some(q=>q.includes('SELECT id,kind,state,payload')),false);
  assert.equal(queries.some(q=>q.includes('FROM presentation_email_attempts')),false);
  await assert.rejects(readPresentationDetail(database,actor,42,2),{statusCode:404});
  await assert.rejects(readPresentationSettings(database,actor,42),{statusCode:403});
  await assert.rejects(readPresentationBatch(database,actor,42,'batch'),{statusCode:403});
 }
});

test('admin retains complete roster, verification, email and audit reads with optional received filtering',async()=>{
 const {database,actor}=fixture('admin');
 const list=await readPresentationList(database,actor,42,listQuerySchema.parse({}));
 assert.equal(list.total,3);assert.equal(list.counts.not_submitted,1);
 assert.equal(list.items[0].matchState,'conflict');assert.ok(list.items[0].lastEmail);
 assert.equal((await readPresentationList(database,actor,42,listQuerySchema.parse({received:'true'}))).total,2);
 const detail=await readPresentationDetail(database,actor,42,1);
 assert.equal(detail.emailJobs.length,1);assert.equal(detail.audit.length,6);assert.equal(detail.capabilities.manage,true);
 assert.equal(detail.emailJobs[0].html,'private-html');
 assert.ok((await readPresentationDetail(database,actor,42,2)).row);
 assert.equal((await readPresentationSettings(database,actor,42)).capabilities.manage,true);
 assert.equal((await readPresentationBatch(database,actor,42,'batch')).jobs.length,1);
});

test('a target shows only its present announcement; withdrawn rows stay only when nothing present replaces them', () => {
 const row=(source_key:string,target_id:string|null,present:boolean)=>({source_key,target_id,present,source_row:{round:Number(source_key[0])}});
 const kept=currentRosterRecords([
  row('1:121','target-a',false),row('2:75','target-a',true),
  row('1:5','target-b',false),row('2:9','target-b',false),
  row('1:7',null,false),row('1:8',null,false),
  row('2:1','target-c',true),row('2:2','target-c',true),
 ]).map(r=>r.source_key);
 // Round 1 history must not shadow the current Round 2 row that owns the same uploads.
 assert.deepEqual(kept,['2:75','2:9','1:7','1:8','2:1','2:2']);
});

function historyFixture(role: string, status: RevisionDto['status'] = 'open') {
  const base = fixture(role);
  const now = '2026-10-07T00:00:00.000Z';
  const current: UploadDto = {
    id: 'file-current', version: 2, fileName: 'latest.pdf',
    storedFileName: 'latest.pdf', mimeType: 'application/pdf', sizeBytes: 100,
    fileUrl: 'https://example.invalid/latest.pdf', fileStatus: 'available',
    deletedAt: null, storageProvider: 'r2', driveFileId: null,
    receivedAt: now, revisionRequestId: 'private-request',
  };
  const old: UploadDto = {
    ...current, id: 'file-old', version: 1, fileName: 'private-old.pdf',
    fileUrl: 'https://example.invalid/private-old.pdf', revisionRequestId: null,
  };
  const request: RevisionDto = {
    id: 'private-request', details: 'private-revision-details',
    closesAt: '2026-10-08T00:00:00.000Z', status, createdAt: now,
    requestedBy: 99, submittedAt: null, cancelledAt: null,
    cancelledBy: null, cancellationReason: null,
  };
  for (const row of base.roster) {
    if (row.current_upload_id) row.current_upload_id = current.id;
  }
  const dialect = new PgDialect();
  const database = {
    execute: async (statement: SQL) => {
      const { sql, params } = dialect.sqlToQuery(statement);
      if (sql.includes('FROM presentation_upload_files u JOIN')) {
        base.queries.push(sql);
        return [current, old].map(file => ({ ...file, targetId: 'target-1' }));
      }
      if (sql.includes('SELECT id FROM presentation_uploads')) {
        base.queries.push(sql);
        return [{ id: current.id }, { id: old.id }];
      }
      if (sql.includes('FROM presentation_upload_files WHERE')) {
        base.queries.push(sql);
        return [current, old].filter(file => file.id === params[0]);
      }
      if (sql.includes('FROM presentation_revision_requests')) {
        base.queries.push(sql);
        return [{ ...request, targetId: 'target-1' }];
      }
      return base.database.execute(statement);
    },
  } as unknown as PresentationDatabase;
  return { ...base, database, current, old, request };
}

test('viewers receive only current file and cannot infer revision state through filters', async () => {
  for (const role of ['organizer', 'reviewer']) {
    for (const state of ['open', 'submitted', 'expired', 'cancelled'] as const) {
      const f = historyFixture(role, state);
      for (const received of [undefined, 'true']) {
        for (const status of [undefined, 'not_submitted', 'submitted', 'revision_pending', 'revised', 'revision_expired']) {
          const list = await readPresentationList(f.database, f.actor, 42,
            listQuerySchema.parse({ status, received, pageSize: 1, page: 2, matchState: 'ready' }));
          assert.equal(list.total, 2);
          assert.equal(list.items[0].abstractId, 3);
          assert.deepEqual(list.counts, {
            not_submitted: 0, submitted: 2, revision_pending: 0,
            revised: 0, revision_expired: 0,
          });
          assert.equal(list.items[0].progress, 'submitted');
          assert.equal(list.items[0].activeRequest, null);
          assert.equal(list.items[0].currentUpload?.revisionRequestId, null);
        }
      }
      const detail = await readPresentationDetail(f.database, f.actor, 42, 1);
      assert.deepEqual(detail.uploads.map(file => file.id), [f.current.id]);
      assert.equal(detail.row.currentUpload?.id, f.current.id);
      assert.equal(detail.uploads[0].revisionRequestId, null);
      assert.deepEqual(detail.requests, []);
      assert.deepEqual(detail.emailJobs, []);
      assert.deepEqual(detail.audit, []);
      assert.equal(detail.row.activeRequest, null);
      assert.equal(detail.row.progress, 'submitted');
      assert.equal(JSON.stringify(detail).includes('private-'), false);
      assert.equal(f.queries.some(q => q.includes('SELECT id FROM presentation_uploads')), false);
      assert.equal(f.queries.some(q => q.includes('FROM presentation_audit_events')), false);
    }
  }
});

test('admin keeps old files and real revision filters', async () => {
  const f = historyFixture('admin');
  const detail = await readPresentationDetail(f.database, f.actor, 42, 1);
  assert.equal(detail.uploads.length, 2);
  assert.equal(detail.requests[0].details, 'private-revision-details');
  assert.equal(detail.row.currentUpload?.revisionRequestId, 'private-request');
  assert.equal(detail.row.progress, 'revision_pending');
  assert.ok(detail.emailJobs.length > 0);
  assert.ok(detail.audit.length > 0);
  const list = await readPresentationList(f.database, f.actor, 42,
    listQuerySchema.parse({ status: 'revision_pending' }));
  assert.deepEqual(list.items.map(row => row.abstractId), [1]);
});

test('viewer retains unavailable current file without falling back to an older file', async () => {
  for (const role of ['organizer', 'reviewer']) {
    const f = historyFixture(role);
    f.current.fileUrl = null;
    f.current.fileStatus = 'deleted';
    const detail = await readPresentationDetail(f.database, f.actor, 42, 1);
    assert.deepEqual(detail.uploads.map(file => file.id), [f.current.id]);
    assert.equal(detail.row.currentUpload?.fileUrl, null);
    assert.equal(detail.row.currentUpload?.fileStatus, 'deleted');
    assert.equal(JSON.stringify(detail).includes(f.old.fileUrl!), false);
  }
});
