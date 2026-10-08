import {createCalendar} from './calendar.js';
import {createDateTracker} from './tracker.js';
import {createManualAnchor} from './anchor.js';
import {storyDate} from './point.js';
const copy=structuredClone;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createTimeService({repository,source,now=()=>new Date().toISOString()}={}){
 if(!repository||typeof source?.captureChatSource!=='function')throw new Error('时间服务缺少来源接口');
 let tracker=null,trackerKey=null,serial=0,manualJob=null,invalidation=0;
 const capture=async()=>{const target=repository.captureTarget(),selection=await repository.captureTime(target),snapshot=selection.time.activeCalendarId===null?null:source.captureChatSource(target);return {target,selection,snapshot};};
 const current=(target,snapshot,ticket)=>()=>{
  if(ticket!==serial)return false;
  try{return typeof source.matchesChatSource==='function'?source.matchesChatSource(target,snapshot):equal(source.captureChatSource(target),snapshot);}catch{return false;}
 };
 const calendarOf=time=>{const definition=time.calendars.find(item=>item.id===time.activeCalendarId);return definition?createCalendar(definition):null;};
 return {
  invalidate(){invalidation++;serial++;tracker=null;trackerKey=null;manualJob=null;},
  calibrate(date){
   const ticket=++serial;
   const job=(async()=>{
    const {target,selection,snapshot}=await capture(),calendar=calendarOf(selection.time);
    if(!calendar)throw new Error('请先选择历法');
    const next={...selection.time,currentDate:storyDate(calendar,date),manualAnchor:createManualAnchor(calendar,date,snapshot.messages,{now})};
    const result=await repository.updateTime(target,selection,next,{isCurrent:current(target,snapshot,ticket)});tracker=null;trackerKey=null;return result;
   })();
   manualJob=job;const clear=()=>{if(manualJob===job)manualJob=null;};job.then(clear,clear);return job;
  },
  async reconcile({reidentify=false}={}){
   const generation=invalidation,requestedTarget=repository.captureTarget();
   while(manualJob){const pending=manualJob;try{await pending;}catch{}if(manualJob===pending)manualJob=null;}
   try{if(generation!==invalidation||!equal(requestedTarget,repository.captureTarget()))return {status:'cancelled',date:null};}catch{return {status:'cancelled',date:null};}
   const ticket=++serial,{target,selection,snapshot}=await capture(),time=selection.time,calendar=calendarOf(time);
   if(!calendar)return {status:'no-calendar',date:time.currentDate};
   const options={settings:time.recognition,chronology:time.chronology,manualAnchor:reidentify?null:time.manualAnchor};
   const key=JSON.stringify({target,calendar:calendar.definition,...options});
   if(reidentify||key!==trackerKey){tracker=createDateTracker(calendar,options);trackerKey=key;}
   const result=tracker.reconcile(snapshot.messages);
   if(result.status==='needs-calibration')return result;
   if(reidentify&&result.date===null)return {status:'not-found',date:copy(time.currentDate)};
   const next={...time,currentDate:result.date,...(reidentify?{manualAnchor:null}:{})};
   const saved=await repository.updateTime(target,selection,next,{isCurrent:current(target,snapshot,ticket)});
   return {status:saved.status,date:saved.root.time?.currentDate??null,parsedMessages:result.parsedMessages,historical:result.historical??false};
  },
 };
}
