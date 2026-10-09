import { trackingExclusionsOf, effectiveTrackingExclusions, trackingRecordExcluded } from '../../domain/tracking/exclusions.js';
import {DEFAULT_TRACKING_PROMPTS} from '../../domain/tracking/prompts.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {featureGate} from '../../domain/controls/gate.js';
import {currentTracking,prepareTrackingUpdate,applyTrackingResponseParts,addTrackingRecord,editTrackingRecord,deleteTrackingRecord,setTrackingPreferences,invalidateTrackingFloors,pruneTrackingSnapshots,setTrackingExclusionNames,setTrackingRecordExcluded} from '../../domain/tracking/data.js';
import {TRACKING_FIELDS} from '../../domain/tracking/model.js';
import {buildTrackingRequest,parseTrackingResponseParts} from '../../domain/tracking/requests.js';
import {buildTrackingRecall} from '../../domain/tracking/recall.js';
import {matchesStoredLatestSource} from '../../domain/latest/source.js';
import {recallInputs} from './recall-runtime.js';
const clone=structuredClone,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const KEY='lantai_benmo_tracking_context',supported=new Set(['normal','regenerate','swipe','continue']);
export function createTrackingRuntime({repository,adapter,settings,getContext,getControls,captureSource,onChange}={}) {
  const controls=()=>getControls?.()??{allowed:()=>false,capture:()=>null,matches:()=>false};
  const gate=featureGate(controls,'enabled'),categoryGates={items:featureGate(controls,'item'),npcs:featureGate(controls,'npc')};
  let disposed=false,target=null,lastTarget=null,selection=null,state={records:[],preferences:{itemsEnabled:false,npcsEnabled:false},writeBlocked:false,error:'',target:null},tail=Promise.resolve(),serial=0,exclusionEpoch=0,pendingExclusions=0;
  const listeners=new Set(),releases=[];
  const effectivePreferences=()=>Object.fromEntries(['items','npcs'].map(key=>[`${key}Enabled`,gate.allowed()&&categoryGates[key].allowed()]));
  const captureCategories=()=>Object.fromEntries(['items','npcs'].map(key=>[key,categoryGates[key].capture()]));
  const contentOf=domain=>{const {revision,preferences,...content}=domain;return content;};
  const current=t=>{try{return !disposed&&sameTarget(t,repository.captureTarget());}catch{return false;}};
  const snapshot=()=>clone({...state,exclusions:state.exclusions??trackingExclusionsOf(null),prompts:settings.captureTrackingPrompts?.().prompts??DEFAULT_TRACKING_PROMPTS,writeBlocked:state.writeBlocked||!gate.allowed()}),notify=()=>{for(const fn of listeners)try{fn(snapshot());}catch{/* Observer cannot break data. */}};
  function adopt(t,captured){
    if(selection&&!equal(trackingExclusionsOf(selection.tracking),trackingExclusionsOf(captured.tracking))){exclusionEpoch++;clear();}
    const projected=currentTracking(captured.tracking,captureSource(t)),exclusions=effectiveTrackingExclusions(captured.tracking,projected.records);target=clone(t);lastTarget=clone(t);selection=captured;
    state={records:projected.records.map(row=>({...row,excluded:trackingRecordExcluded(row,exclusions),...(row.kind==='npc'?{absentTurns:projected.absenceTurns[row.id]}:{})})),preferences:captured.tracking.preferences,exclusions:trackingExclusionsOf(captured.tracking),writeBlocked:false,error:'',target:clone(t),aiTurn:projected.aiTurn};notify();return snapshot();
  }
  async function load(){const ticket=serial,t=await adapter.prepare(),captured=await repository.captureTracking(t);if(disposed||ticket!==serial||!current(t))throw new Error('聊天已变化，请重新打开追踪');return adopt(t,captured);}
  function clear({invalidate=true}={}){if(invalidate)serial++;try{getContext().setExtensionPrompt(KEY,'',1,0,false,0);return true;}catch{return false;}}
  function mutate(change,{fresh=false,requireConfirmation=true,requireEnabled=true,category=null}={}){
    const requestedTarget=clone(target),requested=selection,ticket=serial,controlProof=gate.capture(),categoryGate=categoryGates[category],categoryProof=categoryGate?.capture();
    const controlsValid=()=>!requireEnabled||gate.allowed()&&gate.matches(controlProof)&&(!categoryGate||categoryGate.allowed()&&categoryGate.matches(categoryProof));
    const work=tail.catch(()=>{}).then(async()=>{
      if(!requestedTarget||!current(requestedTarget)||ticket!==serial||!requested||!controlsValid())throw new Error('聊天已变化，请重新读取追踪');
      const latest=await repository.captureTracking(requestedTarget);
      if(!fresh&&!equal(latest.tracking,requested.tracking))throw new Error('追踪资料已更新，请重新读取后修改');
      const valid=()=>current(requestedTarget)&&ticket===serial&&controlsValid();
      const value=change(latest.tracking,captureSource(requestedTarget));
      const saved=await repository.updateTracking(requestedTarget,latest,value,{isCurrent:valid,requireConfirmation});
      if(!valid())throw new Error('聊天已变化，请重新读取追踪');
      const result=adopt(requestedTarget,saved.selection);onChange?.();return result;
    }).catch(error=>{if(current(requestedTarget)&&ticket===serial){state={...state,writeBlocked:true,error:error.message};notify();}throw error;});tail=work;return work;
  }
  function changeExclusions(change){
    // Invalidate before awaiting persistence: a pending interceptor or provider
    // must not publish old context/results while a user pause is being saved.
    exclusionEpoch++;pendingExclusions++;clear();
    return mutate(change,{fresh:true}).finally(()=>{pendingExclusions--;clear({invalidate:false});});
  }
  const visibleRecords=ticket=>ticket.current.filter(record=>ticket.preferences[record.kind==='item'?'itemsEnabled':'npcsEnabled']&&!trackingRecordExcluded(record,ticket.exclusions));
  function saveRecord(kind,draft){
    if(!['item','npc'].includes(kind)||!draft||typeof draft.id!=='string'||!draft.id)throw new Error('追踪记录身份无效');
    const value=clone(draft);
    return mutate((domain,raw)=>{
      const existing=currentTracking(domain,raw).records.find(row=>row.id===value.id),allowed=['name','aliases','pinned','customFields',...TRACKING_FIELDS[kind]],patch={};
      for(const [key,field] of Object.entries(value)){if(key==='id')continue;if(!allowed.includes(key))throw new Error('追踪记录字段无效');patch[key]=field;}
      if(existing){if(existing.kind!==kind)throw new Error('追踪记录类型已变化');return editTrackingRecord(domain,raw,value.id,patch);}
      // addTrackingRecord rejects any historical/tombstoned reuse of this ID.
      return addTrackingRecord(domain,{kind,...patch},{makeId:()=>value.id});
    },{category:kind==='item'?'items':'npcs'});
  }
  async function prepareBackground(t,source,{automatic=false,taskId,rules=[]}={}){
    if(pendingExclusions||!gate.allowed()||taskId&&taskId!=='tracking')return null;
    const preparedEpoch=exclusionEpoch,captured=await repository.captureTracking(t),domain=captured.tracking;
    const activePreferences=effectivePreferences();
    if(preparedEpoch!==exclusionEpoch||pendingExclusions||!current(t)||!gate.allowed()||!activePreferences.itemsEnabled&&!activePreferences.npcsEnabled)return null;
    const raw=captureSource(t);
    if(automatic&&domain.snapshots.some(row=>row.sourceSnapshot.replyId===source.replyId&&matchesStoredLatestSource(row.sourceSnapshot,raw)))return null;
    const ticket=prepareTrackingUpdate({...domain,preferences:activePreferences},raw,{floor:source.assistantFloor,rules});
    const prompts=settings.captureTrackingPrompts?.().prompts??DEFAULT_TRACKING_PROMPTS;
    const request=buildTrackingRequest({ticket,prompts});
    return {target:clone(t),selection:captured,ticket,prompts,exclusionEpoch:preparedEpoch,categoryProofs:captureCategories(),gate:gate.capture(),task:{id:'tracking',name:'物品与 NPC 追踪',instructions:request.previewParts.slice(0,-1).map(part=>part.content).join('\n\n'),previousState:visibleRecords(ticket)}};
  }
  // Recheck immediately before the shared provider call, without granting a
  // new epoch to a category switched off/on while other plans were prepared.
  async function filterBackgroundPlan(plan){
    const valid=()=>!!plan&&!pendingExclusions&&plan.exclusionEpoch===exclusionEpoch&&current(plan.target)&&gate.allowed()&&gate.matches(plan.gate);
    if(!valid())return null;
    // Imports, another runtime and direct root writes do not advance this
    // runtime's local epoch. Re-read authority before sharing captured facts.
    let captured;
    try{captured=await repository.captureTracking(plan.target);}catch{if(valid())clear();return null;}
    if(!valid())return null;
    if(!equal(contentOf(captured.tracking),contentOf(plan.selection.tracking))){
      if(!equal(trackingExclusionsOf(captured.tracking),trackingExclusionsOf(plan.selection.tracking))){exclusionEpoch++;clear();}
      return null;
    }
    return filterCurrentBackgroundPlan(plan);
  }
  function filterCurrentBackgroundPlan(plan){
    if(!plan||pendingExclusions||plan.exclusionEpoch!==exclusionEpoch||!current(plan.target)||!gate.allowed()||!gate.matches(plan.gate))return null;
    const preferences=Object.fromEntries(['items','npcs'].map(key=>[`${key}Enabled`,plan.ticket.preferences[`${key}Enabled`]&&categoryGates[key].matches(plan.categoryProofs[key])]));
    if(!Object.values(preferences).some(Boolean))return null;
    const ticket={...plan.ticket,preferences},request=buildTrackingRequest({ticket,prompts:plan.prompts});
    return {...plan,ticket,task:{...plan.task,instructions:request.previewParts.slice(0,-1).map(part=>part.content).join('\n\n'),previousState:visibleRecords(ticket)}};
  }
  async function saveBackgroundResult(plan,text,{isCurrent=()=>true,attempt=0}={}){
    const valid=()=>!pendingExclusions&&plan.exclusionEpoch===exclusionEpoch&&current(plan.target)&&gate.allowed()&&gate.matches(plan.gate)&&isCurrent();
    if(!valid())throw new Error('追踪任务已停止');
    const captured=await repository.captureTracking(plan.target);
    if(!equal(contentOf(captured.tracking),contentOf(plan.selection.tracking)))throw new Error('追踪资料已变化，请重试');
    const preferences=Object.fromEntries(['items','npcs'].map(key=>[`${key}Enabled`,plan.ticket.preferences[`${key}Enabled`]&&categoryGates[key].matches(plan.categoryProofs[key])]));
    const enabled=['items','npcs'].filter(key=>preferences[`${key}Enabled`]);
    if(!enabled.length)return {errors:{items:null,npcs:null},skipped:true};
    const ticket={...plan.ticket,revision:captured.tracking.revision,preferences};
    const parsed=parseTrackingResponseParts(text,{preferences});
    for(const key of ['items','npcs'])if(!preferences[`${key}Enabled`])parsed.errors[key]='本类别已关闭或来源设置已变化';
    if(enabled.every(key=>parsed.errors[key]))throw new Error(enabled.map(key=>parsed.errors[key]).join('；'));
    const applied=applyTrackingResponseParts({...captured.tracking,preferences},ticket,parsed,captureSource(plan.target));
    if(enabled.every(key=>applied.errors[key]))throw new Error(enabled.map(key=>applied.errors[key]).join('；'));
    const next={...applied.tracking,preferences:captured.tracking.preferences};
    const categoriesValid=()=>enabled.every(key=>categoryGates[key].matches(plan.categoryProofs[key])),commitValid=()=>valid()&&categoriesValid();
    let saved;
    try{saved=await repository.updateTracking(plan.target,captured,next,{isCurrent:commitValid,requireConfirmation:true});}
    catch(error){
      if(valid()&&attempt<2&&!categoriesValid()){
        // Only a shrinking global eligibility set permits retry. Preserve the
        // categories whose captured control epochs still match.
        await tail.catch(()=>{});return saveBackgroundResult(plan,text,{isCurrent,attempt:attempt+1});
      }
      throw error;
    }
    if(commitValid())adopt(plan.target,saved.selection);
    return {errors:Object.fromEntries(['items','npcs'].map(key=>[key,preferences[`${key}Enabled`]?applied.errors[key]:null]))};
  }
  async function reconcile(t,{invalidatedFloors=[],replyVersions,isCurrent=()=>true}={}){
    const captured=await repository.captureTracking(t);
    if(!current(t)||!isCurrent())return null;
    const next=pruneTrackingSnapshots(invalidateTrackingFloors(captured.tracking,invalidatedFloors),captureSource(t),{replyVersions});
    const saved=equal(next,captured.tracking)?{selection:captured}:await repository.updateTracking(t,captured,next,{isCurrent:()=>current(t)&&isCurrent(),requireConfirmation:true});
    if(current(t)&&isCurrent())adopt(t,saved.selection);
    return saved.selection;
  }
  async function backgroundState(t){
    const captured=await repository.captureTracking(t);if(!current(t))throw new Error('聊天已变化');
    const raw=captureSource(t),projected=currentTracking(captured.tracking,raw),byId=new Map(captured.tracking.snapshots.map(row=>[row.id,row])),activeIds=new Set();
    let key=projected.baseKey;while(key&&!activeIds.has(key)){activeIds.add(key);key=byId.get(key)?.baseKey;}
    return {target:t,...captured,projected,activeIds,sourceSignature:JSON.stringify(raw),enabled:gate.allowed()};
  }
  function displayState(captured,raw,invalidatedFloors=[]){
    if(!captured)return null;
    if(!invalidatedFloors.length&&captured.sourceSignature===JSON.stringify(raw))return captured;
    const domain=invalidatedFloors.length?invalidateTrackingFloors(captured.tracking,invalidatedFloors):captured.tracking;
    const projected=currentTracking(domain,raw),byId=new Map(domain.snapshots.map(row=>[row.id,row])),activeIds=new Set();
    let key=projected.baseKey;while(key&&!activeIds.has(key)){activeIds.add(key);key=byId.get(key)?.baseKey;}
    return {...captured,tracking:domain,projected,activeIds};
  }
  function floorTasks(captured,raw,floor,replyId,status={}){
    if(!captured?.enabled||!gate.allowed())return [];
    const domain={...captured.tracking,preferences:effectivePreferences()},version=domain.snapshots.find(row=>row.sourceSnapshot.replyId===replyId&&captured.activeIds?.has(row.id)&&matchesStoredLatestSource(row.sourceSnapshot,{...raw,messages:raw.messages.filter(message=>message.floor===row.sourceSnapshot.assistantFloor||message.floor===row.sourceSnapshot.userFloor)}));
    if(!version&&!['running','failed'].includes(status.status))return [];
    if(!domain.preferences.itemsEnabled&&!domain.preferences.npcsEnabled)return [];
    const counts=version?['items','npcs'].filter(key=>domain.preferences[`${key}Enabled`]).map(key=>`${key==='items'?'物品':'NPC'} ${version.changes[key].length} 条`).join('、'):'';
    return [{id:'tracking',name:'物品与 NPC 追踪',body:version?`本轮更新：${counts}。当前资料可在本末查看。`:'',status:status.status??'ready',error:status.error??''}];
  }

  async function intercept(messages,_size,_abort,type='normal'){
    if(disposed||!clear()||pendingExclusions||!gate.allowed()||!Object.values(effectivePreferences()).some(Boolean)||!supported.has(type)||messages?.some(row=>String(row?.mes??row?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
    const ticket=serial,t=repository.captureTarget(),proof=gate.capture(),categoryProofs=captureCategories(),preferences=effectivePreferences();
    try{
      const captured=await repository.captureTracking(t),raw=captureSource(t),projected=currentTracking(captured.tracking,raw),config=settings.captureRecall();
      const valid=()=>!disposed&&ticket===serial&&current(t)&&gate.matches(proof)&&['items','npcs'].every(key=>!preferences[`${key}Enabled`]||categoryGates[key].matches(categoryProofs[key]))&&settings.captureRecall().epoch===config.epoch&&equal(captureSource(t),raw);
      if(!valid())return;
      const context=getContext(),inputs=recallInputs(messages,config.recall.recentFloorCount,context.chat);
      const result=await buildTrackingRecall({records:projected.records,exclusions:effectiveTrackingExclusions(captured.tracking,projected.records),preferences,aiTurn:projected.aiTurn,...inputs,settings:config.recall,countTokens:typeof context.getTokenCountAsync==='function'?text=>context.getTokenCountAsync(text):null});
      if(!valid())return;
      const latest=await repository.captureTracking(t);if(!valid()||!equal(latest.tracking,captured.tracking))return;
      context.setExtensionPrompt(KEY,result.prompt,1,config.recall.memoryDepth,false,0);
      if(!valid())clear();
    }catch{if(!disposed&&ticket===serial)clear();}
  }
  const context=getContext();
  for(const name of ['CHAT_CHANGED','CHAT_CREATED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','GENERATION_STOPPED']){
    const event=context?.eventTypes?.[name],events=context?.eventSource;if(!event||!events?.on)continue;
    const listener=()=>{clear();if(name.startsWith('CHAT_')){target=null;selection=null;state={...state,records:[],exclusions:trackingExclusionsOf(null),target:null};notify();}};
    events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));
  }
  return {load,snapshot,saveRecord,
    saveExclusionNames(kind,names,{original}={}){const value=clone(names),before=clone(original);return changeExclusions(domain=>{if(before!==undefined&&!equal(trackingExclusionsOf(domain)[kind]?.names,before))throw new Error('追踪排除名单已变化，请重新读取后修改');return setTrackingExclusionNames(domain,kind,value);});},
    setRecordExcluded(kind,id,excluded){return changeExclusions((domain,raw)=>setTrackingRecordExcluded(domain,raw,kind,id,excluded));},
    defaultPrompts:DEFAULT_TRACKING_PROMPTS,
    async savePrompt(kind,prompt,{original}={}){
      if(!['item','npc'].includes(kind))throw new Error('追踪类别无效');
      const captured=settings.captureTrackingPrompts();
      if(original!==undefined&&captured.prompts[kind]!==original)throw new Error('追踪要求已变化，请重新读取后修改');
      await settings.saveTrackingPrompts({...captured.prompts,[kind]:prompt},{expectedEpoch:captured.epoch});
      notify();return snapshot();
    },isCurrent:()=>current(target),
    rebindTarget(next){const previous=target??lastTarget;if(!previous||previous.chatId!==next.chatId||previous.rootId!==next.rootId)throw new Error('聊天已变化');if(!sameTarget(target,next)){clear();target=clone(next);selection=null;state={...state,target:clone(next),writeBlocked:true,error:'聊天已重新读取，请重新读取追踪'};notify();}},
    deleteRecord(kind,id){return mutate((domain,raw)=>{const record=currentTracking(domain,raw).records.find(row=>row.id===id);if(record?.kind!==kind)throw new Error('追踪记录已变化');return deleteTrackingRecord(domain,raw,id);},{category:kind==='item'?'items':'npcs'});},
    savePreferences(patch){
      return mutate(domain=>setTrackingPreferences(domain,{...domain.preferences,...patch}),{fresh:true,requireConfirmation:false,requireEnabled:false});
    },
    controlsChanged(){clear({invalidate:false});notify();},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},prepareBackground,filterBackgroundPlan,filterCurrentBackgroundPlan,saveBackgroundResult,reconcile,backgroundState,displayState,floorTasks,intercept,clear,
    dispose(){if(disposed)return;clear();disposed=true;for(const release of releases)release();listeners.clear();},
  };
}
