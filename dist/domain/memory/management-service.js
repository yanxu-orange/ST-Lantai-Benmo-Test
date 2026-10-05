import { blankEvent, validateEvent } from './model.js';
import { sameTarget, mergeRanges, mergeParticipants } from './repository.js';
import { parseStoryDate } from './timeline.js';
import { generationSettings,indexRequest,mergeRequest } from './management-prompts.js';
import { equalData,exactKeys,strings,validateIndexes,validateMergedText,validateReview,originalSnapshot } from './management-validation.js';

export function initialMergeTimes(events) {
 const boundary=(key,last)=>{
  const values=events.map(event=>event[key]);if(values.some(value=>!value.trim()))return '';if(values.every(value=>value===values[0]))return values[0];
  const dates=values.map(parseStoryDate);if(dates.some(date=>!date||date.year===null||date.month===null||date.day===null))return '';
  const ordered=dates.map((date,index)=>({date,index,key:date.year*10000+date.month*100+date.day})).sort((a,b)=>a.key-b.key),chosen=last?ordered.at(-1):ordered[0],matching=ordered.filter(item=>item.key===chosen.key);
  if(matching.every(item=>values[item.index]===values[chosen.index]))return values[chosen.index];
  return `${chosen.date.year}年${chosen.date.month}月${chosen.date.day}日`;
 };
 return {startTime:boundary('startTime',false),endTime:boundary('endTime',true)};
}
export function createMemoryManagementService({repository,manager,provider,getGenerationSettings,getOriginalSnapshot,uuid=()=>crypto.randomUUID()}={}) {
 if(!repository||typeof repository.matchesSelection!=='function'||!manager||typeof manager.start!=='function'||typeof provider?.generateJson!=='function'||typeof getGenerationSettings!=='function')throw new TypeError('记忆管理依赖未配置');
 const records=new Map();
 const readSettings=()=>generationSettings(getGenerationSettings());
 function targetCurrent(snapshot,target) {
  try{return sameTarget(target,repository.captureTarget())&&(!snapshot.settings||equalData(readSettings(),snapshot.settings));}catch{return false;}
 }
 function sourcesCurrent(snapshot,target) {
  try {
   if(!repository.matchesSelection(target,snapshot.selection,{hidden:snapshot.kind==='undo'}))return false;
   return snapshot.sourceMode!=='original'||typeof getOriginalSnapshot==='function'&&equalData(originalSnapshot(getOriginalSnapshot(target,structuredClone(snapshot.ranges)),snapshot.ranges),snapshot.original);
  }catch{return false;}
 }
 async function checkAsync(snapshot,target) {
  await repository.read(target);
  if(!targetCurrent(snapshot,target)||!sourcesCurrent(snapshot,target))throw new Error('记忆来源或生成设置已变化');
 }
 function indexesToResults(data,events,ids) {
  return events.map(event=>{
   const output=data.indexes.find(index=>index.draftId===event.id);
   return {id:event.id,eventWords:output.eventKeywords,detailWords:output.detailKeywords.map(word=>{
    const key=JSON.stringify([event.id,word]);if(!ids.has(key))ids.set(key,event.detailWords.find(term=>term.word===word)?.id??uuid());
    return {id:ids.get(key),word,aliases:output.detailAliases.find(record=>record.parentDetail===word)?.aliases??[]};
   })};
  });
 }
 async function requestIndexes(ctx,events,snapshot) {
  await checkAsync(snapshot,ctx.target);
  const request=indexRequest(events,snapshot.settings),current=()=>!ctx.signal.aborted&&targetCurrent(snapshot,ctx.target)&&sourcesCurrent(snapshot,ctx.target);
  const output=await provider.generateJson({...request,signal:ctx.signal,isCurrent:current,validate:data=>validateIndexes(data,events.map(event=>event.id),snapshot.settings.eventWords.map(word=>word.name))});
  // The service validates too: an injected provider cannot bypass the business contract.
  if(!current()||!validateIndexes(output.data,events.map(event=>event.id),snapshot.settings.eventWords.map(word=>word.name)))throw new Error('关键词结果或来源无效');
  return output.data;
 }
 function start(snapshot,worker) {
  if(!targetCurrent(snapshot,snapshot.selection.target)||!sourcesCurrent(snapshot,snapshot.selection.target))throw new Error('记忆来源或生成设置已变化');
  const taskId=manager.start({key:`memory:${snapshot.kind}:${snapshot.selection.target.chatId}:${snapshot.selection.events.map(event=>event.id).sort().join('|')}`,target:snapshot.selection.target,snapshot,validateCurrent:target=>targetCurrent(snapshot,target),validateSnapshot:sourcesCurrent,worker});
  records.set(taskId,{kind:snapshot.kind,outcome:null,stage:snapshot.kind==='merge'?'merge-text':snapshot.kind==='keywords'?'keywords':'undo-review'});return taskId;
 }
 return {
  async rebuildKeywords(ids) {
   const settings=readSettings(),target=repository.captureTarget(),selection=await repository.captureSelection(target,ids),detailIds=new Map(),snapshot={kind:'keywords',settings,selection,sourceMode:'memories',ranges:[],original:null};
   return start(snapshot,async ctx=>{
    const data=await requestIndexes(ctx,ctx.snapshot.selection.events,ctx.snapshot),results=indexesToResults(data,ctx.snapshot.selection.events,detailIds);
    records.get(ctx.taskId).stage='final-review';
    return {kind:'keywords',results,comparisons:ctx.snapshot.selection.events.map(event=>({id:event.id,before:{eventWords:event.eventWords,detailWords:event.detailWords},after:results.find(result=>result.id===event.id)}))};
   });
  },
  async merge(ids,{sourceMode}={}) {
   if(!['original','memories'].includes(sourceMode))throw new Error('请选择合并来源');
   const settings=readSettings(),target=repository.captureTarget(),selection=await repository.captureSelection(target,ids);
   if(selection.events.length<2||selection.events.some(event=>event.mergedFrom))throw new Error('合并至少需要两条未合并的活动记忆');
   const ranges=mergeRanges(selection.events.flatMap(event=>event.sources));
   if(sourceMode==='original'&&(!ranges.length||typeof getOriginalSnapshot!=='function'))throw new Error('当前记忆缺少可确认的原文来源');
   const original=sourceMode==='original'?originalSnapshot(getOriginalSnapshot(target,structuredClone(ranges)),ranges):null,snapshot={kind:'merge',settings,selection,sourceMode,ranges,original},mergedId=uuid(),detailIds=new Map();
   return start(snapshot,async ctx=>{
    const captured=ctx.snapshot,events=captured.selection.events;await checkAsync(captured,ctx.target);
    const current=()=>!ctx.signal.aborted&&targetCurrent(captured,ctx.target)&&sourcesCurrent(captured,ctx.target);
    const output=await provider.generateJson({...mergeRequest(events,captured.settings,captured.sourceMode,captured.original),signal:ctx.signal,isCurrent:current,validate:validateMergedText});
    if(!current()||!validateMergedText(output.data))throw new Error('合并正文结果或来源无效');
    const base={...blankEvent(mergedId),title:output.data.title,body:output.data.body,...mergeParticipants(events),...initialMergeTimes(events),sources:captured.ranges,mode:events.every(event=>event.mode==='resident')?'resident':'trigger'},impact={sourceIds:events.map(event=>event.id),sourceCount:events.length,ranges:captured.ranges,coherenceWarning:output.data.coherenceWarning};
    const fields={title:base.title,body:base.body,people:base.people,places:base.places,startTime:base.startTime,endTime:base.endTime};
    records.get(ctx.taskId).stage='merge-body-review';
    const reviewed=await ctx.awaitReview({kind:'merge-body',fields,...impact});const event=validateReview(reviewed,base);
    records.get(ctx.taskId).stage='merge-indexes';
    const data=await requestIndexes(ctx,[event],captured),result=indexesToResults(data,[event],detailIds)[0];
    records.get(ctx.taskId).stage='final-review';
    return {kind:'merge',event:{...event,eventWords:result.eventWords,detailWords:result.detailWords},...impact};
   });
  },
  async undoMerge(id) {
   const target=repository.captureTarget(),selection=await repository.captureMerge(target,id),snapshot={kind:'undo',settings:null,selection,sourceMode:'memories',ranges:[],original:null};
   return start(snapshot,async ctx=>{await checkAsync(ctx.snapshot,ctx.target);const result=ctx.snapshot.selection.events.find(event=>event.mergedFrom);return {kind:'undo',resultId:result.id,restoreIds:result.mergedFrom,restoreCount:result.mergedFrom.length};});
  },
  review(taskId,fields) {
   const state=manager.inspect(taskId);if(!records.has(taskId)||!state?.reviewPending||state.candidate?.kind!=='merge-body')return false;
   try{validateReview(fields,{...blankEvent('review-validation'),sources:state.candidate.ranges});}catch{return false;}
   const record=records.get(taskId),previousStage=record.stage;record.stage='merge-indexes';
   const resumed=manager.resume(taskId,fields);if(!resumed)record.stage=previousStage;return resumed;
  },
  async confirm(taskId,{reviewedIndexes}={}) {
   const record=records.get(taskId);if(!record||record.outcome==='unconfirmed')return {taskId,status:'rejected',outcome:record?.outcome??null};
   let reviewed;
   if(reviewedIndexes!==undefined){
    const state=manager.inspect(taskId);
    if(state?.candidate?.kind!=='keywords'||state.reviewPending||!['awaiting-user','failed'].includes(state.status))return {taskId,status:'rejected'};
    try{
     reviewed=structuredClone(reviewedIndexes);
     const events=state.snapshot.selection.events;
     const owners=new Map(),termIds=new Set();for(const event of [...events,...state.candidate.results])for(const term of event.detailWords)owners.set(term.id,event.id);
     if(!Array.isArray(reviewed)||reviewed.length!==events.length||new Set(reviewed.map(item=>item?.id)).size!==events.length)throw new Error('结果须完整覆盖所选记忆');
     for(const [index,item]of reviewed.entries()){
      try{
       const original=events.find(event=>event.id===item?.id);
       if(!original||!exactKeys(item,['id','eventWords','detailWords'])||!strings(item.eventWords)||!Array.isArray(item.detailWords)||item.detailWords.some(term=>!exactKeys(term,['id','word','aliases'])||!strings(term.aliases)))throw new Error('词条或记忆身份无效');
       for(const term of item.detailWords){if(termIds.has(term.id)||owners.has(term.id)&&owners.get(term.id)!==item.id)throw new Error('细节词身份或绑定无效');termIds.add(term.id);}
       validateEvent({...original,eventWords:item.eventWords,detailWords:item.detailWords});
      }catch(error){return {taskId,status:'invalid',errorIndex:index,error:error.message};}
     }
    }catch{return {taskId,status:'invalid',error:'结果须完整覆盖所选记忆'};}
   }
   const result=await manager.confirm(taskId,async ctx=>{
    try {
     await checkAsync(ctx.snapshot,ctx.target);
     const options={isCurrent:ctx.isCurrent};
     if(ctx.candidate.kind==='keywords')return await repository.rebuildKeywords(ctx.target,ctx.snapshot.selection,reviewed??ctx.candidate.results,options);
     if(ctx.candidate.kind==='merge')return await repository.merge(ctx.target,ctx.snapshot.selection,ctx.candidate.event,options);
     if(ctx.candidate.kind==='undo')return await repository.undoMerge(ctx.target,ctx.snapshot.selection,options);
     throw new Error('候选类型无效');
    }catch(error){if(error?.code==='COMMIT_UNCONFIRMED')record.outcome='unconfirmed';throw error;}
   });
   return {...result,outcome:record.outcome};
  },
  inspect(taskId) {const state=manager.inspect(taskId),record=records.get(taskId);return state&&record?{...state,outcome:record.outcome,stage:record.stage}:null;},
  subscribe(listener) {return manager.subscribe(state=>{const record=records.get(state.taskId);if(record)listener({...state,outcome:record.outcome,stage:record.stage});});},
  cancel:taskId=>records.has(taskId)&&manager.cancel(taskId),
  retry(taskId) {
   const record=records.get(taskId);if(!record||record.outcome==='unconfirmed')return false;
   const previousStage=record.stage;record.stage=record.kind==='merge'?'merge-text':record.kind==='keywords'?'keywords':'undo-review';
   const retried=manager.retry(taskId);if(!retried)record.stage=previousStage;return retried;
  },
  settled:taskId=>manager.settled(taskId)
 };
}
