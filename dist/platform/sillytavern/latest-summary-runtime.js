import {createWorkshopSendContext} from './workshop-send-context.js';
import {captureSingleCharacterCard,captureCurrentUserPersona} from './character-card.js';
import {hasWorkshopMaterials,prepareWorkshopMaterials,workshopMaterials} from '../../domain/workshop/materials.js';
import {AiProviderError} from '../../shared/ai/provider.js';
import {SettingsError} from '../../shared/settings/model.js';
import {latestArchivedFloors} from '../../domain/latest/coverage.js';
import {cleanSummaryFloors,createDefaultCleaningRules,normalizeCleaningRule} from '../../domain/summary/cleaning.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {DEFAULT_LATEST_PROMPT,emptyLatest,pruneLatestRecords} from '../../domain/latest/data.js';
import {prepareLatestSource,prepareManualLatestSource,matchesLatestSource,matchesBackgroundLatestSource,matchesStoredLatestSource,createStoredLatestSourceMatcher} from '../../domain/latest/source.js';
import {buildLatestRequest,promptIdentities} from '../../domain/latest/requests.js';
import {planLatestBackfill,buildLatestBackfillRequest,parseLatestBackfillResponse} from '../../domain/latest/backfill.js';
import {buildBackgroundRoundRequest,parseBackgroundRoundResponse} from '../../domain/background/round.js';
import {buildWorkshopRoundRequest} from '../../domain/workshop/requests.js';
import {resultText} from '../../domain/workshop/results.js';
import {transformLatestMessages} from '../../domain/latest/transform.js';
import {prepareWorkshopIdentities,WORKSHOP_REPLY_KEY} from './workshop-identities.js';
import {mapSummaryPromptFloors} from './summary-history.js';
import {latestSourceMetadata,pendingProjection} from './latest-source-metadata.js';

const copy=value=>structuredClone(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const summarySettings=({enabled,...preferences})=>preferences;
const normalizedRules=rules=>(rules??createDefaultCleaningRules()).map(normalizeCleaningRule);
const supported=new Set(['normal','regenerate','swipe','continue']);
const failureLabels={preparation:'准备',config:'配置',request:'请求',parse:'解析',save:'保存'};
const safeLocalFailures=new Set(['未收到该任务的完整结果','该任务分段格式无效或发生嵌套','该任务返回了空白结果','该任务分段未完整闭合','该任务出现重复分段','清洗后没有可总结的 AI 正文','该楼层没有可总结的 AI 正文','后台任务数量无效','后台任务分段无效','工坊条目或生成资料已变化','最新摘要设置已变化，请重试','最新摘要已修改，请重新读取']);
const safeFailure=(error,stage)=>`${failureLabels[stage]}失败：${error instanceof AiProviderError?new AiProviderError(error.code).message:error instanceof SettingsError?new SettingsError(error.code).message:safeLocalFailures.has(error?.message)?error.message:error?.code==='COMMIT_UNCONFIRMED'?'保存结果尚未确认，请重新读取后核对。':'请重试。'}`;
// Capture only names the host explicitly binds; never infer a story person from
// the user/assistant author labels on a message.
export function captureLatestPromptIdentities(context={}){
  const character=context.characters?.[context.characterId];
  return promptIdentities({user:context.name1??context.userName,char:context.name2??character?.data?.name??character?.name});
}
// Latest owns neither provider configuration nor event/ancient summary progress.
export function createLatestSummaryRuntime({repository,adapter,settings,provider,getGenerationSettings,getPreparationSettings,getContext,getControls,workshopRuntime,trackingRuntime,scheduleRuntime,isSourceDeletionPending=()=>false,autoInitialize=true}={}) {
  const workshopSends=createWorkshopSendContext({getContext,captureTarget:()=>repository.captureTarget()});
  let sendDiagnostics=[],activeHostGenerations=0;
  let latestEpoch=0,disposed=false,serial=0,readSerial=0,target=null,selection=null,pending=null,receipt=null,enabled=true,generationQueue=Promise.resolve(),foregroundStopped=false,foregroundType=null,foregroundEnded=false;
  let workshopState=null,workshopFloorStates={},trackingState=null,trackingFloorStates={},scheduleState=null,scheduleFloorStates={};
  let libraryCache=null,displayEpoch=0,lastReadView=null,displayReadDirty=false,initialized=autoInitialize;
  let settingsRecoveryEpoch=0,displayRecoveryEpoch=null,maintenanceProof=null;
  const automaticReceipts=new Map(),displayBatches=new Map(),failureReports=[],retryOwners=new Map();
  let state={...emptyLatest(),status:'idle',error:'',floorStates:{}};
  let backfillState={status:'idle',id:null,total:0,completed:0,skipped:0,failed:0,error:''},backfillController=null;
  let automaticState={status:'idle',message:'尚未收到新一轮正文生成信号',floor:null};
  const listeners=new Set(),visibilityReleases=new Set(),releases=[],jobs=new Set(),queuedFloors=new Set(),invalidatedFloors=new Set();
  const allowed=()=>!disposed&&enabled&&getControls?.()?.allowed('enabled')===true;
  const summaryAllowed=()=>allowed()&&getControls?.()?.allowed('summary')===true;
  const summaryMatches=proof=>summaryAllowed()&&getControls?.()?.matches(proof)===true;
  const current=t=>{try{return !disposed&&sameTarget(t,repository.captureTarget());}catch{return false;}};
  const publish=()=>{displayEpoch++;libraryCache=null;for(const listener of listeners)try{listener(inspect());}catch{/* UI cannot break a write. */}};
  const identities=()=>captureLatestPromptIdentities(getContext());
  const currentFailures=()=>failureReports.filter(row=>target&&current(target)&&row.target.chatId===target.chatId&&row.target.rootId===target.rootId);
  function retainFailure({requestId,target:owner,replyIds,taskIds,rawResponse,error}){
    if(typeof rawResponse!=='string'||!owner)return;
    const existing=failureReports.find(row=>row.requestId===requestId);
    if(existing){if(error&&!existing.errors.includes(error))existing.errors.push(error);return;}
    failureReports.push({requestId,target:copy(owner),replyIds:copy(replyIds),taskIds:copy(taskIds),rawResponse,errors:error?[error]:[],createdAt:new Date().toISOString()});
  }
  function inspect(){return copy({...state,target,sendDiagnostics,automatic:automaticState,backfill:backfillState,failureReports:currentFailures()});}
  function automaticStatus(status,message,floor=automaticState.floor){automaticState={status,message,floor};publish();}
  function cancel(){retryOwners.clear();workshopSends.clear();stopBackfill();for(const [key,value] of automaticReceipts)if(['queued','running'].includes(value.status))automaticReceipts.set(key,{...value,status:'cancelled',message:'本轮自动生成已取消，未自动重试'});if(['waiting','queued','running'].includes(automaticState.status))automaticState={...automaticState,status:'cancelled',message:'本轮自动生成已取消，未自动重试'};serial++;foregroundType=null;for(const [key,value] of Object.entries(scheduleFloorStates))if(value.status==='running')scheduleFloorStates[key]={status:'cancelled',error:'任务已取消，未自动重试'};scheduleRuntime?.cancel?.();for(const [key,value] of Object.entries(trackingFloorStates))if(value.status==='running')trackingFloorStates[key]={status:'cancelled',error:'任务已取消，未自动重试'};for(const tasks of Object.values(workshopFloorStates))for(const [key,value] of Object.entries(tasks))if(value.status==='running')tasks[key]={status:'cancelled',error:'任务已取消，未自动重试'};receipt=null;foregroundEnded=false;generationQueue=Promise.resolve();queuedFloors.clear();displayBatches.clear();for(const job of jobs)job.abort();jobs.clear();for(const [key,value] of Object.entries(state.floorStates))if(value.status==='running')state.floorStates[key]={status:'cancelled',error:'任务已取消，未自动重试'};if(state.status==='running')state.status='ready';publish();}
  function raw(t,retention=false){
    const snapshot=retention&&adapter.captureLatestRetentionSource?adapter.captureLatestRetentionSource(t):adapter.captureChatSource(t),chat=getContext().chat;
    snapshot.messages=snapshot.messages.map(item=>({...item,...latestSourceMetadata(chat[item.floor])}));
    return snapshot;
  }
  function matchesRaw(t,source){
    if(!source||!adapter.matchesChatSource(t,source))return false;
    const chat=getContext().chat;
    return source.messages.every(item=>{
      const metadata=latestSourceMetadata(chat[item.floor]);
      return item.replyId===metadata.replyId&&item.specialPayload===metadata.specialPayload&&item.latestTextOnly===metadata.latestTextOnly;
    });
  }
  const archivedFloor=(t,floor)=>latestArchivedFloors(adapter.peekConfirmed(t),raw(t,true)).has(floor);
  function cleaningRules(){const generation=settings?.captureEventGeneration?settings.captureEventGeneration().generation:getGenerationSettings();return normalizedRules(generation.summaryCleaning?.rules);}
  function versions(){return (getContext().chat??[]).flatMap((message,floor)=>{
    if(message?.is_user!==false||typeof message.mes!=='string')return [];
    const swipes=Array.isArray(message.swipes)&&message.swipes.length?message.swipes:[message.mes];
    return swipes.map((text,swipeId)=>({replyId:message.swipe_info?.[swipeId]?.extra?.[WORKSHOP_REPLY_KEY]??((message.swipe_id??0)===swipeId?message.extra?.[WORKSHOP_REPLY_KEY]:null),floor,swipeId,text})).filter(item=>item.replyId);
  });}
  // A display read may adopt saved facts, but only a completed maintenance pass
  // can certify that source ownership and collector inputs have been reconciled.
  function maintenanceConfiguration(){
    const controls=getControls?.();
    return copy({modules:settings?.captureWorkshop?.().workshop.modules??[],rules:cleaningRules(),gates:['enabled','summary','item','npc','schedule','collect','sync','prompt'].map(key=>({key,allowed:controls?.allowed(key)===true,proof:controls?.capture?.(key)??null}))});
  }
  function maintenanceMatches(proof,readView){
    try{
      if(!proof||disposed||isSourceDeletionPending()||proof.serial!==serial||invalidatedFloors.size||!current(proof.target)||!matchesRaw(proof.target,proof.source)||!sameVersions(proof.versions,versions())||!equal(proof.config,maintenanceConfiguration()))return false;
      if(proof.workshopSource&&!workshopRuntime.matchesDisplaySource(proof.target,proof.workshopSource))return false;
      if(readView){
        if(!repository.matchesPanelData(proof.target,readView))return false;
        const root=repository.readPanelRoot(proof.target,readView);
        if(!equal(proof.binding,[root.binding?.kind,root.binding?.owner])||!equal(proof.modules,root.workshop?.modules??[]))return false;
      }
      return true;
    }catch{return false;}
  }
  async function projectMaintainedPanel(){
    const proof=maintenanceProof;
    if(!maintenanceMatches(proof))return false;
    const readView=await repository.capturePanelData?.(proof.target);
    if(!readView||!maintenanceMatches(proof,readView))return false;
    await read({target:proof.target,readView});
    // A source/config change during projection still owes real maintenance.
    return maintenanceProof===proof&&!!lastReadView&&maintenanceMatches(proof,lastReadView);
  }
  workshopRuntime?.setBackgroundSourceReader?.(t=>({...raw(t),invalidatedFloors:[...invalidatedFloors]}));
  function failedDisplayRead(error,startedEpoch){
    if(error?.code!=='SETTINGS_COMMIT_UNCONFIRMED')return;
    // Keep only the display work that actually failed during staging. If its
    // rejection arrived after confirmation, that transition still owes one
    // recovery read; a failure in the same epoch never starts a retry loop.
    displayRecoveryEpoch=startedEpoch;
    if(!pending&&settingsRecoveryEpoch>startedEpoch)updateWorkshopDisplay();
  }
  async function read({target:prepared,readView:provided}={}){
    initialized=true;
    const token=++readSerial,startedEpoch=settingsRecoveryEpoch;let t;
    try{
    t=prepared??await adapter.prepare();
    const readView=provided??await repository.capturePanelData?.(t),source=raw(t);
    const captured=await repository.captureLatest(t,readView),workshop=await workshopRuntime?.backgroundState(t,{readView}),tracking=await trackingRuntime?.backgroundState(t,{readView,raw:source}),schedule=await scheduleRuntime?.backgroundState(t,{readView,raw:source});
    if(disposed||token!==readSerial||!current(t))return inspect();
    if(readView&&!repository.matchesPanelData(t,readView))return read({target:t});
    if(target&&!sameTarget(target,t)){cancel();resetBackfill();state.floorStates={};invalidatedFloors.clear();}
    displayRecoveryEpoch=null;
    lastReadView=readView;target=t;selection=captured;workshopState=workshop??null;trackingState=tracking??null;scheduleState=schedule??null;state={...captured.latest,status:state.status==='running'?'running':'ready',error:'',floorStates:state.floorStates};publish();return inspect();
    }catch(error){if(!disposed&&token===readSerial&&(!t||current(t)))failedDisplayRead(error,startedEpoch);throw error;}
  }
  function sendPreparationCurrent(owner){
    try{return !disposed&&!isSourceDeletionPending()&&owner.serial===serial&&current(owner.target)&&equal(owner.config,maintenanceConfiguration());}catch{return false;}
  }
  async function reconcile(owner){
    maintenanceProof=null;
    // Verified suffix rollback owns all source-bound domains in one root write.
    if(isSourceDeletionPending()||owner&&!sendPreparationCurrent(owner))return false;
    let config;try{config=maintenanceConfiguration();}catch{/* Unconfirmed settings cannot grant reuse. */}
    const ticket=serial,t=await adapter.prepare();
    if(owner&&(!sameTarget(t,owner.target)||!sendPreparationCurrent(owner)))return false;
    const workshopPass=await workshopRuntime?.request();
    if(owner&&!sendPreparationCurrent(owner))return false;
    const readView=workshopPass?.readView??await repository.capturePanelData?.(t);let captured=await repository.captureLatest(t,readView);
    const sharedSource=raw(t),workshop=await workshopRuntime?.backgroundState(t,{readView}),tracking=await trackingRuntime?.backgroundState(t,{readView,raw:sharedSource}),schedule=await scheduleRuntime?.backgroundState(t,{readView,raw:sharedSource});
    if(disposed||ticket!==serial||!current(t)||isSourceDeletionPending()||owner&&!sendPreparationCurrent(owner))return false;
    // Disabling generation must not disable ownership maintenance for saved
    // summaries: ST copies extension metadata into newly generated swipes.
    // Keep an unsettled host projection untouched until syncSwipeToMes runs;
    // rewriting its extra now would attach the survivor's UUID to stale text.
    const identityChat=getContext().chat.map(message=>pendingProjection(message)?null:message);
    const prepared=summaryAllowed()||captured.latest.records.length||workshop?.modules.length||workshop?.selection.workshop.results.some(row=>row.generationSource==='background')||getControls?.()?.allowed('item')||getControls?.()?.allowed('npc')||tracking?.tracking.snapshots.length||getControls?.()?.allowed('schedule')||schedule?.receipts.length?prepareWorkshopIdentities(identityChat,{allowPendingLast:true}):{changed:false,selected:[]},source=raw(t);
    let maintainedProof=null;
    if(config&&readView&&(!workshopRuntime||workshopPass?.displaySource||!config.gates.some(row=>['prompt','collect','sync'].includes(row.key)&&row.allowed))){const root=repository.readPanelRoot(t,readView);maintainedProof={target:copy(t),serial:ticket,source,versions:versions(),config,binding:[root.binding?.kind,root.binding?.owner],modules:copy(root.workshop?.modules??[]),workshopSource:workshopPass?.displaySource??null};}
    const next=pruneLatestRecords(captured.latest,raw(t,true),{replyVersions:versions(),retainStale:true});
    const valid=()=>{try{return !disposed&&!isSourceDeletionPending()&&ticket===serial&&current(t)&&matchesRaw(t,source)&&(!owner||sendPreparationCurrent(owner));}catch{return false;}};
    if(prepared.changed||!equal(next,captured.latest)){
      const saved=await repository.updateLatest(t,captured,next,{isCurrent:valid,forceSave:prepared.changed,workshopProof:prepared.selected.map(({floor,swipeId,replyId})=>({floor,swipeId,replyId}))});
      captured=saved.selection;
    }
    const replyVersions=versions(),options={readView,raw:source,replyVersions,invalidatedFloors:[...invalidatedFloors],isCurrent:valid};
    const maintained=valid()?await workshopRuntime?.reconcileBackground(t,source,{...options,state:workshop}):null;
    const trackingSelection=valid()?await trackingRuntime?.reconcile(t,options):null;
    const scheduleSelection=valid()?await scheduleRuntime?.reconcile(t,options):null;
    const tracked=valid()?await trackingRuntime?.backgroundState(t,{readView,raw:source,captured:trackingSelection??undefined}):null,scheduled=valid()?await scheduleRuntime?.backgroundState(t,{readView,raw:source,captured:scheduleSelection??undefined}):null;
    // This in-memory receipt keeps the maintained source bound through any
    // trailing display reads; a display projection cannot certify new input.
    const completion=()=>valid()?{isCurrent:valid}:null;
    if(valid()&&readView&&!repository.matchesPanelData(t,readView)){invalidatedFloors.clear();await read({target:t});if(lastReadView&&maintenanceMatches(maintainedProof,lastReadView))maintenanceProof=maintainedProof;return completion();}
    if(valid()){displayRecoveryEpoch=null;invalidatedFloors.clear();lastReadView=readView;target=t;selection=captured;workshopState=maintained??workshop??null;trackingState=tracked??tracking??null;scheduleState=scheduled??schedule??null;state={...captured.latest,status:'ready',error:'',floorStates:state.floorStates};if(maintenanceMatches(maintainedProof,readView))maintenanceProof=maintainedProof;publish();return completion();}
    return false;
  }
  function queueRefresh(allowProjection=false,owner){
    initialized=true;
    // Explicit refreshes retain their own queued pass and failure. Only the
    // panel's ensureData joins existing initialization, so an old chat's failed
    // pass cannot consume a later chat's initialization or hide its own error.
    const work=(pending??Promise.resolve()).catch(()=>{}).then(async()=>{
      if(owner&&!sendPreparationCurrent(owner))return false;
      const ticket=serial,startedEpoch=settingsRecoveryEpoch;displayReadDirty=false;
      try{let completed=true;if(!allowProjection||!await projectMaintainedPanel())completed=await reconcile(owner);
      // Notifications received during a pass coalesce into a current read.
      while(!disposed&&ticket===serial&&displayReadDirty&&(!owner||completed?.isCurrent?.()===true)){displayReadDirty=false;await read({target,readView:lastReadView});}
      if(owner)return completed?.isCurrent?.()===true&&sendPreparationCurrent(owner);
      }catch(error){if(!disposed&&ticket===serial)failedDisplayRead(error,startedEpoch);throw error;}
    });pending=work;
    work.finally(()=>{if(pending===work){pending=null;if(displayRecoveryEpoch!==null&&settingsRecoveryEpoch>displayRecoveryEpoch)updateWorkshopDisplay();}}).catch(()=>{});return work;
  }
  const refresh=()=>queueRefresh();
  const ensureData=()=>pending??queueRefresh(true);
  // Formal sampling waits for this target's own maintenance receipt, never a
  // previous chat's pending display read or the separate model job queue.
  const prepareSend=owner=>queueRefresh(false,{target:copy(owner),serial,config:maintenanceConfiguration()});
  function adoptLatestReceipt(saved,{resetFloors=false}={}){
    // The repository has already confirmed this write. Adopt its exact result;
    // a separate display read must never turn that receipt into a save failure.
    readSerial++;lastReadView=null;selection=saved.selection;
    state={...selection.latest,status:'ready',error:'',floorStates:resetFloors?{}:state.floorStates};publish();
  }
  async function savePreferences(preferences){
    if(!target||!current(target))throw new Error('聊天已变化，请重新读取');
    if(Object.keys(preferences).some(key=>key!=='enabled'&&preferences[key]!==state.preferences[key]))latestEpoch++;
    const t=copy(target),ticket=serial,snapshot=await repository.captureLatest(t);
    const result=await repository.updateLatestPreferences(t,preferences,{expectedLatestRevision:snapshot.latest.revision,isCurrent:()=>current(t)&&ticket===serial});
    if(!current(t)||ticket!==serial)throw new Error('聊天已变化，请重新读取');
    adoptLatestReceipt(result,{resetFloors:true});return inspect();
  }
  async function clear(){
    if(!target||!current(target))throw new Error('聊天已变化，请重新读取');
    cancel();const t=copy(target),ticket=serial;
    const captured=await repository.captureLatest(t);
    const saved=await repository.updateLatest(t,captured,{...captured.latest,records:[]},{isCurrent:()=>current(t)&&ticket===serial});
    if(!current(t)||ticket!==serial)throw new Error('聊天已变化，请重新读取');
    selection=saved.selection;state={...selection.latest,status:'ready',error:'',floorStates:{}};publish();return inspect();
  }
  // Retry ownership is runtime-only and records the actual dispatched request.
  // Successful categories and separately issued failures must never be joined.
  const summaryValue=record=>record?{id:record.id,body:record.body,updatedAt:record.updatedAt}:null;
  function failedRetry(floor,options={},replyId){
    if(options.automatic||options.workshopOnly&&options.taskId!=='tracking')return null;
    try{
      const id=replyId??raw(target).messages.find(row=>row.floor===floor)?.replyId,owner=retryOwners.get(id);if(!owner)return null;
      const latest=owner.latest,tracking=owner.tracking,summaryFailed=state.floorStates[id]?.status==='failed'&&latest?.status==='failed',trackingFailed=trackingFloorStates[id]?.status==='failed'&&tracking?.status==='failed';
      const summaryUnchanged=equal(latest?.baseline,summaryValue(state.records.find(record=>record.sourceSnapshot.replyId===id)));
      const fromTracking=options.workshopOnly===true,requested=fromTracking?trackingFailed:summaryFailed;
      if(!requested)return null;
      const together=summaryFailed&&trackingFailed&&latest.requestId===tracking.requestId;
      return {summary:summaryFailed&&summaryUnchanged&&(!fromTracking||together),trackingKinds:trackingFailed&&(fromTracking||together)?[...tracking.kinds]:[],trackingReceipt:trackingFailed?tracking.receipt:null};
    }catch{return null;}
  }
  function retryLabel(replyId,options){const parts=failedRetry(null,options,replyId);return parts?.summary&&parts.trackingKinds.length?'重试摘要与追踪':parts&&(parts.summary||parts.trackingKinds.length)?'重试未完成项':null;}
  async function generate(floor,{automatic=false,expectedMessage=null,workshopOnly=false,taskId,automaticSummaryProof=null,automaticMasterProof=null,automaticScheduleProof=null,queuedSummary=null,retryParts=null}={}){
    const ticket=serial,controller=new AbortController(),requestId=crypto.randomUUID();let rawResponse=null,requestedTaskIds=[];jobs.add(controller);displayBatches.set(controller,{floor,ticket});let key=String(floor),t,latestTask=false,plan=null,trackingPlan=null,schedulePlan=null,preparationFailed=false,partialResults=false,skippedTasks=0,automaticReceiptKey=null,stage='preparation',firstFailure='',generationCurrent=null,originSource=null;
    const inputPair=snapshot=>snapshot.messages.filter(row=>row.floor===floor||row.floor===floor-1).map(({replyId,...row})=>row);
    const origin=getContext().chat?.[floor],originText=origin?.mes,originSwipe=origin?.swipe_id??0;
    const failure=(error,at=stage)=>{const message=safeFailure(error,at);firstFailure||=message;return message;};
    const report=(status,message)=>{if(automatic&&!disposed&&ticket===serial&&(!t||current(t))){automaticStatus(status,message,floor);if(automaticReceiptKey)automaticReceipts.set(automaticReceiptKey,copy(automaticState));}};
    const markTracking=(status,error='')=>{trackingFloorStates[key]={status,error};};
    const markSchedule=(status,error='')=>{scheduleFloorStates[key]={status,error};};
    const markWorkshop=(task,status,error='')=>{workshopFloorStates[key]??={};workshopFloorStates[key][task.module.id]={status,error};};
    try{
      t=await adapter.prepare();if(!allowed()||ticket!==serial||!current(t)){report('skipped','总开关未启用或聊天状态已变化，本轮未调用');return false;}
      const initialSource=raw(t);originSource=inputPair(initialSource);key=initialSource.messages.find(row=>row.floor===floor)?.replyId??key;
      if(expectedMessage&&getContext().chat?.[floor]!==expectedMessage)return false;
      if(automatic&&getControls?.()?.matches(automaticMasterProof)!==true){report('skipped','收到正文时的功能授权已失效，本轮未调用');return false;}
      await refresh();if(!allowed()||ticket!==serial||!current(t))return false;
      const captured=await repository.captureLatest(t),preferences=captured.latest.preferences,summaryEpoch=latestEpoch,summaryProof=automatic?automaticSummaryProof:getControls?.()?.capture('summary'),masterProof=automatic?automaticMasterProof:getControls?.()?.capture('enabled');
      const rawSource=raw(t);key=rawSource.messages.find(row=>row.floor===floor)?.replyId??key;
      stage='config';const preparation=()=>settings?.captureEventGeneration?.()??(getPreparationSettings??getGenerationSettings)(),preparationProof=preparation(),generation=preparationProof.generation??preparationProof;stage='preparation';
      latestTask=(retryParts?retryParts.summary:!workshopOnly)&&summaryMatches(summaryProof);
      const source=prepareLatestSource(rawSource,{floor,rules:generation.summaryCleaning.rules}),names=identities();
      displayBatches.set(controller,{floor,ticket,source});
      const valid=()=>{
        try{return allowed()&&getControls?.()?.matches(masterProof)===true&&!controller.signal.aborted&&ticket===serial&&current(t)&&equal(preparationProof,preparation())&&equal(names,identities())&&matchesBackgroundLatestSource(source,raw(t));}catch{return false;}
      };
      generationCurrent=valid;
      // Each API category owns its configuration proof. A missing or changed
      // route cannot invalidate otherwise authorized sibling-category work.
      const groupProof=group=>{
        const epoch=getGenerationSettings(group).epoch;
        return ()=>{try{return valid()&&getGenerationSettings(group).epoch===epoch;}catch{return false;}};
      };
      let latestCurrent=valid;
      const summaryEligible=()=>captured.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId)||!archivedFloor(t,floor);
      if(queuedSummary&&(queuedSummary.replyId!==source.replyId||!equal(queuedSummary.record,captured.latest.records.find(record=>record.sourceSnapshot.replyId===source.replyId)??null)))return false;
      const receiptKey=JSON.stringify([t,source.replyId,source.fingerprint]);
      if(automatic&&automaticReceipts.has(receiptKey)){automaticState=copy(automaticReceipts.get(receiptKey));publish();return false;}
      latestTask=(retryParts?retryParts.summary:!workshopOnly)&&summaryMatches(summaryProof)&&(!automatic||!captured.latest.records.some(record=>!record.stale&&record.sourceSnapshot.replyId===key&&matchesStoredLatestSource(record.sourceSnapshot,raw(t))));
      // A generated receipt is not success until this root read confirms it.
      if(retryParts?.trackingReceipt){
        const confirmed=await repository.captureTracking(t);if(!valid())return false;
        if(confirmed.tracking.snapshots.some(row=>row.id===retryParts.trackingReceipt.snapshotId)){
          retryParts={...retryParts,trackingKinds:retryParts.trackingKinds.filter(kind=>retryParts.trackingReceipt.failedKinds.includes(kind))};
          if(!retryParts.trackingKinds.length){markTracking('ready');const owner=retryOwners.get(key);if(owner?.tracking)owner.tracking.status='ready';}
        }
      }
      // Summary-only buttons retain their scope; completed replies share all
      // enabled tasks, while workshop retries can target one failed segment.
      if(!retryParts&&(automatic||workshopOnly)){
        try{plan=await workshopRuntime?.prepareBackground(t,source,{automatic,taskId});}
        catch(error){if(!valid())return false;preparationFailed=true;for(const module of workshopState?.modules??[])if(taskId===undefined||module.id===taskId)markWorkshop({module},'failed',failure(error));}
      }
      if(retryParts?retryParts.trackingKinds.length:automatic||workshopOnly){try{trackingPlan=await trackingRuntime?.prepareBackground(t,source,{automatic,taskId,categories:retryParts?.trackingKinds,rules:generation.summaryCleaning.rules,identities:names});}catch(error){if(!valid())return false;preparationFailed=true;markTracking('failed',failure(error));}}
      if(!retryParts&&(automatic||workshopOnly)){try{schedulePlan=await scheduleRuntime?.prepareBackground(t,source,{automatic,taskId,automaticProof:automaticScheduleProof,identities:names});}catch(error){if(!valid())return false;preparationFailed=true;markSchedule('failed',failure(error));}}
      let tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());
      for(const task of plan?.tasks??[])if(!task.instructions.trim()){preparationFailed=true;markWorkshop(task,'failed','请先填写该工坊条目的生成要求');}
      if(!latestTask&&!tasks.length&&!trackingPlan&&!schedulePlan){report(preparationFailed?'failed':'skipped',preparationFailed?`本轮准备失败：${firstFailure||'请检查生成要求'}`:'本轮没有可发送的任务，请检查功能开关、已有结果及生成要求');publish();return false;}
      if(!valid())return false;
      if(automatic){automaticReceiptKey=receiptKey;automaticReceipts.set(receiptKey,copy(automaticState));if(automaticReceipts.size>256)automaticReceipts.delete(automaticReceipts.keys().next().value);}
      if(latestTask){state.status='running';state.error='';state.floorStates[key]={status:'running',error:''};}
      for(const task of tasks)markWorkshop(task,'running');if(trackingPlan)markTracking('running');if(schedulePlan)markSchedule('running');publish();
      // Preparing another participant can yield. Only still-authorized
      // categories may be sent, even before there is a response to discard.
      latestTask=latestTask&&summaryMatches(summaryProof)&&summaryEligible();
      try{trackingPlan=await trackingRuntime?.filterBackgroundPlan(trackingPlan)??null;}
      catch(error){if(!valid())return false;preparationFailed=true;markTracking('failed',failure(error));trackingPlan=null;}
      if(plan&&workshopRuntime?.filterBackgroundPlan){
        try{plan=await workshopRuntime.filterBackgroundPlan(plan);tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());}
        catch(error){if(!valid())return false;preparationFailed=true;for(const task of tasks)markWorkshop(task,'failed',failure(error));tasks=[];}
      }
      latestTask=latestTask&&summaryMatches(summaryProof)&&summaryEligible();
      try{trackingPlan=await trackingRuntime?.filterBackgroundPlan(trackingPlan)??null;}
      catch(error){if(!valid())return false;preparationFailed=true;markTracking('failed',failure(error));trackingPlan=null;}
      try{schedulePlan=await scheduleRuntime?.filterBackgroundPlan(schedulePlan)??null;}
      catch(error){if(!valid())return false;preparationFailed=true;markSchedule('failed',failure(error));schedulePlan=null;}
      // The final authority read also yields. Recheck each participant's
      // captured control epoch without another await before dispatch.
      latestTask=latestTask&&summaryMatches(summaryProof)&&summaryEligible();
      if(workshopRuntime?.filterCurrentBackgroundPlan){
        try{plan=workshopRuntime.filterCurrentBackgroundPlan(plan);tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());}
        catch(error){if(!valid())return false;preparationFailed=true;for(const task of tasks)markWorkshop(task,'failed',failure(error));tasks=[];}
      }
      if(trackingRuntime?.filterCurrentBackgroundPlan){
        try{trackingPlan=trackingRuntime.filterCurrentBackgroundPlan(trackingPlan);}
        catch(error){if(!valid())return false;preparationFailed=true;markTracking('failed',failure(error));trackingPlan=null;}
      }
      if(scheduleRuntime?.filterCurrentBackgroundPlan){
        try{schedulePlan=scheduleRuntime.filterCurrentBackgroundPlan(schedulePlan);}
        catch(error){if(!valid())return false;preparationFailed=true;markSchedule('failed',failure(error));schedulePlan=null;}
      }
      if(!valid()||!latestTask&&!tasks.length&&!trackingPlan&&!schedulePlan)return false;
      const commonWorkshop=tasks.filter(task=>!hasWorkshopMaterials(task.module));
      const descriptors=[...(latestTask?[{id:'latest',name:'最新摘要',instructions:preferences.prompt}]:[]),...(trackingPlan?[trackingPlan.task]:[]),...(schedulePlan?[schedulePlan.task]:[])];
      requestedTaskIds=[...descriptors,...tasks].map(task=>task.id);
      if(latestTask||trackingPlan){
        const owner=retryOwners.get(key)??{};
        if(latestTask)owner.latest={requestId,status:'running',baseline:summaryValue(captured.latest.records.find(record=>record.sourceSnapshot.replyId===key))};
        if(trackingPlan)owner.tracking={requestId,status:'running',kinds:['items','npcs'].filter(kind=>trackingPlan.ticket?.preferences?.[`${kind}Enabled`]!==false)};
        retryOwners.set(key,owner);if(retryOwners.size>256)retryOwners.delete(retryOwners.keys().next().value);
      }
      const sharedRound=trackingPlan||schedulePlan;
      stage='request';const request=descriptors.length?(sharedRound?buildBackgroundRoundRequest({source,tasks:descriptors,identities:names}):buildLatestRequest({source,prompt:preferences.prompt,identities:names})):null;
      report('running','正在进行本轮自动生成');
      let segments=new Map();
      if(request){
        try{
          latestCurrent=groupProof('latest');
          const output=await provider.generateText({...request,signal:controller.signal,isCurrent:latestCurrent});
          if(!latestCurrent())throw new AiProviderError('cancelled');
          rawResponse=output.text;stage='parse';segments=sharedRound?parseBackgroundRoundResponse(output.text,descriptors):new Map([['latest',{text:output.text}]]);
        }catch(error){
          if(!tasks.length)throw error;
          if(!valid())return false;
          const message=failure(error,'request');segments=new Map(descriptors.map(task=>[task.id,{error:message}]));
        }
      }
      let successes=0;
      if(latestTask&&summaryMatches(summaryProof)&&summaryEligible()){
        try{
          stage='parse';const segment=segments.get('latest');if(segment.error){firstFailure||=`解析失败：${segment.error}`;throw new Error(segment.error);}stage='save';
          const latest=await repository.captureLatest(t);
          if(!valid())return false;if(!latestCurrent())throw new AiProviderError('cancelled');
          if(!summaryEligible())throw new Error('来源已归档，未新建摘要');
          if(!summaryMatches(summaryProof)||summaryEpoch!==latestEpoch||!equal(summarySettings(latest.latest.preferences),summarySettings(preferences)))throw new Error('最新摘要设置已变化，请重试');
          const previous=latest.latest.records.find(record=>record.sourceSnapshot.replyId===key),original=captured.latest.records.find(record=>record.sourceSnapshot.replyId===key),now=new Date().toISOString();
          if(!equal(previous??null,original??null))throw new Error('最新摘要已修改，请重新读取');
          await repository.upsertLatestRecord(t,latest,{id:previous?.id??crypto.randomUUID(),body:segment.text,sourceSnapshot:source,cleaningRules:normalizedRules(generation.summaryCleaning.rules),createdAt:previous?.createdAt??now,updatedAt:now},{isCurrent:()=>latestCurrent()&&summaryMatches(summaryProof)&&summaryEpoch===latestEpoch&&summaryEligible()});
          if(!valid())return false;if(!latestCurrent())throw new AiProviderError('cancelled');
          state.floorStates[key]={status:'ready',error:''};successes++;
        }catch(error){if(error?.code==='COMMIT_UNCONFIRMED')retainFailure({requestId,target:t,replyIds:[source.replyId],taskIds:requestedTaskIds,rawResponse,error:failure(error,'save')});if(!valid())return false;if(!summaryEligible()){state.floorStates[key]={status:'idle',error:''};skippedTasks++;}else{state.floorStates[key]={status:'failed',error:failure(error)};state.error=failure(error);}}
        publish();
      }else if(latestTask&&!summaryEligible()){state.floorStates[key]={status:'idle',error:''};skippedTasks++;}
      if(trackingPlan&&valid()){
        try{
          stage='parse';const segment=segments.get(trackingPlan.task.id);if(segment.error){firstFailure||=`解析失败：${segment.error}`;throw new Error(segment.error);}stage='save';
          const result=await trackingRuntime.saveBackgroundResult(trackingPlan,segment.text,{isCurrent:latestCurrent});
          if(!valid())return false;
          const errors=Object.entries(result.errors).filter(([,error])=>error).map(([kind,error])=>`${kind==='items'?'物品':'NPC'}：${error}`);
          if(retryOwners.get(key)?.tracking?.requestId===requestId)retryOwners.get(key).tracking.kinds=Object.entries(result.errors).filter(([,error])=>error).map(([kind])=>kind);
          if(result.skipped){markTracking('idle');skippedTasks++;}
          else{markTracking(errors.length?'failed':'ready',errors.join('；'));successes++;if(errors.length){partialResults=true;firstFailure||=errors.join('；');}}
          trackingState=await trackingRuntime.backgroundState(t);
        }catch(error){if(error?.code==='COMMIT_UNCONFIRMED'){const owner=retryOwners.get(key);if(owner?.tracking?.requestId===requestId&&error.trackingReceipt)owner.tracking.receipt=copy(error.trackingReceipt);if(ticket===serial&&current(t))markTracking('failed',failure(error));retainFailure({requestId,target:t,replyIds:[source.replyId],taskIds:requestedTaskIds,rawResponse,error:failure(error,'save')});}if(!valid())return false;markTracking('failed',failure(error));}
        publish();
      }
      if(schedulePlan&&valid()){
        try{
          stage='parse';const segment=segments.get(schedulePlan.task.id);if(segment.error){firstFailure||=`解析失败：${segment.error}`;throw new Error(segment.error);}stage='save';
          const result=await scheduleRuntime.saveBackgroundResult(schedulePlan,segment.text,{isCurrent:latestCurrent});
          if(!valid())return false;
          if(result.skipped){markSchedule('idle');skippedTasks++;}
          else{const errors=Object.values(result.errors??{}).filter(Boolean);markSchedule(errors.length?'failed':'ready',errors.join('；'));successes++;if(errors.length){partialResults=true;firstFailure||=errors.join('；');}}
          scheduleState=await scheduleRuntime.backgroundState(t);
        }catch(error){if(error?.code==='COMMIT_UNCONFIRMED')retainFailure({requestId,target:t,replyIds:[source.replyId],taskIds:requestedTaskIds,rawResponse,error:failure(error,'save')});if(!valid())return false;markSchedule('failed',failure(error));}
        publish();
      }
      let workshopSegments=new Map(),commonCurrent=valid,commonRawResponse=null;
      if(commonWorkshop.length){
        try{
          stage='config';commonCurrent=groupProof('workshop');
          const ownRequest=buildWorkshopRoundRequest({source,tasks:commonWorkshop,identities:names});
          stage='request';const output=await provider.generateText({...ownRequest,signal:controller.signal,isCurrent:commonCurrent});
          if(!commonCurrent())throw new AiProviderError('cancelled');
          commonRawResponse=output.text;workshopSegments=parseBackgroundRoundResponse(output.text,commonWorkshop);
          for(const [id,segment] of workshopSegments)if(segment.error)retainFailure({requestId:requestId+':workshop',target:t,replyIds:[source.replyId],taskIds:[id],rawResponse:output.text,error:segment.error});
        }catch(error){if(!valid())return false;const message=failure(error);workshopSegments=new Map(commonWorkshop.map(task=>[task.id,{error:message}]));}
      }
      for(const task of [...commonWorkshop,...tasks.filter(task=>hasWorkshopMaterials(task.module))]){
        if(!valid())return false;
        let taskRawResponse=commonRawResponse;
        try{
          let segment=workshopSegments.get(task.id),taskCurrent=commonCurrent;
          if(hasWorkshopMaterials(task.module)){
            const options=workshopMaterials(task.module),capture=()=>prepareWorkshopMaterials({module:task.module,source,raw:null,character:options.character?captureSingleCharacterCard(getContext()):null,userPersona:options.userPersona?captureCurrentUserPersona(getContext()):null,worldInfo:options.worldInfo?workshopSends.captureWorldInfo(source):undefined,history:options.history?(workshopSends.captureHistory(source)?.prepare(source)??{status:'unavailable',messages:[]}):undefined,recall:options.recalledMemory?workshopSends.capture(source):undefined}),prepared=capture();
            task.materials=prepared.materials;task.materialAvailability=prepared.availability;
            task.materialsCurrent=()=>{try{return equal(prepared,capture());}catch{return false;}};
            const refreshed=await workshopRuntime.filterBackgroundPlan({...plan,tasks:[task]});
            stage='config';const configured=groupProof('workshop');
            taskCurrent=()=>configured()&&workshopRuntime.moduleAllowed(task.module)&&task.materialsCurrent();
            if(!refreshed.tasks.length||!taskCurrent())throw new Error('工坊条目或生成资料已变化');
            const ownRequest=buildWorkshopRoundRequest({source,tasks:[task],identities:names,materials:{char:task.materials['角色资料'],user:task.materials['用户人设'],worldInfo:task.materials['世界书'],custom:task.materials['自定义补充资料'],recall:task.materials['本轮召回记忆'],history:task.materials['前情提要']}});
            stage='request';const ownOutput=await provider.generateText({...ownRequest,signal:controller.signal,isCurrent:taskCurrent});
            if(!taskCurrent())throw new Error('工坊条目或生成资料已变化');
            taskRawResponse=ownOutput.text;segment=parseBackgroundRoundResponse(ownOutput.text,[task]).get(task.id);
            if(segment.error)retainFailure({requestId:requestId+':'+task.id,target:t,replyIds:[source.replyId],taskIds:[task.id],rawResponse:ownOutput.text,error:segment.error});
          }
          stage='parse';if(!taskCurrent())throw new AiProviderError('cancelled');if(segment.error){firstFailure||=`解析失败：${segment.error}`;throw new Error(segment.error);}stage='save';
          await workshopRuntime.saveBackgroundResult(plan,task,segment.text,{isCurrent:taskCurrent});
          if(!valid())return false;
          markWorkshop(task,'ready');successes++;
          workshopState=await workshopRuntime.backgroundState(t);
        }catch(error){if(error?.code==='COMMIT_UNCONFIRMED')retainFailure({requestId:requestId+':'+task.id,target:t,replyIds:[source.replyId],taskIds:[task.id],rawResponse:taskRawResponse,error:failure(error,'save')});if(!valid())return false;markWorkshop(task,'failed',failure(error));}
        publish();
      }
      if(valid()){
        const latest=await repository.captureLatest(t);if(!valid())return false;
        selection=latest;state={...latest.latest,status:state.floorStates[key]?.status==='failed'?'failed':'ready',error:state.floorStates[key]?.error??'',floorStates:state.floorStates};publish();
      }
      const complete=successes===descriptors.length+tasks.length&&!preparationFailed&&!partialResults;
      if(!complete&&(!skippedTasks||firstFailure||partialResults)&&(state.floorStates[key]?.status==='failed'||trackingFloorStates[key]?.status==='failed'||scheduleFloorStates[key]?.status==='failed'))retainFailure({requestId,target:t,replyIds:[source.replyId],taskIds:descriptors.map(task=>task.id),rawResponse,error:firstFailure||'本轮部分任务结果未能保存'});
      report(complete?'succeeded':successes?'partial':skippedTasks&&!preparationFailed?'skipped':'failed',complete?'本轮自动生成已保存':successes?'本轮部分结果已保存，其余任务已取消或失败':skippedTasks&&!preparationFailed?'任务授权已变化，本轮结果未写入':`本轮自动生成失败：${firstFailure||'未收到可保存结果，请重试。'}`);
      return successes>0;
    }catch(error){
      if(!disposed&&ticket===serial&&(!t||current(t))){
        if(generationCurrent&&!generationCurrent()&&error?.code!=='COMMIT_UNCONFIRMED')return false;
        // Only preparation failures lack a frozen task's ownership guard.
        // Established tasks may finish against their original text after edits.
        if(!generationCurrent)try{if(originSource&&!equal(originSource,inputPair(raw(t))))return false;}catch{if(error?.code!=='COMMIT_UNCONFIRMED')return false;}
        const message=failure(error);
        retainFailure({requestId,target:t,replyIds:key?[key]:[],taskIds:requestedTaskIds,rawResponse,error:message});
        const hasSaved=state.floorStates[key]?.status==='ready'||trackingFloorStates[key]?.status==='ready'||scheduleFloorStates[key]?.status==='ready'||Object.values(workshopFloorStates[key]??{}).some(row=>row.status==='ready');
        report(hasSaved?'partial':'failed',hasSaved?'本轮部分结果已保存，后续处理失败':`本轮自动生成失败：${firstFailure||'未收到可保存结果，请重试。'}`);
        // refresh may create the reply UUID before preparation fails. Bind only
        // to the same reply version; a floor number is never an error owner.
        const messageNow=getContext().chat?.[floor];
        if(messageNow!==origin||!generationCurrent&&messageNow?.mes!==originText||(messageNow?.swipe_id??0)!==originSwipe)return false;
        if(generationCurrent){if(latestSourceMetadata(messageNow).replyId!==key)return false;}
        else try{key=t?raw(t).messages.find(row=>row.floor===floor)?.replyId:null;}catch{key=null;}
        if(!key)return false;
        if((latestTask||!retryParts&&!plan&&!workshopOnly&&summaryAllowed())&&state.floorStates[key]?.status!=='ready'){state.status='failed';state.error=message;state.floorStates[key]={status:'failed',error:message};}
        const affected=plan?.tasks??((!retryParts&&(automatic||workshopOnly))?workshopState?.modules.filter(module=>taskId===undefined||module.id===taskId).map(module=>({module}))??[]:[]);
        for(const task of affected)if(workshopFloorStates[key]?.[task.module.id]?.status!=='ready')markWorkshop(task,'failed',failure(error));
        if(trackingFloorStates[key]?.status!=='ready'&&(trackingPlan||((automatic||workshopOnly)&&(!taskId||taskId==='tracking')&&(getControls?.()?.allowed('item')||getControls?.()?.allowed('npc')))))markTracking('failed',failure(error));if(scheduleFloorStates[key]?.status!=='ready'&&(schedulePlan||((!retryParts&&(automatic||workshopOnly))&&(!taskId||taskId==='schedule_tracking')&&scheduleRuntime?.allowed?.())))markSchedule('failed',failure(error));publish();
      }
      return false;
    }finally{
      const owner=retryOwners.get(key);
      if(owner?.latest?.requestId===requestId)owner.latest.status=state.floorStates[key]?.status??'cancelled';
      if(owner?.tracking?.requestId===requestId)owner.tracking.status=trackingFloorStates[key]?.status??'cancelled';
      jobs.delete(controller);displayBatches.delete(controller);
      if(automatic&&['queued','running'].includes(automaticState.status))report('cancelled','来源或配置已变化，本轮结果未写入');
      if(!disposed&&ticket===serial){
        if(state.floorStates[key]?.status==='running'){state.floorStates[key]={status:'cancelled',error:'来源或配置已变化，结果未保存'};if(state.status==='running')state.status='ready';}
        for(const [id,value] of Object.entries(workshopFloorStates[key]??{}))if(value.status==='running')workshopFloorStates[key][id]={status:'cancelled',error:'来源或配置已变化，结果未保存'};if(trackingFloorStates[key]?.status==='running')markTracking('cancelled','来源或配置已变化，结果未保存');if(scheduleFloorStates[key]?.status==='running')markSchedule('cancelled','来源或配置已变化，结果未保存');publish();
      }
    }
  }
  function enqueueGeneration(floor,options){
    const ticket=serial,scope=JSON.stringify([ticket,floor]);if(queuedFloors.has(scope))return Promise.resolve(false);
    const retryParts=failedRetry(floor,options);if(retryParts){if(!retryParts.summary&&!retryParts.trackingKinds.length)return Promise.resolve(false);options={...options,retryParts};}
    if(!options.automatic&&(!options.workshopOnly||retryParts?.summary)){
      try{const replyId=raw(target).messages.find(row=>row.floor===floor)?.replyId;options={...options,queuedSummary:{replyId,record:copy(state.records.find(record=>record.sourceSnapshot.replyId===replyId)??null)}};}catch{return Promise.resolve(false);}
    }
    queuedFloors.add(scope);
    const work=generationQueue.catch(()=>{}).then(()=>ticket===serial?generate(floor,options):false);
    generationQueue=work;work.finally(()=>queuedFloors.delete(scope)).catch(()=>{});return work;
  }
  async function intercept(messages,_size,_abort,type='normal'){
    sendDiagnostics=[];
    if(!summaryAllowed()||!supported.has(type)||messages?.some(message=>String(message?.mes??message?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
    const t=repository.captureTarget(),ticket=serial,proof=getControls?.()?.capture('summary'),captured=await repository.captureLatest(t);
    if(!summaryMatches(proof)||ticket!==serial||!current(t))return;
    const source=raw(t),mapping=mapSummaryPromptFloors(messages,getContext().chat);if(!mapping){sendDiagnostics=[{reason:'source-mapping-unavailable'}];return;}
    const transformed=transformLatestMessages({messages,sourceMap:mapping,raw:source,diagnostics:sendDiagnostics,latest:{...captured.latest,preferences:{...captured.latest.preferences,enabled:true},records:captured.latest.records.filter(record=>!invalidatedFloors.has(record.sourceSnapshot.assistantFloor)&&!invalidatedFloors.has(record.sourceSnapshot.userFloor))}});
    if(!summaryMatches(proof)||ticket!==serial||!current(t)||!adapter.matchesChatSource(t,source))return;
    messages.splice(0,messages.length,...transformed);
  }
  function floorInfos(floors){
    const result=new Map();
    try{
      if(!target||!current(target)||!summaryAllowed())return result;
      const source=raw(target),byFloor=new Map(source.messages.map(row=>[row.floor,row])),records=new Map(pruneLatestRecords({schema:state.schema,revision:state.revision,preferences:state.preferences,records:state.records},source,{replyVersions:versions(),retainStale:true}).records.map(record=>[record.sourceSnapshot.replyId,record]));
      for(const floor of floors){
        const row=byFloor.get(floor);if(row?.role!=='assistant'||row.system||!row.replyId)continue;
        const candidate=records.get(row.replyId),snapshot=candidate?.sourceSnapshot;
        const subset={epoch:source.epoch,messages:snapshot?.rawMessages.map(item=>byFloor.get(item.floor)).filter(Boolean)??[]};
        const record=snapshot?.assistantFloor===floor?candidate:null,stale=!!record&&(record.stale===true||invalidatedFloors.has(snapshot.assistantFloor)||invalidatedFloors.has(snapshot.userFloor)||!matchesStoredLatestSource(snapshot,subset));
        result.set(floor,{floor,replyId:row.replyId,body:record?.body??'',batchRunning:[...displayBatches.values()].some(batch=>batch.floor===floor&&batch.ticket===serial),...(stale?{stale:true}:{}),...(state.floorStates[row.replyId]??{status:'idle',error:''}),retryLabel:retryLabel(row.replyId)});
      }
    }catch{/* A changing source cannot authorize a display. */}
    return result;
  }
  function floorInfo(floor){return floorInfos([floor]).get(floor)??null;}
  function workshopFloorInfos(floors,{includeIdle=false}={}){
    const result=new Map();
    try{
      if(!target||!current(target)||!allowed()||!workshopState&&!trackingState&&!scheduleState)return result;
      const source=raw(target),byFloor=new Map(source.messages.map(row=>[row.floor,row]));
      const trackingDisplay=trackingRuntime?.displayState(trackingState,source,[...invalidatedFloors]),scheduleDisplay=scheduleRuntime?.displayState(scheduleState,source,[...invalidatedFloors]);
      const modules=(workshopState?.modules??[]).filter(module=>workshopRuntime.moduleAllowed(module)),byReply=new Map();
      for(const record of workshopState?.selection.workshop.results??[]){
        if(record.generationSource!=='background'||!record.active||record.deleted)continue;
        const bucket=byReply.get(record.replyId)??new Map();bucket.set(record.moduleId,record);byReply.set(record.replyId,bucket);
      }
      for(const floor of floors){
        const row=byFloor.get(floor);if(row?.role!=='assistant'||row.system||!row.replyId)continue;
        const tasks=modules.map(module=>{
          const record=byReply.get(row.replyId)?.get(module.id),snapshot=record?.sourceSnapshot;
          const pair={epoch:source.epoch,messages:snapshot?.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])??[]};
          const valid=record&&!snapshot.rawMessages.some(item=>invalidatedFloors.has(item.floor))&&matchesStoredLatestSource(snapshot,pair);
          return {id:module.id,kind:'workshop',name:module.name,body:valid?resultText(record):'',...(workshopFloorStates[row.replyId]?.[module.id]??{status:'idle',error:''})};
        });
        tasks.push(...(trackingRuntime?.floorTasks(trackingDisplay,source,floor,row.replyId,trackingFloorStates[row.replyId]??{},{includeIdle})??[]).map(task=>({...task,retryLabel:retryLabel(row.replyId,{workshopOnly:true,taskId:'tracking'})})));
        tasks.push(...(scheduleRuntime?.floorTasks(scheduleDisplay,source,floor,row.replyId,scheduleFloorStates[row.replyId]??{},{includeIdle})??[]));
        if(tasks.length)result.set(floor,{floor,replyId:row.replyId,tasks,batchRunning:[...displayBatches.values()].some(batch=>batch.floor===floor&&batch.ticket===serial)});
      }
    }catch{/* Changing chat ownership cannot authorize a display. */}
    return result;
  }
  function workshopFloorInfo(floor,options={}){return workshopFloorInfos([floor],options).get(floor)??null;}
  const sameVersions=(left,right)=>left.length===right.length&&left.every((row,index)=>['replyId','floor','swipeId','text'].every(key=>row[key]===right[index][key]));
  function library(readView,verifiedSource){
    let rules=[];try{rules=settings?.captureEventGeneration?settings.captureEventGeneration().generation.summaryCleaning.rules:getGenerationSettings().summaryCleaning.rules;}catch{/* Saved facts do not require a model. */}
    const context=getContext(),processor=context?.streamingProcessor;
    const stream=JSON.stringify([(context.chat??[]).map(row=>[row?.gen_started??null,row?.gen_finished??null]),processor?[processor.messageId,processor.isFinished,processor.isStopped,!!processor.abortController?.signal?.aborted,processor.toolCalls?.length??0]:null]);
    const emptyResult=()=>({records:[],missing:[],running:[],currentRows:[],historyRecords:[],preferences:copy(state.preferences),target:copy(target),automatic:copy(automaticState),backfill:copy(backfillState),failureReports:copy(currentFailures())});
    if(!target||!current(target))return emptyResult();
    let result;
    try{
      let rootMatches=!!readView;
      if(!readView){
        if(libraryCache?.rootToken)rootMatches=adapter.matchesReadToken?.(target,libraryCache.rootToken)===true;
        else if(lastReadView&&repository.matchesPanelData(target,lastReadView)){readView=lastReadView;rootMatches=true;}
      }
      // These observations belong only to this synchronous display call.
      // Never carry a successful check across an await or into a write guard.
      const replyVersions=versions(),source=verifiedSource??(libraryCache&&matchesRaw(target,libraryCache.source)?libraryCache.source:null);
      const sameSource=libraryCache&&source&&(source===libraryCache.source||equal(source,libraryCache.source));
      if(libraryCache&&libraryCache.epoch===displayEpoch&&equal(rules,libraryCache.rules)&&stream===libraryCache.stream&&rootMatches&&(readView?libraryCache.readView===readView:!!libraryCache.rootToken)&&sameSource&&sameVersions(replyVersions,libraryCache.versions))return copy(libraryCache.result);
      result=emptyResult();
      const cleaningRules=rules,rootToken=readView?null:rootMatches?libraryCache.rootToken:adapter.captureReadToken?.(target),currentSource=source??raw(target);
      const retainedSource=raw(target,true),matcher=createStoredLatestSourceMatcher(currentSource),archived=latestArchivedFloors(readView?repository.readPanelRoot(target,readView):adapter.peekConfirmed(target),retainedSource),byReply=new Map(pruneLatestRecords({schema:state.schema,revision:state.revision,preferences:state.preferences,records:state.records},retainedSource,{replyVersions,retainStale:true}).records.map(row=>[row.sourceSnapshot.replyId,row]));
      for(const row of retainedSource.messages){
        if(row.role!=='assistant'||row.system||!row.replyId||!row.text.trim())continue;
        const hostMessage=getContext().chat?.[row.floor];
        if(hostMessage?.gen_started&&!hostMessage?.gen_finished)continue;
        if(processor&&processor.messageId===row.floor&&(processor.isFinished!==true||processor.isStopped===true||processor.abortController?.signal?.aborted||processor.toolCalls?.length))continue;
        const record=byReply.get(row.replyId),snapshot=record?.sourceSnapshot,run=state.floorStates[row.replyId]??{status:'idle',error:''};
        const valid=record&&!record.stale&&!snapshot.rawMessages.some(item=>invalidatedFloors.has(item.floor))&&matcher.matches(snapshot);
        const nativeHidden=hostMessage?.is_system===true;
        const entry=record?{id:record.id,floor:row.floor,replyId:row.replyId,body:record.body,edited:record.edited===true,manual:record.sourceSnapshot.manual===true,...(!valid&&!nativeHidden?{stale:true}:{}),nativeHidden,status:run.status,error:run.error??'',retryLabel:retryLabel(row.replyId)}:{floor:row.floor,replyId:row.replyId,nativeHidden,status:run.status,error:run.error??'',retryLabel:retryLabel(row.replyId)};
        if(record)result.records.push(entry);
        if(archived.has(row.floor)){if(record)result.historyRecords.push(entry);continue;}
        if(nativeHidden){result.currentRows.push(entry);continue;}
        if(!record)entry.sourceProof=prepareManualLatestSource({epoch:currentSource.epoch,messages:[row]},{floor:row.floor});
        if(run.status==='running')result.running.push(entry);
        else if(!record&&cleanSummaryFloors([row],{includeUser:true,rules:cleaningRules}).length)result.missing.push(entry);
        if(record||run.status==='running'||result.missing.at(-1)===entry)result.currentRows.push(entry);
      }
      result.records.sort((a,b)=>a.floor-b.floor);result.currentRows.sort((a,b)=>a.floor-b.floor);result.historyRecords.sort((a,b)=>a.floor-b.floor);
      if(rootToken||readView)libraryCache={epoch:displayEpoch,readView,rootToken,source:currentSource,rules:copy(rules),stream,versions:replyVersions,result:copy(result)};
    }catch{/* Pending host persistence cannot authorize guessed source rows. */}
    return result??emptyResult();
  }
  async function manualRecord(floor,body,{original}={}){
    if(!target||!current(target)||!summaryAllowed())throw new Error('最新摘要已关闭或聊天已变化');
    if(typeof body!=='string'||!body.trim())throw new Error('最新摘要正文不能为空');
    const t=copy(target),ticket=serial,proof=getControls?.()?.capture('summary');
    const listing=library(),row=[...listing.missing,...listing.running].find(row=>row.floor===floor);
    if(!row||!original||original.replyId!==row.replyId||!equal(original.sourceProof,row.sourceProof))throw new Error('回复版本已变化，请重新打开补录');
    const source=copy(row.sourceProof),valid=()=>current(t)&&ticket===serial&&summaryMatches(proof)&&matchesLatestSource(source,raw(t))&&!archivedFloor(t,floor);
    const captured=await repository.captureLatest(t);
    if(!valid()||captured.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId))throw new Error('该回复已有摘要或来源已变化，请重新读取');
    const now=new Date().toISOString();
    const saved=await repository.upsertLatestRecord(t,captured,{id:crypto.randomUUID(),body:body.trim(),edited:true,sourceSnapshot:source,createdAt:now,updatedAt:now},{isCurrent:valid});
    if(!valid())throw new Error('摘要已保存，但聊天来源已变化，请重新读取');
    if(retryOwners.get(source.replyId))delete retryOwners.get(source.replyId).latest;state.floorStates[source.replyId]={status:'ready',error:''};
    adoptLatestReceipt(saved);return library();
  }
  function backfillPlan(range){
    const {start=0,end=Number.MAX_SAFE_INTEGER}=range??{};
    if(!target||!current(target)||!summaryAllowed())throw new Error('最新摘要已关闭或聊天已变化');
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw new Error('请输入有效的起止楼层');
    const source=raw(target),rules=cleaningRules(),missing=library().missing,byFloor=new Map(source.messages.map(row=>[row.floor,row]));
    const sources=missing.filter(row=>row.floor>=start&&row.floor<=end).map(row=>prepareLatestSource({epoch:source.epoch,messages:[byFloor.get(row.floor-1),byFloor.get(row.floor)].filter(Boolean)},{floor:row.floor,rules}));
    return {...planLatestBackfill({sources,prompt:state.preferences.prompt,identities:identities()}),rules};
  }
  function estimateBackfill(range){const {count,calls,oversized}=backfillPlan(range);return {count,calls,oversized};}
  function resetBackfill(){backfillState={status:'idle',id:null,total:0,completed:0,skipped:0,failed:0,error:''};backfillController=null;}
  function stopBackfill(){
    if(!['queued','running'].includes(backfillState.status))return;
    backfillController?.abort();backfillState={...backfillState,status:'cancelled',error:'补缺已停止，已保存的摘要保留'};publish();
  }
  function startBackfill(range){
    if(['queued','running'].includes(backfillState.status))throw new Error('摘要补缺正在进行');
    const plan=backfillPlan(range),t=copy(target),ticket=serial,proof=getControls?.()?.capture('summary'),epoch=latestEpoch;
    const generation=getGenerationSettings(),frozenRaw=raw(t),prompt=state.preferences.prompt,names=identities(),id=crypto.randomUUID(),controller=new AbortController();
    backfillController=controller;jobs.add(controller);displayBatches.set(controller,{ticket,sources:plan.batches.flat()});
    backfillState={status:'queued',id,total:plan.count,completed:0,skipped:0,failed:0,error:plan.oversized.length?`以下楼层超过字符保护预算，未加入请求：${plan.oversized.join('、')}`:''};publish();
    const sameStructure=()=>{const live=raw(t),byFloor=new Map(live.messages.map(row=>[row.floor,row]));return live.messages.length===frozenRaw.messages.length&&frozenRaw.messages.every(saved=>{const message=byFloor.get(saved.floor);return message&&['floor','identity','role','system','date','replyId','objectTicket','specialPayload','swipeId'].every(key=>message[key]===saved[key]);});};
    const valid=()=>{try{return !controller.signal.aborted&&backfillState.id===id&&ticket===serial&&current(t)&&summaryMatches(proof)&&epoch===latestEpoch&&getGenerationSettings().epoch===generation.epoch&&equal(names,identities())&&sameStructure();}catch{return false;}};
    const archivedNow=source=>archivedFloor(t,source.assistantFloor);
    const skipArchived=source=>{state.floorStates[source.replyId]={status:'idle',error:''};backfillState={...backfillState,skipped:backfillState.skipped+1};};
    const execute=async()=>{
      if(!valid()){jobs.delete(controller);displayBatches.delete(controller);if(backfillController===controller)backfillController=null;if(backfillState.id===id&&backfillState.status==='queued'){backfillState={...backfillState,status:'cancelled',error:'来源或配置已变化，补缺未开始'};publish();}return library();}
      backfillState={...backfillState,status:'running'};publish();
      try{
        for(const planned of plan.batches){
          if(!valid())break;
          const captured=await repository.captureLatest(t);if(!valid())break;
          const currentMissing=new Set(library().missing.map(row=>row.replyId));
          const sources=planned.filter(source=>currentMissing.has(source.replyId)&&!captured.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId)&&matchesBackgroundLatestSource(source,raw(t)));
          backfillState={...backfillState,skipped:backfillState.skipped+planned.length-sources.length};
          if(!sources.length){publish();continue;}
          for(const source of sources){if(retryOwners.get(source.replyId))delete retryOwners.get(source.replyId).latest;state.floorStates[source.replyId]={status:'running',error:''};}publish();
          let parsed,batchResponse=null;const batchRequestId=crypto.randomUUID();
          try{
            const request=buildLatestBackfillRequest({sources,prompt,identities:names});
            const output=await provider.generateText({...request,signal:controller.signal,isCurrent:()=>valid()&&sources.every(source=>matchesBackgroundLatestSource(source,raw(t)))});
            if(!valid())break;
            batchResponse=output.text;
            parsed=parseLatestBackfillResponse(output.text,sources);
          }catch(error){
            if(!valid())break;
            parsed=new Map(sources.map(source=>[source.replyId,{error:error.message}]));
          }
          for(const source of sources){
            if(!valid())break;
            try{
              if(archivedNow(source)){skipArchived(source);continue;}
              const segment=parsed.get(source.replyId);if(!segment||segment.error)throw new Error(segment?.error??'未收到该楼层的摘要');
              if(!matchesBackgroundLatestSource(source,raw(t)))throw new Error('回复来源已变化，结果未保存');
              const latest=await repository.captureLatest(t);if(!valid())break;
              // A manual save or another authorized producer always wins over
              // this missing-only operation, including stale saved records.
              if(latest.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId)){state.floorStates[source.replyId]={status:'ready',error:''};backfillState={...backfillState,skipped:backfillState.skipped+1};publish();continue;}
              const now=new Date().toISOString();
              const saved=await repository.upsertLatestRecord(t,latest,{id:crypto.randomUUID(),body:segment.text,sourceSnapshot:source,cleaningRules:plan.rules,createdAt:now,updatedAt:now},{isCurrent:()=>valid()&&matchesBackgroundLatestSource(source,raw(t))&&!archivedNow(source)});
              if(!valid())break;
              selection=saved.selection;state={...selection.latest,status:'ready',error:'',floorStates:state.floorStates};
              state.floorStates[source.replyId]={status:'ready',error:''};backfillState={...backfillState,completed:backfillState.completed+1};
            }catch(error){
              // Unconfirmed persistence is not ordinary source cancellation.
              // Preserve this error even after the adapter revokes authority.
              if(error.code==='COMMIT_UNCONFIRMED'){retainFailure({requestId:batchRequestId,target:t,replyIds:sources.map(row=>row.replyId),taskIds:['latest.backfill'],rawResponse:batchResponse,error:error.message});throw error;}
              if(!valid())break;
              if(archivedNow(source)){skipArchived(source);continue;}
              retainFailure({requestId:batchRequestId,target:t,replyIds:sources.map(row=>row.replyId),taskIds:['latest.backfill'],rawResponse:batchResponse,error:`${source.replyId}：${error.message}`});
              state.floorStates[source.replyId]={status:'failed',error:error.message};backfillState={...backfillState,failed:backfillState.failed+1};
            }
            publish();
          }
        }
        if(valid())backfillState={...backfillState,status:backfillState.failed?'partial':'succeeded'};
      }catch(error){
        if(error.code==='COMMIT_UNCONFIRMED'){
          if(ticket===serial&&backfillState.id===id)backfillState={...backfillState,status:'failed',error:error.message};
          throw error;
        }
        if(valid())backfillState={...backfillState,status:'failed',error:error.message};
      }
      finally{
        jobs.delete(controller);displayBatches.delete(controller);if(backfillController===controller)backfillController=null;
        if(backfillState.id===id){
          if(['queued','running'].includes(backfillState.status))backfillState={...backfillState,status:'cancelled',error:'来源或配置已变化，补缺已停止'};
          for(const source of plan.batches.flat())if(state.floorStates[source.replyId]?.status==='running')state.floorStates[source.replyId]={status:'cancelled',error:'补缺已停止，已保存的摘要保留'};
          publish();
        }
      }
      return library();
    };
    const work=generationQueue.catch(()=>{}).then(execute);generationQueue=work;return work;
  }
  async function editRecord(id,body,{original}={}){
    if(!target||!current(target)||!summaryAllowed())throw new Error('最新摘要已关闭或聊天已变化');
    const t=copy(target),ticket=serial,proof=getControls?.()?.capture('summary'),captured=await repository.captureLatest(t),record=captured.latest.records.find(row=>row.id===id);
    if(!record||!library().records.some(row=>row.id===id&&!row.nativeHidden)||(original&&(original.body!==record.body||original.replyId!==undefined&&original.replyId!==record.sourceSnapshot.replyId)))throw new Error('摘要或回复版本已变化，请重新读取');
    const source=raw(t),valid=()=>current(t)&&ticket===serial&&summaryMatches(proof)&&adapter.matchesChatSource(t,source)&&pruneLatestRecords(captured.latest,raw(t,true),{replyVersions:versions(),retainStale:true}).records.some(row=>row.id===id);
    if(!valid())throw new Error('摘要来源已变化');
    const saved=await repository.editLatestRecord(t,captured,id,body,{isCurrent:valid});
    if(!valid())throw new Error('摘要已保存，但聊天来源已变化，请重新读取');if(retryOwners.get(record.sourceSnapshot.replyId))delete retryOwners.get(record.sourceSnapshot.replyId).latest;state.floorStates[record.sourceSnapshot.replyId]={status:'ready',error:''};adoptLatestReceipt(saved);return library();
  }


  const context=getContext(),events=context?.eventSource;
  const on=(name,listener)=>{const type=context?.eventTypes?.[name];if(!type||!events?.on)return;events.on(type,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,type,listener));};
  function completedStream(floor,processor=getContext()?.streamingProcessor){
    if(!processor||Number.isSafeInteger(processor.messageId)&&processor.messageId!==floor)return true;
    return processor.isFinished===true&&processor.isStopped!==true&&!processor.abortController?.signal?.aborted&&!(processor.toolCalls?.length);
  }
  // A queued automatic task keeps the authorization at reply receipt; a later
  // toggle must not backfill replies received while the feature was disabled.
  function flushReceipt(){
    const complete=receipt;if(!complete||foregroundStopped)return;
    if(!foregroundEnded){automaticStatus('waiting','已收到正文，等待宿主生成结束信号',complete.floor);return;}
    if(!completedStream(complete.floor,complete.processor)){automaticStatus('waiting','等待正文成功完成；中断或失败的正文不会自动生成',complete.floor);return;}
    workshopSends.receive({...complete,type:foregroundType});receipt=null;foregroundType=null;if(current(complete.target)){if(automaticState.floor!==complete.floor||!['running','succeeded','partial','failed','skipped','cancelled'].includes(automaticState.status))automaticStatus('queued','正文已完成，正在准备本轮自动生成',complete.floor);void enqueueGeneration(complete.floor,{automatic:true,expectedMessage:complete.message,automaticSummaryProof:complete.summaryProof,automaticMasterProof:complete.masterProof,automaticScheduleProof:complete.scheduleProof});}
  }
  on('GENERATION_STARTED',(type,_options,dryRun)=>{
    if(dryRun)return;const normalized=type===undefined?'normal':type;
    if(!supported.has(normalized)&&normalized!=='quiet'){activeHostGenerations++;workshopSends.blockWorldInfo();return;}
    const overlap=activeHostGenerations>0;activeHostGenerations++;
    if(overlap||normalized==='quiet')workshopSends.blockWorldInfo();
    if(supported.has(normalized)){cancel();workshopSends.begin(normalized,{worldInfoAmbiguous:overlap});foregroundStopped=false;foregroundType=normalized;automaticStatus('waiting','等待本轮正文完成',null);}
  });
  on('WORLD_INFO_ACTIVATED',entries=>workshopSends.observeWorldInfo(entries));
  on('GENERATION_ENDED',()=>{workshopSends.closeWorldInfoWindow();activeHostGenerations=Math.max(0,activeHostGenerations-1);});
  on('GENERATION_STOPPED',()=>{activeHostGenerations=0;foregroundStopped=true;cancel();});
  on('MESSAGE_RECEIVED',(floor,type)=>{
    const normalized=type==='appendFinal'&&foregroundType==='continue'?'continue':type===undefined&&foregroundType==='normal'?'normal':type;
    if(foregroundStopped||!supported.has(normalized)||!Number.isSafeInteger(floor))return;
    try{const message=getContext().chat?.[floor];if(message?.is_user===false&&!message.is_system){receipt={floor,message,processor:getContext()?.streamingProcessor??null,target:repository.captureTarget(),summaryProof:summaryAllowed()?getControls?.()?.capture('summary'):null,masterProof:allowed()?getControls?.()?.capture('enabled'):null,scheduleProof:scheduleRuntime?.captureAutomaticProof?.()??null};flushReceipt();}}catch{/* no chat */}
  });
  // ST streaming ends its UI before MESSAGE_RECEIVED; non-streaming reverses
  // this order. Both receipts are required, with successful-stream evidence.
  on('GENERATION_ENDED',()=>{foregroundEnded=true;if(!receipt&&automaticState.status==='waiting')automaticStatus('waiting','已收到结束信号，等待宿主正文回执');flushReceipt();});
  for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED'])on(name,()=>{
    publish();if(pending){displayReadDirty=true;return;}void refresh().catch(()=>{});
  });
  for(const name of ['MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED'])on(name,payload=>{const floor=typeof payload==='number'?payload:payload?.messageId??payload?.mesId??payload?.index;if(!jobs.size||[...displayBatches.values()].some(batch=>{const sources=batch.sources??(batch.source?[batch.source]:[]);return !sources.length||sources.some(source=>name==='MESSAGE_SWIPED'&&(!Number.isSafeInteger(floor)||floor===source.assistantFloor)||!matchesBackgroundLatestSource(source,raw(target)));}))cancel();publish();void refresh().catch(()=>{});});
  for(const name of ['CHAT_CHANGED','CHAT_CREATED'])on(name,()=>{activeHostGenerations=0;cancel();resetBackfill();readSerial++;invalidatedFloors.clear();target=null;selection=null;state={...emptyLatest(),status:'idle',error:'',floorStates:{}};workshopState=null;workshopFloorStates={};trackingState=null;trackingFloorStates={};scheduleState=null;scheduleFloorStates={};scheduleRuntime?.reset?.();automaticReceipts.clear();automaticState={status:'idle',message:'尚未收到新一轮正文生成信号',floor:null};publish();void refresh().catch(()=>{});});
  let displayReadQueued=false;
  const updateWorkshopDisplay=()=>{if(disposed||!initialized)return;if(pending){displayReadDirty=true;return;}if(displayReadQueued)return;displayReadQueued=true;queueMicrotask(()=>{displayReadQueued=false;if(!disposed){if(pending)displayReadDirty=true;else void read().catch(()=>{});}});};
  if(workshopRuntime?.subscribe)releases.push(workshopRuntime.subscribe(updateWorkshopDisplay));
  if(trackingRuntime?.subscribe)releases.push(trackingRuntime.subscribe((_state,change)=>{if(change?.displayChanged!==false)updateWorkshopDisplay();}));
  if(scheduleRuntime?.subscribe)releases.push(scheduleRuntime.subscribe(updateWorkshopDisplay));
  if((workshopRuntime||trackingRuntime||scheduleRuntime)&&adapter.subscribe)releases.push(adapter.subscribe(updateWorkshopDisplay));
  if(settings?.subscribe&&settings.captureEventGeneration){
    let displayedRules,authorityLost=false;
    try{displayedRules=settings.captureEventGeneration().generation.summaryCleaning.rules;}catch{/* Wait for confirmed rules. */}
    releases.push(settings.subscribe(notice=>{
      if(notice?.confirmed===false){authorityLost=true;return;}
      let next;try{next=settings.captureEventGeneration().generation.summaryCleaning.rules;}catch{authorityLost=true;return;}
      const unchanged=displayedRules&&equal(displayedRules,next),restored=authorityLost;displayedRules=next;authorityLost=false;
      if(restored){settingsRecoveryEpoch++;if(displayRecoveryEpoch!==null&&!pending)updateWorkshopDisplay();}
      // Cleaning changes affect the projection, not the saved chat records.
      // Publish directly instead of using an unrelated workshop reread.
      // A DOM refresh during staging may have hidden cards whose settings
      // were unavailable. Restore those cards even when their rules match.
      if(!unchanged||restored)publish();
    }));
  }
  // Never generate on initial load, enabling, edits, or selecting old swipes.
  if(autoInitialize)void refresh().catch(()=>{});
  function captureFloorDisplayProof(floor){const chat=getContext()?.chat,message=chat?.[floor];if(!target||!current(target)||!message||message.is_user||message.is_system||!message.extra?.[WORKSHOP_REPLY_KEY])return null;return {floor,chat,message,text:message.mes,name:message.name,type:message.extra?.type,swipe:message.swipe_id,replyId:message.extra[WORKSHOP_REPLY_KEY],epoch:displayEpoch,target:copy(target)};}
  function matchesFloorDisplayProof(proof,{ignoreEpoch=false}={}){try{const chat=getContext()?.chat,message=chat?.[proof?.floor];return !!proof&&!disposed&&current(proof.target)&&chat===proof.chat&&message===proof.message&&message.mes===proof.text&&message.name===proof.name&&message.extra?.type===proof.type&&message.swipe_id===proof.swipe&&message.extra?.[WORKSHOP_REPLY_KEY]===proof.replyId&&!message.is_user&&!message.is_system&&(ignoreEpoch||displayEpoch===proof.epoch);}catch{return false;}}
  return {captureFloorDisplayProof,matchesFloorDisplayProof,inspect,read,savePreferences,clear,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},defaultPrompt:DEFAULT_LATEST_PROMPT,
    observeVisibility(options){
      const off=adapter.observeSourceVisibility?.(change=>{if(disposed)return;if(change?.visibilityChanged!==false)cancel();else publish();},options)??(()=>{});
      const stop=()=>{off();visibilityReleases.delete(stop);};visibilityReleases.add(stop);return stop;
    },
    library:()=>library(),projectPanel(readView,{target:owner=target,source}={}){
      if(!readView||!sameTarget(owner,target)||!current(target)||!repository.matchesPanelData(target,readView)||source&&!matchesRaw(target,source))return null;
      return library(readView,source);
    },editRecord,manualRecord,estimateBackfill,startBackfill,stopBackfill,generate:(floor,options={})=>enqueueGeneration(floor,{workshopOnly:options.workshopOnly===true,...(typeof options.taskId==='string'?{taskId:options.taskId}:{})}),intercept,floorInfo,floorInfos,workshopFloorInfo,workshopFloorInfos,refresh,ensureData,prepareSend,panelReadView:()=>lastReadView,matchesSource:(t,proof)=>matchesRaw(t,proof),captureSource:(t=target)=>raw(t),
    replaceWorkshopSend:()=>workshopSends.replace(),sealWorkshopSend:(type,injection,history)=>workshopSends.seal(type,injection,history),invalidateWorkshopSend:()=>workshopSends.clear(),
    setEnabled(value){enabled=!!value;if(!enabled)cancel();publish();},
    dispose(){if(disposed)return;for(const stop of [...visibilityReleases])stop();cancel();disposed=true;readSerial++;for(const release of releases)release();listeners.clear();}};
}
