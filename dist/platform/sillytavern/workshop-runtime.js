import {matchesStoredLatestSource} from '../../domain/latest/source.js';
import {featureGate} from '../../domain/controls/gate.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {extractResults,reconcileResults} from '../../domain/workshop/results.js';
import {applicableModules,composeWorkshopPrompts} from '../../domain/workshop/prompts.js';
import {prepareWorkshopIdentities,WORKSHOP_REPLY_KEY} from './workshop-identities.js';
import {generationSourceOf} from '../../domain/workshop/model.js';
import {backgroundModules,workshopBackgroundTask,previousBackgroundResult,reconcileBackgroundResults,upsertBackgroundResult} from '../../domain/workshop/background.js';
const supported = new Set(['normal','regenerate','swipe','continue']);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const pendingProjection=message=>{const slot=message?.swipe_info?.[message.swipe_id??0]?.extra?.[WORKSHOP_REPLY_KEY],active=message?.extra?.[WORKSHOP_REPLY_KEY];return typeof slot==='string'&&!!slot&&typeof active==='string'&&!!active&&slot!==active;};
const roleIds = {system:0,user:1,assistant:2};
export function createWorkshopRuntime({repository,settings,getContext,captureSource,matchesSource,getControls,ensureReady,isSourceDeletionPending=()=>false}={}) {
  const gates=Object.fromEntries(['prompt','collect','sync'].map(key=>[key,featureGate(getControls,key)]));
  let disposed=false,serial=0,pending=null,identityUnconfirmed=true,backgroundSourceReader=null,lastCollection=null;
  let promptRun=null,promptPrepared=null,promptPermit=null;
  const keys=new Set(),releases=[],listeners=new Set();
  const changed=()=>{for(const listener of listeners)try{listener();}catch{/* Display refresh cannot change a write. */}};
  const preparationPolicy=()=>Object.values(gates).map(gate=>({gate,allowed:gate.allowed(),proof:gate.capture()}));
  const policyCurrent=policy=>policy.every(({gate,allowed,proof})=>gate.allowed()===allowed&&(!allowed||gate.matches(proof)));
  // Display reuse needs the live story source as well as the repository root.
  // Reply ownership lives outside that root and can change without an event.
  const replyOwnership=()=>JSON.stringify(getContext().chat.map(message=>[message?.extra?.[WORKSHOP_REPLY_KEY],message?.swipe_info?.map(info=>info?.extra?.[WORKSHOP_REPLY_KEY]),message?.swipes?.length]));
  function captureDisplaySource(target,source){
    if(!captureSource||!matchesSource)return null;
    try{return {serial,source:source??captureSource(target),ownership:replyOwnership(),gates:Object.entries(gates).map(([key,gate])=>({key,allowed:gate.allowed(),proof:gate.capture()}))};}catch{return null;}
  }
  function matchesDisplaySource(target,proof){
    try{return !!proof&&!disposed&&proof.serial===serial&&sameTarget(target,repository.captureTarget())&&matchesSource(target,proof.source)&&proof.ownership===replyOwnership()&&proof.gates.every(row=>gates[row.key].allowed()===row.allowed&&(!row.allowed||gates[row.key].matches(row.proof)));}catch{return false;}
  }
  function clear(){
    serial++;lastCollection=null;promptPrepared=promptPermit=null;const context=getContext();let okay=true;
    for(const key of keys){try{context.setExtensionPrompt(key,'',1,0,false,0);}catch{okay=false;}}
    if(okay)keys.clear();changed();return okay;
  }
  async function collect({target,readView:provided}={}){
    if(disposed||isSourceDeletionPending())return;
    const collectSerial=serial;
    if(!sameTarget(target,repository.captureTarget()))return;
    const config=settings.captureWorkshop(),readView=provided&&repository.matchesPanelData?.(target,provided)?provided:await repository.capturePanelData?.(target),selection=await repository.captureWorkshop(target,readView);
    if(disposed||isSourceDeletionPending()||serial!==collectSerial||!sameTarget(target,repository.captureTarget())||!settings.matchesWorkshop(config))return;
    const root=readView?await repository.readPanelRoot(target,readView):await repository.read(target);
    const modules=applicableModules(config.workshop,selection.workshop,root.binding?.kind==='character'?root.binding.owner:null).filter(module=>gates[module.lifecycle].allowed());
    const collectors=modules.filter(module=>module.lifecycle!=='prompt'&&generationSourceOf(module)==='story');
    if(!modules.some(module=>module.lifecycle!=='prompt')&&!selection.workshop.results.some(row=>row.generationSource==='background'))return {target,selection,config,modules,readView,binding:root.binding,displaySource:captureDisplaySource(target)};
    if(disposed||isSourceDeletionPending()||serial!==collectSerial||!sameTarget(target,repository.captureTarget())||!settings.matchesWorkshop(config))return;
    const prepared=prepareWorkshopIdentities(getContext().chat.map(message=>pendingProjection(message)?null:message),{allowPendingLast:true});
    if(prepared.changed)identityUnconfirmed=true;
    const source=captureSource?.(target);
    const displaySource=captureDisplaySource(target,source);
    const guard=()=>!disposed&&!isSourceDeletionPending()&&serial===collectSerial&&sameTarget(target,repository.captureTarget())&&settings.matchesWorkshop(config)&&(!matchesSource||matchesSource(target,source));
    if(!guard())return;
    const snapshots=collectors.flatMap(module=>prepared.selected.map(reply=>({moduleId:module.id,replyId:reply.replyId,floor:reply.floor,values:[module.captureTag,...(module.captureAliases??[]).filter(alias=>alias.rootId===target.rootId).map(alias=>alias.tag)].flatMap(tag=>extractResults(reply.text,tag))})));
    const backgroundSource=backgroundSourceReader?.(target),byFloor=new Map((backgroundSource?.messages??[]).map(row=>[row.floor,row]));
    const background=selection.workshop.results.filter(row=>row.generationSource==='background').map(row=>{
      const pair=backgroundSource?{epoch:backgroundSource.epoch,messages:row.sourceSnapshot.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])}:null;
      return {...row,active:!!pair&&!row.sourceSnapshot.rawMessages.some(item=>backgroundSource.invalidatedFloors?.includes(item.floor))&&matchesStoredLatestSource(row.sourceSnapshot,pair)};
    });
    const uniqueSnapshots=snapshots.filter(snapshot=>!background.some(row=>row.moduleId===snapshot.moduleId&&row.replyId===snapshot.replyId));
    const stories=reconcileResults(selection.workshop.results.filter(row=>row.generationSource!=='background'),uniqueSnapshots,{moduleIds:collectors.map(module=>module.id)});
    // Changing a module's source must neither recapture its historical tags nor
    // keep an old selected swipe alive as the next background task's baseline.
    for(const row of stories){
      const module=modules.find(item=>item.id===row.moduleId&&generationSourceOf(item)==='background');if(!module)continue;
      const reply=prepared.selected.find(item=>item.replyId===row.replyId);
      row.active=!!reply&&reply.floor===row.floor;
    }
    const next={...selection.workshop,results:[...stories,...background]};
    const forceSave=prepared.changed||identityUnconfirmed;
    let saved;
    try{saved=await repository.updateWorkshop(target,selection,next,{isCurrent:guard,forceSave,workshopProof:prepared.selected.map(({floor,swipeId,replyId})=>({floor,swipeId,replyId}))});}
    catch(error){identityUnconfirmed=true;throw error;}
    if(!guard())return;
    if(saved.status==='committed')identityUnconfirmed=false;
    // A collection may commit. Its input view cannot certify the saved output.
    return {target,selection:saved.selection,config,modules,binding:(saved.root??root).binding,displaySource,readView:readView&&repository.matchesPanelData(target,readView)?readView:undefined};
  }
  function request({target:requestedTarget,readView}={}){
    // A maintenance pass requested before the host-event timer fires owns
    // that collection; do not run the same queued event again afterward.
    clearTimeout(timer);
    if(!gates.collect.allowed()&&!gates.sync.allowed()&&!gates.prompt.allowed())return Promise.resolve(null);
    const requestedSerial=serial,target=requestedTarget??repository.captureTarget();
    const policy=ensureReady?preparationPolicy():null;
    const work=(pending??Promise.resolve()).catch(()=>{}).then(async()=>{
      if(ensureReady)await ensureReady();
      if(disposed||requestedSerial!==serial||!sameTarget(target,repository.captureTarget())||policy&&!policyCurrent(policy))return null;
      return collect({target,readView});
    }).then(result=>{
      if(result){
        const value={target:result.target,selection:result.selection,config:result.config,binding:result.binding,displaySource:result.displaySource};
        // A fixed readView is newly allocated even when all displayed facts and
        // source authority are identical. It is not a change notification.
        if(!result.displaySource||!equal(lastCollection,value)){lastCollection=structuredClone(value);changed();}
      }
      return result;
    }).catch(error=>{lastCollection=null;throw error;});
    pending=work;work.finally(()=>{if(pending===work)pending=null;}).catch(()=>{});return work;
  }
  async function intercept(messages,_size,_abort,type='normal'){
    if(disposed||!clear()||!supported.has(type)||messages?.some(message=>String(message?.mes??message?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
    const ticket=serial,run=promptRun;
    try{
      const state=await request();if(!state||disposed||serial!==ticket)return;
      const {target,config,selection,modules}=state,source=captureSource?.(target);
      const valid=()=>!disposed&&serial===ticket&&(!run||promptRun===run)&&sameTarget(target,repository.captureTarget())&&settings.matchesWorkshop(config)&&(!matchesSource||matchesSource(target,source));
      const latest=await repository.captureWorkshop(target);
      if(!valid()||JSON.stringify(latest.workshop)!==JSON.stringify(selection.workshop))return;
      for(const prompt of composeWorkshopPrompts(modules,selection.workshop.results)){
        if(!valid()){if(serial===ticket)clear();return;}
        const key=`lantai_benmo_workshop_${prompt.id}`;keys.add(key);
        getContext().setExtensionPrompt(key,prompt.text,1,prompt.depth,false,roleIds[prompt.role]);
        if(!valid()){if(serial===ticket)clear();return;}
      }
      if(run&&promptRun===run&&run.type===type&&valid())promptPrepared={run,target:structuredClone(target),serial:ticket};
    }catch{if(!disposed&&serial===ticket)clear();}
  }
  async function backgroundState(target,{readView,captured}={}){
    if(ensureReady){
      const ticket=serial,owner=structuredClone(target),policy=preparationPolicy();
      await ensureReady();
      if(disposed||ticket!==serial||!sameTarget(owner,repository.captureTarget())||!policyCurrent(policy))throw new Error('工坊准备期间聊天或功能已变化');
    }
    const config=settings.captureWorkshop();
    const canShare=typeof repository.capturePanelData==='function'&&typeof repository.readPanelRoot==='function'&&typeof repository.matchesPanelData==='function';
    const view=readView??(canShare?await repository.capturePanelData(target):undefined);
    const selection=captured??await repository.captureWorkshop(target,view),root=view?repository.readPanelRoot(target,view):await repository.read(target);
    if(disposed||!sameTarget(target,repository.captureTarget()))throw new Error('聊天已变化');
    if(view&&repository.matchesPanelData(target,view)!==true)throw new Error('工坊资料读取期间已变化，请重新读取');
    const modules=applicableModules(config.workshop,selection.workshop,root.binding?.kind==='character'?root.binding.owner:null).filter(module=>gates[module.lifecycle].allowed());
    return {target,config,selection,modules:backgroundModules(modules)};
  }
  async function prepareBackground(target,source,{automatic=false,taskId}={}){
    const state=await backgroundState(target);
    const modules=state.modules.filter(module=>(taskId===undefined||module.id===taskId)&&(!automatic||!state.selection.workshop.results.some(row=>row.moduleId===module.id&&row.replyId===source.replyId)));
    return {...state,source,tasks:modules.map((module,index)=>({...workshopBackgroundTask(module,state.selection.workshop.results,source,index),gate:gates[module.lifecycle].capture()}))};
  }
  function taskAllowed(plan,task){
    if(disposed||!sameTarget(plan.target,repository.captureTarget())||!gates[task.module.lifecycle].allowed()||!gates[task.module.lifecycle].matches(task.gate))return false;
    if(task.module.scope==='chat')return true;
    return equal(settings.captureWorkshop().workshop.modules.find(module=>module.id===task.module.id),task.module);
  }
  function filterCurrentBackgroundPlan(plan){return plan?{...plan,tasks:plan.tasks.filter(task=>taskAllowed(plan,task))}:null;}
  async function filterBackgroundPlan(plan){
    if(!plan)return null;
    const current=await backgroundState(plan.target);
    return {...plan,tasks:plan.tasks.filter(task=>taskAllowed(plan,task)&&equal(current.modules.find(module=>module.id===task.module.id),task.module))};
  }
  async function saveBackgroundResult(plan,task,text,{isCurrent=()=>true}={}){
    const current=await backgroundState(plan.target),rows=current.selection.workshop.results;
    if(!isCurrent()||!taskAllowed(plan,task)||!equal(current.modules.find(module=>module.id===task.module.id),task.module)
      ||!equal(rows.find(row=>row.moduleId===task.module.id&&row.replyId===plan.source.replyId)??null,task.existing)
      ||task.module.lifecycle==='sync'&&!equal(previousBackgroundResult(rows,task.module.id,plan.source.assistantFloor),task.previous))throw new Error('工坊条目或此前状态已变化，请重试');
    const next={...current.selection.workshop,results:upsertBackgroundResult(rows,task,plan.source,text)};
    return repository.updateWorkshop(plan.target,current.selection,next,{isCurrent:()=>isCurrent()&&taskAllowed(plan,task),requireConfirmation:true});
  }
  async function reconcileBackground(target,source,options={}){
    const state=options.state??await backgroundState(target,{readView:options.readView}),next={...state.selection.workshop,results:reconcileBackgroundResults(state.selection.workshop.results,source,options)};
    if(equal(next,state.selection.workshop))return state;
    const saved=await repository.updateWorkshop(target,state.selection,next,{isCurrent:()=>!disposed&&sameTarget(target,repository.captureTarget())&&(!options.isCurrent||options.isCurrent())});
    return {...state,selection:saved.selection};
  }
  if(settings.subscribe){
    let displayed;
    try{displayed=settings.captureWorkshop().workshop.modules;}catch{/* Wait for confirmed settings. */}
    releases.push(settings.subscribe(notice=>{
      // Unconfirmed API staging cannot supply display data. Generation and
      // write guards still check live settings; only relevant confirmed
      // workshop changes require another read of stored results.
      if(notice?.confirmed===false)return;
      let next;try{next=settings.captureWorkshop().workshop.modules;}catch{return;}
      const unchanged=displayed&&equal(displayed,next);displayed=next;
      if(!unchanged)changed();
    }));
  }
  const context=getContext();let timer;
  function capturePromptEditProof(target){
    try{return !disposed&&promptPermit&&promptPermit.run===promptRun&&promptPermit.serial===serial&&sameTarget(target,promptPermit.target)&&sameTarget(target,repository.captureTarget())?promptPermit.proof:null;}catch{return null;}
  }
  for(const [name,listener] of [
    ['GENERATION_STARTED',(type,_options,dryRun)=>{const normalized=type===undefined?'normal':type;promptRun=!dryRun&&supported.has(normalized)?{type:normalized}:null;promptPrepared=promptPermit=null;changed();}],
    ['GENERATE_AFTER_DATA',(data,dryRun)=>{if(dryRun!==false||!data||!promptPrepared||promptPrepared.run!==promptRun||promptPrepared.serial!==serial||promptPermit)return;try{if(!sameTarget(promptPrepared.target,repository.captureTarget()))return;promptPermit={...promptPrepared,proof:Object.freeze({})};changed();}catch{/* Missing authority keeps prompt editing locked. */}}],
  ]){const event=context?.eventTypes?.[name],events=context?.eventSource;if(event&&events?.on){events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));}}
  for(const name of ['MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','GENERATION_ENDED']){
    const event=context?.eventTypes?.[name],events=context?.eventSource;if(!event||!events?.on)continue;
    const listener=()=>{if(name==='GENERATION_ENDED')promptRun=null;clear();clearTimeout(timer);timer=setTimeout(()=>request().catch(()=>{}),0);};
    events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));
  }
  for(const name of ['CHAT_CHANGED','CHAT_CREATED','GENERATION_STOPPED']){
    const event=context?.eventTypes?.[name],events=context?.eventSource;if(!event||!events?.on)continue;
    const listener=()=>{promptRun=null;clearTimeout(timer);clear();};events.on(event,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,event,listener));
  }
  return {request,intercept,clear,changed,captureDisplaySource,matchesDisplaySource,capturePromptEditProof,matchesPromptEditProof:(target,proof)=>!!proof&&capturePromptEditProof(target)===proof,setBackgroundSourceReader(reader){backgroundSourceReader=reader;},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},moduleAllowed:module=>gates[module.lifecycle].allowed()&&(module.scope==='chat'||equal(settings.captureWorkshop().workshop.modules.find(item=>item.id===module.id),module)),backgroundState,prepareBackground,filterBackgroundPlan,filterCurrentBackgroundPlan,saveBackgroundResult,reconcileBackground,dispose(){if(disposed)return;clear();disposed=true;clearTimeout(timer);for(const release of releases)release();listeners.clear();}};
}
