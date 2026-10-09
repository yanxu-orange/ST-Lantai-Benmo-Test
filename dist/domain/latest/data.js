import {assertLatestSource,latestSourceKey,matchesStoredLatestSource} from './source.js';
import {assertRawSummarySource,durableSourceMessages} from '../summary/source.js';
import {DEFAULT_LATEST_PROMPT} from './requests.js';
export {DEFAULT_LATEST_PROMPT} from './requests.js';
const clone=structuredClone;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const text=value=>typeof value==='string'&&Boolean(value.trim());
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function defaultLatestPreferences(){return {enabled:false,recentFloors:6,prompt:DEFAULT_LATEST_PROMPT};}
export function emptyLatest(){return {schema:1,revision:0,preferences:defaultLatestPreferences(),records:[]};}
export function assertLatestPreferences(value){
  if(!exact(value,['enabled','recentFloors','prompt'])||typeof value.enabled!=='boolean'||!integer(value.recentFloors)||value.recentFloors<1||!text(value.prompt))throw new Error('最新摘要设置无效');
  return clone(value);
}
export function assertLatestRecord(value){
  if(!exact(value,['id','body','sourceSnapshot','createdAt','updatedAt',...(Object.hasOwn(value??{},'edited')?['edited']:[])])||(Object.hasOwn(value??{},'edited')&&typeof value.edited!=='boolean')||![value.id,value.body,value.createdAt,value.updatedAt].every(text))throw new Error('最新摘要记录无效');
  assertLatestSource(value.sourceSnapshot);return clone(value);
}
export function assertLatest(value){
  if(!exact(value,['schema','revision','preferences','records'])||value.schema!==1||!integer(value.revision)||!Array.isArray(value.records))throw new Error('最新摘要数据版本无效');
  assertLatestPreferences(value.preferences);const ids=new Set(),sources=new Set(),replies=new Set();
  for(const record of value.records){assertLatestRecord(record);const key=latestSourceKey(record.sourceSnapshot);if(ids.has(record.id)||sources.has(key)||replies.has(record.sourceSnapshot.replyId))throw new Error('最新摘要记录或来源重复');ids.add(record.id);sources.add(key);replies.add(record.sourceSnapshot.replyId);}
  return clone(value);
}
export function latestOf(root){return assertLatest(root.latest===undefined?emptyLatest():root.latest);}
export function findLatestRecord(value,raw,floor){
  const current=raw?.messages?.find(item=>item.floor===floor),record=assertLatest(value).records.find(item=>item.sourceSnapshot.assistantFloor===floor&&item.sourceSnapshot.replyId===current?.replyId);
  if(!record)return null;
  const floors=new Set(record.sourceSnapshot.rawMessages.map(item=>item.floor)),relevant={epoch:raw.epoch,messages:raw.messages.filter(item=>floors.has(item.floor))};
  return matchesStoredLatestSource(record.sourceSnapshot,relevant)?record:null;
}
export const recordForLatestFloor=findLatestRecord;
export function inheritLatest(value,floor){
  if(!integer(floor))throw new Error('分支楼层无效');
  const domain=assertLatest(value);return {...domain,revision:0,records:domain.records.filter(record=>record.sourceSnapshot.rawMessages.every(item=>item.floor<floor))};
}
// Editing a user invalidates all replies covering it; editing an AI invalidates
// all of its saved versions when the host cannot identify a narrower version.
export function invalidateLatestFloors(value,floors){
  if(!Array.isArray(floors)||floors.some(floor=>!integer(floor)))throw new Error('最新摘要失效楼层无效');
  const domain=assertLatest(value),affected=new Set(floors);return {...domain,records:domain.records.filter(record=>!record.sourceSnapshot.rawMessages.some(item=>affected.has(item.floor)))};
}
// Reconciliation never guesses at shifted floors. Inactive swipes can be kept
// for later reuse, but cannot match or transform the active reply in the meantime.
export function pruneLatestRecords(value,raw,{replyVersions=raw?.replyVersions}={}){
  const domain=assertLatest(value),source=assertRawSummarySource(raw),byFloor=new Map(source.messages.map(item=>[item.floor,item]));
  if(replyVersions!==undefined&&(!Array.isArray(replyVersions)||replyVersions.some(item=>!text(item?.replyId)||!integer(item.floor)||!integer(item.swipeId)||typeof item.text!=='string')))throw new Error('最新摘要回复版本证据无效');
  const counts=new Map(),byReply=new Map();for(const item of replyVersions??[]){counts.set(item.replyId,(counts.get(item.replyId)??0)+1);byReply.set(item.replyId,item);}
  return {...domain,records:domain.records.filter(record=>{
    const snapshot=record.sourceSnapshot,relevant={epoch:source.epoch,messages:snapshot.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])};
    if(byFloor.get(snapshot.assistantFloor)?.replyId===snapshot.replyId&&matchesStoredLatestSource(snapshot,relevant))return replyVersions===undefined||counts.get(snapshot.replyId)===1;
    const saved=record.sourceSnapshot.rawMessages,reply=saved.at(-1),version=byReply.get(record.sourceSnapshot.replyId);
    if(!version||counts.get(version.replyId)!==1||version.floor!==reply.floor||version.text!==reply.text)return false;
    const current=byFloor.get(reply.floor);
    if(!current||current.role!=='assistant'||current.system)return false;
    // When the selected UUID matches but its proof differs this is an edit, not
    // an inactive swipe. Never resurrect it after the text happens to revert.
    if(current.replyId===record.sourceSnapshot.replyId)return false;
    const user=saved.length===2?saved[0]:null,currentUser=user?byFloor.get(user.floor):null;
    return !user||!!currentUser&&currentUser.specialPayload!==true&&JSON.stringify(durableSourceMessages([currentUser]))===JSON.stringify([user]);
  })};
}
