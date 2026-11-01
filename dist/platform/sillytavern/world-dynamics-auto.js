import {isVerifiedTailDeletion} from '../../domain/summary/source-deletion.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {featureGate} from '../../domain/controls/gate.js';
import {createCalendar} from '../../domain/time/calendar.js';
import {worldCalendar} from '../../domain/world-dynamics/data.js';
import {worldPreferences} from '../../domain/world-dynamics/preferences.js';
import {materialEnabled} from '../../domain/world-dynamics/materials.js';
const copy=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createWorldAutoRuntime({adapter,repository,history,dateRuntime,getContext,getControls,getController,canGenerate=()=>true,onRun=()=>{},scheduleStart=work=>setTimeout(work,0)}={}){
 const gate=featureGate(getControls,'time'),attempts=new Map(),lastConfirmed=new Map(),releases=[];let disposed=false,serial=0,pending=null,queued=false,chain=0,lastDate=null,status={status:'idle'},observedReply=null,continuePermit=null,foreground=null,receipt=null,foregroundStopped=false,latestSeen=null,editedReply=null,editEpoch=0;
 const current=(target,ticket)=>{try{return !disposed&&ticket===serial&&sameTarget(target,repository.captureTarget());}catch{return false;}};
 const scope=target=>JSON.stringify([target.chatId,target.rootId]);
 const key=(target,date)=>JSON.stringify([target.chatId,target.rootId,date.calendarId,date.year,date.month,date.day]);
 const mark=(target,date,endFloor=adapter.captureSummarySource(target).messages.at(-1)?.floor??-1)=>attempts.set(key(target,date),{scope:scope(target),date:copy(date),endFloor});
 function recordCurrent(selection){const v=selection.worldDynamics.current;lastConfirmed.set(scope(selection.target),v?{id:v.id,endFloor:v.endFloor,date:copy(v.date),calendar:copy(v.calendar)}:null);}
 function reconcileHistory(selection){const s=scope(selection.target),before=lastConfirmed.get(s),next=selection.worldDynamics.current;if(before&&(!next||next.endFloor<before.endFloor||equal(next.calendar,before.calendar)&&createCalendar(next.calendar).compare(next.date,before.date)<0)){for(const [id,attempt]of attempts)if(attempt.scope===s&&(!next||attempt.date.calendarId!==next.date.calendarId||createCalendar(next.calendar).compare(attempt.date,next.date)>0))attempts.delete(id);}recordCurrent(selection);}
 function candidate(selection){const {worldDynamics:domain,time}=selection,version=domain.current,definition=time?.calendars.find(v=>v.id===time.activeCalendarId);if(!version||!worldPreferences(domain).enabled||!definition||time.currentDate?.day==null||!equal(worldCalendar(definition),worldCalendar(version.calendar)))return null;const calendar=createCalendar(definition),date=calendar.validate(time.currentDate);return {date,forward:calendar.compare(date,version.date)>0};}
 const supported=new Set(['normal','regenerate','swipe','continue']);
 const locator=row=>row?{floor:row.floor,identity:row.identity,objectTicket:row.objectTicket,role:row.role,swipeId:row.swipeId??null}:null;
 const sameReply=(a,b)=>equal(locator(a),locator(b));
 function latestReply(target){const rows=adapter.captureSummarySource(target).messages;return rows.filter(row=>row.role==='assistant'&&!row.system&&typeof row.text==='string'&&row.text.trim()).at(-1)??null;}
 function completedStream(floor,processor=getContext()?.streamingProcessor){const message=getContext()?.chat?.[floor];if(message?.gen_started&&!message?.gen_finished)return false;if(!processor||Number.isSafeInteger(processor.messageId)&&processor.messageId!==floor)return true;return processor.isFinished===true&&processor.isStopped!==true&&!processor.abortController?.signal?.aborted&&!(processor.toolCalls?.length);}
 function eligible(selection,wanted){
  const row=latestReply(selection.target);if(row&&(!latestSeen||!sameReply(latestSeen,row)))latestSeen=copy(row);if(!row||foreground&&!foreground.ended||foregroundStopped||!completedStream(row.floor))return false;
  let permit=continuePermit;if(permit&&(!sameTarget(permit.target,selection.target)||!sameReply(permit.row,row)||permit.row.text!==row.text))continuePermit=permit=null;
  const s=scope(selection.target);if(!observedReply||observedReply.scope!==s||!sameReply(observedReply.row,row)||permit&&!permit.date){observedReply={scope:s,row:locator(row),date:copy(wanted.date)};if(permit)permit.date=copy(wanted.date);}
  if(!equal(observedReply.date,wanted.date)||permit&&!equal(permit.date,wanted.date))return false;
  if(!wanted.forward){continuePermit=null;return false;}
  if(editedReply&&sameReply(editedReply,row)&&!permit)return false;
  return row.floor>selection.worldDynamics.current.endFloor||!!permit;
 }
 function flushReceipt(){
  if(!receipt||!foreground?.ended||foregroundStopped)return;
  const r=receipt;if(!completedStream(r.floor,r.processor))return;
  try{const t=repository.captureTarget(),row=latestReply(t),message=getContext()?.chat?.[r.floor];if(!sameTarget(t,r.target)||!row||row.floor!==r.floor||r.message&&r.message!==message)return;
   if(foreground.endRow&&(!sameReply(foreground.endRow,row)||foreground.endRow.text!==row.text)||foreground.endEditEpoch!==undefined&&foreground.endEditEpoch!==editEpoch){editedReply=locator(row);receipt=null;foreground=null;continuePermit=null;void request();return;}
   if(foreground.explicit===true)editedReply=null;latestSeen=copy(row);
   if(foreground.explicit===true&&foreground.type==='continue'&&r.type==='continue'&&typeof row.objectTicket==='string'&&row.objectTicket)continuePermit={target:copy(t),row:copy(row),date:null};
  }catch{}
  receipt=null;foreground=null;void request();
 }
 async function check(ticket){
  if(history.inspect().unconfirmed)return;await adapter.prepare();if(disposed||ticket!==serial)return;
  const target=repository.captureTarget(),initial=await repository.captureWorldDynamics(target);if(!current(target,ticket)||!initial.worldDynamics.current||!worldPreferences(initial.worldDynamics).enabled)return;
  if(!lastConfirmed.has(scope(target)))recordCurrent({...initial,target});const controller=await getController(target);if(!controller||!current(target,ticket)||!gate.allowed()||!await controller.ensureAutomatic())return;
  const permission=gate.capture(),valid=()=>current(target,ticket)&&gate.matches(permission);
  const maintained=await history.request();if(!valid()||maintained.status!=='ready')return;const observed=await dateRuntime.request();if(!valid()||['failed','needs-calibration','cancelled','no-calendar','disabled'].includes(observed.status))return;
  let selection=await repository.captureWorldDynamics(target);if(!valid())return;let wanted=candidate(selection);if(!wanted||!eligible({...selection,target},wanted))return;const attempt=key(target,wanted.date);if(attempts.has(attempt)||!canGenerate())return;
  if(controller.isGenerating()){const success=await controller.waitForGeneration();if(!valid()||!success)return;selection=await repository.captureWorldDynamics(target);if(!valid())return;wanted=candidate(selection);if(!wanted||!eligible({...selection,target},wanted)||attempts.has(key(target,wanted.date)))return;}
  if(!canGenerate()||controller.isAutomaticBlocked?.())return;mark(target,wanted.date);continuePermit=null;const token=++chain;status={status:'generating',date:copy(wanted.date)};onRun({running:true,token});
  try{
   const success=await controller.generate({automatic:true});if(!valid()||!success)return;
   selection=await repository.captureWorldDynamics(target);if(!valid())return;recordCurrent({...selection,target});wanted=candidate(selection);if(!wanted)return;
   const end=adapter.captureSummarySource(target).messages.at(-1)?.floor??-1,more=materialEnabled(selection.worldDynamics.config,'storyContext')&&end>selection.worldDynamics.current.endFloor;
   if(wanted.forward&&eligible({...selection,target},wanted)||more&&eligible({...selection,target},{...wanted,forward:true})){if(controller.isAutomaticBlocked?.())return;mark(target,wanted.date);continuePermit=null;const caught=await controller.generate({automatic:true});if(valid()&&caught){const saved=await repository.captureWorldDynamics(target);if(valid())recordCurrent({...saved,target});}}
  }finally{onRun({running:false,token});if(current(target,ticket))status={status:'idle'};}
 }
 function request(){if(disposed)return Promise.resolve(copy(status));queued=true;if(pending)return pending;const job=(async()=>{await Promise.resolve();while(queued&&!disposed){queued=false;const ticket=serial;try{await check(ticket);}catch(error){if(!disposed&&ticket===serial)status={status:'failed',message:error?.message??'世界动态自动更新未完成'};}}return copy(status);})();pending=job;const done=()=>{if(pending===job){pending=null;if(queued&&!disposed)void request();}};job.then(done,done);return job;}
 const context=getContext(),events=context?.eventSource;
 for(const name of ['MESSAGE_SENT','MESSAGE_SWIPED','MESSAGE_DELETED']){const event=context?.eventTypes?.[name];if(event&&events?.on){const fn=()=>void request();events.on(event,fn);releases.push(()=>(events.off??events.removeListener)?.call(events,event,fn));}}
 const on=(name,fn)=>{const event=context?.eventTypes?.[name];if(event&&events?.on){events.on(event,fn);releases.push(()=>(events.off??events.removeListener)?.call(events,event,fn));}};
 for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED'])on(name,floor=>{try{const row=latestReply(repository.captureTarget());if(row&&((latestSeen&&sameReply(latestSeen,row)&&latestSeen.text!==row.text)||!latestSeen&&name==='MESSAGE_EDITED'&&(floor===undefined||floor===row.floor))){editedReply=locator(row);editEpoch++;}if(row)latestSeen=copy(row);}catch{}void request();});
 on('GENERATION_STARTED',(type,_options,dryRun)=>{if(dryRun===true)return;const normalized=type??'normal';if(!supported.has(normalized))return;foreground={type:normalized,ended:false,explicit:true};receipt=null;foregroundStopped=false;continuePermit=null;});
 on('MESSAGE_RECEIVED',(floor,type)=>{const normalized=type==='appendFinal'&&foreground?.type==='continue'?'continue':type===undefined?(foreground?.type??'normal'):type;if(!supported.has(normalized)||foregroundStopped)return;try{const target=repository.captureTarget();if(receipt&&foreground?.ended){flushReceipt();void request();return;}if(!foreground)foreground={type:normalized,ended:false};const message=context?.chat?.[floor];latestSeen=copy(latestReply(target));receipt={target:copy(target),floor,type:normalized,message,processor:getContext()?.streamingProcessor??null};flushReceipt();}catch{}void request();});
 on('GENERATION_ENDED',()=>{if(foreground&&!foreground.ended){foreground.ended=true;foreground.endEditEpoch=editEpoch;try{foreground.endRow=copy(latestReply(repository.captureTarget()));}catch{}}flushReceipt();void request();});
 on('CHARACTER_MESSAGE_RENDERED',()=>{flushReceipt();void request();});
 on('GENERATION_STOPPED',()=>{foregroundStopped=true;foreground=null;receipt=null;continuePermit=null;});
 for(const name of ['CHAT_CHANGED','CHAT_CREATED']){const event=context?.eventTypes?.[name];if(event&&events?.on){const fn=()=>{serial++;lastDate=null;observedReply=null;continuePermit=null;foreground=null;receipt=null;foregroundStopped=false;latestSeen=null;editedReply=null;editEpoch=0;void request();};events.on(event,fn);releases.push(()=>(events.off??events.removeListener)?.call(events,event,fn));}}
 releases.push(dateRuntime.subscribe(value=>{flushReceipt();const next=JSON.stringify(value.date??null);if(next!==lastDate){lastDate=next;if(value.date)void request();}}));
 if(typeof adapter.subscribeSourceDeletions==='function')releases.push(adapter.subscribeSourceDeletions(record=>{if(disposed||!record.target||!isVerifiedTailDeletion(record.deletion))return;const s=scope(record.target),end=record.deletion.after.messages.length;for(const [id,attempt]of attempts)if(attempt.scope===s&&attempt.endFloor>=end)attempts.delete(id);}));
 scheduleStart(()=>{if(!disposed)void request();});
 return {request,noteAttempt({target,date,endFloor}){mark(target,date,endFloor);},recordCurrent,reconcileHistory,controlsChanged(){serial++;void request();},inspect:()=>copy(status),dispose(){disposed=true;serial++;queued=false;attempts.clear();lastConfirmed.clear();observedReply=null;continuePermit=null;foreground=null;receipt=null;latestSeen=null;editedReply=null;for(const release of releases)release();}};
}
