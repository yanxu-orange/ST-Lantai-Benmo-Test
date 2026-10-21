import {featureGate} from '../../domain/controls/gate.js';
import {sameTarget} from '../../domain/memory/repository.js';
import {buildRecall,extractRecallInputs} from '../../domain/recall/build.js';
import {mapSummaryPromptFloors} from './summary-history.js';
import {createRecallPreviewBuilder} from './recall-preview.js';
import {recallChannels} from '../../shared/settings/model.js';
import {AiProviderError} from '../../shared/ai/provider.js';
import {createVectorMaintenance} from './vector-maintenance.js';
import {usesMultichannel} from '../../domain/recall/multichannel-build.js';
import {createMultichannelWorkerBuilder} from './recall-multichannel.js';

export const RECALL_PROMPT_KEY='lantai_benmo_memory_context';
const supported=new Set(['normal','regenerate','swipe','continue']);
const copy=value=>structuredClone(value);
const text=message=>typeof message?.mes==='string'?message.mes:typeof message?.content==='string'?message.content:'';
// These are the actual interceptor messages after ST's own transformations.
// Their filtered index is not an original floor identifier.
export function recallInputs(messages,recentFloorCount,original=null) {
  const usable=Array.isArray(messages)?messages:[],eligible=message=>message&&!message.is_system&&message.role!=='system';
  const mapping=original&&messages!==original?mapSummaryPromptFloors(messages,original):null;
  let index=-1;
  for(let i=usable.length-1;i>=0;i--)if(eligible(usable[i])&&usable[i]?.is_user&&text(usable[i]).trim()){index=i;break;}
  if(index<0)for(let i=usable.length-1;i>=0;i--)if(eligible(usable[i])&&text(usable[i]).trim()){index=i;break;}
  const recentHistory=[];
  for(let i=index-1;i>=0&&recentHistory.length<recentFloorCount;i--)if(eligible(usable[i])&&text(usable[i]).trim())recentHistory.push({floor:mapping?.[i]??i,text:text(usable[i]),distanceFromCurrent:mapping?mapping[index]-mapping[i]:index-i});
  return {input:index<0?'':text(usable[index]),recentHistory};
}
export function createRecallRuntime({repository,settings,getContext,captureSource,captureEvents=null,dateRuntime=null,build=buildRecall,previewBuild,getControls,recallProvider=null,vectorStore,Worker:WorkerClass=globalThis.Worker}={}) {
  const gate=featureGate(getControls,'event'),timeGate=featureGate(getControls,'time');
  let disposed=false,ticket=0,proof=null,injectedMaterials=null,injectedSelections=null,materialAuthority=null,flight=null,previewAbort=null,previewGuard=null,recordSequence=0;
  const buildPreview=previewBuild??(build===buildRecall?createRecallPreviewBuilder():build);
  const maintenance=createVectorMaintenance({repository,settings,provider:recallProvider,getControls,store:vectorStore}),buildMulti=createMultichannelWorkerBuilder({Worker:WorkerClass,vectorIndex:maintenance.index,provider:recallProvider});
  function cancelIndexPreparation(){maintenance.pause();}
  const providerSessions=new Map();let previewConfig=null;
  const releaseSession=config=>{const session=providerSessions.get(config);providerSessions.delete(config);try{session?.dispose?.();}catch{/* Cleanup cannot interrupt host generation. */}};
  const cancelPreview=()=>{previewAbort?.abort();previewAbort=null;previewGuard=null;releaseSession(previewConfig);previewConfig=null;};
  const records=new Map(),listeners=new Set(),releases=[];
  const key=target=>JSON.stringify([target.chatId,target.rootId]);
  const notify=()=>{for(const fn of [...listeners])try{fn();}catch{/* observers cannot break host generation */}};
  let guardFailure=null;
  const current=(target,serial,config,source)=>{
    const check=(value,reason)=>{if(!value)guardFailure=reason;return value;};
    guardFailure=null;
    return check(gate.matches(config.controlProof),'control-proof')&&check(!disposed,'disposed')&&check(serial===ticket,'ticket')
      &&check(sameTarget(target,repository.captureTarget()),'target')
      &&check(providerSessions.get(config)?.isCurrent?.()!==false,'credential-proof')
      &&check(!captureSource||JSON.stringify(captureSource(target))===source,'source');
  };
  function clear(reason='cancelled',expectedTarget=null) {
    const previous=flight,oldProof=proof;ticket++;proof=null;injectedMaterials=null;injectedSelections=null;flight=null;
    cancelPreview();
    for(const config of providerSessions.keys())releaseSession(config);
    maintenance.checkLifecycle();
    previous?.abort?.abort();
    if(previous)record(previous.target,{status:'failed',type:previous.type,message:'本轮召回已取消，未注入记忆。'});
    else if(reason==='stopped'&&oldProof)record(oldProof.target,{status:'failed',type:'cancelled',message:'本轮生成已取消，未继续注入记忆。'});
    try {
      const context=getContext();if(typeof context?.setExtensionPrompt!=='function')throw new Error();
      context.setExtensionPrompt(RECALL_PROMPT_KEY,'',1,0,false,0);return true;
    }catch {
      let target;try{target=repository.captureTarget();}catch{target=previous?.target??oldProof?.target;}
      if(target&&(!expectedTarget||sameTarget(target,expectedTarget)))record(target,{status:'unconfirmed',type:'cleanup',message:'记忆槽清理尚未确认，可能仍保留旧内容；本轮未完成召回注入。'});
      return false;
    }
  }
  function record(target,value){records.set(key(target),copy({...value,sequence:++recordSequence}));notify();}
  function preparationFailed(target,messages,type='normal') {
    if(disposed)return;
    try{if(!target||!sameTarget(target,repository.captureTarget()))return;}catch{return;}
    const cleared=clear('cancelled',target);
    if(!cleared||disposed||!supported.has(type)||messages?.some(message=>text(message).includes('[LANTAI_BACKGROUND_TASK:')))return;
    // Clearing can synchronously reenter the host and change the chat.
    try{if(sameTarget(target,repository.captureTarget()))record(target,{status:'failed',type,message:'本轮召回准备失败，未注入记忆；原上下文已保留。'});}catch{/* Unavailable target cannot receive a guessed record. */}
  }
  async function compute(messages,target,serial,previewInput=null,signal=null,onStage=()=>{}) {
    onStage('start');
    if(signal?.aborted)throw new AiProviderError('cancelled');
    if(!gate.allowed())throw new Error('事件记忆已关闭');
    // Ordinary edits belong to the next task. Keep provider sessions private,
    // never in replacement proofs, monitor records, or Worker messages.
    const config={controlProof:gate.capture(),...settings.captureRecall(),timeReminders:settings.captureTimeReminders?.()??null};
    const channels=recallChannels(config.recall),timeEnabled=timeGate.allowed();
    const capabilities=[...(channels.vector?['embedding']:[]),...(channels.rerank?['rerank']:[])];
    const taskProvider=capabilities.length&&recallProvider?.captureSession?recallProvider.captureSession(capabilities):recallProvider;
    if(taskProvider!==recallProvider)providerSessions.set(config,taskProvider);
    if(previewInput!==null)previewConfig=config;
    try {
    let vectorConfig=null;
    if(channels.vector)try{vectorConfig=taskProvider?.getConfig?taskProvider.getConfig('embedding'):settings.getAiConfig('embedding');}catch{/* A missing optional route degrades in the builder. */}
    onStage('date');
    const observed=dateRuntime&&timeEnabled?await dateRuntime.request():null;
    if(disposed||serial!==ticket||signal?.aborted||!sameTarget(target,repository.captureTarget()))throw new Error('stale');
    onStage('settings-source');
    const source=captureSource?JSON.stringify(captureSource(target)):null;
    let retries=0,stage='guard-after-read';
    const budget={remainingMs:5000};
    const mark=value=>{stage=value;onStage(value);};
    for(;;){
      try{
        // Recheck the original chat source before rebuilding from a newer root.
        mark('guard-after-read');
        if(signal?.aborted||!current(target,serial,config,source))throw new Error('stale');
        return await computeCaptured(messages,target,serial,previewInput,signal,mark,{config,source,channels,timeEnabled,observed,vectorConfig,taskProvider,budget});
      }catch(error){
        // No automatic replay once a builder/API request may have started.
        if(error?.code!=='COMMIT_UNCONFIRMED'||stage!=='guard-after-read'||!repository.waitForPendingWrite)throw error;
        if(retries>=2)throw Object.assign(new Error('保存期间重建次数已达上限'),{code:'COMMIT_RETRY_LIMIT'});
        if(signal?.aborted||disposed||serial!==ticket||!sameTarget(target,repository.captureTarget())||!gate.matches(config.controlProof))throw new Error('stale');
        retries++;
        mark('wait-pending-save');
        await repository.waitForPendingWrite(target,{signal,budget});
      }
    }
    } catch(error) { releaseSession(config);throw error; }
  }
  async function computeCaptured(messages,target,serial,previewInput,signal,onStage,{config,source,channels,timeEnabled,observed,vectorConfig,taskProvider,budget}) {
    const guard=()=>current(target,serial,config,source);
    if(previewInput===null&&flight?.abort.signal===signal)flight.guard=guard;
    else if(previewAbort?.signal===signal)previewGuard=guard;
    onStage('read-before');
    const root=await repository.read(target,{signal,budget});
    onStage('read-returned');
    if(signal?.aborted){onStage('post-read-aborted');throw new Error('stale');}
    onStage('guard-after-read');
    if(!guard())throw new Error('stale');
    onStage('inputs');
    const context=getContext(),inputs=previewInput===null?recallInputs(messages,config.recall.recentFloorCount,context?.chat)
      :extractRecallInputs(messages,{recentFloorCount:config.recall.recentFloorCount,input:previewInput,currentIndex:messages.length});
    const multi=build===buildRecall&&usesMultichannel(config.recall);
    onStage(multi?'build-worker':'build-main');
    const result=await (multi?buildMulti:previewInput===null?build:buildPreview)({events:root.events,batches:root.summary?.batches??[],...inputs,settings:config.recall,time:root.time??null,timeAvailable:timeEnabled&&(!dateRuntime||!['failed','needs-calibration','cancelled','no-calendar','unavailable'].includes(observed?.status)),timeReminders:config.timeReminders?.reminders??null,
      countTokens:typeof context?.getTokenCountAsync==='function'?body=>context.getTokenCountAsync(body):null},
      {signal,isCurrent:()=>current(target,serial,config,source),target,vectorConfig,taskProvider});
    onStage('guard-after-build');
    if(!current(target,serial,config,source))throw new Error('stale');
    onStage('read-authority');
    const authority=await repository.read(target,{signal,budget});
    onStage('guard-authority');
    if(!current(target,serial,config,source))throw new Error('stale');
    const recallAuthority=value=>({events:value.events,batches:value.summary?.batches??[],time:value.time??null});
    if(JSON.stringify(recallAuthority(authority))!==JSON.stringify(recallAuthority(root))){guardFailure='root-changed';throw new Error('stale');}
    return {result,target,config,source,serial,revision:root.revision};
  }
  async function preview(input='',messages) {
    if(typeof input!=='string')throw new TypeError('召回测试输入无效');
    cancelPreview();const abort=new AbortController();previewAbort=abort;
    const target=repository.captureTarget(),serial=ticket;
    try{
      const value=await compute(messages??getContext()?.chat,target,serial,input,abort.signal);
      if(abort.signal.aborted)throw new Error('stale');
      // compute owns this isolated result; preview never installs it in the
      // runtime's actual/proof cache. A second full clone has no shared owner.
      return value.result;
    }finally{if(previewAbort===abort){previewAbort=null;previewGuard=null;releaseSession(previewConfig);previewConfig=null;}}
  }
  async function intercept(messages,_size,_abort,type='normal') {
    if(disposed)return;
    const invocation=ticket+1;
    if(!clear())return;
    if(ticket!==invocation)return;
    if(!gate.allowed()||!supported.has(type)||messages?.some(message=>text(message).includes('[LANTAI_BACKGROUND_TASK:')))return;
    let target,stage='capture-target';guardFailure=null;
    const serial=ticket;
    try {
      target=repository.captureTarget();
      const abort=new AbortController();flight={target,type,abort};
      stage='record-preparing';
      record(target,{status:'preparing',type,message:'正在构造本轮召回，尚未注入记忆。'});
      const value=await compute(messages,target,serial,null,abort.signal,value=>{stage=value;});
      stage='guard-before-write';
      if(!current(target,serial,value.config,value.source))return;
      stage='write-prompt';
      const context=getContext();
      if(typeof context?.setExtensionPrompt!=='function')throw new Error('injection-unavailable');
      context.setExtensionPrompt(RECALL_PROMPT_KEY,value.result.prompt,1,value.config.recall.memoryDepth,false,0);
      // Host callbacks may synchronously switch chat or settings during writing.
      stage='guard-after-write';
      if(!current(target,serial,value.config,value.source)){clear();return;}
      stage='capture-materials';
      injectedSelections=(value.result.selected??[]).map(({id,event})=>({id,event:copy(event)}));
      injectedMaterials=(value.result.selected??[]).map(({event})=>({startTime:event.startTime,endTime:event.endTime,title:event.title,body:event.body}));
      stage='record-injected';
      proof={target:copy(target),eventIds:new Set(value.result.selectedIds),revision:value.revision,serial,config:value.config,source:value.source};
      record(target,{status:'injected',type,depth:value.config.recall.memoryDepth,prompt:value.result.prompt,result:value.result});
      flight=null;
    }catch(error) {
      // Diagnostic-only allowlists: never expose error.message, stack, story text or credentials.
      const names=new Set(['Error','TypeError','RangeError','SyntaxError','DataCloneError','AbortError','AiProviderError','SettingsError']);
      const codes=new Set(['COMMIT_UNCONFIRMED','COMMIT_WAIT_TIMEOUT','COMMIT_RETRY_LIMIT','SETTINGS_COMMIT_UNCONFIRMED','SETTINGS_CONFLICT','SETTINGS_UNAVAILABLE','SETTINGS_INVALID','read-target-changed','read-not-ready','read-binding-changed','read-root-invalid','read-duplicate-id','read-unavailable','cancelled','stale','configuration','capability','mapping','timeout','http','authentication','endpoint','rate_limit','cors_network','request','task_preset_missing','unavailable','storage']);
      const readErrors={'聊天目标已变化，请返回列表重新进入':'read-target-changed','请等待当前聊天读取完成':'read-not-ready','记忆聊天归属已变化，请重新读取':'read-binding-changed','数据版本或归属无法确认，已停止读取和写入':'read-root-invalid','重复记忆身份':'read-duplicate-id','无法确认聊天已保存，请检查连接后重试':'read-unavailable','无法读回聊天文件，请检查连接后重试':'read-unavailable'};
      const code=codes.has(error?.code)?error.code:Object.hasOwn(readErrors,error?.message)?readErrors[error.message]:null;
      const abort=flight?.abortDiagnostic;
      const abortDiagnostic=abort?{reason:abort.reason==='settings-guard'?'settings-guard':'settings-error',...(names.has(abort.name)?{name:abort.name}:{}),...(codes.has(abort.code)?{code:abort.code}:{}),...(abort.guard?{guard:abort.guard}:{})}:null;
      const worker=error?.workerDiagnostic;
      const workerCodes=new Set(['invalid-context','invalid-snapshot','duplicate-id','token-count',...codes]);
      const workerDiagnostic=worker?{name:names.has(worker.name)?worker.name:'Error',...(workerCodes.has(worker.code)?{code:worker.code}:{})}:null;
      const diagnostic={stage,...(abortDiagnostic?{abort:abortDiagnostic}:{}),...(workerDiagnostic?{worker:workerDiagnostic}:{}),...(guardFailure?{guard:guardFailure}:{}),name:names.has(error?.name)?error.name:'Error',...(code?{code}:{})};
      if(!disposed&&serial===ticket){const cleared=clear();if(cleared&&target&&sameTarget(target,repository.captureTarget()))record(target,{status:'failed',type,diagnostic,message:`本轮召回失败，未注入记忆。诊断：${diagnostic.stage}${diagnostic.guard?' / '+diagnostic.guard:''} / ${diagnostic.name}${diagnostic.code?' / '+diagnostic.code:''}${diagnostic.abort?' / abort:'+diagnostic.abort.reason+(diagnostic.abort.guard?'/'+diagnostic.abort.guard:'')+(diagnostic.abort.code?'/'+diagnostic.abort.code:''):''}${diagnostic.worker?' / worker:'+diagnostic.worker.name+(diagnostic.worker.code?'/'+diagnostic.worker.code:''):''}`});}
    }
  }
  const context=getContext();
  const selectedUnchanged=(authority,events)=>authority.selected.every(saved=>JSON.stringify(events.find(row=>row.id===saved.id))===JSON.stringify(saved.event));
  if(repository.subscribeEventCommits)releases.push(repository.subscribeEventCommits(notice=>{
    if(materialAuthority&&sameTarget(materialAuthority.target,notice.target)&&!selectedUnchanged(materialAuthority,notice.events))materialAuthority.revoked=true;
  }));
  // Ordinary settings changes do not cancel a captured task. Explicit host
  // lifecycle/feature-stop hooks still clear it, and source checks remain live.
  releases.push(maintenance.subscribe(notify));
  for(const name of ['CHAT_CHANGED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED']) {
    const event=context?.eventTypes?.[name],source=context?.eventSource;
    if(!event||typeof source?.on!=='function')continue;
    const listener=()=>{clear(name==='GENERATION_STOPPED'?'stopped':name);notify();};
    source.on(event,listener);releases.push(()=>(source.off??source.removeListener)?.call(source,event,listener));
  }
  function inspect(limit=null){try{const value=records.get(key(repository.captureTarget()))??{status:'empty'};
    return copy(limit===null||!value.result?value:{...value,result:{...value.result,unselected:value.result.unselected.slice(0,limit),unselectedCount:value.result.unselected.length}});
  }catch{return {status:'empty'};}}
  async function prepareVectorIndex({rebuild=false,mode='all'}={}){
    if(rebuild)throw new AiProviderError('request');return maintenance.process({mode});
  }
  const vectorIndexState=()=>maintenance.state();
  return Object.freeze({preview,intercept,clear,preparationFailed,cancelPreview,prepareVectorIndex,vectorIndexState,cancelIndexPreparation,
    captureWorkshopInjection(){
      try{
        if(!proof||!current(proof.target,proof.serial,proof.config,proof.source)||!injectedMaterials)return null;
        const owner=copy(proof.target),config=proof.config,memories=copy(injectedMaterials),authority={target:owner,selected:copy(injectedSelections),revoked:false};materialAuthority=authority;
        return {memories,isCurrent:()=>!disposed&&!authority.revoked&&(!captureEvents||selectedUnchanged(authority,captureEvents(owner)))&&sameTarget(owner,repository.captureTarget())&&gate.matches(config.controlProof)};
      }catch{return null;}
    },
    getReplacementProof(){try{return proof&&current(proof.target,proof.serial,proof.config,proof.source)?proof:null;}catch{return null;}},
    inspect,inspectView:({more=false}={})=>inspect(more?null:2),
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    dispose(){if(disposed)return;clear();disposed=true;maintenance.dispose();releases.forEach(fn=>fn());listeners.clear();records.clear();}
  });
}
