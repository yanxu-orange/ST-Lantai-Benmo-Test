import {sourceFingerprint} from './source.js';
const copy=value=>structuredClone(value);
const validRange=value=>value&&Number.isSafeInteger(value.start)&&value.start>=0&&Number.isSafeInteger(value.end)&&value.end>=value.start;
const exact=(value,keys)=>{if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('总结数据结构无效');};
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const text=value=>typeof value==='string'&&!!value.trim();
export function emptySummary() {
  return {schema:1,revision:0,preferences:{
    manual:{startFloor:0,endFloor:null,includeUser:true,reviewBeforeCommit:true,hideOriginal:true},
    auto:{enabled:false,startFloor:0,batchSize:15,recentFloors:6,includeUser:true,reviewBeforeCommit:false,hideOriginal:true},
  },excludedFloors:[],batches:[],progress:{startFloor:0,lastProcessedFloor:null,nextBatchOrdinal:1}};
}
export function assertSummaryPreferences(value) {
  exact(value,['manual','auto']);
  exact(value.manual,['startFloor','endFloor','includeUser','reviewBeforeCommit','hideOriginal']);
  exact(value.auto,['enabled','startFloor','batchSize','recentFloors','includeUser','reviewBeforeCommit','hideOriginal']);
  for(const item of [value.manual,value.auto])if(!integer(item.startFloor)||['includeUser','reviewBeforeCommit','hideOriginal'].some(key=>typeof item[key]!=='boolean'))throw new Error('总结参数无效');
  if(!(value.manual.endFloor===null||integer(value.manual.endFloor)&&value.manual.endFloor>=value.manual.startFloor)||typeof value.auto.enabled!=='boolean'||!integer(value.auto.batchSize,1)||!integer(value.auto.recentFloors))throw new Error('总结范围参数无效');
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
  exact(summary,['schema','revision','preferences','excludedFloors','batches','progress']);
  if(summary.schema!==1||!integer(summary.revision)||!Array.isArray(summary.batches))throw new Error('总结版本无效');
  assertSummaryPreferences(summary.preferences);assertExcludedFloors(summary.excludedFloors);
  exact(summary.progress,['startFloor','lastProcessedFloor','nextBatchOrdinal']);
  if(!integer(summary.progress.startFloor)||!(summary.progress.lastProcessedFloor===null||integer(summary.progress.lastProcessedFloor))||!integer(summary.progress.nextBatchOrdinal,1))throw new Error('总结进度无效');
  const ids=new Set(),tasks=new Set(),ordinals=new Set(),members=new Set();
  for(const batch of summary.batches){assertBatch(batch);if(ids.has(batch.id)||tasks.has(batch.taskId)||ordinals.has(batch.ordinal)||batch.ordinal>=summary.progress.nextBatchOrdinal)throw new Error('批历史身份重复或游标无效');ids.add(batch.id);tasks.add(batch.taskId);ordinals.add(batch.ordinal);for(const id of batch.eventIds){if(members.has(id))throw new Error('批成员归属重复');members.add(id);const event=events.find(item=>item.id===id);if(event&&(event.batch?.id!==batch.id||JSON.stringify(event.batch.sources)!==JSON.stringify([batch.actualRange])))throw new Error('切片与独立批归属不符');}}
  for(const event of events){if(ids.has(event.batch?.id)&&!summary.batches.find(batch=>batch.id===event.batch.id).eventIds.includes(event.id))throw new Error('批成员不在正式历史中');}
  return copy(summary);
}
export function summaryOf(root) { return root.summary===undefined?emptySummary():assertSummary(root.summary,root.events); }
export function projectSummaryBatches(root) {
  return summaryOf(root).batches.map(batch=>{const members=root.events.filter(event=>batch.eventIds.includes(event.id));return {...copy(batch),itemCount:batch.eventIds.length,derivedCount:members.filter(event=>!event.supersededBy).length,resultsDeleted:members.length===0,mergeBlocked:members.some(event=>event.supersededBy||event.mergedFrom)};});
}
