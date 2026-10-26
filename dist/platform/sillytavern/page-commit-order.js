// Temporary event-only evidence. No DOM, geometry, timers, text or chat identities.
export function createPageCommitOrder({now=()=>globalThis.performance?.now?.()??Date.now()}={}){
 const groups=[],maxGroups=6,maxEvents=128;let serial=0,sequence=0,evicted=0,frozen=true,disposed=false,windowActive=false,windowGeneration=null;
 const stamp=()=>{try{const n=now();return Number.isFinite(n)?Math.round(n*1000)/1000:null;}catch{return null;}};
 function append(kind,fields={}){
  if(disposed||frozen||!groups.length)return;
  const group=groups.at(-1),event={sequence:++sequence,t:stamp(),kind,...fields};group.events.push(event);
  if(group.events.length>maxEvents){group.events.splice(maxEvents/2,1);group.omittedEvents++;}
 }
 const safe=fn=>(...args)=>{try{return fn(...args);}catch{return null;}};
 const snapshot=()=>structuredClone({schema:'lantai-page-commit-order-v1',clock:'performance-ms-event-order-not-paint',limits:{navigationGroups:maxGroups,eventsPerGroup:maxEvents,overflow:'retain-first-half-and-latest-half'},evictedNavigations:evicted,frozen,groups});
 return {
  navigate:safe(area=>{if(disposed||!['memory','time','benmo','workshop'].includes(area))return;frozen=false;groups.push({id:++serial,area,started:stamp(),omittedEvents:0,events:[]});if(groups.length>maxGroups){groups.shift();evicted++;}append('navigation');}),
  stage:safe(phase=>{if(['ensure-ready','mount-ready'].includes(phase))append(phase);}),
  window:safe(value=>{if(!value)return;windowActive=value.active===true;windowGeneration=Number.isSafeInteger(value.generation)?value.generation:null;append(value.active?'window-begin':'window-restore',{generation:Number.isSafeInteger(value.generation)?value.generation:null,reason:['idle','commit','superseded','two-frames','unavailable','background','close','dispose','error','reopen','chat-change','leave-area','cancel'].includes(value.lastReason)?value.lastReason:'other'});}),
  notification:safe((source,delivered)=>{if(['latest','tracking','narrative'].includes(source))append('notification',{source,delivered:delivered===true});}),
  commit:safe((area,changed,replaced)=>{if(['benmo','workshop'].includes(area))append('render',{area,markupChanged:changed===true,mainReplaced:replaced===true,windowActive,windowGeneration});}),
  freeze:safe(reason=>{if(!frozen)append('freeze',{reason:['settings','close','chat-change','dispose','export'].includes(reason)?reason:'other'});frozen=true;}),
  snapshot,text:()=>JSON.stringify(snapshot(),null,2),dispose(){disposed=true;frozen=true;groups.length=0;},
 };
}
// A click can be silently refused by a browser: always return the same copyable
// text alongside the download result. Retain at most one object URL per host.
export function createPageCommitOrderExport({document:doc,trace,version}){
 let release=null;
 return {export(){trace.freeze('export');const text=JSON.stringify({version,...trace.snapshot()},null,2);let downloadStarted=false;
  try{release?.();release=null;const api=doc.defaultView?.URL??globalThis.URL,BlobType=doc.defaultView?.Blob??globalThis.Blob;
   const url=api.createObjectURL(new BlobType([text],{type:'application/json'}));release=()=>api.revokeObjectURL(url);const anchor=doc.createElement('a');
   try{anchor.href=url;anchor.download='lantai-page-commit-order.json';anchor.hidden=true;doc.body.append(anchor);anchor.click();downloadStarted=true;}finally{anchor.remove();}
  }catch{/* The caller exposes copyable text even if downloads are blocked. */}
  return {text,downloadStarted};
 },dispose(){try{release?.();}catch{}release=null;}};
}
