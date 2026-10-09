import {sourceFingerprint} from './source.js';
import {validateEvent} from '../memory/event-model.js';
const copy=value=>structuredClone(value);
const validRange=value=>value&&Number.isSafeInteger(value.start)&&value.start>=0&&Number.isSafeInteger(value.end)&&value.end>=value.start;
const exact=(value,keys)=>{if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('总结数据结构无效');};
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const text=value=>typeof value==='string'&&!!value.trim();
export function emptySummary() {
  return {schema:1,revision:0,preferences:{
    manual:{startFloor:0,endFloor:null,includeUser:true,reviewBeforeCommit:true,hideOriginal:true},
    auto:{startFloor:0,batchSize:15,recentFloors:6,includeUser:true,reviewBeforeCommit:false,hideOriginal:true},
  },excludedFloors:[],batches:[],progress:{startFloor:0,lastProcessedFloor:null,nextBatchOrdinal:1}};
}
export function assertSummaryPreferences(value) {
  exact(value,['manual','auto']);
  exact(value.manual,['startFloor','endFloor','includeUser','reviewBeforeCommit','hideOriginal']);
  exact(value.auto,['startFloor','batchSize','recentFloors','includeUser','reviewBeforeCommit','hideOriginal']);
  for(const item of [value.manual,value.auto])if(!integer(item.startFloor)||['includeUser','reviewBeforeCommit','hideOriginal'].some(key=>typeof item[key]!=='boolean'))throw new Error('总结参数无效');
  if(!(value.manual.endFloor===null||integer(value.manual.endFloor)&&value.manual.endFloor>=value.manual.startFloor)||!integer(value.auto.batchSize,1)||!integer(value.auto.recentFloors))throw new Error('总结范围参数无效');
  return copy(value);
}
export function assertExcludedFloors(value) {
  if(!Array.isArray(value))throw new Error('排除楼层无效');const seen=new Set();
  for(const item of value){exact(item,['floor','identity']);if(!integer(item.floor)||seen.has(item.floor)||!(item.identity===null||text(item.identity)))throw new Error('排除楼层身份无效');seen.add(item.floor);}
  return copy(value).sort((a,b)=>a.floor-b.floor);
}
function jsonEvidence(value) {
  if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return;
  if(Array.isArray(value)){value.forEach(jsonEvidence);return;}
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('生成证据无效');
  for(const [key,item] of Object.entries(value)){if(/^(apiKey|password|credentials|authorization|secretValue)$/i.test(key))throw new Error('生成证据不得包含凭证');jsonEvidence(item);}
}
export function assertGeneratedEvidence(candidates) {
  if(!Array.isArray(candidates)||!candidates.length)throw new Error('生成证据不能为空');
  jsonEvidence(candidates);
  for(const candidate of candidates){
    if(!candidate||!Array.isArray(candidate.classificationTags)||candidate.classificationTags.some(item=>typeof item!=='string')||!Array.isArray(candidate.specialDateCandidates))throw new Error('生成证据缺少原始候选字段');
    for(const item of candidate.specialDateCandidates){exact(item,['name','storyDate','reason']);if(![item.name,item.storyDate,item.reason].every(text))throw new Error('特殊日期候选无效');}
  }
  return copy(candidates);
}
export function publicSummarySettingsEvidence(value) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('总结配置证据无效');
  const keys=['generationMode','promptOverrides','customPrompts','eventWords','summaryCleaning'];
  if(Object.keys(value).some(key=>!keys.includes(key)&&!['epoch','generationEpoch'].includes(key)))throw new Error('待审核证据不得包含 AI 私有配置');
  const result=Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
  const noPrivate=item=>{if(Array.isArray(item)){item.forEach(noPrivate);return;}if(item&&typeof item==='object')for(const [key,child] of Object.entries(item)){if(/^(ai|api|apiKey|password|credentials|credentialEpoch|authorization|secret|secretId|secretValue|endpoint|model|presets|activePresetId)$/i.test(key))throw new Error('待审核证据不得包含 AI 私有配置');noPrivate(child);}};
  noPrivate(result);
  jsonEvidence(result);return copy(result);
}
export function assertSummaryPending(value) {
  exact(value,['schema','id','batchId','origin','generationMode','completedStages','nextStage','failedStage','events','generatedCandidates','sourceSnapshot','settingsEvidence','params','createdAt','updatedAt']);
  if(value.schema!==1||!text(value.id)||!text(value.batchId)||!['manual','auto'].includes(value.origin)||!text(value.createdAt)||!text(value.updatedAt))throw new Error('待审核身份无效');
  const stages={one:['fast'],two:['qualitySummary','qualityIndexes'],three:['enhancedSummary','enhancedKeywords','aliases']}[value.generationMode];
  const publicSettings=publicSummarySettingsEvidence(value.settingsEvidence);
  if(publicSettings.generationMode!==undefined&&publicSettings.generationMode!=={one:'fast',two:'quality',three:'enhanced'}[value.generationMode])throw new Error('待审核模式与配置不符');
  if(!stages||!Array.isArray(value.completedStages)||!value.completedStages.length||value.completedStages.length>stages.length||value.completedStages.some((stage,index)=>stage!==stages[index])||value.nextStage!==(stages[value.completedStages.length]??null)||!(value.failedStage===null||value.failedStage===value.nextStage&&value.nextStage!==null))throw new Error('待审核阶段证据无效');
  exact(value.params,['includeUser','reviewBeforeCommit','hideOriginal']);if(Object.values(value.params).some(item=>typeof item!=='boolean'))throw new Error('待审核参数无效');
  if(!Array.isArray(value.events)||!value.events.length||new Set(value.events.map(event=>event?.id)).size!==value.events.length)throw new Error('待审核切片身份无效');
  for(const event of value.events){validateEvent(event);if(event.batch!==null||event.mergedFrom!=null||event.supersededBy!=null||JSON.stringify(event.sources)!==JSON.stringify([value.sourceSnapshot?.actualRange]))throw new Error('待审核切片不得占用正式关系或改变来源');}
  if(value.sourceSnapshot?.includeUser!==value.params.includeUser)throw new Error('待审核来源策略不符');
  assertBatch({id:value.batchId,taskId:value.id,ordinal:1,sourceType:value.origin,requestedRange:value.sourceSnapshot?.requestedRange,actualRange:value.sourceSnapshot?.actualRange,sourceSnapshot:value.sourceSnapshot,settingsEvidence:publicSummarySettingsEvidence(value.settingsEvidence),generationMode:value.generationMode,hideOriginal:value.params.hideOriginal,generatedCandidates:value.generatedCandidates,eventIds:value.events.map(event=>event.id),createdAt:value.createdAt,completedAt:value.updatedAt});
  jsonEvidence(value.events);
  return {...copy(value),settingsEvidence:publicSummarySettingsEvidence(value.settingsEvidence)};
}
export function assertBatch(batch) {
  exact(batch,['id','taskId','ordinal','sourceType','requestedRange','actualRange','sourceSnapshot','settingsEvidence','generationMode','hideOriginal','generatedCandidates','eventIds','createdAt','completedAt']);
  if(!text(batch.id)||!text(batch.taskId)||!integer(batch.ordinal,1)||!['manual','auto'].includes(batch.sourceType)||!validRange(batch.requestedRange)||!validRange(batch.actualRange)||batch.actualRange.start!==batch.requestedRange.start||batch.actualRange.end>batch.requestedRange.end||!['one','two','three'].includes(batch.generationMode)||typeof batch.hideOriginal!=='boolean'||!text(batch.createdAt)||!text(batch.completedAt))throw new Error('总结批记录无效');
  if(!Array.isArray(batch.eventIds)||!batch.eventIds.length||batch.eventIds.some(id=>!text(id))||new Set(batch.eventIds).size!==batch.eventIds.length)throw new Error('批成员身份无效');
  const source=batch.sourceSnapshot;
  if(!source||!integer(source.epoch)||!text(source.fingerprint)||!Array.isArray(source.rawMessages)||source.rawMessages.length!==batch.requestedRange.end-batch.requestedRange.start+1||JSON.stringify(source.requestedRange)!==JSON.stringify(batch.requestedRange)||JSON.stringify(source.actualRange)!==JSON.stringify(batch.actualRange))throw new Error('批来源证据无效');
  for(let i=0;i<source.rawMessages.length;i++){const message=source.rawMessages[i];if(message.floor!==batch.requestedRange.start+i||!text(message.identity)||!['user','assistant','system'].includes(message.role)||typeof message.system!=='boolean'||typeof message.text!=='string'||!(message.date===null||typeof message.date==='string'))throw new Error('批消息证据无效');}
  if(sourceFingerprint(source.rawMessages)!==source.fingerprint)throw new Error('批来源指纹不符');
  assertGeneratedEvidence(batch.generatedCandidates);jsonEvidence(source);jsonEvidence(batch.settingsEvidence);
  return copy(batch);
}
export function assertSummary(summary,events=[]) {
  exact(summary,['schema','revision','preferences','excludedFloors','batches','progress',...(Object.hasOwn(summary,'pending')?['pending']:[]),...(Object.hasOwn(summary,'sourcePositions')?['sourcePositions']:[])]);
  if(summary.schema!==1||!integer(summary.revision)||!Array.isArray(summary.batches))throw new Error('总结版本无效');
  const preferences=assertSummaryPreferences(summary.preferences);assertExcludedFloors(summary.excludedFloors);
  exact(summary.progress,['startFloor','lastProcessedFloor','nextBatchOrdinal']);
  if(!integer(summary.progress.startFloor)||!(summary.progress.lastProcessedFloor===null||integer(summary.progress.lastProcessedFloor))||!integer(summary.progress.nextBatchOrdinal,1))throw new Error('总结进度无效');
  const ids=new Set(),tasks=new Set(),ordinals=new Set(),members=new Set();
  for(const batch of summary.batches){assertBatch(batch);if(ids.has(batch.id)||tasks.has(batch.taskId)||ordinals.has(batch.ordinal)||batch.ordinal>=summary.progress.nextBatchOrdinal)throw new Error('批历史身份重复或游标无效');ids.add(batch.id);tasks.add(batch.taskId);ordinals.add(batch.ordinal);for(const id of batch.eventIds){if(members.has(id))throw new Error('批成员归属重复');members.add(id);const event=events.find(item=>item.id===id);if(event&&(event.batch?.id!==batch.id||JSON.stringify(event.batch.sources)!==JSON.stringify([batch.actualRange])))throw new Error('切片与独立批归属不符');}}
  for(const event of events){if(ids.has(event.batch?.id)&&!summary.batches.find(batch=>batch.id===event.batch.id).eventIds.includes(event.id))throw new Error('批成员不在正式历史中');}
  if(Object.hasOwn(summary,'sourcePositions'))assertSummarySourcePositions(summary.sourcePositions,summary.batches);
  if(Object.hasOwn(summary,'pending')&&summary.pending!==null){const pending=assertSummaryPending(summary.pending);if(ids.has(pending.batchId)||tasks.has(pending.id)||pending.events.some(candidate=>events.some(event=>event.id===candidate.id)))throw new Error('待审核与正式身份冲突');}
  return {...copy(summary),preferences};
}
export function assertSummarySourcePositions(value,batches) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('总结来源位置无效');
  for(const [id,positions] of Object.entries(value)){
    const batch=batches.find(item=>item.id===id);
    if(!batch||!Array.isArray(positions)||positions.length!==batch.sourceSnapshot.rawMessages.length)throw new Error('总结来源位置归属无效');
    let previous=-1;
    for(let index=0;index<positions.length;index++){
      const position=positions[index];if(position===null)continue;
      exact(position,['floor','identity']);
      if(!integer(position.floor)||position.floor<=previous||position.floor>batch.sourceSnapshot.rawMessages[index].floor||!text(position.identity))throw new Error('总结来源位置证据无效');
      previous=position.floor;
    }
  }
  return copy(value);
}
export function summaryOf(root) { return root.summary===undefined?emptySummary():assertSummary(root.summary,root.events); }
export function projectSummaryBatches(root) {
  return summaryOf(root).batches.map(batch=>{const members=root.events.filter(event=>batch.eventIds.includes(event.id));return {...copy(batch),itemCount:batch.eventIds.length,derivedCount:members.filter(event=>!event.supersededBy).length,resultsDeleted:members.length===0,mergeBlocked:members.some(event=>event.supersededBy||event.mergedFrom)};});
}
