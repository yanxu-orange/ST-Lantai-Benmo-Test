import {cleanSummaryFloors} from '../../domain/summary/cleaning.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {DEFAULT_LATEST_PROMPT,emptyLatest,pruneLatestRecords} from '../../domain/latest/data.js';
import {prepareLatestSource,matchesLatestSource,matchesStoredLatestSource} from '../../domain/latest/source.js';
import {buildLatestRequest} from '../../domain/latest/requests.js';
import {buildBackgroundRoundRequest,parseBackgroundRoundResponse} from '../../domain/background/round.js';
import {resultText} from '../../domain/workshop/results.js';
import {transformLatestMessages} from '../../domain/latest/transform.js';
import {prepareWorkshopIdentities,WORKSHOP_REPLY_KEY} from './workshop-identities.js';
import {mapSummaryPromptFloors} from './summary-history.js';

const copy=value=>structuredClone(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const summarySettings=({enabled,...preferences})=>preferences;
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
  const automaticReceipts=new Set();
  let state={...emptyLatest(),status:'idle',error:'',floorStates:{}};
  const listeners=new Set(),releases=[],jobs=new Set(),queuedFloors=new Set(),invalidatedFloors=new Set();
  const allowed=()=>!disposed&&enabled&&getControls?.()?.allowed('enabled')===true;
  const summaryAllowed=()=>allowed()&&getControls?.()?.allowed('summary')===true;
  const summaryMatches=proof=>summaryAllowed()&&getControls?.()?.matches(proof)===true;
  const current=t=>{try{return !disposed&&sameTarget(t,repository.captureTarget());}catch{return false;}};
  const publish=()=>{for(const listener of listeners)try{listener(inspect());}catch{/* UI cannot break a write. */}};
  function inspect(){return copy({...state,target});}
  function cancel(){serial++;for(const [key,value] of Object.entries(trackingFloorStates))if(value.status==='running')trackingFloorStates[key]={status:'idle',error:''};for(const tasks of Object.values(workshopFloorStates))for(const [key,value] of Object.entries(tasks))if(value.status==='running')tasks[key]={status:'idle',error:''};receipt=null;foregroundEnded=false;generationQueue=Promise.resolve();queuedFloors.clear();for(const job of jobs)job.abort();jobs.clear();for(const [key,value] of Object.entries(state.floorStates))if(value.status==='running')state.floorStates[key]={status:'idle',error:''};if(state.status==='running')state.status='ready';publish();}
  function raw(t){
    const snapshot=adapter.captureChatSource(t),chat=getContext().chat;
    snapshot.messages=snapshot.messages.map(item=>{
      const message=chat[item.floor],swipes=message?.swipes,current=message?.swipe_id??0;
      // New swipes first have no slot. Deletion changes the selected slot before
      // syncSwipeToMes updates mes/extra. Neither stale projection owns a reply.
      const pending=Array.isArray(swipes)&&swipes.length&&typeof swipes[current]!=='string'||pendingProjection(message);
      return {...item,replyId:pending?null:message?.extra?.[WORKSHOP_REPLY_KEY]??null,specialPayload:!!special(message)};
    });
    return snapshot;
  }
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
    if(target&&!sameTarget(target,t)){cancel();state.floorStates={};invalidatedFloors.clear();}
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
    const next=pruneLatestRecords(captured.latest,source,{replyVersions:versions()});
    next.records=next.records.filter(record=>!invalidatedFloors.has(record.sourceSnapshot.assistantFloor)&&!invalidatedFloors.has(record.sourceSnapshot.userFloor));
    const valid=()=>!disposed&&ticket===serial&&current(t)&&adapter.matchesChatSource(t,source);
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
  async function generate(floor,{automatic=false,expectedMessage=null,workshopOnly=false,taskId}={}){
    const ticket=serial,controller=new AbortController();jobs.add(controller);let key=String(floor),t,latestTask=false,plan=null,trackingPlan=null;
    const markTracking=(status,error='')=>{trackingFloorStates[key]={status,error};};
    const markWorkshop=(task,status,error='')=>{workshopFloorStates[key]??={};workshopFloorStates[key][task.module.id]={status,error};};
    try{
      t=await adapter.prepare();if(!allowed()||ticket!==serial||!current(t))return false;
      if(expectedMessage&&getContext().chat?.[floor]!==expectedMessage)return false;
      await refresh();if(!allowed()||ticket!==serial||!current(t))return false;
      const captured=await repository.captureLatest(t),preferences=captured.latest.preferences,summaryEpoch=latestEpoch,summaryProof=getControls?.()?.capture('summary'),masterProof=getControls?.()?.capture('enabled');
      const generation=getGenerationSettings(),rawSource=raw(t);key=rawSource.messages.find(row=>row.floor===floor)?.replyId??key;
      latestTask=!workshopOnly&&summaryAllowed();
      const source=prepareLatestSource(rawSource,{floor,rules:generation.summaryCleaning.rules});
      latestTask=!workshopOnly&&summaryAllowed()&&(!automatic||!captured.latest.records.some(record=>record.sourceSnapshot.replyId===key&&matchesStoredLatestSource(record.sourceSnapshot,raw(t))));
      // Summary-only buttons retain their scope; completed replies share all
      // enabled tasks, while workshop retries can target one failed segment.
      plan=automatic||workshopOnly?await workshopRuntime?.prepareBackground(t,source,{automatic,taskId}):null;
      if(automatic||workshopOnly){try{trackingPlan=await trackingRuntime?.prepareBackground(t,source,{automatic,taskId,rules:generation.summaryCleaning.rules});}catch(error){markTracking('failed',error.message);}}
      const tasks=(plan?.tasks??[]).filter(task=>task.instructions.trim());
      for(const task of plan?.tasks??[])if(!task.instructions.trim())markWorkshop(task,'failed','请先填写该工坊条目的生成要求');
      if(!latestTask&&!tasks.length&&!trackingPlan){publish();return false;}
      const valid=()=>{
        try{return allowed()&&getControls?.()?.matches(masterProof)===true&&!controller.signal.aborted&&ticket===serial&&current(t)&&getGenerationSettings().epoch===generation.epoch&&matchesLatestSource(source,raw(t));}catch{return false;}
      };
      if(!valid())return false;
      const receiptKey=JSON.stringify([t,source.replyId,source.fingerprint]);
      if(automatic&&automaticReceipts.has(receiptKey))return false;
      if(automatic){automaticReceipts.add(receiptKey);if(automaticReceipts.size>256)automaticReceipts.delete(automaticReceipts.values().next().value);}
      if(latestTask){state.status='running';state.error='';state.floorStates[key]={status:'running',error:''};}
      for(const task of tasks)markWorkshop(task,'running');if(trackingPlan)markTracking('running');publish();
      // Preparing another participant can yield. Only still-authorized
      // categories may be sent, even before there is a response to discard.
      latestTask=latestTask&&summaryMatches(summaryProof);
      trackingPlan=trackingRuntime?.filterBackgroundPlan(trackingPlan)??null;
      if(!valid()||!latestTask&&!tasks.length&&!trackingPlan)return false;
      const descriptors=[...(latestTask?[{id:'latest',name:'最新摘要',instructions:preferences.prompt}]:[]),...tasks,...(trackingPlan?[trackingPlan.task]:[])];
      const request=tasks.length||trackingPlan?buildBackgroundRoundRequest({source,tasks:descriptors}):buildLatestRequest({source,prompt:preferences.prompt});
      const output=await provider.generateText({...request,signal:controller.signal,isCurrent:valid});
      if(!valid())return false;
      const segments=tasks.length||trackingPlan?parseBackgroundRoundResponse(output.text,descriptors):new Map([['latest',{text:output.text}]]);
      let successes=0;
      if(latestTask&&summaryMatches(summaryProof)){
        try{
          const segment=segments.get('latest');if(segment.error)throw new Error(segment.error);
          const latest=await repository.captureLatest(t);
          if(!valid())return false;
          if(!summaryMatches(summaryProof)||summaryEpoch!==latestEpoch||!equal(summarySettings(latest.latest.preferences),summarySettings(preferences)))throw new Error('最新摘要设置已变化，请重试');
          const previous=latest.latest.records.find(record=>record.sourceSnapshot.replyId===key),original=captured.latest.records.find(record=>record.sourceSnapshot.replyId===key),now=new Date().toISOString();
          if(!equal(previous??null,original??null))throw new Error('最新摘要已修改，请重新读取');
          await repository.upsertLatestRecord(t,latest,{id:previous?.id??crypto.randomUUID(),body:segment.text,sourceSnapshot:source,createdAt:previous?.createdAt??now,updatedAt:now},{isCurrent:()=>valid()&&summaryMatches(summaryProof)&&summaryEpoch===latestEpoch});
          if(!valid())return false;
          state.floorStates[key]={status:'ready',error:''};successes++;
        }catch(error){if(!valid())return false;state.floorStates[key]={status:'failed',error:error.message};state.error=error.message;}
        publish();
      }
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
          markTracking(errors.length?'failed':'ready',errors.join('；'));successes++;
          trackingState=await trackingRuntime.backgroundState(t);
        }catch(error){if(!valid())return false;markTracking('failed',error.message);}
        publish();
      }
      if(valid()){
        const latest=await repository.captureLatest(t);if(!valid())return false;
        selection=latest;state={...latest.latest,status:state.floorStates[key]?.status==='failed'?'failed':'ready',error:state.floorStates[key]?.error??'',floorStates:state.floorStates};publish();
      }
      return successes>0;
    }catch(error){
      if(!disposed&&ticket===serial&&(!t||current(t))){
        if(latestTask||!plan&&!workshopOnly){state.status='failed';state.error=error.message;state.floorStates[key]={status:'failed',error:error.message};}
        const affected=plan?.tasks??((automatic||workshopOnly)?workshopState?.modules.filter(module=>taskId===undefined||module.id===taskId).map(module=>({module}))??[]:[]);
        for(const task of affected)markWorkshop(task,'failed',error.message);
        if(trackingPlan||((automatic||workshopOnly)&&(!taskId||taskId==='tracking')&&(getControls?.()?.allowed('item')||getControls?.()?.allowed('npc'))))markTracking('failed',error.message);publish();
      }
      return false;
    }finally{
      jobs.delete(controller);
      if(!disposed&&ticket===serial){
        if(state.floorStates[key]?.status==='running'){state.floorStates[key]={status:'idle',error:''};if(state.status==='running')state.status='ready';}
        for(const task of plan?.tasks??[])if(workshopFloorStates[key]?.[task.module.id]?.status==='running')markWorkshop(task,'idle');if(trackingFloorStates[key]?.status==='running')markTracking('idle');publish();
      }
    }
  }
  function enqueueGeneration(floor,options){
    const ticket=serial,scope=JSON.stringify([ticket,floor]);if(queuedFloors.has(scope))return Promise.resolve(false);
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
      const source=raw(target),byFloor=new Map(source.messages.map(row=>[row.floor,row])),records=new Map(state.records.map(record=>[record.sourceSnapshot.replyId,record]));
      for(const floor of floors){
        const row=byFloor.get(floor);if(row?.role!=='assistant'||row.system||!row.replyId)continue;
        const candidate=records.get(row.replyId),snapshot=candidate?.sourceSnapshot;
        const subset={epoch:source.epoch,messages:snapshot?.rawMessages.map(item=>byFloor.get(item.floor)).filter(Boolean)??[]};
        const record=snapshot&&!invalidatedFloors.has(snapshot.assistantFloor)&&!invalidatedFloors.has(snapshot.userFloor)&&matchesStoredLatestSource(snapshot,subset)?candidate:null;
        result.set(floor,{floor,replyId:row.replyId,body:record?.body??'',...(state.floorStates[row.replyId]??{status:'idle',error:''})});
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
    const result={records:[],missing:[],running:[],preferences:copy(state.preferences),target:copy(target)};
    if(!target||!current(target))return result;
    try{
      let cleaningRules=[];try{cleaningRules=settings?.captureEventGeneration?settings.captureEventGeneration().generation.summaryCleaning.rules:getGenerationSettings().summaryCleaning.rules;}catch{/* Reading saved facts never requires a connected model. */}
      const source=raw(target),byFloor=new Map(source.messages.map(row=>[row.floor,row])),byReply=new Map(state.records.map(row=>[row.sourceSnapshot.replyId,row])),processor=getContext()?.streamingProcessor;
      for(const row of source.messages){
        if(row.role!=='assistant'||row.system||!row.replyId||!row.text.trim())continue;
        const hostMessage=getContext().chat?.[row.floor];
        if(hostMessage?.gen_started&&!hostMessage?.gen_finished)continue;
        if(processor&&processor.messageId===row.floor&&(processor.isFinished!==true||processor.isStopped===true||processor.abortController?.signal?.aborted||processor.toolCalls?.length))continue;
        const record=byReply.get(row.replyId),snapshot=record?.sourceSnapshot,run=state.floorStates[row.replyId]??{status:'idle',error:''};
        const pair={epoch:source.epoch,messages:snapshot?.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])??[]};
        const valid=record&&!snapshot.rawMessages.some(item=>invalidatedFloors.has(item.floor))&&matchesStoredLatestSource(snapshot,pair);
        if(valid)result.records.push({id:record.id,floor:row.floor,replyId:row.replyId,body:record.body,edited:record.edited===true,status:run.status,error:run.error??''});
        if(run.status==='running')result.running.push({floor:row.floor,replyId:row.replyId,status:'running'});
        else if(!valid&&cleanSummaryFloors([row],{includeUser:true,rules:cleaningRules}).length)result.missing.push({floor:row.floor,replyId:row.replyId,status:run.status,error:run.error??''});
      }
      result.records.sort((a,b)=>b.floor-a.floor);
    }catch{/* Pending host persistence cannot authorize guessed source rows. */}
    return result;
  }
  async function editRecord(id,body,{original}={}){
    if(!target||!current(target)||!summaryAllowed())throw new Error('最新摘要已关闭或聊天已变化');
    const t=copy(target),ticket=serial,proof=getControls?.()?.capture('summary'),captured=await repository.captureLatest(t),record=captured.latest.records.find(row=>row.id===id);
    if(!record||!library().records.some(row=>row.id===id)||(original&&(original.body!==record.body||original.replyId!==undefined&&original.replyId!==record.sourceSnapshot.replyId)))throw new Error('摘要或回复版本已变化，请重新读取');
    const source=record.sourceSnapshot,valid=()=>current(t)&&ticket===serial&&summaryMatches(proof)&&!source.rawMessages.some(row=>invalidatedFloors.has(row.floor))&&matchesStoredLatestSource(source,raw(t));
    if(!valid())throw new Error('摘要来源已变化');
    await repository.editLatestRecord(t,captured,id,body,{isCurrent:valid});
    if(!valid())throw new Error('摘要来源已变化');await read();return library();
  }


  const context=getContext(),events=context?.eventSource;
  const on=(name,listener)=>{const type=context?.eventTypes?.[name];if(!type||!events?.on)return;events.on(type,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,type,listener));};
  function completedStream(floor){
    const processor=getContext()?.streamingProcessor;
    if(!processor||Number.isSafeInteger(processor.messageId)&&processor.messageId!==floor)return true;
    return processor.isFinished===true&&processor.isStopped!==true&&!processor.abortController?.signal?.aborted&&!(processor.toolCalls?.length);
  }
  function flushReceipt(){
    const complete=receipt;if(!complete||!foregroundEnded||foregroundStopped||!completedStream(complete.floor))return;
    receipt=null;if(current(complete.target))void enqueueGeneration(complete.floor,{automatic:true,expectedMessage:complete.message});
  }
  on('GENERATION_STARTED',(type,_options,dryRun)=>{if(supported.has(type)&&!dryRun){cancel();foregroundStopped=false;foregroundType=type;}});
  on('GENERATION_STOPPED',()=>{foregroundStopped=true;cancel();});
  on('MESSAGE_RECEIVED',(floor,type)=>{
    const normalized=type==='appendFinal'&&foregroundType==='continue'?'continue':type;
    if(foregroundStopped||!supported.has(normalized)||!Number.isSafeInteger(floor)||!completedStream(floor))return;
    try{const message=getContext().chat?.[floor];if(message?.is_user===false&&!message.is_system){receipt={floor,message,target:repository.captureTarget()};flushReceipt();}}catch{/* no chat */}
  });
  // ST streaming ends its UI before MESSAGE_RECEIVED; non-streaming reverses
  // this order. Both receipts are required, with successful-stream evidence.
  on('GENERATION_ENDED',()=>{foregroundEnded=true;flushReceipt();});
  for(const name of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED'])on(name,payload=>{const floor=typeof payload==='number'?payload:payload?.messageId??payload?.mesId??payload?.index;if(name==='MESSAGE_EDITED'){if(Number.isSafeInteger(floor)&&floor>=0)invalidatedFloors.add(floor);else for(const record of [...state.records,...(workshopState?.selection.workshop.results.filter(row=>row.generationSource==='background')??[]),...(trackingState?.tracking.snapshots??[])])for(const row of record.sourceSnapshot.rawMessages)invalidatedFloors.add(row.floor);}cancel();publish();void refresh().catch(()=>{});});
  for(const name of ['CHAT_CHANGED','CHAT_CREATED'])on(name,()=>{cancel();readSerial++;invalidatedFloors.clear();target=null;selection=null;state={...emptyLatest(),status:'idle',error:'',floorStates:{}};workshopState=null;workshopFloorStates={};trackingState=null;trackingFloorStates={};automaticReceipts.clear();publish();void read().then(()=>refresh()).catch(()=>{});});
  let displayReadQueued=false;
  const updateWorkshopDisplay=()=>{if(disposed||displayReadQueued)return;displayReadQueued=true;queueMicrotask(()=>{displayReadQueued=false;if(!disposed)void read().catch(()=>{});});};
  if(workshopRuntime?.subscribe)releases.push(workshopRuntime.subscribe(updateWorkshopDisplay));
  if(trackingRuntime?.subscribe)releases.push(trackingRuntime.subscribe(updateWorkshopDisplay));
  if((workshopRuntime||trackingRuntime)&&adapter.subscribe)releases.push(adapter.subscribe(updateWorkshopDisplay));
  // Never generate on initial load, enabling, edits, or selecting old swipes.
  void read().then(()=>refresh()).catch(()=>{});
  return {inspect,read,savePreferences,clear,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},defaultPrompt:DEFAULT_LATEST_PROMPT,
    library,editRecord,generate:(floor,options={})=>enqueueGeneration(floor,{workshopOnly:options.workshopOnly===true,...(typeof options.taskId==='string'?{taskId:options.taskId}:{})}),intercept,floorInfo,floorInfos,workshopFloorInfo,workshopFloorInfos,refresh,captureSource:(t=target)=>raw(t),
    setEnabled(value){enabled=!!value;if(!enabled)cancel();publish();},
    dispose(){if(disposed)return;cancel();disposed=true;readSerial++;for(const release of releases)release();listeners.clear();}};
}
