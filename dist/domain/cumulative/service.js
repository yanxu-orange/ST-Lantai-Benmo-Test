import {sameTarget} from '../memory/repository.js';
import {equalData} from '../memory/management-validation.js';
import {assertCumulativeGeneration} from '../../shared/settings/model.js';
import {baseSnapshotOf,cumulativeOf,cumulativeCoverage,publicCumulativeEvidence} from './data.js';
import {prepareCumulativeSource,storedCumulativeSource,matchesCumulativeSource,matchesStoredCumulativeSource} from './source.js';
import {buildCumulativeRequest,validCumulativeSummary} from './requests.js';
import {AiProviderError} from '../../shared/ai/provider.js';

// Diagnose only trusted provider codes. Never forward arbitrary error text or
// response details from the transport into the user-facing task state.
const AI_FAILURE_MESSAGES=Object.freeze({
  configuration:'AI 配置不完整，请在 API 设置中选择来源并完成配置后重新生成',
  unavailable:'当前 AI 生成接口不可用，请检查 API 设置后重新生成',
  cancelled:'AI 任务已取消，需要时请重新生成',
  stale:'任务来源或 API 配置已变化，请确认当前聊天与配置后重新生成',
  request:'AI 请求格式不正确，请刷新插件后重新生成；若仍失败，请反馈此提示',
  transport:'AI 请求未成功，请检查连接后重新生成',
  http:'AI 接口返回错误，请检查 API 服务与配置后重新生成',
  empty_output:'AI 返回了空内容，请重新生成',
  invalid_json:'AI 返回内容无法解析为 JSON，请重新生成',
  schema:'AI 返回内容不符合古法总结格式，请重新生成',
});

// The host supplies PUBLIC tickets only:
// {generation,cumulativeEpoch,summaryCleaning,cleaningEpoch,aiIdentity,aiEpoch}.
// aiIdentity is an opaque public selection identity, never a credential or API object.
export function createCumulativeSummaryService({repository,manager,provider,captureSource,getGenerationSettings,uuid=()=>crypto.randomUUID(),now=()=>new Date().toISOString()}={}) {
  const records=new Map(),listeners=new Set(),reservations=new Set(),reboundReceipts=new WeakSet();let disposed=false;
  const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
  function reboundGuard(previous,next,isCurrent){
    if(disposed||typeof isCurrent!=='function'||isCurrent()!==true||!sameTarget(previous,previous)||!sameTarget(next,next)||previous.chatId!==next.chatId||previous.rootId!==next.rootId||previous.epoch===next.epoch||!sameTarget(next,repository.captureTarget()))throw new Error('重载目标或读取来路已变化');
  }
  function settings() {
    const value=structuredClone(getGenerationSettings()),keys=['generation','cumulativeEpoch','summaryCleaning','cleaningEpoch','aiIdentity','aiEpoch'];
    if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||['cumulativeEpoch','cleaningEpoch','aiEpoch'].some(key=>!Number.isSafeInteger(value[key])||value[key]<0)||!(value.aiIdentity===null||typeof value.aiIdentity==='string'&&value.aiIdentity.trim()))throw new Error('古法公开配置票据无效');
    assertCumulativeGeneration(value.generation);publicCumulativeEvidence({...value.generation,summaryCleaning:value.summaryCleaning});return value;
  }
  const targetCurrent=(snapshot,target)=>{try{return !disposed&&sameTarget(target,repository.captureTarget())&&equalData(snapshot.settings,settings());}catch{return false;}};
  function sourceCurrent(snapshot,target) {
    const record=[...records.values()].find(item=>item.operationId===snapshot.operationId);
    try{return repository.matchesCumulative(target,record?.selection??snapshot.selection)&&matchesCumulativeSource(snapshot.source,captureSource(target));}catch{return false;}
  }
  const current=(snapshot,target)=>targetCurrent(snapshot,target)&&sourceCurrent(snapshot,target);
  function inspect(taskId) {
    const state=manager.inspect(taskId),record=records.get(taskId);if(!state||!record)return null;
    return {...state,origin:record.origin,stage:record.stage,outcome:record.outcome,reviewResolution:record.reviewResolution,rebindRequired:record.rebindRequired,receipt:record.receipt?structuredClone(record.receipt):null,errorMessage:record.errorMessage,restoreOnly:record.restoreOnly};
  }
  function notify(taskId){const state=inspect(taskId);if(state)for(const listener of [...listeners])try{listener(state);}catch{/* observation only */}}
  function evidence(config,params){return publicCumulativeEvidence({...config.generation,injectionPosition:config.generation.injectionPosition??9999,summaryCleaning:config.summaryCleaning,includeUser:params.includeUser,checkBeforeSave:params.checkBeforeSave,hideSource:params.hideSource});}
  async function capture(origin,options={},pending=null) {
    if(!['manual','auto','regeneration'].includes(origin))throw new Error('古法生成来源无效');
    const target=repository.captureTarget(),selection=await repository.captureCumulative(target),config=settings(),domain=selection.cumulative,previous=domain.versions.at(-1)??null;
    const stored=origin==='regeneration'?previous:null;
    if(origin==='regeneration'&&(!stored||options.versionId!==undefined&&options.versionId!==stored.id))throw new Error('再生成须选择当前已确认古法版本');
    const pref=domain.preferences[origin==='auto'?'auto':'manual'];
    const params={includeUser:options.includeUser??pref.includeUser,checkBeforeSave:origin==='regeneration'||(options.checkBeforeSave??pref.checkBeforeSave),hideSource:options.hideSource??pref.hideSource};
    if(Object.values(params).some(item=>typeof item!=='boolean'))throw new Error('古法参数须明确提供');
    const raw=captureSource(target),savedSource=pending?.version.sourceSnapshot??stored?.sourceSnapshot;
    const range=savedSource?.requestedRange??{start:options.startFloor??pref.startFloor,end:options.endFloor??(origin==='auto'?null:pref.endFloor)};
    if(range.end===null)range.end=raw.messages.length?Math.max(...raw.messages.map(item=>item.floor)):-1;
    if(savedSource&&!matchesStoredCumulativeSource(savedSource,raw))throw new Error('保留版本的原始来源已变化');
    const prepared=prepareCumulativeSource(raw,{startFloor:range.start,endFloor:range.end,includeUser:savedSource?.includeUser??params.includeUser,excludedFloors:savedSource?.excludedFloors??domain.excludedFloors,rules:savedSource?[]:config.summaryCleaning.rules});
    const source=savedSource?{...prepared,sentFloors:structuredClone(savedSource.sentFloors)}:prepared;
    params.includeUser=source.includeUser;
    const publicConfig=evidence(config,params);
    if(pending&&!equalData(pending.version.settingsEvidence,publicConfig))throw new Error('保留草稿的生成配置已变化');
    const baseSnapshot=pending?.version.baseSnapshot??(stored?stored.baseSnapshot:baseSnapshotOf(previous));
    const snapshot={target,selection,settings:config,source,origin,operationId:uuid(),params,baseSnapshot,coverageRanges:pending?.version.coverageRanges??stored?.coverageRanges??cumulativeCoverage([...(previous?.coverageRanges??[]),source.requestedRange]),versionId:pending?.version.id??stored?.id??uuid(),settingsEvidence:publicConfig,startTime:options.startTime??pending?.version.startTime??previous?.startTime??'',endTime:options.endTime??pending?.version.endTime??previous?.endTime??''};
    if(typeof snapshot.startTime!=='string'||typeof snapshot.endTime!=='string'||!current(snapshot,target))throw new Error('古法目标、基版或配置已变化');
    return snapshot;
  }
  function reviewVersion(candidate,edited) {
    if(edited===undefined)return structuredClone(candidate.version);
    if(!edited||Object.getPrototypeOf(edited)!==Object.prototype||Object.keys(edited).some(key=>!['body','startTime','endTime'].includes(key))||Object.values(edited).some(value=>typeof value!=='string'))throw new Error('候选仅允许编辑正文及起止时间');
    const version={...structuredClone(candidate.version),...edited};if(!version.body.trim())throw new Error('古法正文不能为空');return version;
  }
  function writeError(record,error){
    if(error?.code==='COMMIT_UNCONFIRMED'){
      record.errorMessage='保存结果尚未确认，请明确重新读取';record.outcome='unconfirmed';return;
    }
    record.errorMessage=error instanceof AiProviderError&&Object.hasOwn(AI_FAILURE_MESSAGES,error.code)
      ?AI_FAILURE_MESSAGES[error.code]:'古法任务未完成，请检查来源与配置后明确重试';
  }
  async function confirm(taskId,edited) {
    const record=records.get(taskId),state=inspect(taskId);if(!record||record.outcome==='unconfirmed'||!state?.candidate)return {status:'rejected'};
    let version;try{version=reviewVersion(state.candidate,edited);}catch(error){return {status:'invalid',error:error.message};}
    const result=await manager.confirm(taskId,async ctx=>{
      record.writeInFlight=true;
      try{
        await repository.read(ctx.target);
        const options={isCurrent:ctx.isCurrent,...(record.pendingId?{pendingId:record.pendingId}:{})};
        const receipt=ctx.snapshot.origin==='regeneration'?await repository.replaceCumulative(ctx.target,record.selection,version,options):await repository.appendCumulative(ctx.target,record.selection,version,options);
        record.receipt=receipt;record.selection=receipt.selection;record.stage='completed';record.reviewResolution='committed';return receipt;
      }catch(error){writeError(record,error);throw error;}finally{record.writeInFlight=false;}
    });notify(taskId);return {...result,outcome:record.outcome};
  }
  const release=manager.subscribe(state=>{
    const record=records.get(state.taskId);if(!record)return;notify(state.taskId);
    if(state.status==='awaiting-user'&&!state.reviewPending&&!record.reviewRequired&&!record.autoConfirmScheduled){record.autoConfirmScheduled=true;queueMicrotask(()=>void confirm(state.taskId));}
  });
  async function launch(origin,options={},pending=null) {
    if(disposed)throw new Error('古法服务已关闭');
    const initialTarget=repository.captureTarget(),key=initialTarget?.chatId;if(!key||reservations.has(key))throw new Error('当前聊天已有古法任务');reservations.add(key);
    try{
      for(const id of records.keys()){const state=inspect(id);if(state?.target.chatId===key&&(['starting','running','awaiting-user','committing'].includes(state.status)||state.outcome==='unconfirmed'||state.rebindRequired))throw new Error('当前聊天已有古法任务或未确认保存');}
      const snapshot=await capture(origin,options,pending);
      if(!sameTarget(initialTarget,snapshot.target))throw new Error('古法聊天目标已变化');
      if(snapshot.selection.cumulative.pending&&!pending)throw new Error('请先处理保留的古法草稿');
      if(pending&&!equalData(snapshot.selection.cumulative.pending,pending))throw new Error('古法草稿已变化');
      const record={origin,operationId:snapshot.operationId,selection:snapshot.selection,reviewRequired:!!pending||snapshot.params.checkBeforeSave,restoreOnly:!!pending,pendingId:pending?.id??null,stage:'starting',outcome:null,reviewResolution:null,discardAttempted:false,writeInFlight:false,rebindRequired:false,receipt:null,errorMessage:'',autoConfirmScheduled:false};
      const taskId=manager.start({key:`cumulative-summary:${key}`,target:snapshot.target,snapshot,validateCurrent:target=>targetCurrent(snapshot,target),validateSnapshot:sourceCurrent,worker:async ctx=>{
        if(pending){record.stage='final-review';return {kind:'cumulative-summary',version:structuredClone(pending.version)};}
        await repository.read(ctx.target);
        const isCurrent=()=>!ctx.signal.aborted&&current(ctx.snapshot,ctx.target);
        if(!isCurrent())throw new Error('古法来源已变化');record.stage='summary';notify(ctx.taskId);
        let output;
        try{output=await provider.generateJson({...buildCumulativeRequest({source:ctx.snapshot.source,previousSummary:ctx.snapshot.baseSnapshot?.body??null,settings:ctx.snapshot.settings.generation}),signal:ctx.signal,isCurrent,validate:validCumulativeSummary});}catch(error){writeError(record,error);throw error;}
        if(!isCurrent()||!validCumulativeSummary(output?.data))throw new Error('古法结果或来源无效');
        const timestamp=now(),version={id:snapshot.versionId,taskId:snapshot.operationId,body:output.data.summary,startTime:snapshot.startTime,endTime:snapshot.endTime,baseSnapshot:snapshot.baseSnapshot,sourceSnapshot:origin==='regeneration'?snapshot.selection.cumulative.versions.at(-1).sourceSnapshot:storedCumulativeSource(snapshot.source),coverageRanges:snapshot.coverageRanges,settingsEvidence:snapshot.settingsEvidence,createdAt:timestamp,updatedAt:timestamp};
        if(record.reviewRequired){const draft={schema:1,id:version.taskId,operation:origin==='regeneration'?'replace':'append',version,createdAt:timestamp,updatedAt:timestamp};record.pendingId=draft.id;
          record.writeInFlight=true;try{const receipt=await repository.saveCumulativePending(ctx.target,record.selection,draft,{isCurrent});record.selection=receipt.selection;}catch(error){if(error.code!=='COMMIT_UNCONFIRMED')record.pendingId=null;writeError(record,error);throw error;}finally{record.writeInFlight=false;}
        }
        record.stage='final-review';return {kind:'cumulative-summary',version};
      }});
      records.set(taskId,record);notify(taskId);return taskId;
    }finally{reservations.delete(key);}
  }
  const service={
    async preview(origin='manual',options={}){const snapshot=await capture(origin,options);return {...buildCumulativeRequest({source:snapshot.source,previousSummary:snapshot.baseSnapshot?.body??null,settings:snapshot.settings.generation}),snapshot};},
    start:(origin='manual',options={})=>launch(origin,options),confirm,inspect,settled:taskId=>manager.settled(taskId),
    completed(taskId){return new Promise(resolve=>{let off;const check=()=>{const state=inspect(taskId),record=records.get(taskId);if(!state||['succeeded','failed','stale','cancelled'].includes(state.status)||state.status==='awaiting-user'&&record.reviewRequired){off?.();resolve(state);}};off=service.subscribe(state=>{if(state.taskId===taskId)check();});check();});},
    cancel:taskId=>records.has(taskId)&&manager.cancel(taskId),
    async discard(taskId){const record=records.get(taskId),state=inspect(taskId);if(!record||!state||record.outcome==='unconfirmed'||state.status==='committing')return false;const guard=()=>sameTarget(state.target,repository.captureTarget());if(!guard())return false;
      if(record.pendingId){record.discardAttempted=true;record.writeInFlight=true;try{const receipt=await repository.clearCumulativePending(state.target,record.selection,{isCurrent:guard});record.selection=receipt.selection;record.receipt=receipt;}catch(error){writeError(record,error);notify(taskId);throw error;}finally{record.writeInFlight=false;}}
      record.outcome='discarded';record.reviewResolution='discarded';record.errorMessage='';
      manager.cancel(taskId);notify(taskId);return true;
    },
    async discardPending(){const target=repository.captureTarget(),selection=await repository.captureCumulative(target),pending=selection.cumulative.pending;if(!pending)return false;
      const owners=[...records].filter(([id,record])=>record.pendingId===pending.id&&sameTarget(inspect(id).target,target));for(const [,record] of owners){record.discardAttempted=true;record.writeInFlight=true;}
      let receipt;try{receipt=await repository.clearCumulativePending(target,selection,{isCurrent:()=>sameTarget(target,repository.captureTarget())});}catch(error){for(const [id,record] of owners){writeError(record,error);notify(id);}throw error;}finally{for(const [,record] of owners)record.writeInFlight=false;}
      for(const [id,record] of owners){record.selection=receipt.selection;record.receipt=receipt;record.outcome='discarded';record.reviewResolution='discarded';record.errorMessage='';manager.cancel(id);notify(id);}
      return true;},
    async restorePending(){const target=repository.captureTarget(),selection=await repository.captureCumulative(target),pending=selection.cumulative.pending;if(!pending)return null;
      return launch(pending.operation==='replace'?'regeneration':'manual',{...pending.version.settingsEvidence,startFloor:pending.version.sourceSnapshot.requestedRange.start,endFloor:pending.version.sourceSnapshot.requestedRange.end},pending);
    },
    retry(taskId){const record=records.get(taskId),state=inspect(taskId);if(!record||record.outcome==='unconfirmed'||record.pendingId||state?.status!=='failed'||!current(state.snapshot,state.target))return false;record.errorMessage='';record.autoConfirmScheduled=false;return manager.retry(taskId)?taskId:false;},
    async readReboundTarget({previousTarget,nextTarget,taskId,isCurrent}={}){
      const previous=structuredClone(previousTarget),next=structuredClone(nextTarget);reboundGuard(previous,next,isCurrent);
      const owners=[...records].filter(([id])=>sameTarget(inspect(id).target,previous));
      if(taskId!==undefined&&!owners.some(([id])=>id===taskId))throw new Error('旧重载任务归属不符');
      for(const [,record] of owners)record.rebindRequired=true;
      if(owners.some(([id,record])=>record.writeInFlight||inspect(id).status==='committing'))throw new Error('旧聊天保存尚未结束，请等待后重新读取');
      const root=await repository.read(next);reboundGuard(previous,next,isCurrent);
      if(owners.some(([id,record])=>record.writeInFlight||inspect(id).status==='committing'))throw new Error('旧聊天保存尚未结束，请等待后重新读取');
      const selection={target:next,cumulative:cumulativeOf(root)},domain=selection.cumulative;
      const tasks=owners.map(([id,record])=>{const state=inspect(id),operationId=state.candidate?.version.taskId??record.pendingId??record.operationId,committed=domain.versions.some(version=>version.taskId===operationId);
        return {taskId:id,operationId,outcome:committed?'recovered-committed':domain.pending?.version.taskId===operationId?'recovered-pending':'recovered-previous',reviewResolution:committed?'committed':record.discardAttempted&&!domain.pending?'discarded':null};
      });
      reboundGuard(previous,next,isCurrent);if(!repository.matchesCumulative(next,selection))throw new Error('重载读取权威已变化');
      const primary=tasks.find(task=>task.taskId===taskId)??tasks.at(-1)??null;
      const receipt=frozen(structuredClone({status:'readback',previousTarget:previous,nextTarget:next,root,selection,tasks,outcome:primary?.outcome??null,reviewResolution:primary?.reviewResolution??null}));
      // Only confirmed authority ends old tickets. Original target, snapshot and
      // selection remain attached to the old task and can never adopt in next.
      for(const task of tasks){const record=records.get(task.taskId);record.outcome=task.outcome;record.reviewResolution=task.reviewResolution;record.rebindRequired=false;record.receipt=receipt;manager.cancel(task.taskId);notify(task.taskId);}
      reboundReceipts.add(receipt);return receipt;
    },
    matchesReboundReadback(receipt){try{return !disposed&&reboundReceipts.has(receipt)&&sameTarget(receipt.nextTarget,repository.captureTarget())&&repository.matchesCumulative(receipt.nextTarget,receipt.selection);}catch{return false;}},
    async reconcile(taskId){const record=records.get(taskId),state=inspect(taskId);if(!record||record.outcome!=='unconfirmed')return null;
      const root=await repository.read(state.target),selection={target:structuredClone(state.target),cumulative:cumulativeOf(root)},domain=selection.cumulative;
      const committed=domain.versions.find(version=>version.taskId===(state.candidate?.version.taskId??record.pendingId??state.snapshot.operationId));
      record.outcome=committed?'recovered-committed':domain.pending?.id===record.pendingId?'recovered-pending':'recovered-previous';
      if(committed)record.reviewResolution='committed';else if(record.discardAttempted&&!domain.pending)record.reviewResolution='discarded';
      record.selection=selection;record.receipt={status:'readback',root,selection};
      // A discarded readback is a completed storage action even if the manager
      // was still awaiting review when the uncertain clear was attempted.
      if(record.reviewResolution==='discarded')manager.cancel(taskId);
      notify(taskId);return structuredClone(record.receipt);
    },
    subscribe(listener){if(typeof listener!=='function')throw new TypeError('Observer must be a function');listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){if(disposed)return;disposed=true;for(const id of records.keys())manager.cancel(id);release();listeners.clear();},
  };
  return Object.freeze(service);
}
