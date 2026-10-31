import {isVerifiedTailDeletion} from '../../domain/summary/source-deletion.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {featureGate} from '../../domain/controls/gate.js';
import {createCalendar} from '../../domain/time/calendar.js';
import {worldCalendar} from '../../domain/world-dynamics/data.js';
import {worldPreferences} from '../../domain/world-dynamics/preferences.js';
import {materialEnabled} from '../../domain/world-dynamics/materials.js';
const copy=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createWorldAutoRuntime({adapter,repository,history,dateRuntime,getContext,getControls,getController,canGenerate=()=>true,onRun=()=>{},scheduleStart=work=>setTimeout(work,0)}={}){
 const gate=featureGate(getControls,'time'),attempts=new Map(),lastConfirmed=new Map(),releases=[];let disposed=false,serial=0,pending=null,queued=false,chain=0,lastDate=null,status={status:'idle'};
 const current=(target,ticket)=>{try{return !disposed&&ticket===serial&&sameTarget(target,repository.captureTarget());}catch{return false;}};
 const scope=target=>JSON.stringify([target.chatId,target.rootId]);
 const key=(target,date)=>JSON.stringify([target.chatId,target.rootId,date.calendarId,date.year,date.month,date.day]);
 const mark=(target,date,endFloor=adapter.captureSummarySource(target).messages.at(-1)?.floor??-1)=>attempts.set(key(target,date),{scope:scope(target),date:copy(date),endFloor});
 function recordCurrent(selection){const v=selection.worldDynamics.current;lastConfirmed.set(scope(selection.target),v?{id:v.id,endFloor:v.endFloor,date:copy(v.date),calendar:copy(v.calendar)}:null);}
 function reconcileHistory(selection){const s=scope(selection.target),before=lastConfirmed.get(s),next=selection.worldDynamics.current;if(before&&(!next||next.endFloor<before.endFloor||equal(next.calendar,before.calendar)&&createCalendar(next.calendar).compare(next.date,before.date)<0)){for(const [id,attempt]of attempts)if(attempt.scope===s&&(!next||attempt.date.calendarId!==next.date.calendarId||createCalendar(next.calendar).compare(attempt.date,next.date)>0))attempts.delete(id);}recordCurrent(selection);}
 function candidate(selection){const {worldDynamics:domain,time}=selection,version=domain.current,definition=time?.calendars.find(v=>v.id===time.activeCalendarId);if(!version||!worldPreferences(domain).enabled||!definition||time.currentDate?.day==null||!equal(worldCalendar(definition),worldCalendar(version.calendar)))return null;const calendar=createCalendar(definition),date=calendar.validate(time.currentDate);return {date,forward:calendar.compare(date,version.date)>0};}
 async function check(ticket){
  if(history.inspect().unconfirmed)return;await adapter.prepare();if(disposed||ticket!==serial)return;
  const target=repository.captureTarget(),initial=await repository.captureWorldDynamics(target);if(!current(target,ticket)||!initial.worldDynamics.current||!worldPreferences(initial.worldDynamics).enabled)return;
  if(!lastConfirmed.has(scope(target)))recordCurrent({...initial,target});const controller=await getController(target);if(!controller||!current(target,ticket)||!gate.allowed()||!await controller.ensureAutomatic())return;
  const permission=gate.capture(),valid=()=>current(target,ticket)&&gate.matches(permission);
  const maintained=await history.request();if(!valid()||maintained.status!=='ready')return;const observed=await dateRuntime.request();if(!valid()||['failed','needs-calibration','cancelled','no-calendar','disabled'].includes(observed.status))return;
  let selection=await repository.captureWorldDynamics(target);if(!valid())return;let wanted=candidate(selection);if(!wanted?.forward)return;const attempt=key(target,wanted.date);if(attempts.has(attempt)||!canGenerate())return;
  if(controller.isGenerating()){const success=await controller.waitForGeneration();if(!valid()||!success)return;selection=await repository.captureWorldDynamics(target);if(!valid())return;wanted=candidate(selection);if(!wanted?.forward||attempts.has(key(target,wanted.date)))return;}
  if(!canGenerate()||controller.isAutomaticBlocked?.())return;mark(target,wanted.date);const token=++chain;status={status:'generating',date:copy(wanted.date)};onRun({running:true,token});
  try{
   const success=await controller.generate({automatic:true});if(!valid()||!success)return;
   selection=await repository.captureWorldDynamics(target);if(!valid())return;recordCurrent({...selection,target});wanted=candidate(selection);if(!wanted)return;
   const end=adapter.captureSummarySource(target).messages.at(-1)?.floor??-1,more=materialEnabled(selection.worldDynamics.config,'storyContext')&&end>selection.worldDynamics.current.endFloor;
   if(wanted.forward||more){if(controller.isAutomaticBlocked?.())return;mark(target,wanted.date);const caught=await controller.generate({automatic:true});if(valid()&&caught){const saved=await repository.captureWorldDynamics(target);if(valid())recordCurrent({...saved,target});}}
  }finally{onRun({running:false,token});if(current(target,ticket))status={status:'idle'};}
 }
 function request(){if(disposed)return Promise.resolve(copy(status));queued=true;if(pending)return pending;const job=(async()=>{await Promise.resolve();while(queued&&!disposed){queued=false;const ticket=serial;try{await check(ticket);}catch(error){if(!disposed&&ticket===serial)status={status:'failed',message:error?.message??'世界动态自动更新未完成'};}}return copy(status);})();pending=job;const done=()=>{if(pending===job){pending=null;if(queued&&!disposed)void request();}};job.then(done,done);return job;}
 const context=getContext(),events=context?.eventSource;
 for(const name of ['MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_ENDED']){const event=context?.eventTypes?.[name];if(event&&events?.on){const fn=()=>void request();events.on(event,fn);releases.push(()=>(events.off??events.removeListener)?.call(events,event,fn));}}
 for(const name of ['CHAT_CHANGED','CHAT_CREATED']){const event=context?.eventTypes?.[name];if(event&&events?.on){const fn=()=>{serial++;lastDate=null;void request();};events.on(event,fn);releases.push(()=>(events.off??events.removeListener)?.call(events,event,fn));}}
 releases.push(dateRuntime.subscribe(value=>{const next=JSON.stringify(value.date??null);if(next!==lastDate){lastDate=next;if(value.date)void request();}}));
 if(typeof adapter.subscribeSourceDeletions==='function')releases.push(adapter.subscribeSourceDeletions(record=>{if(disposed||!record.target||!isVerifiedTailDeletion(record.deletion))return;const s=scope(record.target),end=record.deletion.after.messages.length;for(const [id,attempt]of attempts)if(attempt.scope===s&&attempt.endFloor>=end)attempts.delete(id);}));
 scheduleStart(()=>{if(!disposed)void request();});
 return {request,noteAttempt({target,date,endFloor}){mark(target,date,endFloor);},recordCurrent,reconcileHistory,controlsChanged(){serial++;void request();},inspect:()=>copy(status),dispose(){disposed=true;serial++;queued=false;attempts.clear();lastConfirmed.clear();for(const release of releases)release();}};
}
