import { POSTER_TEXT_TEMPLATE_VERSION } from './email-template.js';
import { loadPosterAnnouncements } from './data/index.js';
import type { Announcement } from './types.js';

export function publicAnnouncements(): Announcement[] {
  return loadPosterAnnouncements().map(r => ({ id: r.id, sequence: r.sequence, trackingId: r.trackingId,
    title: r.title, presentationType: r.presentationType, categoryId: r.categoryId,
    categoryName: r.categoryName, submitterName: r.submitterName, affiliation: r.affiliation, round: r.round }));
}

import { ApiError } from '../../errors/ApiError.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { rows, fail, dbNow, requirePosterOwner, requirePosterStaff, type PosterDatabase } from './access.js';
import { effectiveRevisionStatus, isBeforeClose, normalizeSubmitterName } from './policy.js';
import { assertInitialReady } from './reconcile.js';
import { readUploadDto } from './storage.js';
import { listQuerySchema } from './schemas.js';
import type { OwnerPosterDto, PosterActor, UploadDto, RevisionDto, DbCandidate, MatchResult, MatchState, MailKind, MailState, PosterProgress, PosterListRow, PosterSettingsDto, PosterSettingsHistoryDto, PosterListDto, PosterDetailDto, PosterBatchDto } from './types.js';
export async function readOwnerPoster(database:PosterDatabase,actor:PosterActor,abstractId:number,requestId?:string):Promise<OwnerPosterDto>{
 const owner=await requirePosterOwner(database,actor,abstractId);
 const [target]=await rows<{id:string;current_upload_id:string|null;closes_at:Date}>(database,sql`SELECT t.id,t.current_upload_id,s.closes_at
  FROM poster_targets t JOIN poster_settings s ON s.event_id=t.event_id WHERE t.event_id=${owner.eventId} AND t.abstract_id=${abstractId}`);
 if(!target)fail('POSTER_NOT_ELIGIBLE',404);
 const files=await rows<{id:string}>(database,sql`SELECT id FROM poster_uploads WHERE target_id=${target.id}::uuid ORDER BY version DESC`);
 const uploads:UploadDto[]=[];for(const file of files)uploads.push((await readUploadDto(database,file.id))!);
 const requests=await rows<RevisionDto>(database,sql`SELECT id,details,closes_at AS "closesAt",status,created_at AS "createdAt",
  requested_by AS "requestedBy",submitted_at AS "submittedAt",cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",
  cancellation_reason AS "cancellationReason" FROM poster_revision_requests WHERE target_id=${target.id}::uuid ORDER BY created_at DESC,id DESC`);
 const now=await dbNow(database);
 const converted=requests.map(r=>({...r,closesAt:new Date(r.closesAt).toISOString(),createdAt:new Date(r.createdAt).toISOString(),
  submittedAt:r.submittedAt?new Date(r.submittedAt).toISOString():null,cancelledAt:r.cancelledAt?new Date(r.cancelledAt).toISOString():null,
  status:effectiveRevisionStatus({...r,closesAt:new Date(r.closesAt).toISOString()},now)}));
 const selected=requestId?converted.find(r=>r.id===requestId.toLowerCase()):converted.find(r=>r.status==='open');
 if(requestId&&!selected)fail('POSTER_REQUEST_NOT_FOUND',404);
 let blockCode:string|null=null;
 if(process.env.POSTER_SUBMISSIONS_ENABLED!=='true')blockCode='POSTER_RECEIVING_DISABLED';
 if(selected){if(selected.status!=='open')blockCode=`POSTER_REQUEST_${selected.status.toUpperCase()}`;}
 else if(uploads.length)blockCode='POSTER_ALREADY_SUBMITTED';
 else {try{await assertInitialReady(database,target.id);}catch(error){if(!(error instanceof ApiError))throw error;blockCode=error.code;}
  if(!blockCode&&!isBeforeClose(now,new Date(target.closes_at)))blockCode='POSTER_DEADLINE_PASSED';}
 if(owner.presentationType!=='poster')blockCode='POSTER_NOT_ELIGIBLE';
 const [announcement]=await rows<{source_row:Announcement}>(database,sql`SELECT source_row FROM poster_announcements
  WHERE target_id=${target.id}::uuid ORDER BY present DESC,source_key LIMIT 1`);
 const row=announcement?.source_row;
 return {abstractId,trackingId:owner.canonicalTrackingId??row?.trackingId??'',title:owner.title,
  submitterName:normalizeSubmitterName(`${owner.firstName??''} ${owner.lastName??''}`),presentationType:row?.presentationType??'poster',
  categoryName:row?.categoryName??'',round:row?.round??1,serverNow:now.toISOString(),mainClosesAt:iso(target.closes_at),
  canUpload:!blockCode,blockCode,mode:selected?.status==='open'?'revision':blockCode?'locked':'initial',
  selectedRequest:selected??null,currentUpload:uploads.find(u=>u.id===target.current_upload_id)??null,uploads};
}
export function posterProgress(current:UploadDto|null,latest:RevisionDto|null,now:Date):PosterProgress{
 if(latest){const state=effectiveRevisionStatus(latest,now);
  if(state==='open')return 'revision_pending';if(state==='expired')return 'revision_expired';}
 return !current?'not_submitted':current.revisionRequestId?'revised':'submitted';
}
type RosterRecord={source_key:string;source_row:Announcement;match_state:MatchState;match_fingerprint:string;
 match_snapshot:{announcement:Announcement;candidates:DbCandidate[];match:MatchResult};verified_fingerprint:string|null;
 verified_by:number|null;verified_at:Date|null;verification_reason:string|null;present:boolean;target_id:string|null;
 abstract_id:number|null;current_upload_id:string|null;submitter_email:string|null};
const iso=(value:string|Date)=>new Date(value).toISOString();
const maybeIso=(value:string|Date|null)=>value?iso(value):null;
function revisionDto(r:RevisionDto,now:Date):RevisionDto{
 const dto={...r,closesAt:iso(r.closesAt),createdAt:iso(r.createdAt),submittedAt:maybeIso(r.submittedAt),cancelledAt:maybeIso(r.cancelledAt)};
 return {...dto,status:effectiveRevisionStatus(dto,now)};
}
// ponytail: bounded conference roster; switch to SQL filtering/pagination if events grow to thousands of works.
async function readRosterRows(q:Pick<PosterDatabase,'execute'>,eventId:number,now:Date):Promise<PosterListRow[]>{
 const announcements=await rows<RosterRecord>(q,sql`SELECT a.*,t.id AS target_id,t.abstract_id,t.current_upload_id,u.email AS submitter_email
  FROM poster_announcements a LEFT JOIN poster_targets t ON t.id=a.target_id LEFT JOIN abstracts ab ON ab.id=t.abstract_id AND ab.event_id=a.event_id
  LEFT JOIN users u ON u.id=ab.user_id WHERE a.event_id=${eventId} AND (a.source_row->>'presentationType' IN ('poster','highlighted-poster'))
  ORDER BY (a.source_row->>'round')::int,(a.source_row->>'categoryId')::int,(a.source_row->>'sequence')::int NULLS LAST,a.source_key`);
 const files=await rows<UploadDto&{targetId:string}>(q,sql`SELECT u.id,u.target_id AS "targetId",u.version,u.filename AS "fileName",u.mime_type AS "mimeType",
  u.size_bytes AS "sizeBytes",u.public_url AS "publicUrl",u.received_at AS "receivedAt",u.request_id AS "revisionRequestId"
  FROM poster_uploads u JOIN poster_targets t ON t.id=u.target_id WHERE t.event_id=${eventId} ORDER BY u.version DESC`);
 const requests=await rows<RevisionDto&{targetId:string}>(q,sql`SELECT r.id,r.target_id AS "targetId",r.details,r.closes_at AS "closesAt",r.status,
  r.created_at AS "createdAt",r.requested_by AS "requestedBy",r.submitted_at AS "submittedAt",r.cancelled_at AS "cancelledAt",
  r.cancelled_by AS "cancelledBy",r.cancellation_reason AS "cancellationReason" FROM poster_revision_requests r
  JOIN poster_targets t ON t.id=r.target_id WHERE t.event_id=${eventId} ORDER BY r.created_at DESC,r.id DESC`);
 const mails=await rows<{targetId:string;id:string;kind:MailKind;state:MailState;createdAt:string;errorCode:string|null}>(q,
  sql`SELECT DISTINCT ON(j.target_id) j.target_id AS "targetId",j.id,j.kind,j.state,j.created_at AS "createdAt",j.error_code AS "errorCode"
   FROM poster_email_jobs j JOIN poster_targets t ON t.id=j.target_id WHERE t.event_id=${eventId} ORDER BY j.target_id,j.created_at DESC,j.id DESC`);
 const [setting]=await rows<{closes_at:Date;reconcile_ready:boolean}>(q,sql`SELECT closes_at,reconcile_ready FROM poster_settings WHERE event_id=${eventId}`);
 const uploads=new Map(files.map(({targetId: _targetId,...u})=>[u.id,{...u,receivedAt:iso(u.receivedAt)}]));
 const latest=new Map<string,RevisionDto>();
 for(const {targetId,...request} of requests)if(!latest.has(targetId))latest.set(targetId,revisionDto(request,now));
 const lastEmail=new Map(mails.map(j=>[j.targetId,{id:j.id,kind:j.kind,state:j.state,createdAt:iso(j.createdAt),errorCode:j.errorCode}]));
 return announcements.map(a=>{
  const file=a.current_upload_id?uploads.get(a.current_upload_id)??null:null;const request=a.target_id?latest.get(a.target_id)??null:null;
  const matchState=a.present?a.match_state:'withdrawn';const verified=a.verified_fingerprint===a.match_fingerprint;
  return {sourceKey:a.source_key,announcement:a.source_row,abstractId:a.abstract_id,matchState,matchFingerprint:a.match_fingerprint??'',
   problems:a.match_snapshot.match?.problems??[],snapshot:a.match_snapshot,verifiedBy:verified?a.verified_by:null,
   verifiedAt:verified?maybeIso(a.verified_at):null,verificationReason:verified?a.verification_reason:null,submitterEmail:a.submitter_email,
   progress:posterProgress(file,request,now),currentUpload:file,activeRequest:request?.status==='open'?request:null,
   lastEmail:a.target_id?lastEmail.get(a.target_id)??null:null,
   canNotify:a.present&&a.source_row.presentationType!=='oral'&&matchState==='ready'&&!!a.abstract_id&&z.string().email().safeParse(a.submitter_email).success&&!file&&!!setting?.reconcile_ready&&isBeforeClose(now,new Date(setting.closes_at))};
 });
}
function posterViewerRow(row:PosterListRow):PosterListRow{
 return {...row,matchState:null,matchFingerprint:'',problems:[],snapshot:null,verifiedBy:null,verifiedAt:null,
  verificationReason:null,lastEmail:null,canNotify:false};
}
export async function readPosterList(database:PosterDatabase,actor:PosterActor,eventId:number,query:z.infer<typeof listQuerySchema>):Promise<PosterListDto>{
 await requirePosterStaff(database,actor,eventId,false);const now=await dbNow(database);
 const [setting]=await rows<{eventId:number;closesAt:string;version:number;reconcileReady:boolean;reconciledAt:string|null}>(database,
  sql`SELECT event_id AS "eventId",closes_at AS "closesAt",version,reconcile_ready AS "reconcileReady",last_reconciled_at AS "reconciledAt"
   FROM poster_settings WHERE event_id=${eventId}`);
 if(!setting)fail('POSTER_RECONCILE_REQUIRED',503);
 const all=await readRosterRows(database,eventId,now);const term=normalizeSubmitterName(query.search??'').toLowerCase();
 const filtered=all.filter(r=>((actor.role==='admin'&&!query.received)||!!r.currentUpload)
  &&(!query.round||String(r.announcement.round)===query.round)&&(!query.presentationType||r.announcement.presentationType===query.presentationType)
  &&(actor.role!=='admin'||!query.matchState||r.matchState===query.matchState)&&(!query.status||r.progress===query.status)
  &&(!term||normalizeSubmitterName([r.announcement.title,r.announcement.submitterName,r.announcement.trackingId,r.submitterEmail].filter(Boolean).join(' ')).toLowerCase().includes(term)));
 const counts:Record<PosterProgress,number>={not_submitted:0,submitted:0,revision_pending:0,revised:0,revision_expired:0};
 for(const row of filtered)counts[row.progress]++;
 const items=filtered.slice((query.page-1)*query.pageSize,query.page*query.pageSize);
 return {items:actor.role==='admin'?items:items.map(posterViewerRow),total:filtered.length,page:query.page,pageSize:query.pageSize,
  settings:{...setting,closesAt:iso(setting.closesAt),reconciledAt:maybeIso(setting.reconciledAt)},capabilities:{read:true,manage:actor.role==='admin'},counts};
}
export async function readPosterDetail(database:PosterDatabase,actor:PosterActor,eventId:number,abstractId:number):Promise<PosterDetailDto>{
 await requirePosterStaff(database,actor,eventId,false);const now=await dbNow(database);
 const [target]=await rows<{id:string}>(database,sql`SELECT id FROM poster_targets WHERE event_id=${eventId} AND abstract_id=${abstractId}`);
 if(!target)fail('POSTER_NOT_FOUND',404);
 const row=(await readRosterRows(database,eventId,now)).find(r=>r.abstractId===abstractId);
 if(!row||(actor.role!=='admin'&&!row.currentUpload))fail('POSTER_NOT_FOUND',404);
 const ids=await rows<{id:string}>(database,sql`SELECT id FROM poster_uploads WHERE target_id=${target.id}::uuid ORDER BY version DESC`);
 const uploads:UploadDto[]=[];for(const file of ids)uploads.push((await readUploadDto(database,file.id))!);
 const requests=await rows<RevisionDto>(database,sql`SELECT id,details,closes_at AS "closesAt",status,created_at AS "createdAt",requested_by AS "requestedBy",
  submitted_at AS "submittedAt",cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",cancellation_reason AS "cancellationReason"
  FROM poster_revision_requests WHERE target_id=${target.id}::uuid ORDER BY created_at DESC,id DESC`);
 const jobs=actor.role==='admin'?await rows<Omit<PosterDetailDto['emailJobs'][number],'attempts'>>(database,sql`SELECT id,kind,state,payload->>'recipient' AS recipient,
  subject,html,template_version AS "templateVersion",created_at AS "createdAt",finished_at AS "finishedAt",triggered_by AS "triggeredBy",parent_job_id AS "parentJobId",
  request_id AS "requestId",upload_id AS "uploadId",error_code AS "errorCode" FROM poster_email_jobs WHERE target_id=${target.id}::uuid ORDER BY created_at DESC,id DESC`):[];
 const attempts=actor.role==='admin'?await rows<{job_id:string;started_at:string;request_started_at:string|null;finished_at:string|null}>(database,sql`SELECT a.* FROM poster_email_attempts a JOIN poster_email_jobs j ON j.id=a.job_id
  WHERE j.target_id=${target.id}::uuid ORDER BY a.started_at DESC,a.id DESC`):[];
 const audit=await rows<{created_at:string;action:string;after_state:Record<string,unknown>|null}>(database,sql`SELECT * FROM poster_audit_events WHERE event_id=${eventId} AND abstract_id=${abstractId}
  ${actor.role==='admin'?sql``:sql`AND action IN ('revision_created','revision_cancelled')`} ORDER BY created_at DESC,id DESC`);
 return {row:actor.role==='admin'?row!:posterViewerRow(row!),uploads,requests:requests.map(r=>revisionDto(r,now)),emailJobs:jobs.map(j=>({...j,...(j.templateVersion===POSTER_TEXT_TEMPLATE_VERSION?{text:j.html}:{}),createdAt:iso(j.createdAt),finishedAt:maybeIso(j.finishedAt),
  attempts:attempts.filter(a=>a.job_id===j.id).map(a=>({...a,started_at:iso(a.started_at),request_started_at:maybeIso(a.request_started_at),finished_at:maybeIso(a.finished_at)}))})),audit:audit.map(a=>({...a,created_at:iso(a.created_at),
   ...(actor.role!=='admin'&&a.action==='revision_created'?{after_state:{request:a.after_state?.request}}:{})})),capabilities:{read:true,manage:actor.role==='admin'}};
}
export async function readPosterSettings(database:PosterDatabase,actor:PosterActor,eventId:number):Promise<PosterSettingsHistoryDto>{
 await requirePosterStaff(database,actor,eventId,true);
 const [setting]=await rows<PosterSettingsDto>(database,sql`SELECT event_id AS "eventId",closes_at AS "closesAt",version,
  reconcile_ready AS "reconcileReady",last_reconciled_at AS "reconciledAt" FROM poster_settings WHERE event_id=${eventId}`);
 if(!setting)fail('POSTER_RECONCILE_REQUIRED',503);
 const history=await rows<PosterSettingsHistoryDto['history'][number]>(database,sql`SELECT id,actor_id AS "actorId",reason,
  before_state AS before,after_state AS after,created_at AS "createdAt" FROM poster_audit_events
  WHERE event_id=${eventId} AND action='deadline_changed' ORDER BY created_at DESC,id DESC`);
 return {settings:{...setting,closesAt:iso(setting.closesAt),reconciledAt:maybeIso(setting.reconciledAt)},
  history:history.map(h=>({...h,createdAt:iso(h.createdAt)})),capabilities:{read:true,manage:actor.role==='admin'}};
}
export async function readPosterBatch(database:PosterDatabase,actor:PosterActor,eventId:number,batchId:string):Promise<PosterBatchDto>{
 await requirePosterStaff(database,actor,eventId,true);
 const jobs=await rows<PosterBatchDto['jobs'][number]>(database,sql`SELECT j.id,t.abstract_id AS "abstractId",j.payload->>'recipient' AS recipient,j.state,j.error_code AS "errorCode"
  FROM poster_email_jobs j JOIN poster_targets t ON t.id=j.target_id WHERE t.event_id=${eventId} AND j.batch_id=${batchId}::uuid ORDER BY t.abstract_id`);
 if(!jobs.length)fail('POSTER_BATCH_NOT_FOUND',404);return {batchId,jobs};
}
