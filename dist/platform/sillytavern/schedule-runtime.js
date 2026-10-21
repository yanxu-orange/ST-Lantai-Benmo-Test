import {sameTarget} from '../../domain/memory/repository.js';
import {featureGate} from '../../domain/controls/gate.js';
import {matchesStoredLatestSource} from '../../domain/latest/source.js';
import {scheduleState,prepareSchedulePlan,parseScheduleResult,applyScheduleResult,pruneScheduleSources} from '../../domain/time/schedule.js';
import {buildScheduleTask} from '../../domain/time/schedule-requests.js';

const copy=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const TASK_ID='schedule_tracking';
// This participant deliberately owns no host generation listener or provider.
// The round coordinator supplies the same cleaned reply and shared response.
export function createScheduleRuntime({repository,settings,getControls,captureSource,dateRuntime}={}){
  const controls=()=>getControls?.()??{allowed:()=>false,capture:()=>null,matches:()=>false};
  const gates=['enabled','time','schedule'].map(key=>featureGate(controls,key));
  let disposed=false,serial=0;
  const listeners=new Set();
  const notify=()=>{if(!disposed)for(const listener of listeners)try{listener();}catch{/* A display cannot revoke a saved result. */}};
  const current=target=>{try{return !disposed&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  const allowed=()=>!disposed&&gates.every(gate=>gate.allowed());
  const configuration=()=>settings?.captureScheduleTracking?.();
  function captureAutomaticProof(){
    if(!allowed())return null;
    let config;try{config=configuration();}catch{return null;}if(!config)return null;
    return {serial,gates:gates.map(gate=>gate.capture()),settings:copy(config)};
  }
  function matches(proof){
    if(!proof||proof.serial!==serial||!allowed()||!gates.every((gate,index)=>gate.matches(proof.gates[index])))return false;
    try{return equal(configuration(),proof.settings);}catch{return false;}
  }
  async function prepareBackground(target,source,{automatic=false,taskId,automaticProof=null,identities={}}={}){
    if(taskId&&taskId!==TASK_ID||!allowed())return null;
    const proof=automatic?automaticProof:captureAutomaticProof();
    if(!matches(proof))return null;
    // Finish the existing local date observer before freezing its baseline.
    // It performs no model request and installs no additional host listener.
    await dateRuntime?.request?.();
    if(!current(target)||!matches(proof))return null;
    const captured=await repository.captureTime(target);
    if(!current(target)||!matches(proof))return null;
    const raw=captureSource(target),projected=scheduleState(captured.time,raw);
    if(automatic&&projected.receipts.some(row=>projected.activeIds.has(row.id)&&row.sourceSnapshot.replyId===source.replyId&&matchesStoredLatestSource(row.sourceSnapshot,raw)))return null;
    const config=proof.settings.config;
    if(!config?.categories?.length)return null;
    const plan=prepareSchedulePlan(captured.time,source,{categories:config.categories});
    return {target:copy(target),proof,plan,task:buildScheduleTask({plan,instructions:config.instructions,identities})};
  }
  function filterCurrentBackgroundPlan(prepared){return prepared&&current(prepared.target)&&matches(prepared.proof)?prepared:null;}
  async function filterBackgroundPlan(prepared){
    if(!filterCurrentBackgroundPlan(prepared))return null;
    // A date advance is unrelated to authorization and must not invalidate a
    // prepared round. Calendar definitions and the facts sent to AI do matter.
    const captured=await repository.captureTime(prepared.target);
    if(!filterCurrentBackgroundPlan(prepared))return null;
    const now=prepareSchedulePlan(captured.time,prepared.plan.source,{categories:prepared.plan.categories});
    if(!equal(now.calendars,prepared.plan.calendars)||now.activeCalendarId!==prepared.plan.activeCalendarId||!equal(now.current,prepared.plan.current))return null;
    return prepared;
  }
  async function saveBackgroundResult(prepared,text,{isCurrent=()=>true}={}){
    if(!filterCurrentBackgroundPlan(prepared)||!isCurrent())return {skipped:true};
    const result=parseScheduleResult(text,prepared.plan);
    const valid=()=>!!filterCurrentBackgroundPlan(prepared)&&isCurrent();
    const saved=await repository.updateSchedule(prepared.target,{
      apply:time=>applyScheduleResult(time,{plan:prepared.plan,result,source:captureSource(prepared.target),background:true}),
      isCurrent:valid,requireConfirmation:true,
    });
    if(valid())notify();
    return {receipt:saved.receipt,errors:saved.errors??result.errors??{}};
  }
  async function reconcile(target,{invalidatedFloors=[],replyVersions,isCurrent=()=>true,readView,raw}={}){
    if(!current(target)||!isCurrent())return null;
    // Maintenance runs with generation disabled. Old automatic facts must not
    // survive deleted/edited sources merely because the switch was turned off.
    const captured=await repository.captureTime(target,readView),source=raw??captureSource(target),next=pruneScheduleSources(captured.time,source,{replyVersions,invalidatedFloors});
    if(!current(target)||!isCurrent())return null;
    if(equal(next,captured.time))return captured;
    const saved=await repository.updateSchedule(target,{
      apply:time=>pruneScheduleSources(time,captureSource(target),{replyVersions,invalidatedFloors}),
      isCurrent:()=>current(target)&&isCurrent(),requireConfirmation:true,
    });
    return saved.selection;
  }
  async function backgroundState(target,{readView,raw:source,captured:provided}={}){
    const captured=provided??await repository.captureTime(target,readView);
    if(!current(target))throw new Error('聊天已变化');
    const raw=source??captureSource(target);
    return {target:copy(target),...scheduleState(captured.time,raw),sourceSignature:JSON.stringify(raw)};
  }
  function displayState(captured,raw,invalidatedFloors=[]){
    if(!captured)return null;
    if(!invalidatedFloors.length&&captured.sourceSignature===JSON.stringify(raw))return captured;
    const time=pruneScheduleSources(captured.time,raw,{invalidatedFloors});
    return {...captured,...scheduleState(time),sourceSignature:JSON.stringify(raw)};
  }
  function floorTasks(captured,raw,_floor,replyId,status={}){
    if(!captured)return [];
    const receipts=captured.receipts.filter(row=>captured.activeIds.has(row.id)&&row.sourceSnapshot.replyId===replyId&&matchesStoredLatestSource(row.sourceSnapshot,raw));
    const active=allowed();
    const counts=receipts.length?receipts.reduce((counts,row)=>Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key]+row.counts[key]])),{added:0,updated:0,candidates:0}):null;
    const hasChanges=!!counts&&Object.values(counts).some(count=>count>0);
    if(!hasChanges&&(!active||!['running','failed','cancelled'].includes(status.status)))return [];
    return [{id:TASK_ID,kind:'schedule',name:'日程与纪念日',body:hasChanges?`本轮新增 ${counts.added} 条，更新 ${counts.updated} 条，候选 ${counts.candidates} 条。`:'',status:active?status.status??'ready':'ready',error:active?status.error??'':'',canRetry:active,openSchedule:hasChanges}];
  }
  function cancel(){serial++;}
  return {allowed,captureAutomaticProof,prepareBackground,filterBackgroundPlan,filterCurrentBackgroundPlan,saveBackgroundResult,reconcile,backgroundState,displayState,floorTasks,cancel,reset:cancel,
    controlsChanged(){notify();},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){if(disposed)return;cancel();disposed=true;listeners.clear();},
  };
}
