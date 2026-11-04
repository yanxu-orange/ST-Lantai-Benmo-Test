import {sameTarget} from '../../domain/memory/repository.js';
import {featureGate} from '../../domain/controls/gate.js';
import {reconcileWorldHistory} from '../../domain/world-dynamics/history.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),copy=structuredClone;
// Host update notifications may change only adapter revisions. Outcomes follow
// observed structural/reply changes; users own same-reply prose edits. Raw
// text and revisions still guard the asynchronous maintenance transaction.
const observedRow=({revision,text,...row})=>row;
const compact=raw=>({epoch:raw.epoch,messages:raw.messages.map(({floor,identity,objectTicket,revision,role,swipeId,text})=>({floor,identity,objectTicket,revision,role,swipeId:swipeId??null,text}))});
const hasHistory=domain=>!!domain.current||domain.versions.length>0||Object.keys(domain.retained).length>0;
// Maintenance starts with host readiness, never with a mounted world page.
export function createWorldDynamicsRuntime({adapter,repository,getContext,getControls,onChange=()=>{}}={}){
 const context=getContext(),events=context?.eventSource,gate=featureGate(getControls,'time'),subscriptions=[],listeners=new Set(),sourceProofs=new WeakSet(),structuralChanges=new Map();let structuralEpoch=0;
 let disposed=false,serial=0,pending=null,queued=false,baseline=null,target=null,changedFrom=Infinity,blocked=false,knownEmpty=false,proofTracking=false,status={status:'idle'};
 const emit=value=>{status=value;for(const fn of listeners)try{fn(copy(value));}catch{}};
 const capture=t=>compact(adapter.captureSummarySource(t));
 const current=(t,n)=>{try{return !disposed&&n===serial&&sameTarget(t,repository.captureTarget());}catch{return false;}};
 // Empty history is only a source-reading hint: the root queue still rereads
 // the domain. Once a proof is issued, structural observation stays active.
 function observe(cutoff=Infinity){
  changedFrom=Math.min(changedFrom,cutoff);
  try{const t=repository.captureTarget(),next=capture(t);if(sameTarget(t,target)&&baseline){const before=baseline.messages,after=next.messages;let i=0;while(i<Math.min(before.length,after.length)&&equal(observedRow(before[i]),observedRow(after[i])))i++;if(i<before.length){const floor=before[i].floor;changedFrom=Math.min(changedFrom,floor);structuralChanges.set(floor,++structuralEpoch);}}else{target=copy(t);changedFrom=Math.min(changedFrom,cutoff);}baseline=next;return next;}catch{}
 }
 function request(){
  if(disposed)return Promise.resolve(status);if(!knownEmpty||proofTracking)observe();queued=true;if(pending)return pending;
  const job=(async()=>{await Promise.resolve();while(queued&&!disposed){queued=false;if(blocked||!gate.allowed())continue;const n=serial,proof=gate.capture();try{
   await adapter.prepare();if(disposed||n!==serial||!gate.matches(proof))continue;const t=repository.captureTarget();let raw=!knownEmpty||proofTracking?observe()??capture(t):null,cutoff=changedFrom;
   const valid=()=>current(t,n)&&gate.matches(proof)&&(!raw||equal(capture(t),raw));
   const receipt=await repository.updateWorldDynamics(t,{apply:domain=>{if(!hasHistory(domain)){if(!proofTracking)raw=null;return domain;}if(!raw){raw=observe()??capture(t);cutoff=changedFrom;}return reconcileWorldHistory(domain,raw,{changedFrom:cutoff});},isCurrent:valid});
   if(!valid())continue;if(!['committed','unchanged'].includes(receipt.status))throw Object.assign(new Error('世界动态保存尚未确认'),{code:'COMMIT_UNCONFIRMED'});
   changedFrom=Infinity;knownEmpty=!hasHistory(receipt.selection.worldDynamics);if(knownEmpty&&!proofTracking){baseline=null;target=null;}const selection={target:copy(t),worldDynamics:copy(receipt.selection.worldDynamics)};onChange(selection);emit({status:'ready',...selection});
  }catch(error){if(disposed||n!==serial)continue;if(error?.code==='COMMIT_UNCONFIRMED'||/尚未确认|待确认|可能已经保存/.test(error?.message??''))blocked=true;emit({status:'failed',message:error?.message??'世界动态维护未完成',unconfirmed:blocked});}}
  return copy(status);})();pending=job;const clear=()=>{if(pending===job){pending=null;if(queued&&!disposed)void request();}};job.then(clear,clear);return job;
 }
 const on=(name,fn)=>{const type=context.eventTypes?.[name];if(type){events.on(type,fn);subscriptions.push([type,fn]);}};
 for(const name of ['MESSAGE_SENT','MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED'])on(name,()=>void request());
 for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED'])on(name,()=>void request());
 on('GENERATION_STARTED',(_type,_options,dryRun)=>{if(dryRun!==true)void request();});
 for(const name of ['CHAT_CHANGED','CHAT_CREATED'])on(name,()=>{serial++;baseline=null;target=null;changedFrom=Infinity;blocked=false;knownEmpty=false;proofTracking=false;structuralEpoch=0;structuralChanges.clear();emit({status:'loading'});void request();});
 function captureSourceProof(){proofTracking=true;observe();const value=Object.freeze({target:copy(repository.captureTarget()),serial,structuralEpoch});sourceProofs.add(value);return value;}
 function matchesSourceProof(value,endFloor){return sourceProofs.has(value)&&current(value.target,value.serial)&&![...structuralChanges].some(([floor,epoch])=>floor<=endFloor&&epoch>value.structuralEpoch);}
 return {request,captureSourceProof,matchesSourceProof,inspect:()=>copy(status),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},controlsChanged(){serial++;void request();},async reread(){blocked=false;return request();},dispose(){disposed=true;serial++;queued=false;baseline=null;target=null;structuralChanges.clear();listeners.clear();for(const [type,fn]of subscriptions)(events.removeListener??events.off).call(events,type,fn);}};
}
