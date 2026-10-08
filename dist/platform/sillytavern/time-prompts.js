import {featureGate} from '../../domain/controls/gate.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {composeTimePrompts} from '../../domain/time/prompts.js';
export const TIME_PROMPT_KEYS=Object.freeze(Object.fromEntries(['current','schedule','anniversary','holiday'].map(kind=>[kind,`lantai_benmo_time_${kind}`])));
const supported=new Set(['normal','regenerate','swipe','continue']);
export function createTimePromptRuntime({repository,settings,dateRuntime,getContext,captureSource,matchesSource,getControls}={}){
 const gate=featureGate(getControls,'time');
 let disposed=false,serial=0,reminderProof=null,status={status:'empty'};const releases=[];
 const inspect=()=>structuredClone(status);
 function clear(){
  serial++;reminderProof=null;let success=true,context;try{context=getContext();}catch{success=false;}
  for(const key of Object.values(TIME_PROMPT_KEYS)){try{if(typeof context?.setExtensionPrompt!=='function')throw new Error();context.setExtensionPrompt(key,'',1,0,false,0);}catch{success=false;}}
  status={status:success?'empty':'unconfirmed'};return success;
 }
 const matches=(target,ticket,config,source)=>{try{return gate.allowed()&&!disposed&&ticket===serial&&sameTarget(target,repository.captureTarget())&&settings.matchesTimeReminders(config)&&(matchesSource?matchesSource(target,source):!captureSource||JSON.stringify(captureSource(target))===JSON.stringify(source));}catch{return false;}};
 async function intercept(messages,_size,_abort,type='normal'){
  if(disposed)return;
  if(!clear()||!gate.allowed()||!supported.has(type)||messages?.some(message=>String(message?.mes??message?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
  const ticket=serial;let target;
  try{
   target=repository.captureTarget();
   const observed=await dateRuntime.request();
   if(disposed||ticket!==serial||!sameTarget(target,repository.captureTarget()))return;
   if(observed.status==='no-calendar'){status={status:'empty'};return;}
   if(['failed','needs-calibration','cancelled'].includes(observed.status)){status={status:'unavailable',message:'当前故事日期尚未确认'};return;}
   const config=settings.captureTimeReminders();reminderProof=config;
   const source=captureSource?.(target),selection=await repository.captureTime(target);
   if(!matches(target,ticket,config,source))return;
   const channels=composeTimePrompts(selection.time,config.reminders);
   // A queued item/settings edit must not turn the computed text into stale authority.
   const latest=await repository.captureTime(target);
   if(!matches(target,ticket,config,source)||JSON.stringify(latest.time)!==JSON.stringify(selection.time))return;
   const context=getContext();
   for(const [kind,value]of Object.entries(channels)){
    if(!matches(target,ticket,config,source)){if(ticket===serial)clear();return;}
    context.setExtensionPrompt(TIME_PROMPT_KEYS[kind],value.prompt,1,value.depth,false,0);
    if(!matches(target,ticket,config,source)){if(ticket===serial)clear();return;}
   }
   status={status:'injected',channels};
  }catch{if(!disposed&&ticket===serial){const cleaned=clear();if(cleaned)status={status:'failed',message:'时间提醒未完成，本轮未注入'};}}
 }
 const context=getContext();
 for(const name of ['CHAT_CHANGED','CHAT_CREATED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED']){
  const event=context?.eventTypes?.[name],events=context?.eventSource;if(!event||typeof events?.on!=='function')continue;
  const listener=()=>clear();events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));
 }
 // Host SETTINGS_UPDATED also fires for unrelated settings saves. Invalidate
 // only the reminder configuration used by this pending/injected generation.
 const settingsChanged=()=>{if(!reminderProof)return;try{if(settings.matchesTimeReminders(reminderProof))return;}catch{/* Lost authority must clear owned prompts. */}clear();};
 const settingsEvent=context?.eventTypes?.SETTINGS_UPDATED,events=context?.eventSource;
 if(settingsEvent&&typeof events?.on==='function'){events.on(settingsEvent,settingsChanged);releases.push(()=>(events.off??events.removeListener)?.call(events,settingsEvent,settingsChanged));}
 if(typeof settings?.subscribe==='function')releases.push(settings.subscribe(settingsChanged));
 return {intercept,clear,inspect,dispose(){if(disposed)return;clear();disposed=true;for(const release of releases)release();}};
}
