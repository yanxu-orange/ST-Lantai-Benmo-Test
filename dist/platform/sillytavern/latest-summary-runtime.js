import {latestArchivedFloors} from '../../domain/latest/coverage.js';
import {cleanSummaryFloors,createDefaultCleaningRules,normalizeCleaningRule} from '../../domain/summary/cleaning.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {DEFAULT_LATEST_PROMPT,emptyLatest,pruneLatestRecords} from '../../domain/latest/data.js';
import {prepareLatestSource,prepareManualLatestSource,storedLatestSource,matchesLatestSource,matchesStoredLatestSource} from '../../domain/latest/source.js';
import {buildLatestRequest} from '../../domain/latest/requests.js';
import {planLatestBackfill,buildLatestBackfillRequest,parseLatestBackfillResponse} from '../../domain/latest/backfill.js';
import {buildBackgroundRoundRequest,parseBackgroundRoundResponse} from '../../domain/background/round.js';
import {resultText} from '../../domain/workshop/results.js';
import {transformLatestMessages} from '../../domain/latest/transform.js';
import {prepareWorkshopIdentities,WORKSHOP_REPLY_KEY} from './workshop-identities.js';
import {mapSummaryPromptFloors} from './summary-history.js';

const copy=value=>structuredClone(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const summarySettings=({enabled,...preferences})=>preferences;
const normalizedRules=rules=>(rules??createDefaultCleaningRules()).map(normalizeCleaningRule);
const supported=new Set(['normal','regenerate','swipe','continue']);
const specialKeys=['reasoning','reasoning_content','thinking','tool_calls','function_call','tool_invocations','image','images','media','file','files','attachments','audio','video'];
const present=value=>value!==undefined&&value!==null&&value!==false&&value!==''&&(!Array.isArray(value)||value.length>0);
const special=message=>specialKeys.some(key=>present(message?.[key])||present(message?.extra?.[key]))||present(message?.extra?.type);
const pendingProjection=message=>{
  const slot=message?.swipe_info?.[message.swipe_id??0]?.extra?.[WORKSHOP_REPLY_KEY],active=message?.extra?.[WORKSHOP_REPLY_KEY];
  return typeof slot==='string'&&!!slot&&typeof active==='string'&&!!active&&slot!==active;
};
// Latest owns neither provider configuration nor event/ancient summary progress.
export function createLatestSummaryRuntime({repository,adapter,settings,provider,getGenerationSettings,getContext,getControls,workshopRuntime,trackingRuntime}={}) {
  let latestEpoch=0,disposed=false,serial=0,readSerial=0,target=null,selection=null,pending=null,receipt=null,enabled=true,generationQueue=Promise.resolve(),foregroundStopped=false,foregroundType=null,foregroundEnded=false;
  let workshopState=null,workshopFloorStates={},trackingState=null,trackingFloorStates={};
  const automaticReceipts=new Map();
  let state={...emptyLatest(),status:'idle',error:'',floorStates:{}};
  let backfillState={status:'idle',id:null,total:0,completed:0,skipped:0,failed:0,error:''},backfillController=null;
  let automaticState={status:'idle',message:'尚未收到新一轮正文生成信号',floor:null};
  const listeners=new Set(),visibilityReleases=new Set(),releases=[],jobs=new Set(),queuedFloors=new Set(),invalidatedFloors=new Set();
  const allowed=()=>!disposed&&enabled&&getControls?.()?.allowed('enabled')===true;
  const summaryAllowed=()=>allowed()&&getControls?.()?.allowed('summary')===true;
  const summaryMatches=proof=>summaryAllowed()&&getControls?.()?.matches(proof)===true;
  const current=t=>{try{return !disposed&&sameTarget(t,repository.captureTarget());}catch{return false;}};
  const publish=()=>{for(const listener of listeners)try{listener(inspect());}catch{/* UI cannot break a write. */}};
  function inspect(){return copy({...state,target,automatic:automaticState,backfill:backfillState});}
  function automaticStatus(status,message,floor=automaticState.floor){automaticState={status,message,floor};publish();}
  function cancel(){stopBackfill();for(const [key,value] of automaticReceipts)if(['queued','running'].includes(value.status))automaticReceipts.set(key,{...value,status:'cancelled',message:'本轮自动生成已取消，未自动重试'});if(['waiting','queued','running'].includes(automaticState.status))automaticState={...automaticState,status:'cancelled',message:'本轮自动生成已取消，未自动重试'};serial++;foregroundType=null;for(const [key,value] of Object.entries(trackingFloorStates))if(value.status==='running')trackingFloorStates[key]={status:'idle',error:''};for(const tasks of Object.values(workshopFloorStates))for(const [key,value] of Object.entries(tasks))if(value.status==='running')tasks[key]={status:'idle',error:''};receipt=null;foregroundEnded=false;generationQueue=Promise.resolve();queuedFloors.clear();for(const job of jobs)job.abort();jobs.clear();for(const [key,value] of Object.entries(state.floorStates))if(value.status==='running')state.floorStates[key]={status:'idle',error:''};if(state.status==='running')state.status='ready';publish();}
  function raw(t,retention=false){
    const snapshot=retention&&adapter.captureLatestRetentionSource?adapter.captureLatestRetentionSource(t):adapter.captureChatSource(t),chat=getContext().chat;
    snapshot.messages=snapshot.messages.map(item=>{
      const message=chat[item.floor],swipes=message?.swipes,current=message?.swipe_id??0;
      // New swipes first have no slot. Deletion changes the selected slot before
      // syncSwipeToMes updates mes/extra. Neither stale projection owns a reply.
      const pending=Array.isArray(swipes)&&swipes.length&&typeof swipes[current]!=='string'||pendingProjection(message);
      return {...item,replyId:pending?null:message?.extra?.[WORKSHOP_REPLY_KEY]??null,specialPayload:!!special(message)};
    });
    return snapshot;
  }
  const archivedFloor=(t,floor)=>latestArchivedFloors(adapter.peekConfirmed(t),raw(t,true)).has(floor);
  function cleaningRules(){const generation=settings?.captureEventGeneration?settings.captureEventGeneration().generation:getGenerationSettings();return normalizedRules(generation.summaryCleaning?.rules);}
  function versions(){return (getContext().chat??[]).flatMap((message,floor)=>{
    if(message?.is_user!==false||typeof message.mes!=='string')return [];
    const swipes=Array.isArray(message.swipes)&&message.swipes.length?message.swipes:[message.mes];
    return swipes.map((text,swipeId)=>({replyId:message.swipe_info?.[swipeId]?.extra?.[WORKSHOP_REPLY_KEY]??((message.swipe_id??0)===swipeId?message.extra?.[WORKSHOP_REPLY_KEY]:null),floor,swipeId,text})).filter(item=>item.replyId);
  });}
  workshopRuntime?.setBackgroundSourceReader?.(t=>({...raw(t),invalidatedFloors:[...invalidatedFloors]}));
  async function read(){
    const token=++readSerial,t=await adapter.prepare();
    const captured=await repository.captureLatest(t),workshop=await workshopRuntime?.backgroundState(t),tracking=await trackingRuntime?.backgroundState(t);
    if(disposed||token!==readSerial||!current(t))return inspect();
    if(target&&!sameTarget(target,t)){cancel();resetBackfill();state.floorStates={};invalidatedFloors.clear();}
    target=t;selection=captured;workshopState=workshop??null;trackingState=tracking??null;state={...captured.latest,status:state.status==='running'?'running':'ready',error:'',floorStates:state.floorStates};publish();return inspect();
  }
  async function reconcile(){
    const ticket=serial,t=await adapter.prepare();await workshopRuntime?.request();let captured=await repository.captureLatest(t);
    const workshop=await workshopRuntime?.backgroundState(t),tracking=await trackingRuntime?.backgroundState(t);
    if(disposed||ticket!==serial||!current(t))return;
    // Disabling generation must not disable ownership maintenance for saved
    // summaries: ST copies extension metadata into newly generated swipes.
    // Keep an unsettled host projection untouched until syncSwipeToMes runs;
    // rewriting its extra now would attach the survivor's UUID to stale text.
    const identityChat=getContext().chat.map(message=>pendingProjection(message)?null:message);
    const prepared=summaryAllowed()||captured.latest.records.length||workshop?.modules.length||workshop?.selection.workshop.results.some(row=>row.generationSource==='background')||getControls?.()?.allowed('item')||getControls?.()?.allowed('npc')||tracking?.tracking.snapshots.length?prepareWorkshopIdentities(identityChat,{allowPendingLast:true}):{changed:false,selected:[]},source=raw(t);
    const next=pruneLatestRecords(captured.latest,raw(t,true),{replyVersions:versions(),retainStale:true});
    let rules=null,rebound=false;try{rules=cleaningRules();}catch{/* Missing configuration cannot prove equal generated input. */}
    next.records=next.records.map(record=>{
      const snapshot=record.sourceSnapshot;
      let retained=invalidatedFloors.has(snapshot.assistantFloor)||invalidatedFloors.has(snapshot.userFloor)?{...record,stale:true}:record;
      if(retained.stale&&rules&&record.cleaningRules&&equal(rules,record.cleaningRules)){
        try{
          const prepared=storedLatestSource(prepareLatestSource(source,{floor:snapshot.assistantFloor,rules}));
          if(prepared.replyId===snapshot.replyId&&prepared.userFloor===snapshot.userFloor&&equal(prepared.sentFloors,snapshot.sentFloors)){
            const {stale,...unchanged}=retained;retained={...unchanged,sourceSnapshot:prepared};rebound=true;
          }
        }catch{/* Keep the old result visible without claiming it matches. */}
      }
      return retained;
    });
    const valid=()=>{try{return !disposed&&ticket===serial&&current(t)&&adapter.matchesChatSource(t,source)&&(!rebound||equal(cleaningRules(),rules));}catch{return false;}};
    if(prepared.changed||!equal(next,captured.latest)){
      const saved=await repository.updateLatest(t,captured,next,{isCurrent:valid,forceSave:prepared.changed,workshopProof:prepared.selected.map(({floor,swipeId,replyId})=>({floor,swipeId,replyId}))});
      captured=saved.selection;
    }
    const maintained=valid()?await workshopRuntime?.reconcileBackground(t,source,{replyVersions:versions(),invalidatedFloors:[...invalidatedFloors],isCurrent:valid}):null;
    if(valid())await trackingRuntime?.reconcile(t,{replyVersions:versions(),invalidatedFloors:[...invalidatedFloors],isCurrent:valid});
    const tracked=valid()?await trackingRuntime?.backgroundState(t):null;
    if(valid()){invalidatedFloors.clear();target=t;selection=captured;workshopState=maintained??workshop??null;trackingState=tracked??tracking??null;state={...captured.latest,status:'ready',error:'',floorStates:state.floorStates};publish();}
  }
  function refresh(){
    const work=(pending??Promise.resolve()).catch(()=>{}).then(()=>reconcile());pending=work;
    work.finally(()=>{if(pending===work)pending=null;}).catch(()=>{});return work;
  }
  async function savePreferences(preferences){
    if(!target||!current(target))throw new Error('聊天已变化，请重新读取');
    if(Object.keys(preferences).some(key=>key!=='enabled'&&preferences[key]!==state.preferences[key]))latestEpoch++;
    const t=copy(target),ticket=serial,snapshot=await repository.captureLatest(t);
    const result=await repository.updateLatestPreferences(t,preferences,{expectedLatestRevision:snapshot.latest.revision,isCurrent:()=>current(t)&&ticket===serial});
    if(!current(t)||ticket!==serial)throw new Error('聊天已变化，请重新读取');
    selection=result.selection??await repository.captureLatest(t);state={...selection.latest,status:'ready',error:'',floorStates:{}};publish();await refresh();return inspect();
  }
  async function clear(){
    if(!target||!current(target))throw new Error('聊天已变化，请重新读取');
    cancel();const t=copy(target),ticket=serial;
    const captured=await repository.captureLatest(t);
    const saved=await repository.updateLatest(t,captured,{...captured.latest,records:[]},{isCurrent:()=>current(t)&&ticket===serial});
    if(!current(t)||ticket!==serial)throw new Error('聊天已变化，请重新读取');
    selection=saved.selection;state={...selection.latest,status:'ready',error:'',floorStates:{}};publish();return inspect();
  }
  async function generate(floor,{automatic=false,expectedMessage=null,workshopOnly=false,taskId,automaticSummaryProof=null,automaticMasterProof=null,queuedSummary=null}={}){
    const ticket=serial,controller=new AbortController();jobs.add(controller);let key=String(floor),t,latestTask=false,plan=null,trackingPlan=null,preparationFailed=false,partialResults=false,skippedTasks=0,automaticReceiptKey=null;
    const report=(status,message)=>{if(automatic&&!disposed&&ticket===serial&&(!t||current(t))){automaticStatus(status,message,floor);if(automaticReceiptKey)automaticReceipts.set(automaticReceiptKey,copy(automaticState));}};
    const markTracking=(status,error='')=>{trackingFloorStates[key]={status,error};};
    const markWorkshop=(task,status,error='')=>{workshopFloorStates[key]??={};workshopFloorStates[key][task.module.id]={status,error};};
    try{
      t=await adapter.prepare();if(!allowed()||ticket!==serial||!current(t)){report('skipped','总开关未启用或聊天状态已变化，本轮未调用');return false;}
      key=raw(t).messages.find(row=>row.floor===floor)?.replyId??key;
      if(expectedMessage&&getContext().chat?.[floor]!==expectedMessage)return false;
      if(automatic&&getControls?.()?.matches(automaticMasterProof)!==true){report('skipped','收到正文时的功能授权已失效，本轮未调用');return false;}
      await refresh();if(!allowed()||ticket!==serial||!current(t))return false;
      const captured=await repository.captureLatest(t),preferences=captured.latest.preferences,summaryEpoch=latestEpoch,summaryProof=automatic?automaticSummaryProof:getControls?.()?.capture('summary'),masterProof=automatic?automaticMasterProof:getControls?.()?.capture('enabled');
      const generation=getGenerationSettings(),rawSource=raw(t);key=rawSource.messages.find(row=>row.floor===floor)?.replyId??key;
      latestTask=!workshopOnly&&summaryMatches(summaryProof);
      const source=prepareLatestSource(rawSource,{floor,rules:generation.summaryCleaning.rules});
      const summaryEligible=()=>captured.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId)||!archivedFloor(t,floor);
      if(queuedSummary&&(queuedSummary.replyId!==source.replyId||!equal(queuedSummary.record,captured.latest.records.find(record=>record.sourceSnapshot.replyId===source.replyId)??null)))return false;
      const receiptKey=JSON.stringify([t,source.replyId,source.fingerprint]);
      if(automatic&&automaticReceipts.has(receiptKey)){automaticState=copy(automaticReceipts.get(receiptKey));publish();return false;}
      latestTask=!workshopOnly&&summaryMatches(summaryProof)&&(!automatic||!captured.latest.records.some(record=>!record.stale&&record.sourceSnapshot.replyId===key&&matchesStoredLatestSource(record.sourceSnapshot,raw(t))));
      // Summary-only buttons retain their scope; completed replies share all
      // enabled tasks, while workshop retries can target one failed segment.
      if(automatic||workshopOnly){
        try{plan=await workshopRuntime?.prepareBackground(t,source,{automatic,taskId});}
        catch(error){preparationFailed=true;for(const module of workshopState?.modules??[])if(taskId===undefined||module.id===taskId)markWorkshop({module},'failed',error.message);}
      }
      if(automatic||workshopOnly){try{trackingPlan=await trackingRuntime?.prepareBackground(t,source,{automatic,taskId,rules:generation.summaryCleaning.rules});}catch(error){preparationFailed=true;markTracking('failed',error.message);}}
      let tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());
      for(const task of plan?.tasks??[])if(!task.instructions.trim()){preparationFailed=true;markWorkshop(task,'failed','请先填写该工坊条目的生成要求');}
      if(!latestTask&&!tasks.length&&!trackingPlan){report('skipped','本轮没有可发送的任务，请检查功能开关、已有结果及工坊生成要求');publish();return false;}
      const valid=()=>{
        try{return allowed()&&getControls?.()?.matches(masterProof)===true&&!controller.signal.aborted&&ticket===serial&&current(t)&&getGenerationSettings().epoch===generation.epoch&&matchesLatestSource(source,raw(t));}catch{return false;}
      };
      if(!valid())return false;
      if(automatic){automaticReceiptKey=receiptKey;automaticReceipts.set(receiptKey,copy(automaticState));if(automaticReceipts.size>256)automaticReceipts.delete(automaticReceipts.keys().next().value);}
      if(latestTask){state.status='running';state.error='';state.floorStates[key]={status:'running',error:''};}
      for(const task of tasks)markWorkshop(task,'running');if(trackingPlan)markTracking('running');publish();
      // Preparing another participant can yield. Only still-authorized
      // categories may be sent, even before there is a response to discard.
      latestTask=latestTask&&summaryMatches(summaryProof)&&summaryEligible();
      try{trackingPlan=await trackingRuntime?.filterBackgroundPlan(trackingPlan)??null;}
      catch(error){preparationFailed=true;markTracking('failed',error.message);trackingPlan=null;}
      if(plan&&workshopRuntime?.filterBackgroundPlan){
        try{plan=await workshopRuntime.filterBackgroundPlan(plan);tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());}
        catch(error){preparationFailed=true;for(const task of tasks)markWorkshop(task,'failed',error.message);tasks=[];}
      }
      latestTask=latestTask&&summaryMatches(summaryProof)&&summaryEligible();
      try{trackingPlan=await trackingRuntime?.filterBackgroundPlan(trackingPlan)??null;}
      catch(error){preparationFailed=true;markTracking('failed',error.message);trackingPlan=null;}
      // The final authority read also yields. Recheck each participant's
      // captured control epoch without another await before dispatch.
      latestTask=latestTask&&summaryMatches(summaryProof)&&summaryEligible();
      if(workshopRuntime?.filterCurrentBackgroundPlan){
        try{plan=workshopRuntime.filterCurrentBackgroundPlan(plan);tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());}
        catch(error){preparationFailed=true;for(const task of tasks)markWorkshop(task,'failed',error.message);tasks=[];}
      }
      if(trackingRuntime?.filterCurrentBackgroundPlan){
        try{trackingPlan=trackingRuntime.filterCurrentBackgroundPlan(trackingPlan);}
        catch(error){preparationFailed=true;markTracking('failed',error.message);trackingPlan=null;}
      }
      if(!valid()||!latestTask&&!tasks.length&&!trackingPlan)return false;
      const descriptors=[...(latestTask?[{id:'latest',name:'最新摘要',instructions:preferences.prompt}]:[]),...tasks,...(trackingPlan?[trackingPlan.task]:[])];
      const request=tasks.length||trackingPlan?buildBackgroundRoundRequest({source,tasks:descriptors}):buildLatestRequest({source,prompt:preferences.prompt});
      report('running','正在进行本轮自动生成');
      const output=await provider.generateText({...request,signal:controller.signal,isCurrent:valid});
      if(!valid())return false;
      const segments=tasks.length||trackingPlan?parseBackgroundRoundResponse(output.text,descriptors):new Map([['latest',{text:output.text}]]);
      let successes=0;
      if(latestTask&&summaryMatches(summaryProof)&&summaryEligible()){
        try{
          const segment=segments.get('latest');if(segment.error)throw new Error(segment.error);
          const latest=await repository.captureLatest(t);
          if(!valid())return false;
          if(!summaryEligible())throw new Error('来源已归档，未新建摘要');
          if(!summaryMatches(summaryProof)||summaryEpoch!==latestEpoch||!equal(summarySettings(latest.latest.preferences),summarySettings(preferences)))throw new Error('最新摘要设置已变化，请重试');
          const previous=latest.latest.records.find(record=>record.sourceSnapshot.replyId===key),original=captured.latest.records.find(record=>record.sourceSnapshot.replyId===key),now=new Date().toISOString();
          if(!equal(previous??null,original??null))throw new Error('最新摘要已修改，请重新读取');
          await repository.upsertLatestRecord(t,latest,{id:previous?.id??crypto.randomUUID(),body:segment.text,sourceSnapshot:source,cleaningRules:normalizedRules(generation.summaryCleaning.rules),createdAt:previous?.createdAt??now,updatedAt:now},{isCurrent:()=>valid()&&summaryMatches(summaryProof)&&summaryEpoch===latestEpoch&&summaryEligible()});
          if(!valid())return false;
          state.floorStates[key]={status:'ready',error:''};successes++;
        }catch(error){if(!valid())return false;if(!summaryEligible()){state.floorStates[key]={status:'idle',error:''};skippedTasks++;}else{state.floorStates[key]={status:'failed',error:error.message};state.error=error.message;}}
        publish();
      }else if(latestTask&&!summaryEligible()){state.floorStates[key]={status:'idle',error:''};skippedTasks++;}
      for(const task of tasks){
        if(!valid())return false;
        try{
          const segment=segments.get(task.id);if(segment.error)throw new Error(segment.error);
          await workshopRuntime.saveBackgroundResult(plan,task,segment.text,{isCurrent:valid});
          if(!valid())return false;
          markWorkshop(task,'ready');successes++;
          workshopState=await workshopRuntime.backgroundState(t);
        }catch(error){if(!valid())return false;markWorkshop(task,'failed',error.message);}
        publish();
      }
      if(trackingPlan&&valid()){
        try{
          const segment=segments.get(trackingPlan.task.id);if(segment.error)throw new Error(segment.error);
          const result=await trackingRuntime.saveBackgroundResult(trackingPlan,segment.text,{isCurrent:valid});
          if(!valid())return false;
          const errors=Object.entries(result.errors).filter(([,error])=>error).map(([kind,error])=>`${kind==='items'?'物品':'NPC'}：${error}`);
          if(result.skipped){markTracking('idle');skippedTasks++;}
          else{markTracking(errors.length?'failed':'ready',errors.join('；'));successes++;if(errors.length)partialResults=true;}
          trackingState=await trackingRuntime.backgroundState(t);
        }catch(error){if(!valid())return false;markTracking('failed',error.message);}
        publish();
      }
      if(valid()){
        const latest=await repository.captureLatest(t);if(!valid())return false;
        selection=latest;state={...latest.latest,status:state.floorStates[key]?.status==='failed'?'failed':'ready',error:state.floorStates[key]?.error??'',floorStates:state.floorStates};publish();
      }
      const complete=successes===descriptors.length&&!preparationFailed&&!partialResults;
      report(complete?'succeeded':successes?'partial':skippedTasks&&!preparationFailed?'skipped':'failed',complete?'本轮自动生成已保存':successes?'本轮部分结果已保存，其余任务已取消或失败':skippedTasks&&!preparationFailed?'任务授权已变化，本轮结果未写入':'本轮自动生成失败，请在来源楼层查看错误并重试');
      return successes>0;
    }catch(error){
      if(!disposed&&ticket===serial&&(!t||current(t))){
        report('failed','本轮自动生成失败，请在来源楼层查看错误并重试');
        if(latestTask||!plan&&!workshopOnly){state.status='failed';state.error=error.message;state.floorStates[key]={status:'failed',error:error.message};}
        const affected=plan?.tasks??((automatic||workshopOnly)?workshopState?.modules.filter(module=>taskId===undefined||module.id===taskId).map(module=>({module}))??[]:[]);
        for(const task of affected)markWorkshop(task,'failed',error.message);
        if(trackingPlan||((automatic||workshopOnly)&&(!taskId||taskId==='tracking')&&(getControls?.()?.allowed('item')||getControls?.()?.allowed('npc'))))markTracking('failed',error.message);publish();
      }
      return false;
    }finally{
      jobs.delete(controller);
      if(automatic&&['queued','running'].includes(automaticState.status))report('cancelled','来源或配置已变化，本轮结果未写入');
      if(!disposed&&ticket===serial){
        if(state.floorStates[key]?.status==='running'){state.floorStates[key]={status:'idle',error:''};if(state.status==='running')state.status='ready';}
        for(const [id,value] of Object.entries(workshopFloorStates[key]??{}))if(value.status==='running')workshopFloorStates[key][id]={status:'idle',error:''};if(trackingFloorStates[key]?.status==='running')markTracking('idle');publish();
      }
    }
  }
  function enqueueGeneration(floor,options){
    const ticket=serial,scope=JSON.stringify([ticket,floor]);if(queuedFloors.has(scope))return Promise.resolve(false);
    if(!options.automatic&&!options.workshopOnly){
      try{const replyId=raw(target).messages.find(row=>row.floor===floor)?.replyId;options={...options,queuedSummary:{replyId,record:copy(state.records.find(record=>record.sourceSnapshot.replyId===replyId)??null)}};}catch{return Promise.resolve(false);}
    }
    queuedFloors.add(scope);
    const work=generationQueue.catch(()=>{}).then(()=>ticket===serial?generate(floor,options):false);
    generationQueue=work;work.finally(()=>queuedFloors.delete(scope)).catch(()=>{});return work;
  }
  async function intercept(messages,_size,_abort,type='normal'){
    if(!summaryAllowed()||!supported.has(type)||messages?.some(message=>String(message?.mes??message?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
    const t=repository.captureTarget(),ticket=serial,proof=getControls?.()?.capture('summary'),captured=await repository.captureLatest(t);
    if(!summaryMatches(proof)||ticket!==serial||!current(t))return;
    const source=raw(t),mapping=mapSummaryPromptFloors(messages,getContext().chat);if(!mapping)return;
    const transformed=transformLatestMessages({messages,sourceMap:mapping,raw:source,latest:{...captured.latest,preferences:{...captured.latest.preferences,enabled:true},records:captured.latest.records.filter(record=>!invalidatedFloors.has(record.sourceSnapshot.assistantFloor)&&!invalidatedFloors.has(record.sourceSnapshot.userFloor))}});
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
        result.set(floor,{floor,replyId:row.replyId,body:record?.body??'',...(stale?{stale:true}:{}),...(state.floorStates[row.replyId]??{status:'idle',error:''})});
      }
    }catch{/* A changing source cannot authorize a display. */}
    return result;
  }
  function floorInfo(floor){return floorInfos([floor]).get(floor)??null;}
  function workshopFloorInfos(floors){
    const result=new Map();
    try{
      if(!target||!current(target)||!allowed()||!workshopState&&!trackingState)return result;
      const source=raw(target),byFloor=new Map(source.messages.map(row=>[row.floor,row]));
      const trackingDisplay=trackingRuntime?.displayState(trackingState,source,[...invalidatedFloors]);
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
          return {id:module.id,name:module.name,body:valid?resultText(record):'',...(workshopFloorStates[row.replyId]?.[module.id]??{status:'idle',error:''})};
        });
        tasks.push(...(trackingRuntime?.floorTasks(trackingDisplay,source,floor,row.replyId,trackingFloorStates[row.replyId]??{})??[]));
        if(tasks.length)result.set(floor,{floor,replyId:row.replyId,tasks});
      }
    }catch{/* Changing chat ownership cannot authorize a display. */}
    return result;
  }
  function workshopFloorInfo(floor){return workshopFloorInfos([floor]).get(floor)??null;}
  function library(){
    const result={records:[],missing:[],running:[],currentRows:[],historyRecords:[],preferences:copy(state.preferences),target:copy(target),automatic:copy(automaticState),backfill:copy(backfillState)};
    if(!target||!current(target))return result;
    try{
      let cleaningRules=[];try{cleaningRules=settings?.captureEventGeneration?settings.captureEventGeneration().generation.summaryCleaning.rules:getGenerationSettings().summaryCleaning.rules;}catch{/* Reading saved facts never requires a connected model. */}
      const source=raw(target),retainedSource=raw(target,true),archived=latestArchivedFloors(adapter.peekConfirmed(target),retainedSource),byFloor=new Map(source.messages.map(row=>[row.floor,row])),byReply=new Map(pruneLatestRecords({schema:state.schema,revision:state.revision,preferences:state.preferences,records:state.records},retainedSource,{replyVersions:versions(),retainStale:true}).records.map(row=>[row.sourceSnapshot.replyId,row])),processor=getContext()?.streamingProcessor;
      for(const row of retainedSource.messages){
        if(row.role!=='assistant'||row.system||!row.replyId||!row.text.trim())continue;
        const hostMessage=getContext().chat?.[row.floor];
        if(hostMessage?.gen_started&&!hostMessage?.gen_finished)continue;
        if(processor&&processor.messageId===row.floor&&(processor.isFinished!==true||processor.isStopped===true||processor.abortController?.signal?.aborted||processor.toolCalls?.length))continue;
        const record=byReply.get(row.replyId),snapshot=record?.sourceSnapshot,run=state.floorStates[row.replyId]??{status:'idle',error:''};
        const pair={epoch:source.epoch,messages:snapshot?.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])??[]};
        const valid=record&&!record.stale&&!snapshot.rawMessages.some(item=>invalidatedFloors.has(item.floor))&&matchesStoredLatestSource(snapshot,pair);
        const nativeHidden=hostMessage?.is_system===true;
        const entry=record?{id:record.id,floor:row.floor,replyId:row.replyId,body:record.body,edited:record.edited===true,manual:record.sourceSnapshot.manual===true,...(!valid&&!nativeHidden?{stale:true}:{}),nativeHidden,status:run.status,error:run.error??''}:{floor:row.floor,replyId:row.replyId,nativeHidden,status:run.status,error:run.error??''};
        if(record)result.records.push(entry);
        if(archived.has(row.floor)){if(record)result.historyRecords.push(entry);continue;}
        if(nativeHidden){result.currentRows.push(entry);continue;}
        if(!record)entry.sourceProof=prepareManualLatestSource({epoch:source.epoch,messages:[row]},{floor:row.floor});
        if(run.status==='running')result.running.push(entry);
        else if(!record&&cleanSummaryFloors([row],{includeUser:true,rules:cleaningRules}).length)result.missing.push(entry);
        if(record||run.status==='running'||result.missing.at(-1)===entry)result.currentRows.push(entry);
      }
      result.records.sort((a,b)=>a.floor-b.floor);result.currentRows.sort((a,b)=>a.floor-b.floor);result.historyRecords.sort((a,b)=>a.floor-b.floor);
    }catch{/* Pending host persistence cannot authorize guessed source rows. */}
    return result;
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
    await repository.upsertLatestRecord(t,captured,{id:crypto.randomUUID(),body:body.trim(),edited:true,sourceSnapshot:source,createdAt:now,updatedAt:now},{isCurrent:valid});
    if(!valid())throw new Error('摘要已保存，但聊天来源已变化，请重新读取');
    await read();return library();
  }
  function backfillPlan(range){
    const {start=0,end=Number.MAX_SAFE_INTEGER}=range??{};
    if(!target||!current(target)||!summaryAllowed())throw new Error('最新摘要已关闭或聊天已变化');
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw new Error('请输入有效的起止楼层');
    const source=raw(target),rules=cleaningRules(),missing=library().missing,byFloor=new Map(source.messages.map(row=>[row.floor,row]));
    const sources=missing.filter(row=>row.floor>=start&&row.floor<=end).map(row=>prepareLatestSource({epoch:source.epoch,messages:[byFloor.get(row.floor-1),byFloor.get(row.floor)].filter(Boolean)},{floor:row.floor,rules}));
    return {...planLatestBackfill({sources,prompt:state.preferences.prompt}),rules};
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
    const generation=getGenerationSettings(),frozenRaw=raw(t),prompt=state.preferences.prompt,id=crypto.randomUUID(),controller=new AbortController();
    backfillController=controller;jobs.add(controller);
    backfillState={status:'queued',id,total:plan.count,completed:0,skipped:0,failed:0,error:plan.oversized.length?`以下楼层超过字符保护预算，未加入请求：${plan.oversized.join('、')}`:''};publish();
    const valid=()=>{try{return !controller.signal.aborted&&backfillState.id===id&&ticket===serial&&current(t)&&summaryMatches(proof)&&epoch===latestEpoch&&getGenerationSettings().epoch===generation.epoch&&adapter.matchesChatSource(t,frozenRaw);}catch{return false;}};
    const archivedNow=source=>archivedFloor(t,source.assistantFloor);
    const skipArchived=source=>{state.floorStates[source.replyId]={status:'idle',error:''};backfillState={...backfillState,skipped:backfillState.skipped+1};};
    const execute=async()=>{
      if(!valid()){jobs.delete(controller);if(backfillController===controller)backfillController=null;if(backfillState.id===id&&backfillState.status==='queued'){backfillState={...backfillState,status:'cancelled',error:'来源或配置已变化，补缺未开始'};publish();}return library();}
      backfillState={...backfillState,status:'running'};publish();
      try{
        for(const planned of plan.batches){
          if(!valid())break;
          const captured=await repository.captureLatest(t);if(!valid())break;
          const currentMissing=new Set(library().missing.map(row=>row.replyId));
          const sources=planned.filter(source=>currentMissing.has(source.replyId)&&!captured.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId)&&matchesLatestSource(source,raw(t)));
          backfillState={...backfillState,skipped:backfillState.skipped+planned.length-sources.length};
          if(!sources.length){publish();continue;}
          for(const source of sources)state.floorStates[source.replyId]={status:'running',error:''};publish();
          let parsed;
          try{
            const request=buildLatestBackfillRequest({sources,prompt});
            const output=await provider.generateText({...request,signal:controller.signal,isCurrent:()=>valid()&&sources.every(source=>matchesLatestSource(source,raw(t)))});
            if(!valid())break;
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
              if(!matchesLatestSource(source,raw(t)))throw new Error('回复来源已变化，结果未保存');
              const latest=await repository.captureLatest(t);if(!valid())break;
              // A manual save or another authorized producer always wins over
              // this missing-only operation, including stale saved records.
              if(latest.latest.records.some(record=>record.sourceSnapshot.replyId===source.replyId)){state.floorStates[source.replyId]={status:'ready',error:''};backfillState={...backfillState,skipped:backfillState.skipped+1};publish();continue;}
              const now=new Date().toISOString();
              const saved=await repository.upsertLatestRecord(t,latest,{id:crypto.randomUUID(),body:segment.text,sourceSnapshot:source,cleaningRules:plan.rules,createdAt:now,updatedAt:now},{isCurrent:()=>valid()&&matchesLatestSource(source,raw(t))&&!archivedNow(source)});
              if(!valid())break;
              selection=saved.selection;state={...selection.latest,status:'ready',error:'',floorStates:state.floorStates};
              state.floorStates[source.replyId]={status:'ready',error:''};backfillState={...backfillState,completed:backfillState.completed+1};
            }catch(error){
              // Unconfirmed persistence is not ordinary source cancellation.
              // Preserve this error even after the adapter revokes authority.
              if(error.code==='COMMIT_UNCONFIRMED')throw error;
              if(!valid())break;
              if(archivedNow(source)){skipArchived(source);continue;}
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
        jobs.delete(controller);if(backfillController===controller)backfillController=null;
        if(backfillState.id===id){
          if(['queued','running'].includes(backfillState.status))backfillState={...backfillState,status:'cancelled',error:'来源或配置已变化，补缺已停止'};
          for(const source of plan.batches.flat())if(state.floorStates[source.replyId]?.status==='running')state.floorStates[source.replyId]={status:'idle',error:''};
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
    await repository.editLatestRecord(t,captured,id,body,{isCurrent:valid});
    if(!valid())throw new Error('摘要来源已变化');await read();return library();
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
    receipt=null;foregroundType=null;if(current(complete.target)){if(automaticState.floor!==complete.floor||!['running','succeeded','partial','failed','skipped','cancelled'].includes(automaticState.status))automaticStatus('queued','正文已完成，正在准备本轮自动生成',complete.floor);void enqueueGeneration(complete.floor,{automatic:true,expectedMessage:complete.message,automaticSummaryProof:complete.summaryProof,automaticMasterProof:complete.masterProof});}
  }
  on('GENERATION_STARTED',(type,_options,dryRun)=>{const normalized=type===undefined?'normal':type;if(supported.has(normalized)&&!dryRun){cancel();foregroundStopped=false;foregroundType=normalized;automaticStatus('waiting','等待本轮正文完成',null);}});
  on('GENERATION_STOPPED',()=>{foregroundStopped=true;cancel();});
  on('MESSAGE_RECEIVED',(floor,type)=>{
    const normalized=type==='appendFinal'&&foregroundType==='continue'?'continue':type===undefined&&foregroundType==='normal'?'normal':type;
    if(foregroundStopped||!supported.has(normalized)||!Number.isSafeInteger(floor))return;
    try{const message=getContext().chat?.[floor];if(message?.is_user===false&&!message.is_system){receipt={floor,message,processor:getContext()?.streamingProcessor??null,target:repository.captureTarget(),summaryProof:summaryAllowed()?getControls?.()?.capture('summary'):null,masterProof:allowed()?getControls?.()?.capture('enabled'):null};flushReceipt();}}catch{/* no chat */}
  });
  // ST streaming ends its UI before MESSAGE_RECEIVED; non-streaming reverses
  // this order. Both receipts are required, with successful-stream evidence.
  on('GENERATION_ENDED',()=>{foregroundEnded=true;if(!receipt&&automaticState.status==='waiting')automaticStatus('waiting','已收到结束信号，等待宿主正文回执');flushReceipt();});
  for(const name of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED'])on(name,payload=>{const floor=typeof payload==='number'?payload:payload?.messageId??payload?.mesId??payload?.index;if(name==='MESSAGE_EDITED'){if(Number.isSafeInteger(floor)&&floor>=0)invalidatedFloors.add(floor);else for(const record of [...state.records,...(workshopState?.selection.workshop.results.filter(row=>row.generationSource==='background')??[]),...(trackingState?.tracking.snapshots??[])])for(const row of record.sourceSnapshot.rawMessages)invalidatedFloors.add(row.floor);}cancel();publish();void refresh().catch(()=>{});});
  for(const name of ['CHAT_CHANGED','CHAT_CREATED'])on(name,()=>{cancel();resetBackfill();readSerial++;invalidatedFloors.clear();target=null;selection=null;state={...emptyLatest(),status:'idle',error:'',floorStates:{}};workshopState=null;workshopFloorStates={};trackingState=null;trackingFloorStates={};automaticReceipts.clear();automaticState={status:'idle',message:'尚未收到新一轮正文生成信号',floor:null};publish();void read().then(()=>refresh()).catch(()=>{});});
  let displayReadQueued=false;
  const updateWorkshopDisplay=()=>{if(disposed||displayReadQueued)return;displayReadQueued=true;queueMicrotask(()=>{displayReadQueued=false;if(!disposed)void read().catch(()=>{});});};
  if(workshopRuntime?.subscribe)releases.push(workshopRuntime.subscribe(updateWorkshopDisplay));
  if(trackingRuntime?.subscribe)releases.push(trackingRuntime.subscribe(updateWorkshopDisplay));
  if((workshopRuntime||trackingRuntime)&&adapter.subscribe)releases.push(adapter.subscribe(updateWorkshopDisplay));
  // Never generate on initial load, enabling, edits, or selecting old swipes.
  void read().then(()=>refresh()).catch(()=>{});
  return {inspect,read,savePreferences,clear,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},defaultPrompt:DEFAULT_LATEST_PROMPT,
    observeVisibility(options){
      const off=adapter.observeSourceVisibility?.(change=>{if(disposed)return;if(change?.visibilityChanged!==false)cancel();else publish();},options)??(()=>{});
      const stop=()=>{off();visibilityReleases.delete(stop);};visibilityReleases.add(stop);return stop;
    },
    library,editRecord,manualRecord,estimateBackfill,startBackfill,stopBackfill,generate:(floor,options={})=>enqueueGeneration(floor,{workshopOnly:options.workshopOnly===true,...(typeof options.taskId==='string'?{taskId:options.taskId}:{})}),intercept,floorInfo,floorInfos,workshopFloorInfo,workshopFloorInfos,refresh,captureSource:(t=target)=>raw(t),
    setEnabled(value){enabled=!!value;if(!enabled)cancel();publish();},
    dispose(){if(disposed)return;for(const stop of [...visibilityReleases])stop();cancel();disposed=true;readSerial++;for(const release of releases)release();listeners.clear();}};
}
