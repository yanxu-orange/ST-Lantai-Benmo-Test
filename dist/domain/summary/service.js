import { sameTarget } from '../memory/repository.js';
import { equalData, exactKeys, validateIndexes } from '../memory/management-validation.js';
import { validDrafts, draftsToEvents, applyIndexes, reviewEvents, normalizeSummaryAliases, normalizeSummaryLocationAliases } from './candidates.js';
import { buildSummaryRequest, summaryStages, summaryPreview } from './requests.js';
import { prepareSummarySource, matchesSummarySource, matchesStoredSummarySource, storedSummarySource } from './source.js';
import { publicSummarySettingsEvidence, normalizedSummarySettingsEvidence, publicSummaryTrackingTicket } from './data.js';
import { prepareBatchTracking, applyBatchTracking } from '../tracking/batch.js';
import { parseBatchTrackingResponseParts } from '../tracking/requests.js';

// Uses the shared manager/provider. Chat transactions remain repository-owned.
export function createEventSummaryService({repository,manager,provider,getGenerationSettings,captureSource,getTrackingContext=()=>({identities:{},allowed:{itemsEnabled:true,npcsEnabled:true}}),control=null,afterSummaryCommit=null,retrySummaryCommit=null,skipSummaryCommit=null,getPendingNarrative=null,uuid=()=>crypto.randomUUID()}={}) {
  const records=new Map(),listeners=new Set(),reservations=new Set(),restorations=new Map();
  const readSettings=()=>structuredClone(getGenerationSettings());
  const durableTrackingContext=context=>({identities:context.identities??{},allowed:context.allowed??{itemsEnabled:true,npcsEnabled:true}});
  const readTrackingContext=()=>{const context=getTrackingContext();return structuredClone({...durableTrackingContext(context),...(context.proofs?{proofs:{items:context.proofs.items??null,npcs:context.proofs.npcs??null}}:{})});};
  function targetCurrent(snapshot,target) {
    try{return sameTarget(target,repository.captureTarget())&&equalData(snapshot.settings,readSettings())&&equalData(snapshot.identities??{},readTrackingContext().identities)&&(!snapshot.tracking||equalData(snapshot.tracking.context,readTrackingContext()));}catch{return false;}
  }
  function sourceCurrent(snapshot,target) {
    const record=[...records.values()].find(item=>item.operationId===snapshot.operationId);
    try{return repository.matchesSummary(target,record?.selection??snapshot.selection)&&(!snapshot.tracking||repository.matchesTrackingRevision(target,snapshot.tracking.ticket.revision))&&matchesSummarySource(snapshot.source,captureSource(target));}catch{return false;}
  }
  const available=settings=>settings.eventWords.filter(item=>item.enabled!==false).map(item=>item.name);
  function notify(taskId) {const value=inspect(taskId);if(value)for(const listener of [...listeners])try{listener(value);}catch{/* observers cannot stop a task */}}
  function inspect(taskId) {const record=records.get(taskId),task=manager.inspect(taskId)??record?.restoredTask;return task&&record?{...task,...(task.status==='succeeded'&&record.narrative?.status==='running'?{status:'narrative-running'}:task.status==='succeeded'&&record.narrative?.status==='failed'?{status:'narrative-failed'}:{}),narrative:record.narrative?{...record.narrative}:null,stage:record.stage,origin:record.origin,outcome:record.outcome,receipt:record.receipt,errorMessage:record.errorMessage,restoreOnly:record.restoreOnly,diagnostics:structuredClone(record.diagnostics),trackingRejected:structuredClone(record.trackingRejected??record.trackingParts?.rejected??null)}:null;}
  // The memory transaction has already completed. Narrative failures never enter
  // the guarded commit and cannot undo or retry the saved memory batch.
  async function runNarrative(taskId,work) {
    const record=records.get(taskId);
    if(record.narrativePromise)return record.narrativePromise;
    record.narrative={status:'running',error:''};record.stage='narrative';notify(taskId);
    record.narrativePromise=Promise.resolve().then(work).then(result=>{
      record.narrative={status:result?.run?.status==='skipped'?'skipped':'succeeded',error:''};record.errorMessage='';
    }).catch(error=>{record.narrative={status:'failed',error:error.message};record.errorMessage=`本批记忆已保存；自述与大纲未完成：${error.message}`;}).finally(()=>{record.narrativePromise=null;notify(taskId);});
    await record.narrativePromise;return inspect(taskId);
  }
  const busyStatuses=['starting','running','awaiting-user','committing','narrative-running','narrative-failed'];
  const isBusy=(target=repository.captureTarget())=>reservations.has(target.chatId)||[...records.keys()].some(id=>{const state=inspect(id);return state&&sameTarget(state.target,target)&&busyStatuses.includes(state.status);});
  async function capture(origin,options={}) {
    const target=repository.captureTarget(),selection=origin==='regeneration'?await repository.captureBatch(target,options.batchId):await repository.captureSummary(target),settings=readSettings();
    const preferences=selection.summary.preferences[origin==='auto'?'auto':'manual'];
    const stored=selection.batch,range=stored?.actualRange??{start:options.startFloor??preferences.startFloor,end:options.endFloor??preferences.endFloor};
    if(stored&&selection.events.some(event=>event.supersededBy||event.mergedFrom))throw new Error('批成员参与合并，不能破坏撤销关系');
    const params={...preferences,...options};
    const raw=captureSource(target);
    if(options.resumePending&&!matchesStoredSummarySource(options.resumePending.sourceSnapshot,raw))throw new Error('保留草稿的来源定位已变化');
    if(stored&&!matchesStoredSummarySource(stored.sourceSnapshot,raw))throw new Error('原批来源已变化或隐藏楼层角色无法确认；请按当前范围重新总结');
    const savedSource=stored?.sourceSnapshot??options.resumePending?.sourceSnapshot;
    const source=prepareSummarySource(raw,{startFloor:range.start,endFloor:range.end,includeUser:savedSource?.includeUser??params.includeUser,excludedFloors:savedSource?.excludedFloors??selection.summary.excludedFloors,rules:settings.summaryCleaning.rules});
    const snapshot={target,selection,settings,source,identities:readTrackingContext().identities,origin,operationId:uuid(),params:{includeUser:params.includeUser,reviewBeforeCommit:origin==='regeneration'||params.reviewBeforeCommit,hideOriginal:stored?.hideOriginal??params.hideOriginal},batchId:stored?.id??options.resumePending?.batchId??uuid()};
    const trackingPreferences={itemsEnabled:settings.trackingItemsEnabled===true,npcsEnabled:settings.trackingNpcsEnabled===true};
    if(trackingPreferences.itemsEnabled||trackingPreferences.npcsEnabled){
      const context=readTrackingContext();
      for(const list of ['items','npcs'])if(trackingPreferences[`${list}Enabled`]&&context.allowed?.[`${list}Enabled`]===false)throw new Error(list==='items'?'物品追踪功能已关闭，请先开启或取消同步追踪':'角色追踪功能已关闭，请先开启或取消同步追踪');
      const tracking=await repository.captureTracking(target),ticket=prepareBatchTracking(tracking.tracking,raw,source,trackingPreferences,{batchId:snapshot.batchId});
      snapshot.tracking={ticket,context};
      const resumed=options.resumePending?.tracking;
      if(options.resumePending&&!resumed)throw new Error('保留草稿缺少同步追踪证据，请重新总结');
      if(resumed){if(!equalData(publicSummaryTrackingTicket(resumed.ticket),publicSummaryTrackingTicket(ticket))||!equalData(durableTrackingContext(resumed.context),durableTrackingContext(context)))throw new Error('保留草稿的追踪资料已变化，请重新总结');}
    }
    if(!targetCurrent(snapshot,target)||!sourceCurrent(snapshot,target))throw new Error('聊天来源或总结设置已变化');
    return snapshot;
  }
  async function request(stage,ctx,snapshot,events) {
    await repository.read(ctx.target);
    const current=()=>!ctx.signal.aborted&&targetCurrent(snapshot,ctx.target)&&sourceCurrent(snapshot,ctx.target);
    if(!current())throw new Error('聊天来源或总结设置已变化');
    const spec=buildSummaryRequest(stage,{origin:snapshot.origin,source:snapshot.source,events,settings:snapshot.settings,identities:snapshot.identities,tracking:snapshot.tracking?{ticket:snapshot.tracking.ticket,...snapshot.tracking.context}:null}),ids=events.map(event=>event.id),names=available(snapshot.settings);
    const validateRaw=data=>{
      if(stage==='fast'||stage.endsWith('Summary'))return validDrafts(data,{complete:stage==='fast',availableNames:names});
      if(stage==='qualityIndexes')return validateIndexes(data,ids,names);
      if(!exactKeys(data,['indexes'])||!Array.isArray(data.indexes)||data.indexes.length!==ids.length)return false;
      if(stage==='enhancedKeywords')return data.indexes.every(item=>exactKeys(item,['draftId','eventKeywords','detailKeywords']))&&validateIndexes({indexes:data.indexes.map(item=>({...item,detailAliases:[]}))},ids,names);
      return data.indexes.every(item=>exactKeys(item,['draftId','detailAliases']))&&validateIndexes({indexes:data.indexes.map(item=>{const event=events.find(event=>event.id===item.draftId);return {...item,eventKeywords:event?.eventWords??[],detailKeywords:event?.detailWords.map(term=>term.word)??[]};})},ids,names);
    };
    const trackingStage=!!snapshot.tracking&&(stage==='fast'||stage.endsWith('Summary'));
    const eventData=data=>{if(!trackingStage||!data||typeof data!=='object'||Array.isArray(data))return data;const {tracking,...events}=data;return events;};
    const normalize=data=>{
      const details=['fast','qualityIndexes','aliases'].includes(stage)?normalizeSummaryAliases(data,{stage,events}):{data,diagnostics:[]};
      const locations=stage==='fast'||stage.endsWith('Summary')?normalizeSummaryLocationAliases(details.data):{data:details.data,diagnostics:[]};
      return {data:locations.data,diagnostics:[...details.diagnostics,...locations.diagnostics]};
    };
    const validate=data=>{try{return validateRaw(normalize(eventData(data)).data);}catch{return false;}};
    records.get(ctx.taskId).stage=stage;notify(ctx.taskId);
    const output=await provider.generateJson({...spec,signal:ctx.signal,isCurrent:current,validate});
    if(!current()||!validate(output.data))throw new Error('总结结果或来源无效');
    const normalized=normalize(eventData(output.data)),record=records.get(ctx.taskId);record.diagnostics.push(...normalized.diagnostics);
    if(trackingStage){record.trackingParts=parseBatchTrackingResponseParts(output.data?.tracking,{ticket:snapshot.tracking.ticket});for(const [list,error] of Object.entries(record.trackingParts.errors))if(error)record.diagnostics.push({kind:'tracking',category:list,message:error});}
    return normalized.data;
  }
  async function confirm(taskId,edited) {
    if(control&&!control.allowed()){const record=records.get(taskId);if(record)record.autoConfirmPaused=!record.reviewRequired;return {status:'paused'};}
    const record=records.get(taskId),state=inspect(taskId);
    if(!record||record.outcome==='unconfirmed'||!state?.candidate)return {status:'rejected'};
    let events;
    try{events=reviewEvents(edited??state.candidate.events,state.candidate.events);}catch(error){return {status:'invalid',error:error.message};}
    const result=await manager.confirm(taskId,async ctx=>{
      await repository.read(ctx.target);
      const snapshot=ctx.snapshot,selection=record.selection??snapshot.selection;
      const batch={id:snapshot.batchId,taskId:`${taskId}:${snapshot.operationId}`,sourceType:snapshot.selection.batch?.sourceType??snapshot.origin,requestedRange:snapshot.source.requestedRange,actualRange:snapshot.source.actualRange,sourceSnapshot:storedSummarySource(snapshot.source),settingsEvidence:snapshot.settings,generationMode:{fast:'one',quality:'two',enhanced:'three'}[snapshot.settings.generationMode],hideOriginal:snapshot.params.hideOriginal,generatedCandidates:ctx.candidate.generatedCandidates};
      try{
        const options={isCurrent:ctx.isCurrent,...(record.pendingId?{pendingId:record.pendingId}:{})};
        if(snapshot.tracking){
          const selected=await repository.captureTracking(ctx.target),applied=applyBatchTracking(selected.tracking,snapshot.tracking.ticket,ctx.candidate.trackingParts,captureSource(ctx.target),{makeId:uuid,batchId:snapshot.batchId});
          options.trackingUpdate={expectedRevision:snapshot.tracking.ticket.revision,value:applied.tracking};
          record.trackingErrors=applied.errors;
          record.trackingRejected=applied.rejected??null;
          record.diagnostics=record.diagnostics.filter(row=>row.kind!=='tracking');
          for(const [category,message] of Object.entries(applied.errors))if(message)record.diagnostics.push({kind:'tracking',category,message});
        }
        const receipt=snapshot.origin==='regeneration'?await repository.replaceBatch(ctx.target,selection,events,batch,options):await repository.appendBatch(ctx.target,selection,events,batch,options);
        record.receipt=receipt;if(receipt?.status==='committed'&&afterSummaryCommit)record.narrative={status:'running',error:''};return receipt;
      }catch(error){if(error.code==='COMMIT_UNCONFIRMED')record.outcome='unconfirmed';record.errorMessage=error.message;throw error;}
    });
    if(result.status==='succeeded'&&record.narrative?.status==='running'){const {start,end}=state.snapshot.source.actualRange;await runNarrative(taskId,()=>afterSummaryCommit({target:state.target,startFloor:start,endFloor:end}));}
    notify(taskId);return {...result,...(result.status==='succeeded'?{status:inspect(taskId).status}:{}),outcome:record.outcome};
  }
  const release=manager.subscribe(state=>{
    const record=records.get(state.taskId);if(!record)return;
    notify(state.taskId);
    if(state.status==='awaiting-user'&&!state.reviewPending&&!record.reviewRequired&&!record.autoConfirmScheduled){record.autoConfirmScheduled=true;queueMicrotask(()=>void confirm(state.taskId).then(result=>{if(result.status==='invalid'){record.errorMessage=result.error;record.invalidAuto=true;notify(state.taskId);}}));}
  });
    return Object.freeze({
    async preview(origin,options) {const snapshot=await capture(origin,options);return {...summaryPreview(snapshot.source,snapshot.settings,snapshot.tracking?{ticket:snapshot.tracking.ticket,...snapshot.tracking.context}:null,snapshot.identities,snapshot.origin),snapshot};},
    async start(origin='manual',options={}) {
      const operationProof=control?.capture();if(control&&!control.allowed())throw new Error('功能已关闭');
      if(!['manual','auto','regeneration'].includes(origin))throw new Error('总结来源无效');
      const key=repository.captureTarget().chatId;if(reservations.has(key))throw new Error('当前聊天已有总结任务');reservations.add(key);
      try{
      if([...records.keys()].some(id=>{const state=inspect(id);return state&&sameTarget(state.target,repository.captureTarget())&&busyStatuses.includes(state.status);}))throw new Error('当前聊天已有总结任务，请先完成本批');
      if(await getPendingNarrative?.())throw new Error('请先继续、重试或跳过当前自述与大纲批次');
      const snapshot=await capture(origin,options),resume=options.resumePending;
      if(control&&!control.matches(operationProof))throw new Error('功能开关已变化，请重新开始');
      if(snapshot.selection.summary.pending&&!resume)throw new Error('请先处理已保留的总结草稿');
      if(resume&&snapshot.selection.summary.pending?.id!==resume.id)throw new Error('总结草稿已变化');
      if(resume)snapshot.batchId=resume.batchId;
      const execution={origin,operationId:snapshot.operationId,stage:'starting',selection:snapshot.selection,reviewRequired:!!resume||snapshot.params.reviewBeforeCommit,restoreOnly:options.restoreOnly===true,outcome:null,receipt:null,errorMessage:'',autoConfirmScheduled:false,pendingId:resume?.id??null,diagnostics:Object.entries(resume?.tracking?.parts?.errors??{}).flatMap(([category,message])=>message?[{kind:'tracking',category,message}]:[]),trackingParts:structuredClone(resume?.tracking?.parts??null)};
      const taskId=manager.start({key:`event-summary:${snapshot.target.chatId}`,target:snapshot.target,snapshot,validateCurrent:target=>targetCurrent(snapshot,target),validateSnapshot:sourceCurrent,worker:async ctx=>{
        let events=structuredClone(resume?.events??[]),generatedCandidates=structuredClone(resume?.generatedCandidates??[]),completedStages=[...(resume?.completedStages??[])];
        const stages=summaryStages(ctx.snapshot.settings.generationMode);
        if(options.restoreOnly){execution.reviewRequired=true;execution.stage=resume.failedStage??'final-review';return {kind:'event-summary',events,generatedCandidates,incomplete:!!resume.nextStage,nextStage:resume.nextStage,trackingParts:execution.trackingParts};}
        for(const stage of stages.slice(resume?(resume.nextStage===null?stages.length:stages.indexOf(resume.nextStage)):0)) {
          let output;
          try{output=await request(stage,ctx,ctx.snapshot,events);}catch(error){
            if(!events.length||snapshot.origin==='regeneration'||!targetCurrent(snapshot,ctx.target)||!sourceCurrent(snapshot,ctx.target)||ctx.signal.aborted)throw error;
            const now=new Date().toISOString();
            const pending={schema:1,id:execution.pendingId??snapshot.operationId,batchId:snapshot.batchId,origin:snapshot.origin,generationMode:{fast:'one',quality:'two',enhanced:'three'}[snapshot.settings.generationMode],completedStages,nextStage:stage,failedStage:stage,events,generatedCandidates,sourceSnapshot:storedSummarySource(snapshot.source),settingsEvidence:snapshot.settings,params:snapshot.params,createdAt:resume?.createdAt??now,updatedAt:now,...(snapshot.tracking?{tracking:{ticket:publicSummaryTrackingTicket(snapshot.tracking.ticket),context:durableTrackingContext(snapshot.tracking.context),parts:execution.trackingParts}}:{})};
            let receipt;
            try{receipt=await repository.saveSummaryPending(ctx.target,execution.selection,pending,{isCurrent:()=>!ctx.signal.aborted&&targetCurrent(snapshot,ctx.target)&&sourceCurrent(snapshot,ctx.target)});}catch(writeError){if(writeError.code==='COMMIT_UNCONFIRMED')execution.outcome='unconfirmed';execution.errorMessage=writeError.message;throw writeError;}
            execution.selection=receipt.selection;execution.pendingId=pending.id;execution.reviewRequired=true;execution.errorMessage='后续生成失败，已保留正文；可重试后续阶段或编辑后明确采用。';
            return {kind:'event-summary',events,generatedCandidates,incomplete:true,nextStage:stage,trackingParts:execution.trackingParts};
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
        return {kind:'event-summary',events,generatedCandidates,...(snapshot.tracking?{trackingParts:execution.trackingParts}:{})};
      }});
      records.set(taskId,execution);notify(taskId);return taskId;
      }finally{reservations.delete(key);}
    },
    resumeAutoConfirm(){for(const [id,record]of records)if(record.autoConfirmPaused&&control?.allowed()){record.autoConfirmPaused=false;queueMicrotask(()=>void confirm(id));}},
    confirm,inspect,isBusy,
    async restorePendingNarrative(origin='manual'){
      const target=repository.captureTarget(),key=JSON.stringify([target.chatId,target.rootId,target.epoch]);
      if(restorations.has(key))return restorations.get(key);
      const existing=()=>[...records.keys()].find(id=>{const task=inspect(id);return task&&sameTarget(task.target,target)&&['narrative-running','narrative-failed'].includes(task.status);});
      const id=existing();if(id)return id;
      const work=(async()=>{
        const pending=await getPendingNarrative?.();
        if(!pending?.summary||(pending.summarySource??'event')!=='event'||!sameTarget(target,repository.captureTarget())||!sameTarget(target,pending.target))return null;
        const selection=await repository.captureSummary(target);
        if(!sameTarget(target,repository.captureTarget()))return null;
        const previous=existing();if(previous)return previous;
        const taskId=`narrative-restored:${uuid()}`;
        records.set(taskId,{origin,stage:'narrative',outcome:null,receipt:null,errorMessage:'本批记忆已保存，请继续自述与大纲或跳过本批',diagnostics:[],narrative:{status:'failed',error:pending.error??''},restoredTask:{taskId,status:'succeeded',attempt:1,target,snapshot:{target,selection,params:selection.summary.preferences[origin],source:{actualRange:{start:pending.range.startFloor,end:pending.range.endFloor}}}}});
        notify(taskId);return taskId;
      })();
      restorations.set(key,work);try{return await work;}finally{if(restorations.get(key)===work)restorations.delete(key);}
    },
    async retryNarrative(taskId){const record=records.get(taskId),state=inspect(taskId);if(!retrySummaryCommit||state?.status!=='narrative-failed'||!sameTarget(state.target,repository.captureTarget()))return false;return runNarrative(taskId,()=>retrySummaryCommit());},
    async skipNarrative(taskId){const record=records.get(taskId),state=inspect(taskId);if(!skipSummaryCommit||state?.status!=='narrative-failed'||!sameTarget(state.target,repository.captureTarget()))return false;return runNarrative(taskId,async()=>{await skipSummaryCommit();return {run:{status:'skipped'}};});},
    settled:taskId=>manager.settled(taskId),
    completed(taskId) {
      return new Promise(resolve=>{
        const check=()=>{const state=inspect(taskId),record=records.get(taskId);if(!state||['succeeded','failed','stale','cancelled','narrative-failed'].includes(state.status)||state.status==='awaiting-user'&&record.reviewRequired){stop?.();resolve(state);}};
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
      if(!matchesStoredSummarySource(pending.sourceSnapshot,captureSource(target)))throw new Error('保留草稿的来源已变化或隐藏楼层角色无法确认；请按当前范围重新总结');
      const current=publicSummarySettingsEvidence(readSettings()),saved=pending.settingsEvidence;
      if(!equalData(normalizedSummarySettingsEvidence(current),normalizedSummarySettingsEvidence(saved)))throw new Error('保留草稿的生成配置已变化');
      return this.start(pending.origin,{...pending.params,startFloor:pending.sourceSnapshot.actualRange.start,endFloor:pending.sourceSnapshot.actualRange.end,resumePending:pending,restoreOnly:true});
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
          return this.start(pending.origin,{...pending.params,startFloor:pending.sourceSnapshot.actualRange.start,endFloor:pending.sourceSnapshot.actualRange.end,resumePending:pending});
        })();
      }
      record.autoConfirmScheduled=false;return manager.retry(taskId)?taskId:false;
    },
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){release();for(const id of records.keys())manager.cancel(id);listeners.clear();}
  });
}
