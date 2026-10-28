import {featureGate} from '../../domain/controls/gate.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {worldDynamicsOf} from '../../domain/world-dynamics/data.js';
import {worldPreferences,worldInjectionAuthority} from '../../domain/world-dynamics/preferences.js';
import {timeOf} from '../../domain/time/data.js';
import {projectWorldOutcomes,WORLD_CONTEXT_INTRO} from '../../domain/world-dynamics/projection.js';
export const WORLD_PROMPT_KEY='lantai_benmo_world_dynamics';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),supported=new Set(['normal','regenerate','swipe','continue']);
export function createWorldPromptRuntime({repository,history,dateRuntime,getContext,getControls,captureSource,getRoot}={}){
 const gate=featureGate(getControls,'time'),releases=[];let disposed=false,serial=0,proof=null,status={status:'empty'};
 function clear(){serial++;proof=null;let success=true;try{getContext().setExtensionPrompt(WORLD_PROMPT_KEY,'',1,0,false,0);}catch{success=false;}status={status:success?'empty':'unconfirmed'};return success;}
 const valid=p=>{try{const root=getRoot(p.target);return !disposed&&p.serial===serial&&gate.matches(p.gate)&&sameTarget(p.target,repository.captureTarget())&&equal(worldInjectionAuthority(worldDynamicsOf(root)),worldInjectionAuthority(p.domain))&&equal(timeOf(root),p.time)&&equal(captureSource(p.target),p.source)&&history.inspect().status==='ready';}catch{return false;}};
 async function intercept(messages,_size,_abort,type='normal'){
  if(disposed||!clear()||!gate.allowed()||!supported.has(type)||messages?.some(row=>String(row?.mes??row?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
  const ticket=serial,target=repository.captureTarget(),permission=gate.capture();
  try{
   const maintained=await history.request();if(disposed||ticket!==serial||!gate.matches(permission)||maintained.status!=='ready')return;
   const observed=await dateRuntime.request();if(disposed||ticket!==serial||!gate.matches(permission)||['failed','needs-calibration','cancelled','no-calendar','disabled'].includes(observed.status))return;
   const source=captureSource(target),selection=await repository.captureWorldDynamics(target);if(disposed||ticket!==serial||!gate.matches(permission)||!sameTarget(target,repository.captureTarget()))return;
   const domain=selection.worldDynamics,preferences=worldPreferences(domain);if(!preferences.enabled)return;
   const projected=projectWorldOutcomes(domain,selection.time);if(!projected.text)return;
   const candidate={serial:ticket,target,gate:permission,domain,time:selection.time,source};if(!valid(candidate))return;
   const text=WORLD_CONTEXT_INTRO+'\n\n'+projected.text;getContext().setExtensionPrompt(WORLD_PROMPT_KEY,text,1,preferences.depth,false,0);
   if(!valid(candidate)){if(ticket===serial)clear();return;}proof=candidate;status={status:'injected',text,depth:preferences.depth};
  }catch{if(!disposed&&ticket===serial)clear();}
 }
 // Called synchronously after the host's final await; callers cannot manufacture
 // a receipt. The captured source and root are private to this instance.
 function finalize(){if(!proof)return status.status==='empty';if(valid(proof))return true;clear();return false;}
 const context=getContext(),events=context?.eventSource;
 for(const name of ['CHAT_CHANGED','CHAT_CREATED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED']){const event=context?.eventTypes?.[name];if(event&&typeof events?.on==='function'){const fn=()=>clear();events.on(event,fn);releases.push(()=>(events.off??events.removeListener)?.call(events,event,fn));}}
 return {intercept,finalize,clear,domainChanged(selection){if(proof&&!equal(worldInjectionAuthority(selection.worldDynamics),worldInjectionAuthority(proof.domain)))clear();},inspect:()=>structuredClone(status),dispose(){if(disposed)return;clear();disposed=true;for(const release of releases)release();}};
}
