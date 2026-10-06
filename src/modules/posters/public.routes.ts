import type { PosterActor } from './types.js';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { fail, requirePosterOwner, type PosterDatabase } from './access.js';
import { publicAnnouncements, readOwnerPoster } from './readers.js';
import { idSchema, operationKeySchema } from './schemas.js';
import { MAX_POSTER_BYTES } from './policy.js';
import { submitPosterUpload } from './uploads.js';
import { createPosterStorage, type PosterStorage } from './storage.js';
export function posterValidationErrors(app: import('fastify').FastifyInstance) {
 app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) return reply.code(400).send({success:false,code:'POSTER_INVALID_INPUT',error:'Invalid input'});
  throw error;
 });
}
async function readPosterMultipart(request:FastifyRequest){
 let file:{buffer:Buffer;filename:string;mimetype:string}|undefined;let requestId:string|null=null;
 for await(const part of request.parts({limits:{files:1,fields:1,parts:2,fileSize:MAX_POSTER_BYTES}})){
  if(part.type==='file'){
   if(part.fieldname!=='file'||file)fail('POSTER_ONE_FILE_REQUIRED',422);
   file={buffer:await part.toBuffer(),filename:part.filename,mimetype:part.mimetype};
   if(part.file.truncated)fail('POSTER_FILE_TOO_LARGE',413);
  }else{if(part.fieldname!=='requestId'||requestId!==null||typeof part.value!=='string')fail('POSTER_INVALID_FIELDS',422);
   requestId=z.string().uuid().parse(part.value);}
 }
 if(!file)fail('POSTER_ONE_FILE_REQUIRED',422);return {file:file!,requestId};
}
// public.routes.ts
import type {FastifyPluginAsync} from 'fastify';
export const posterAnnouncementRoutes:FastifyPluginAsync=async app=>{
 posterValidationErrors(app);
 app.get('/:eventCode/approved-abstracts',async request=>{
  const {eventCode}=z.object({eventCode:z.string()}).strict().parse(request.params);
  z.object({}).strict().parse(request.query);
  if(eventCode!=='PRIS-2026')fail('POSTER_EVENT_NOT_FOUND',404);
  return {success:true,data:publicAnnouncements()};
 });
};
export const posterOwnerRoutes:FastifyPluginAsync<{database:PosterDatabase;storage?:PosterStorage}>=async(app,{database,storage})=>{
 posterValidationErrors(app);
 app.get('/:abstractId/poster',async request=>{
  const {abstractId}=z.object({abstractId:idSchema}).strict().parse(request.params);
  const {requestId}=z.object({requestId:z.string().uuid().optional()}).strict().parse(request.query);
  return {success:true,data:await readOwnerPoster(database,request.user as PosterActor,abstractId,requestId)};
 });
 app.post('/:abstractId/poster-uploads',async(request,reply)=>{
  const {abstractId}=z.object({abstractId:idSchema}).strict().parse(request.params);const actor=request.user as PosterActor;
  await requirePosterOwner(database,actor,abstractId);
  if(process.env.POSTER_SUBMISSIONS_ENABLED!=='true')fail('POSTER_RECEIVING_DISABLED',503);
  z.object({}).strict().parse(request.query);
  const key=operationKeySchema.parse(request.headers['idempotency-key']);
  let input:Awaited<ReturnType<typeof readPosterMultipart>>;
  try{input=await readPosterMultipart(request);}catch(error){
   if(typeof error==='object'&&error!==null&&'code'in error&&String(error.code).startsWith('FST_')){
    fail(String(error.code)==='FST_REQ_FILE_TOO_LARGE'?'POSTER_FILE_TOO_LARGE':'POSTER_ONE_FILE_REQUIRED',String(error.code)==='FST_REQ_FILE_TOO_LARGE'?413:422);
   }throw error;
  }
  const result=await submitPosterUpload(database,actor,abstractId,key,input.requestId,input.file,storage??createPosterStorage());
  return reply.code(201).send({success:true,data:result});
 });
};
