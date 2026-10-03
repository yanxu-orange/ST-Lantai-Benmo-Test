import { sameTarget } from '../memory/repository.js';
import { equalData, exactKeys, validateIndexes } from '../memory/management-validation.js';
import { validDrafts, draftsToEvents, applyIndexes, reviewEvents, normalizeSummaryAliases } from './candidates.js';
import { buildSummaryRequest, summaryStages, summaryPreview } from './requests.js';
import { prepareSummarySource, matchesSummarySource, matchesStoredSummarySource } from './source.js';
import { publicSummarySettingsEvidence } from './data.js';

// Uses the shared manager/provider. Chat transactions remain repository-owned.
export function createEventSummaryService({repository,manager,provider,getGenerationSettings,captureSource,uuid=()=>crypto.randomUUID()}={}) {
  const records=new Map(),listeners=new Set(),reservations=new Set();
  const readSettings=()=>structuredClone(getGenerationSettings());
  function targetCurrent(snapshot,target) {
    try{return sameTarget(target,repository.captureTarget())&&equalData(snapshot.settings,readSettings());}catch{return false;}
  }
  function sourceCurrent(snapshot,target) {
    const record=[...records.values()].find(item=>item.operationId===snapshot.operationId);
    try{return repository.matchesSummary(target,record?.selection??snapshot.selection)&&matchesSummarySource(snapshot.source,captureSource(target));}catch{return false;}
  }
  const available=settings=>settings.eventWords.filter(item=>item.enabled!==false).map(item=>item.name);
  function notify(taskId) {const value=inspect(taskId);if(value)for(const listener of [...listeners])try{listener(value);}catch{/* observers cannot stop a task */}}
  function inspect(taskId) {const task=manager.inspect(taskId),record=records.get(taskId);return task&&record?{...task,stage:record.stage,origin:record.origin,outcome:record.outcome,receipt:record.receipt,errorMessage:record.errorMessage,restoreOnly:record.restoreOnly,diagnostics:structuredClone(record.diagnostics)}:null;}
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
    const validateRaw=data=>{
      if(stage==='fast'||stage.endsWith('Summary'))return validDrafts(data,{complete:stage==='fast',availableNames:names});
      if(stage==='qualityIndexes')return validateIndexes(data,ids,names);
      if(!exactKeys(data,['indexes'])||!Array.isArray(data.indexes)||data.indexes.length!==ids.length)return false;
      if(stage==='enhancedKeywords')return data.indexes.every(item=>exactKeys(item,['draftId','eventKeywords','detailKeywords']))&&validateIndexes({indexes:data.indexes.map(item=>({...item,detailAliases:[]}))},ids,names);
      return data.indexes.every(item=>exactKeys(item,['draftId','detailAliases']))&&validateIndexes({indexes:data.indexes.map(item=>{const event=events.find(event=>event.id===item.draftId);return {...item,eventKeywords:event?.eventWords??[],detailKeywords:event?.detailWords.map(term=>term.word)??[]};})},ids,names);
    };
    const normalize=data=>['fast','qualityIndexes','aliases'].includes(stage)?normalizeSummaryAliases(data,{stage,events}):{data,diagnostics:[]};
    const validate=data=>{try{return validateRaw(normalize(data).data);}catch{return false;}};
    records.get(ctx.taskId).stage=stage;notify(ctx.taskId);
    const output=await provider.generateJson({...spec,signal:ctx.signal,isCurrent:current,validate});
    if(!current()||!validate(output.data))throw new Error('总结结果或来源无效');
    const normalized=normalize(output.data);records.get(ctx.taskId).diagnostics.push(...normalized.diagnostics);return normalized.data;
  }
  async function confirm(taskId,edited) {
    const record=records.get(taskId),state=inspect(taskId);
    if(!record||record.outcome==='unconfirmed'||!state?.candidate)return {status:'rejected'};
    let events;
    try{events=reviewEvents(edited??state.candidate.events,state.candidate.events);}catch(error){return {status:'invalid',error:error.message};}
    const result=await manager.confirm(taskId,async ctx=>{
      await repository.read(ctx.target);
      const snapshot=ctx.snapshot,selection=record.selection??snapshot.selection;
      const batch={id:snapshot.batchId,taskId:`${taskId}:${snapshot.operationId}`,sourceType:snapshot.selection.batch?.sourceType??snapshot.origin,requestedRange:snapshot.source.requestedRange,actualRange:snapshot.source.actualRange,sourceSnapshot:snapshot.source,settingsEvidence:snapshot.settings,generationMode:{fast:'one',quality:'two',enhanced:'three'}[snapshot.settings.generationMode],hideOriginal:snapshot.params.hideOriginal,generatedCandidates:ctx.candidate.generatedCandidates};
      try{
        const options={isCurrent:ctx.isCurrent,...(record.pendingId?{pendingId:record.pendingId}:{})};
        const receipt=snapshot.origin==='regeneration'?await repository.replaceBatch(ctx.target,selection,events,batch,options):await repository.appendBatch(ctx.target,selection,events,batch,options);
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
      const snapshot=await capture(origin,options),resume=options.resumePending;
      if(snapshot.selection.summary.pending&&!resume)throw new Error('请先处理已保留的总结草稿');
      if(resume&&snapshot.selection.summary.pending?.id!==resume.id)throw new Error('总结草稿已变化');
      if(resume)snapshot.batchId=resume.batchId;
      const execution={origin,operationId:snapshot.operationId,stage:'starting',selection:snapshot.selection,reviewRequired:!!resume||snapshot.params.reviewBeforeCommit,restoreOnly:options.restoreOnly===true,outcome:null,receipt:null,errorMessage:'',autoConfirmScheduled:false,pendingId:resume?.id??null,diagnostics:[]};
      const taskId=manager.start({key:`event-summary:${snapshot.target.chatId}`,target:snapshot.target,snapshot,validateCurrent:target=>targetCurrent(snapshot,target),validateSnapshot:sourceCurrent,worker:async ctx=>{
        let events=structuredClone(resume?.events??[]),generatedCandidates=structuredClone(resume?.generatedCandidates??[]),completedStages=[...(resume?.completedStages??[])];
        const stages=summaryStages(ctx.snapshot.settings.generationMode);
        if(options.restoreOnly){execution.reviewRequired=true;execution.stage=resume.failedStage??'final-review';return {kind:'event-summary',events,generatedCandidates,incomplete:!!resume.nextStage,nextStage:resume.nextStage};}
        for(const stage of stages.slice(resume?(resume.nextStage===null?stages.length:stages.indexOf(resume.nextStage)):0)) {
          let output;
          try{output=await request(stage,ctx,ctx.snapshot,events);}catch(error){
            if(!events.length||snapshot.origin==='regeneration'||!targetCurrent(snapshot,ctx.target)||!sourceCurrent(snapshot,ctx.target)||ctx.signal.aborted)throw error;
            const now=new Date().toISOString();
            const pending={schema:1,id:execution.pendingId??snapshot.operationId,batchId:snapshot.batchId,origin:snapshot.origin,generationMode:{fast:'one',quality:'two',enhanced:'three'}[snapshot.settings.generationMode],completedStages,nextStage:stage,failedStage:stage,events,generatedCandidates,sourceSnapshot:snapshot.source,settingsEvidence:snapshot.settings,params:snapshot.params,createdAt:resume?.createdAt??now,updatedAt:now};
            let receipt;
            try{receipt=await repository.saveSummaryPending(ctx.target,execution.selection,pending,{isCurrent:()=>!ctx.signal.aborted&&targetCurrent(snapshot,ctx.target)&&sourceCurrent(snapshot,ctx.target)});}catch(writeError){if(writeError.code==='COMMIT_UNCONFIRMED')execution.outcome='unconfirmed';execution.errorMessage=writeError.message;throw writeError;}
            execution.selection=receipt.selection;execution.pendingId=pending.id;execution.reviewRequired=true;execution.errorMessage='后续生成失败，已保留正文；可重试后续阶段或编辑后明确采用。';
            return {kind:'event-summary',events,generatedCandidates,incomplete:true,nextStage:stage};
          }
          if(stage==='fast'||stage.endsWith('Summary')) {
            generatedCandidates=structuredClone(output.memories);events=draftsToEvents(output,[ctx.snapshot.source.actualRange],uuid);
            if(stage==='fast')events=applyIndexes(events,{indexes:output.memories.map((item,index)=>({draftId:events[index].id,eventKeywords:item.eventKeywords,detailKeywords:item.detailKeywords,detailAliases:item.detailAliases}))},uuid);
          } else if(stage==='aliases')events=events.map(event=>({...event,detailWords:event.detailWords.map(term=>({...term,aliases:output.indexes.find(item=>item.draftId===event.id).detailAliases.find(item=>item.parentDetail===term.word)?.aliases??[]}))}));
          else events=applyIndexes(events,stage==='enhancedKeywords'?{indexes:output.indexes.map(item=>({...item,detailAliases:[]}))}:output,uuid);
          completedStages.push(stage);
          if(execution.pendingId){
            const previous=execution.selection.summary.pending;
            const pending={...previous,events,completedStages:[...completedStages],nextStage:stages[completedStages.length]??null,failedStage:null,updatedAt:new Date().toISOString()};
            try{const receipt=await repository.saveSummaryPending(ctx.target,execution.selection,pending,{isCurrent:()=>!ctx.signal.aborted&&targetCurrent(snapshot,ctx.target)&&sourceCurrent(snapshot,ctx.target)});execution.selection=receipt.selection;}catch(error){if(error.code==='COMMIT_UNCONFIRMED')execution.outcome='unconfirmed';execution.errorMessage=error.message;throw error;}
          }
        }
        if(!ctx.snapshot.params.reviewBeforeCommit)reviewEvents(events,events);
        records.get(ctx.taskId).stage='final-review';
        return {kind:'event-summary',events,generatedCandidates};
      }});
      records.set(taskId,execution);notify(taskId);return taskId;
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
    async discard(taskId){
      const record=records.get(taskId),state=inspect(taskId);if(!record||!state)return false;
      const current=()=>sameTarget(state.target,repository.captureTarget());
      if(!current())return false;
      manager.cancel(taskId);
      if(record.pendingId)await repository.clearSummaryPending(state.target,record.selection,{isCurrent:current});
      return true;
    },
    async discardPending(){const target=repository.captureTarget(),selection=await repository.captureSummary(target);if(!selection.summary.pending)return false;await repository.clearSummaryPending(target,selection,{isCurrent:()=>sameTarget(target,repository.captureTarget())});return true;},
    async restorePending(origin='manual') {
      const target=repository.captureTarget(),selection=await repository.captureSummary(target),pending=selection.summary.pending;
      if(!pending)return null;
      if(!matchesStoredSummarySource(pending.sourceSnapshot,captureSource(target)))throw new Error('保留草稿的来源已变化');
      const current=publicSummarySettingsEvidence(readSettings()),saved=pending.settingsEvidence;
      if(!equalData(current,saved))throw new Error('保留草稿的生成配置已变化');
      return this.start(pending.origin,{...pending.params,startFloor:pending.sourceSnapshot.requestedRange.start,endFloor:pending.sourceSnapshot.requestedRange.end,resumePending:pending,restoreOnly:true});
    },
    retry(taskId,edited){
      const record=records.get(taskId),state=inspect(taskId);if(!record||record.outcome==='unconfirmed'||record.invalidAuto)return false;
      if(state?.candidate?.incomplete||record.pendingId&&state?.status==='failed'){
        if(!targetCurrent(state.snapshot,state.target)||!sourceCurrent(state.snapshot,state.target))return false;
        return (async()=>{
          let pending=record.selection.summary.pending;
          if(edited&&!equalData(edited,pending.events)){
            const events=reviewEvents(edited,state.candidate.events);pending={...pending,events,updatedAt:new Date().toISOString()};
            try{const receipt=await repository.saveSummaryPending(state.target,record.selection,pending,{isCurrent:()=>targetCurrent(state.snapshot,state.target)&&sourceCurrent(state.snapshot,state.target)&&manager.inspect(taskId)?.status==='awaiting-user'});record.selection=receipt.selection;}catch(error){if(error.code==='COMMIT_UNCONFIRMED')record.outcome='unconfirmed';record.errorMessage=error.message;notify(taskId);throw error;}
          }
          if(!targetCurrent(state.snapshot,state.target)||!sourceCurrent(state.snapshot,state.target))return false;
          manager.cancel(taskId);
          return this.start(pending.origin,{...pending.params,startFloor:pending.sourceSnapshot.requestedRange.start,endFloor:pending.sourceSnapshot.requestedRange.end,resumePending:pending});
        })();
      }
      record.autoConfirmScheduled=false;return manager.retry(taskId)?taskId:false;
    },
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){release();for(const id of records.keys())manager.cancel(id);listeners.clear();}
  });
}
