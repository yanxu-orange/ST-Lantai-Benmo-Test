import {featureGate} from '../../domain/controls/gate.js';
import {createTimeService} from '../../domain/time/service.js';
// Date observation is independent of any mounted view and never starts AI work.
export function createTimeRuntime({adapter,repository,getContext,now,getControls}={}){
 const gate=featureGate(getControls,'time');
 const context=getContext(),events=context?.eventSource;
 if(!adapter||!repository||typeof events?.on!=='function'||typeof (events.removeListener??events.off)!=='function')throw new Error('时间观察缺少宿主事件能力');
 const source={captureChatSource:target=>{const capture=adapter.captureTimeSource??adapter.captureChatSource??adapter.captureSummarySource;if(typeof capture!=='function')throw new Error('宿主缺少日期来源接口');return capture.call(adapter,target);},...(typeof (adapter.matchesTimeSource??adapter.matchesChatSource)==='function'?{matchesChatSource:(target,snapshot)=>(adapter.matchesTimeSource??adapter.matchesChatSource)(target,snapshot)}:{})};
 const service=createTimeService({repository,source,now}),listeners=new Set(),subscriptions=[];
 let disposed=false,serial=0,queued=false,pending=null,status={status:'idle',date:null};
 const publish=value=>{status=structuredClone(value);for(const listener of listeners){try{listener(structuredClone(status));}catch{/* A view must not stop date observation. */}}};
 const invalidate=()=>{serial++;service.invalidate();if(!disposed)publish({status:'loading',date:null});};
 const configured=()=>{if(typeof adapter.hasTimeCalendar==='function')return adapter.hasTimeCalendar();try{return !!adapter.peekConfirmed(adapter.captureTarget())?.time?.activeCalendarId;}catch{return null;}};
 function request(type='normal'){
  if(disposed||!gate.allowed()||['quiet','impersonate'].includes(type))return Promise.resolve({status:'skipped'});
  queued=true;if(pending)return pending;
  const job=(async()=>{
   await Promise.resolve();
   while(queued&&!disposed&&gate.allowed()){
    queued=false;const ticket=serial,proof=gate.capture();
    try{
     if(configured()===false){if(!disposed&&ticket===serial)publish({status:'no-calendar',date:null});continue;}
     await adapter.prepare();if(disposed||ticket!==serial||!gate.matches(proof))continue;
     const result=await service.reconcile();if(!disposed&&ticket===serial&&!queued)publish(result);
    }catch(error){if(!disposed&&ticket===serial&&!queued)publish({status:'failed',message:error?.message??'日期识别未完成'});}
   }
   return structuredClone(status);
  })();
  pending=job;const clear=()=>{if(pending===job){pending=null;if(queued&&!disposed)void request();}};job.then(clear,clear);return job;
 }
 const on=(name,handler)=>{const type=context.eventTypes?.[name];if(type){events.on(type,handler);subscriptions.push([type,handler]);}};
 on('MESSAGE_SENT',()=>void request());
 on('MESSAGE_RECEIVED',(_id,type)=>void request(typeof type==='string'?type:'normal'));
 for(const name of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'])on(name,()=>void request());
 for(const name of ['CHAT_CHANGED','CHAT_CREATED'])on(name,()=>{invalidate();void request();});
 return {
  request,
  pause(){queued=false;invalidate();publish({status:'disabled',date:null});},
  inspect:()=>structuredClone(status),
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  async calibrate(date){if(disposed||!gate.allowed())throw new Error('时间功能已关闭');const ticket=serial,result=await service.calibrate(date);if(!disposed&&ticket===serial)publish({status:result.status,date:result.root.time.currentDate});return result;},
  async reidentify(){if(disposed||!gate.allowed())throw new Error('时间功能已关闭');const ticket=serial,result=await service.reconcile({reidentify:true});if(!disposed&&ticket===serial)publish(result);return result;},
  dispose(){if(disposed)return;disposed=true;queued=false;invalidate();listeners.clear();for(const [type,handler]of subscriptions)(events.removeListener??events.off).call(events,type,handler);},
 };
}
