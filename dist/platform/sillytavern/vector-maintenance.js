import {sameTarget} from '../../domain/memory/repository.js';
import {activeEvents} from '../../domain/memory/event-model.js';
import {eventCardText} from '../../domain/recall/multichannel.js';
import {vectorOwner,vectorIdentity} from '../../domain/recall/vector-records.js';
import {createVectorIndex} from '../../domain/recall/vector-index.js';
import {recallChannels} from '../../shared/settings/model.js';
import {AiProviderError} from '../../shared/ai/provider.js';
import {featureGate} from '../../domain/controls/gate.js';
import {createVectorStore} from './vector-store.js';

const texts=events=>new Map(activeEvents(events).filter(event=>event.mode==='trigger').map(event=>[event.id,eventCardText(event)]));
const code=error=>['storage','mapping','timeout','http','cors_network','configuration','capability','request','cancelled','stale','task_preset_missing'].includes(error?.code)?error.code:'transport';
// One derived maintenance flight, never a second formal-result queue. New work
// originates only from confirmed event commits or an explicit processing action.
export function createVectorMaintenance({repository,settings,provider,getControls,store=createVectorStore()}={}){
 const gate=featureGate(getControls,'event'),index=createVectorIndex({provider,store}),listeners=new Set();
 let disposed=false,running=null,pumping=null,owner=null,queued=new Set(),userPaused=false,lastError=null,failedIds=new Set(),pruning=null,serviceIdentity=null,modelChanged=false;
 const notify=()=>{if(!disposed)for(const listener of [...listeners])try{listener();}catch{}};
 const enabled=()=>gate.allowed()&&recallChannels(settings.captureRecall().recall).vector;
 const targetCurrent=target=>{try{return!disposed&&sameTarget(target,repository.captureTarget());}catch{return false;}};
 function capture(){
  if(disposed||!enabled())throw new AiProviderError('cancelled');
  const target=repository.captureTarget();resetOwner(target);const config=settings.getAiConfig('embedding');if(config?.source!=='plugin')throw new AiProviderError('configuration');rememberIdentity(config);
  return{target,config,aiEpoch:settings.captureAi().epoch,control:gate.capture(),identity:vectorIdentity(config)};
 }
 function matches(proof){try{return targetCurrent(proof.target)&&enabled()&&settings.captureAi().epoch===proof.aiEpoch&&gate.matches(proof.control)&&vectorIdentity(settings.getAiConfig('embedding'))===proof.identity;}catch{return false;}}
 function resetOwner(target){const value=vectorOwner(target);if(owner!==value){owner=value;queued.clear();failedIds.clear();userPaused=false;lastError=null;serviceIdentity=null;modelChanged=false;}}
 function rememberIdentity(config){const value=vectorIdentity(config);if(serviceIdentity&&serviceIdentity!==value){queued.clear();failedIds.clear();lastError=null;userPaused=false;modelChanged=true;}serviceIdentity=value;}
 function stop({pause=false,discard=false}={}){
  if(pause)userPaused=true;if(discard){queued.clear();failedIds.clear();lastError=null;}
  if(running){if(discard){running.discarded=true;running.restart=false;}else for(const id of running.ids)queued.add(id);running.controller.abort();index.cancel(running.proof.target);}
  notify();
 }
 function checkLifecycle(){
  if(running&&!matches(running.proof))stop({discard:true});
  try{if(owner&&vectorOwner(repository.captureTarget())!==owner){stop({discard:true});resetOwner(repository.captureTarget());}}catch{stop({discard:true});}
  try{const config=settings.getAiConfig('embedding');if(config?.source==='plugin')rememberIdentity(config);}catch{}
 }
 async function pump(){
  if(pumping||userPaused||disposed||!queued.size)return pumping;
  const task=(async()=>{
   while(!disposed&&!userPaused&&queued.size){
    let proof,root;try{proof=capture();resetOwner(proof.target);root=await repository.read(proof.target);if(!matches(proof))throw new AiProviderError('stale');}
    catch(error){lastError=code(error);failedIds=new Set(queued);queued.clear();notify();return false;}
    const sources=texts(root.events),ids=[...queued].filter(id=>sources.has(id));queued.clear();if(!ids.length)continue;
    const controller=new AbortController(),job={proof,ids,controller,restart:false};running=job;lastError=null;failedIds.clear();notify();
    const current=()=>running===job&&!controller.signal.aborted&&matches(proof);
    const verify=async()=>{if(!current())return false;const latest=await repository.read(proof.target);if(!current())return false;const now=texts(latest.events);return ids.every(id=>now.get(id)===sources.get(id));};
    try{await index.prepare({target:proof.target,events:root.events,config:proof.config,onlyIds:ids,signal:controller.signal,isCurrent:current,verify});}
    catch(error){
     const reason=code(error);
     if(job.discarded){/* A different lifecycle never inherits the old work list. */}
     else if(job.restart&&targetCurrent(proof.target)&&!userPaused){for(const id of ids)queued.add(id);}
     else if(!['cancelled','stale'].includes(reason)){lastError=reason;failedIds=new Set(ids);queued.clear();}
     else if(userPaused){for(const id of ids)queued.add(id);}
     if(lastError){notify();return false;}
     if(!job.restart)return false;
    }finally{if(running===job)running=null;notify();}
   }return true;
  })();pumping=task;
  try{return await task;}finally{if(pumping===task){pumping=null;if(queued.size&&!userPaused&&!lastError&&!disposed)queueMicrotask(()=>{void pump().catch(error=>{lastError=code(error);notify();});});}}
 }
 async function process({mode='all'}={}){
  if(!['all','resume','retry'].includes(mode))throw new AiProviderError('request');
  const proof=capture();resetOwner(proof.target);const root=await repository.read(proof.target);if(!matches(proof))throw new AiProviderError('stale');
  // A failed initial cache read has no task ID list yet. Its explicit retry is
  // the first whole-library action; an existing failed task keeps its own scope.
  const candidates=mode==='all'||mode==='retry'&&!failedIds.size&&!queued.size&&lastError==='storage'?[...texts(root.events).keys()]:mode==='retry'?[...failedIds,...queued]:[...queued];
  userPaused=false;lastError=null;failedIds.clear();for(const id of candidates)queued.add(id);
  if(!running&&!queued.size)return state();
  // Repeated clicks attach to the existing job, never start a parallel batch.
  const result=await (running?pumping:pump());if(result!==true)throw new AiProviderError(lastError??'cancelled');return state();
 }
 async function state(){
  const target=repository.captureTarget(),aiEpoch=settings.captureAi().epoch,allowed=enabled();resetOwner(target);
  let config;try{config=settings.getAiConfig('embedding');}catch{}
  const root=await repository.read(target);if(!targetCurrent(target)||settings.captureAi().epoch!==aiEpoch)throw new AiProviderError('stale');
  const total=activeEvents(root.events).filter(event=>event.mode==='trigger').length;
  if(config?.source!=='plugin')return{enabled:allowed,status:allowed?'unconfigured':'disabled',maintenanceStatus:allowed&&lastError?'failed':'pending',indexed:0,total,missing:total,failed:failedIds.size,lastError,localBrowserCache:true};
  rememberIdentity(config);
  try{await index.hydrate({target,events:root.events,config,isCurrent:()=>targetCurrent(target)&&settings.captureAi().epoch===aiEpoch});}catch(error){lastError=code(error);}
  const value=index.inspect(target,root.events,config),pending=value.missing>0;
  return{...value,enabled:allowed,status:allowed?value.status:'disabled',cachedStatus:value.status,localBrowserCache:true,modelChanged:modelChanged&&pending,lastError:lastError??value.lastError,
   failed:failedIds.size?Math.min(failedIds.size,value.missing):lastError&&pending?value.missing:0,
   maintenanceStatus:running&&vectorOwner(running.proof.target)===vectorOwner(target)?'processing':pending&&userPaused?'paused':pending&&(lastError??value.lastError)?'failed':pending?'pending':'ready'};
 }
 async function committed(notice){
  if(!targetCurrent(notice.target))return;
  const before=texts(notice.before),after=texts(notice.events),changed=[...after].filter(([id,text])=>before.get(id)!==text).map(([id])=>id),deleted=[...before.keys()].filter(id=>!after.has(id));
  let on=false;try{on=enabled();}catch{}
  resetOwner(notice.target);
  if(changed.length||deleted.length){
   if(on)for(const id of changed)queued.add(id);for(const id of deleted){queued.delete(id);failedIds.delete(id);}
   // Revoke stale material before the first asynchronous read/storage step.
   if(running){running.restart=on;for(const id of running.ids)if(on&&after.has(id))queued.add(id);running.controller.abort();index.cancel(running.proof.target);}
  }
  pruning?.abort();const cleanup=new AbortController();pruning=cleanup;
  // Deletions clean derived rows even while the route is off. Use fresh
  // authority because another confirmed edit may already have followed notice.
  try{const latest=await repository.read(notice.target);if(!targetCurrent(notice.target)||pruning!==cleanup)return;await index.prune({target:notice.target,events:latest.events,signal:cleanup.signal,isCurrent:()=>targetCurrent(notice.target)&&pruning===cleanup});}catch(error){if(targetCurrent(notice.target)&&pruning===cleanup&&!cleanup.signal.aborted)lastError=code(error);}
  if(!targetCurrent(notice.target)||pruning!==cleanup||!on)return;
  if(!changed.length&&!deleted.length)return;
  if(!userPaused){lastError=null;void pump().catch(error=>{lastError=code(error);notify();});}notify();
 }
 const offCommit=repository.subscribeEventCommits?.(notice=>{void committed(notice).catch(error=>{lastError=code(error);notify();});}),offSettings=settings.subscribe?.(checkLifecycle),offIndex=index.subscribe(notify);
 return Object.freeze({index,state,process,pause(){stop({pause:true});},checkLifecycle,
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  dispose(){if(disposed)return;stop({discard:true});pruning?.abort();disposed=true;offCommit?.();offSettings?.();offIndex();index.dispose();listeners.clear();},
 });
}
