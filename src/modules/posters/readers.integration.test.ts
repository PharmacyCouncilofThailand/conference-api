import assert from 'node:assert/strict';
import test from 'node:test';
import { readOwnerPoster, readPosterList, readPosterSettings, readPosterDetail, posterProgress } from './readers.js';
import { preparePosterScenario } from './test-support.js';
import { reconcilePosters } from './reconcile.js';
import { listQuerySchema } from './schemas.js';

test('scoped readers retain orphan/withdrawn rows, filter and protect private projections', async t=>{
 const {client:sql,database,fixture:f,announcement}=await preparePosterScenario(t);
 process.env.POSTER_SUBMISSIONS_ENABLED='true';
 const missing={...announcement,id:2,trackingId:'MISSING',title:'Missing'};
 await reconcilePosters(database,[announcement,missing,{...missing,id:3,presentationType:'highlighted-poster'},{...missing,id:4,presentationType:'oral'}]);
 let list=await readPosterList(database,f.admin,f.eventId,listQuerySchema.parse({pageSize:1}));
 assert.equal(list.total,3);assert.equal(list.items.length,1);assert.equal(list.counts.not_submitted,3);
 assert.equal((await readPosterList(database,f.admin,f.eventId,listQuerySchema.parse({matchState:'missing'}))).total,2);
 assert.equal((await readPosterList(database,f.admin,f.eventId,listQuerySchema.parse({search:'OWNER@EXAMPLE.INVALID'}))).total,1);
 const owner=await readOwnerPoster(database,f.owner,f.abstractId);assert.equal(owner.canUpload,true);assert.ok(!JSON.stringify(owner).includes(f.owner.email));
 await assert.rejects(readOwnerPoster(database,{...f.owner,id:999},f.abstractId),{statusCode:403});
 await sql`INSERT INTO backoffice_users(email,role) VALUES ('reviewer@example.invalid','reviewer')`;
 const reviewer={id:2,email:'reviewer@example.invalid',role:'reviewer'};
 await assert.rejects(readPosterList(database,reviewer,f.eventId,listQuerySchema.parse({})),{statusCode:403});
 await sql`INSERT INTO staff_event_assignments VALUES (2,${f.eventId})`;
 await assert.rejects(readPosterSettings(database,reviewer,f.eventId),{statusCode:403});
 assert.equal((await readPosterList(database,reviewer,f.eventId,listQuerySchema.parse({}))).total,0);
 await assert.rejects(readPosterDetail(database,reviewer,f.eventId,f.abstractId),{statusCode:404});
 await assert.rejects(readPosterDetail(database,reviewer,999,f.abstractId),{statusCode:404});
 await assert.rejects(readPosterDetail(database,reviewer,f.eventId,999),{statusCode:404});
 await sql`UPDATE backoffice_users SET role='organizer' WHERE id=2`;
 await assert.rejects(readPosterSettings(database,reviewer,f.eventId),{statusCode:403});
 await reconcilePosters(database,[announcement]);
 list=await readPosterList(database,f.admin,f.eventId,listQuerySchema.parse({matchState:'withdrawn'}));assert.equal(list.total,2);
 process.env.POSTER_SUBMISSIONS_ENABLED='false';assert.equal((await readOwnerPoster(database,f.owner,f.abstractId)).canUpload,false);
});

test('progress derives expired/open revisions and revised/current files',()=>{
 const now=new Date('2026-10-07T00:00:00Z');
 const file={revisionRequestId:null} as any;
 assert.equal(posterProgress(null,null,now),'not_submitted');assert.equal(posterProgress(file,null,now),'submitted');
 assert.equal(posterProgress({...file,revisionRequestId:'x'},null,now),'revised');
 assert.equal(posterProgress(file,{status:'open',closesAt:'2026-10-08T00:00:00Z'} as any,now),'revision_pending');
 assert.equal(posterProgress(file,{status:'open',closesAt:now.toISOString()} as any,now),'revision_expired');
});
