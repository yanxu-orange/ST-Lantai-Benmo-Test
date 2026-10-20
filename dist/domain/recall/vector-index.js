import {AiProviderError,assertAiCurrent} from '../../shared/ai/provider.js';
import {RECALL_REQUEST_LIMITS} from '../../shared/ai/recall-provider.js';
import {cosine} from './multichannel.js';
import {vectorIdentity as identity,vectorDocuments as documents,validStoredVector} from './vector-records.js';

const key=target=>JSON.stringify([target.chatId,target.rootId]);
const safeCode=error=>['cancelled','stale','storage','configuration','capability','mapping','timeout','http','authentication','endpoint','rate_limit','cors_network','request','task_preset_missing'].includes(error?.code)?error.code:'transport';
function batchesFor(docs){
 const batches=[];let batch=[],bytes=0;
 for(const doc of docs){const size=new TextEncoder().encode(doc.text).length;if(size>RECALL_REQUEST_LIMITS.inputBytes)throw new AiProviderError('request');
  if(batch.length&&(batch.length===RECALL_REQUEST_LIMITS.embeddingBatch||bytes+size>RECALL_REQUEST_LIMITS.inputBytes)){batches.push(batch);batch=[];bytes=0;}
  batch.push(doc);bytes+=size;
 }if(batch.length)batches.push(batch);return batches;
}
function checkedRows(result,batch,expected){
 if(!Array.isArray(result?.rows)||result.rows.length!==batch.length)throw new AiProviderError('mapping');
 const byId=new Map(result.rows.map(row=>[row.id,row.embedding]));if(byId.size!==batch.length)throw new AiProviderError('mapping');
 let dimensions=expected;
 const rows=batch.map(doc=>{const vector=byId.get(doc.id);if(!Array.isArray(vector)||!vector.length||vector.length>RECALL_REQUEST_LIMITS.dimensions||vector.some(n=>typeof n!=='number'||!Number.isFinite(n))||!Number.isFinite(Math.hypot(...vector))||Math.hypot(...vector)===0)throw new AiProviderError('mapping');
  dimensions??=vector.length;if(vector.length!==dimensions)throw new AiProviderError('mapping');return{id:doc.id,version:doc.version,vector:[...vector]};
 });return{rows,dimensions};
}

// Persist only validated generated-memory versions and vectors, never query or
// chat text. A missing store is supported only for isolated pure consumers.
export function createVectorIndex({provider,store=null}={}){
 const caches=new Map(),jobs=new Map(),listeners=new Set();let disposed=false;
 const notify=()=>{for(const listener of listeners)try{listener();}catch{}};
 const current=(job,isCurrent)=>{try{return!disposed&&jobs.get(job.key)===job&&!job.controller.signal.aborted&&isCurrent()===true;}catch{return false;}};
 function view(target,events,config){
  const docs=documents(events),cache=caches.get(key(target)),job=jobs.get(key(target));
  const matches=cache?.identity===identity(config),valid=matches?docs.filter(doc=>cache.entries.get(doc.id)?.version===doc.version):[];
  return{status:job?'preparing':valid.length===docs.length&&matches?'ready':valid.length?'partial':'needs-preparation',indexed:valid.length,total:docs.length,missing:docs.length-valid.length,dimensions:matches?cache.dimensions:null,
   lastError:matches?cache.error:null,modelIdentityVerified:matches&&valid.length>0?valid.every(doc=>cache.entries.get(doc.id).modelIdentityVerified):false,runtimeOnly:!store,refreshRequiresPreparation:!store,
   maintenanceStatus:job?'processing':valid.length===docs.length&&matches?'ready':matches&&cache.error?'failed':matches&&cache.paused?'paused':'pending',persistent:!!store&&matches&&!cache.storageError};
 }
 async function hydrate({target,events,config,signal,isCurrent=()=>true}){
  assertAiCurrent(signal,isCurrent);const cacheKey=key(target),expected=identity(config),old=caches.get(cacheKey);
  if(old?.identity===expected)return view(target,events,config);
  const cache={identity:expected,entries:new Map(),dimensions:null,error:null,paused:false,storageError:false};
  if(!store){if(!old)caches.set(cacheKey,cache);return view(target,events,config);}
  try{
   const rows=await store.load({target,identity:expected},{signal,isCurrent});assertAiCurrent(signal,isCurrent);
   const wanted=new Map(documents(events).map(doc=>[doc.id,doc.version]));
   for(const row of rows){if(!validStoredVector(row)||wanted.get(row.id)!==row.version)continue;if(cache.dimensions!==null&&cache.dimensions!==row.dimensions)throw new AiProviderError('mapping');cache.dimensions=row.dimensions;cache.entries.set(row.id,{id:row.id,version:row.version,vector:Array.from(row.vector),modelIdentityVerified:row.modelIdentityVerified});}
   // Another request may have hydrated/prepared this scope while storage read.
   if(caches.get(cacheKey)!==old)return view(target,events,config);caches.set(cacheKey,cache);return view(target,events,config);
  }catch(error){assertAiCurrent(signal,isCurrent);cache.error=safeCode(error);cache.storageError=true;if(caches.get(cacheKey)===old)caches.set(cacheKey,cache);throw new AiProviderError(cache.error);}
 }
 function cancel(target){
  let changed=false;for(const job of jobs.values())if(!target||job.key===key(target)){job.controller.abort();jobs.delete(job.key);const cache=caches.get(job.key);if(cache)cache.paused=true;changed=true;}if(changed)notify();
 }
 async function prepare({target,events,config,signal,isCurrent,verify,rebuild=false,onlyIds=null}){
  if(disposed||typeof isCurrent!=='function'||typeof verify!=='function'||typeof provider?.embed!=='function')throw new AiProviderError('configuration');
  assertAiCurrent(signal,isCurrent);if(caches.get(key(target))?.storageError)caches.delete(key(target));await hydrate({target,events,config,signal,isCurrent});cancel(target);
  const docs=documents(events),cacheKey=key(target),old=caches.get(cacheKey),same=!rebuild&&old?.identity===identity(config);
  const entries=new Map(same?docs.flatMap(doc=>old.entries.get(doc.id)?.version===doc.version?[[doc.id,old.entries.get(doc.id)]]:[]):[]);
  const selected=onlyIds===null?null:new Set(onlyIds);if(selected&&(selected.size!==onlyIds.length||[...selected].some(id=>!docs.some(doc=>doc.id===id))))throw new AiProviderError('request');
  const cache={identity:identity(config),entries,dimensions:same?old.dimensions:null,error:null,paused:false,storageError:false};
  const job={key:cacheKey,controller:new AbortController()};jobs.set(cacheKey,job);
  const abort=()=>job.controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();notify();
  const check=async()=>{assertAiCurrent(job.controller.signal,()=>current(job,isCurrent));if(await verify()!==true)throw new AiProviderError('stale');assertAiCurrent(job.controller.signal,()=>current(job,isCurrent));};
  try{
   const pending=docs.filter(doc=>(!selected||selected.has(doc.id))&&!entries.has(doc.id)),batches=batchesFor(pending);
   await check();
   for(const batch of batches){
    await check();
    const result=await provider.embed({inputs:batch,inputType:'document',...(cache.dimensions?{expectedDimensions:cache.dimensions}:{}),signal:job.controller.signal,isCurrent:()=>current(job,isCurrent)});
    const checked=checkedRows(result,batch,cache.dimensions);await check();
    const saved=checked.rows.map(row=>({...row,dimensions:checked.dimensions,modelIdentityVerified:result.modelIdentity?.verified===true}));
    if(store)try{await store.save({target,identity:cache.identity,rows:saved},{signal:job.controller.signal,isCurrent:()=>current(job,isCurrent)});}catch(error){throw new AiProviderError(safeCode(error));}
    await check();cache.dimensions=checked.dimensions;
    for(const row of saved)entries.set(row.id,row);
    caches.set(cacheKey,cache);notify();
   }
   await check();caches.set(cacheKey,cache);if(jobs.get(cacheKey)===job)jobs.delete(cacheKey);return view(target,events,config);
  }catch(error){
   cache.error=safeCode(error);cache.storageError=cache.error==='storage';if(current(job,isCurrent)&&!['stale','cancelled'].includes(cache.error))caches.set(cacheKey,cache);if(caches.get(cacheKey)===cache)notify();throw new AiProviderError(cache.error);
  }finally{signal?.removeEventListener('abort',abort);if(jobs.get(cacheKey)===job)jobs.delete(cacheKey);notify();}
 }
 async function query({target,events,config,text,signal,isCurrent,dateById=new Map()}){
  if(disposed||typeof provider?.embed!=='function')throw new AiProviderError('configuration');assertAiCurrent(signal,isCurrent);
  await hydrate({target,events,config,signal,isCurrent});
  const state=view(target,events,config),cache=caches.get(key(target));
  if(!text.trim())return{status:'empty-query',rows:[],index:state};
  if(!state.indexed)return{status:'missing-index',rows:[],index:state};
  const docs=documents(events).filter(doc=>cache.entries.get(doc.id)?.version===doc.version&&!dateById.get(doc.id)?.blocked);
  if(!docs.length)return{status:'no-date-eligible',rows:[],index:state};
  const guarded=()=>isCurrent()===true&&!disposed&&caches.get(key(target))===cache&&cache.identity===identity(config);
  const result=await provider.embed({inputs:[{id:'query',text}],inputType:'query',expectedDimensions:cache.dimensions,signal,isCurrent:guarded});
  assertAiCurrent(signal,guarded);const checked=checkedRows(result,[{id:'query',text}],cache.dimensions),vector=checked.rows[0].vector;
  const order=new Map(events.map((event,index)=>[event.id,index]));
  const rows=docs.map(doc=>({id:doc.id,score:cosine(vector,cache.entries.get(doc.id).vector),libraryIndex:order.get(doc.id)}))
   .sort((a,b)=>b.score-a.score||a.libraryIndex-b.libraryIndex).map((row,index)=>({...row,rank:index+1}));
  return{status:state.status==='ready'?'ready':'partial',rows,index:state,modelIdentityVerified:result.modelIdentity?.verified===true,localDateProjectionLimited:docs.some(doc=>dateById.get(doc.id)?.partialScope)};
 }
 async function prune({target,events,config,signal,isCurrent=()=>true}){assertAiCurrent(signal,isCurrent);const ids=new Set(events.filter(event=>event.mode==='trigger'&&!event.supersededBy).map(doc=>doc.id)),cache=caches.get(key(target));if(cache&&(!config||cache.identity===identity(config)))for(const id of cache.entries.keys())if(!ids.has(id))cache.entries.delete(id);if(store)await store.prune({target,ids:[...ids]},{signal,isCurrent});notify();}
 return Object.freeze({prepare,query,hydrate,prune,inspect:view,cancel,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},dispose(){disposed=true;cancel();caches.clear();listeners.clear();store?.close?.();}});
}
