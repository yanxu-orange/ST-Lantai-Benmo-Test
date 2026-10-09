import {generationSourceOf} from './model.js';
import {currentResult,resultText} from './results.js';
import {emptyLatest,pruneLatestRecords} from '../latest/data.js';
import {storedLatestSource,matchesStoredLatestSource} from '../latest/source.js';
import {assertRawSummarySource} from '../summary/source.js';

const copy=structuredClone;
export function backgroundModules(modules){return modules.filter(module=>module.lifecycle!=='prompt'&&generationSourceOf(module)==='background');}
export function previousBackgroundResult(results,moduleId,floor){return currentResult(results.filter(row=>row.floor<floor),moduleId);}
export function workshopBackgroundTask(module,results,source,index){
  const previous=module.lifecycle==='sync'?previousBackgroundResult(results,module.id,source.assistantFloor):null;
  return {id:`workshop_${index}`,name:module.name,instructions:module.content.trim(),...(module.lifecycle==='sync'?{previousState:previous?resultText(previous):null}:{}),module:copy(module),previous:copy(previous),existing:copy(results.find(row=>row.moduleId===module.id&&row.replyId===source.replyId)??null)};
}
export function reconcileBackgroundResults(results,raw,{replyVersions,invalidatedFloors=[]}={}){
  if(!results.some(row=>row.generationSource==='background'))return copy(results);
  // Index the chat once. Reusing the latest-summary proof on each two-floor
  // pair preserves its ownership rules without cloning the entire chat for
  // every stored module result. UUID buckets still include owners anywhere
  // in the chat, so duplicated identities cannot become valid by subsetting.
  const source=assertRawSummarySource(raw),byFloor=new Map(source.messages.map(row=>[row.floor,row]));
  const versions=replyVersions===undefined?raw.replyVersions:replyVersions,byReply=new Map(),invalid=new Set(invalidatedFloors);
  if(versions!==undefined){
    if(!Array.isArray(versions)||versions.some(row=>typeof row?.replyId!=='string'||!row.replyId.trim()||!Number.isSafeInteger(row.floor)||row.floor<0||!Number.isSafeInteger(row.swipeId)||row.swipeId<0||typeof row.text!=='string'))throw new Error('最新摘要回复版本证据无效');
    for(const version of versions){const bucket=byReply.get(version.replyId)??[];bucket.push(version);byReply.set(version.replyId,bucket);}
  }
  return results.flatMap(row=>{
    if(row.generationSource!=='background')return [copy(row)];
    const snapshot=row.sourceSnapshot,pair={epoch:source.epoch,messages:snapshot.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])};
    const record={id:row.id,body:row.value,sourceSnapshot:snapshot,createdAt:'background',updatedAt:'background'};
    const kept=pruneLatestRecords({...emptyLatest(),records:[record]},pair,{replyVersions:versions===undefined?undefined:byReply.get(snapshot.replyId)??[]}).records.length>0;
    if(!kept||snapshot.rawMessages.some(item=>invalid.has(item.floor)))return [];
    return [{...copy(row),active:matchesStoredLatestSource(snapshot,pair)}];
  });
}
export function upsertBackgroundResult(results,task,source,text,{makeId=()=>crypto.randomUUID()}={}){
  if(typeof text!=='string'||!text.trim())throw new Error('后台结果正文不能为空');
  const previous=results.find(row=>row.moduleId===task.module.id&&row.replyId===source.replyId);
  // A story result from the same source cannot silently become a second capture.
  if(previous&&previous.generationSource!=='background')throw new Error('该回复已有随剧情收集结果');
  const row={id:previous?.id??makeId(),moduleId:task.module.id,replyId:source.replyId,index:0,floor:source.assistantFloor,value:text.trim(),manualValue:previous?.manualValue??null,deleted:previous?.deleted??false,active:true,generationSource:'background',sourceSnapshot:storedLatestSource(source)};
  return previous?results.map(item=>item.id===previous.id?row:copy(item)):[...copy(results),row];
}
