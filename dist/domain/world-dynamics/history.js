import {assertWorldDynamics,retainWorldVersions} from './data.js';
const copy=structuredClone;
// Stored versions contain only outcome text and reply locators. Object tickets
// and per-floor revisions are compared by the runtime, never persisted here.
export function reconcileWorldHistory(value,source,{changedFrom=Infinity}={}){
 const domain=assertWorldDynamics(value),messages=source.messages,endFloor=messages.at(-1)?.floor??-1,byFloor=new Map(messages.map(row=>[row.floor,row]));
 const valid=version=>{
  if(!version||version.endFloor>endFloor||version.endFloor>=changedFrom)return false;
  if(!version.anchor)return true; // Legacy versions have only their floor bound.
  const row=byFloor.get(version.anchor.floor);
  return !!row&&row.identity===version.anchor.identity&&row.role===version.anchor.role&&(row.swipeId??null)===version.anchor.swipeId;
 };
 const available=domain.versions.filter(valid),current=valid(domain.current)?domain.current:available.at(-1)??null;
 const versions=retainWorldVersions(available,endFloor);
 const retained=current?Object.fromEntries(Object.entries(domain.retained).filter(([,v])=>valid(v)&&v.endFloor<=current.endFloor)):{};
 return {...domain,current:copy(current),versions,retained:copy(retained)};
}
export function rollbackWorldTail(value,deletion){return reconcileWorldHistory(value,deletion.after,{changedFrom:deletion.after.messages.length});}
