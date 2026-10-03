import { sameTarget } from '../memory/repository.js';
import { equalData, exactKeys, validateIndexes } from '../memory/management-validation.js';
import { validDrafts, draftsToEvents, applyIndexes, reviewEvents } from './candidates.js';
import { buildSummaryRequest, summaryStages, summaryPreview } from './requests.js';
import { prepareSummarySource, matchesSummarySource, matchesStoredSummarySource } from './source.js';

// Uses the shared manager/provider. Chat transactions remain repository-owned.
export function createEventSummaryService({repository,manager,provider,getGenerationSettings,captureSource,uuid=()=>crypto.randomUUID()}={}) {
  const records=new Map(),listeners=new Set(),reservations=new Set();
  const readSettings=()=>structuredClone(getGenerationSettings());
  function targetCurrent(snapshot,target) {
    try{return sameTarget(target,repository.captureTarget())&&equalData(snapshot.settings,readSettings());}catch{return false;}
  }
  function sourceCurrent(snapshot,target) {
    try{return repository.matchesSummary(target,snapshot.selection)&&matchesSummarySource(snapshot.source,captureSource(target));}catch{return false;}
  }
  const available=settings=>settings.eventWords.filter(item=>item.enabled!==false).map(item=>item.name);
  function notify(taskId) {const value=inspect(taskId);if(value)for(const listener of [...listeners])try{listener(value);}catch{/* observers cannot stop a task */}}
  function inspect(taskId) {const task=manager.inspect(taskId),record=records.get(taskId);return task&&record?{...task,stage:record.stage,origin:record.origin,outcome:record.outcome,receipt:record.receipt,errorMessage:record.errorMessage}:null;}
  async function capture(origin,options={}) {
    const target=repository.captureTarget(),selection=origin==='regeneration'?await repository.captureBatch(target,options.batchId):await repository.captureSummary(target),settings=readSettings();
    const preferences=selection.summary.preferences[origin==='auto'?'auto':'manual'];
    const stored=selection.batch,range=stored?.requestedRange??{start:options.startFloor??preferences.startFloor,end:options.endFloor??preferences.endFloor};
    if(stored&&selection.events.some(event=>event.supersededBy||event.mergedFrom))throw new Error('批成员参与合并，不能破坏撤销关系');
    const params={...preferences,...options};
    const raw=captureSource(target);
    if(stored&&!matchesStoredSummarySource(stored.sourceSnapshot,raw))throw new Error('原批来源已变化，不能安全重新生成');
    const source=prepareSummarySource(raw,{startFloor:range.start,endFloor:range.end,includeUser:stored?.sourceSnapshot?.includeUser??params.includeUser,excludedFloors:stored?.sourceSnapshot?.excludedFloors??selection.summary.excludedFloors,rules:settings.summaryCleaning.rules});
    const snapshot={target,selection,settings,source,origin,operationId:uuid(),params:{includeUser:params.includeUser,reviewBeforeCommit:origin==='regeneration'||params.reviewBeforeCommit,hideOriginal:stored?.hideOriginal??params.hideOriginal},batchId:stored?.id??uuid()};
    if(!targetCurrent(snapshot,target)||!sourceCurrent(snapshot,target))throw new Error('聊天来源或总结设置已变化');
    return snapshot;
  }
  async function request(stage,ctx,snapshot,events) {
    await repository.read(ctx.target);
    const current=()=>!ctx.signal.aborted&&targetCurrent(snapshot,ctx.target)&&sourceCurrent(snapshot,ctx.target);
    if(!current())throw new Error('聊天来源或总结设置已变化');
    const spec=buildSummaryRequest(stage,{source:snapshot.source,events,settings:snapshot.settings}),ids=events.map(event=>event.id),names=available(snapshot.settings);
    const validate=data=>{
      if(stage==='fast'||stage.endsWith('Summary'))return validDrafts(data,{complete:stage==='fast',availableNames:names});
      if(stage==='qualityIndexes')return validateIndexes(data,ids,names);
      if(!exactKeys(data,['indexes'])||!Array.isArray(data.indexes)||data.indexes.length!==ids.length)return false;
      if(stage==='enhancedKeywords')return data.indexes.every(item=>exactKeys(item,['draftId','eventKeywords','detailKeywords']))&&validateIndexes({indexes:data.indexes.map(item=>({...item,detailAliases:[]}))},ids,names);
      return data.indexes.every(item=>exactKeys(item,['draftId','detailAliases']))&&validateIndexes({indexes:data.indexes.map(item=>{const event=events.find(event=>event.id===item.draftId);return {...item,eventKeywords:event?.eventWords??[],detailKeywords:event?.detailWords.map(term=>term.word)??[]};})},ids,names);
    };
    records.get(ctx.taskId).stage=stage;notify(ctx.taskId);
    const output=await provider.generateJson({...spec,signal:ctx.signal,isCurrent:current,validate});
    if(!current()||!validate(output.data))throw new Error('总结结果或来源无效');
    return output.data;
  }
  async function confirm(taskId,edited) {
    const record=records.get(taskId),state=inspect(taskId);
    if(!record||record.outcome==='unconfirmed'||!state?.candidate)return {status:'rejected'};
    let events;
    try{events=reviewEvents(edited??state.candidate.events,state.candidate.events);}catch(error){return {status:'invalid',error:error.message};}
    const result=await manager.confirm(taskId,async ctx=>{
      await repository.read(ctx.target);
      const snapshot=ctx.snapshot;
      const batch={id:snapshot.batchId,taskId:`${taskId}:${snapshot.operationId}`,sourceType:snapshot.selection.batch?.sourceType??snapshot.origin,requestedRange:snapshot.source.requestedRange,actualRange:snapshot.source.actualRange,sourceSnapshot:snapshot.source,settingsEvidence:snapshot.settings,generationMode:{fast:'one',quality:'two',enhanced:'three'}[snapshot.settings.generationMode],hideOriginal:snapshot.params.hideOriginal,generatedCandidates:ctx.candidate.generatedCandidates};
      try{
        const receipt=snapshot.origin==='regeneration'?await repository.replaceBatch(ctx.target,snapshot.selection,events,batch,{isCurrent:ctx.isCurrent}):await repository.appendBatch(ctx.target,snapshot.selection,events,batch,{isCurrent:ctx.isCurrent});
        record.receipt=receipt;return receipt;
      }catch(error){if(error.code==='COMMIT_UNCONFIRMED')record.outcome='unconfirmed';record.errorMessage=error.message;throw error;}
    });
    notify(taskId);return {...result,outcome:record.outcome};
  }
  const release=manager.subscribe(state=>{
    const record=records.get(state.taskId);if(!record)return;
    notify(state.taskId);
    if(state.status==='awaiting-user'&&!state.reviewPending&&!record.reviewRequired&&!record.autoConfirmScheduled){record.autoConfirmScheduled=true;queueMicrotask(()=>void confirm(state.taskId).then(result=>{if(result.status==='invalid'){record.errorMessage=result.error;record.invalidAuto=true;notify(state.taskId);}}));}
  });
    return Object.freeze({
    async preview(origin,options) {const snapshot=await capture(origin,options);return {...summaryPreview(snapshot.source,snapshot.settings),snapshot};},
    async start(origin='manual',options={}) {
      if(!['manual','auto','regeneration'].includes(origin))throw new Error('总结来源无效');
      const key=repository.captureTarget().chatId;if(reservations.has(key))throw new Error('当前聊天已有总结任务');reservations.add(key);
      try{
      for(const id of records.keys()){const state=inspect(id);if(state&&sameTarget(state.target,repository.captureTarget())&&['starting','running','awaiting-user','committing'].includes(state.status))throw new Error('当前聊天已有总结任务');}
      const snapshot=await capture(origin,options);
      const taskId=manager.start({key:`event-summary:${snapshot.target.chatId}`,target:snapshot.target,snapshot,validateCurrent:target=>targetCurrent(snapshot,target),validateSnapshot:sourceCurrent,worker:async ctx=>{
        let events=[],generatedCandidates=[];
        for(const stage of summaryStages(ctx.snapshot.settings.generationMode)) {
          const output=await request(stage,ctx,ctx.snapshot,events);
          if(stage==='fast'||stage.endsWith('Summary')) {
            generatedCandidates=structuredClone(output.memories);events=draftsToEvents(output,[ctx.snapshot.source.actualRange],uuid);
            if(stage==='fast')events=applyIndexes(events,{indexes:output.memories.map((item,index)=>({draftId:events[index].id,eventKeywords:item.eventKeywords,detailKeywords:item.detailKeywords,detailAliases:item.detailAliases}))},uuid);
          } else if(stage==='aliases')events=events.map(event=>({...event,detailWords:event.detailWords.map(term=>({...term,aliases:output.indexes.find(item=>item.draftId===event.id).detailAliases.find(item=>item.parentDetail===term.word)?.aliases??[]}))}));
          else events=applyIndexes(events,stage==='enhancedKeywords'?{indexes:output.indexes.map(item=>({...item,detailAliases:[]}))}:output,uuid);
        }
        if(!ctx.snapshot.params.reviewBeforeCommit)reviewEvents(events,events);
        records.get(ctx.taskId).stage='final-review';
        return {kind:'event-summary',events,generatedCandidates};
      }});
      records.set(taskId,{origin,stage:'starting',reviewRequired:snapshot.params.reviewBeforeCommit,outcome:null,receipt:null,errorMessage:'',autoConfirmScheduled:false});notify(taskId);return taskId;
      }finally{reservations.delete(key);}
    },
    confirm,inspect,settled:taskId=>manager.settled(taskId),
    completed(taskId) {
      return new Promise(resolve=>{
        const check=()=>{const state=inspect(taskId),record=records.get(taskId);if(!state||['succeeded','failed','stale','cancelled'].includes(state.status)||state.status==='awaiting-user'&&record.reviewRequired){stop?.();resolve(state);}};
        let stop=null;stop=this.subscribe(state=>{if(state.taskId===taskId)check();});check();
      });
    },
    cancel:taskId=>records.has(taskId)&&manager.cancel(taskId),
    retry(taskId){const record=records.get(taskId);if(!record||record.outcome==='unconfirmed'||record.invalidAuto)return false;record.autoConfirmScheduled=false;return manager.retry(taskId);},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){release();for(const id of records.keys())manager.cancel(id);listeners.clear();}
  });
}
