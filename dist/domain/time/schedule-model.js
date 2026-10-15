import {assertLatestSource} from '../latest/source.js';
const clone=structuredClone;
const object=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const text=value=>typeof value==='string'&&!!value.trim();
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export const sameScheduleValue=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const hasScheduleDateClue=value=>typeof value==='string'&&!!value.trim()&&!/^(?:未知|不详|未提及|未说明|没有日期|无日期|无|暂无|不确定|待定|unknown|n\/?a)[。.]?$/iu.test(value.trim());
export function calendarCandidateKey(value){
 const normalize=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/gu,' ');
 const date=value.startDate;
 return JSON.stringify([value.kind,normalize(value.title),value.calendarId??date?.calendarId??null,date?{calendarId:date.calendarId,year:date.year,month:date.month,day:date.day}:normalize(value.dateText)]);
}
export function assertScheduleSource(source){
 if(!object(source)||!['round','summary'].includes(source.kind))throw new Error('日程来源无效');
 if(source.kind==='round')assertLatestSource(source.sourceSnapshot);
 else if(!text(source.batchId)||Object.hasOwn(source,'fingerprint')||!object(source.evidence))throw new Error('纪念日批来源无效');
 return clone(source);
}
export function assertScheduleCandidate(value,{calendars=new Map(),validateItem}={}){
 if(!object(value)||!text(value.id)||!['schedule','anniversary'].includes(value.kind)||!text(value.title)||!text(value.dateText)||!['reason','description'].every(key=>typeof value[key]==='string')||!(value.calendarId===null||calendars.has(value.calendarId))||!['once','yearly','weekly','monthly','unknown'].includes(value.repeat)||!Number.isSafeInteger(value.durationDays)||value.durationDays<1||value.durationDays>366||!['pending','adopted','ignored'].includes(value.status)||!text(value.sourceKey)||!(value.itemId===null||text(value.itemId)))throw new Error('日程候选字段无效');
 if(value.kind==='anniversary'&&value.durationDays!==1)throw new Error('纪念日候选持续天数须为1');
 if(value.startDate!==null){const calendar=calendars.get(value.calendarId);if(!calendar)throw new Error('候选日期缺少历法');calendar.validate(value.startDate);}
 if(value.status==='adopted'&&!value.itemId)throw new Error('已采用候选缺少事项身份');
 if(value.status==='pending'&&value.itemId!==null&&!value.targetItem)throw new Error('改期候选缺少原事项快照');
 if(value.targetItem!==undefined){
  if(!object(value.targetItem)||value.targetItem.id!==value.itemId||value.targetItem.kind!==value.kind||typeof validateItem!=='function')throw new Error('改期候选绑定无效');
  validateItem(value.targetItem);
 }

 assertScheduleSource(value.source);
 if(Object.hasOwn(value,'sourceKeys')&&(!Array.isArray(value.sourceKeys)||value.sourceKeys.some(key=>!text(key))||new Set(value.sourceKeys).size!==value.sourceKeys.length||!value.sourceKeys.includes(value.sourceKey)))throw new Error('候选来源键无效');
 if(Object.hasOwn(value,'sources')){if(!Array.isArray(value.sources)||!value.sources.length)throw new Error('候选来源列表无效');if(value.sourceKeys&&value.sourceKeys.length!==value.sources.length)throw new Error('候选来源键与证据数量不符');value.sources.forEach(assertScheduleSource);}
 return clone(value);
}
export function emptyScheduleLedger(){return {receipts:[],lockedIds:[]};}
export function assertScheduleLedger(value,{validateItem,calendars}={}){
 if(!object(value)||Object.keys(value).some(key=>!['receipts','lockedIds','lockedKeys'].includes(key))||!Array.isArray(value.receipts)||!Array.isArray(value.lockedIds)||value.lockedIds.some(id=>!text(id))||new Set(value.lockedIds).size!==value.lockedIds.length)throw new Error('日程追踪记录无效');
 if(value.lockedKeys!==undefined&&(!Array.isArray(value.lockedKeys)||value.lockedKeys.some(key=>!text(key))||new Set(value.lockedKeys).size!==value.lockedKeys.length))throw new Error('人工日程保护证据无效');
 const ids=new Set();
 for(const row of value.receipts){
  if(!object(row)||!text(row.id)||ids.has(row.id)||typeof row.active!=='boolean'||!object(row.counts)||!['added','updated','candidates'].every(key=>integer(row.counts[key]))||!Array.isArray(row.changes))throw new Error('日程回执无效');
  ids.add(row.id);assertLatestSource(row.sourceSnapshot);
  const changed=new Set();
  for(const change of row.changes){
   if(!object(change)||!['items','candidates'].includes(change.collection)||!text(change.id)||changed.has(change.id)||!(change.parentId===null||text(change.parentId))||change.before===null&&change.after===null)throw new Error('日程变更证据无效');changed.add(change.id);
   for(const record of [change.before,change.after])if(record!==null){if(record?.id!==change.id)throw new Error('日程变更身份不符');if(change.collection==='items')validateItem(record);else assertScheduleCandidate(record,{calendars,validateItem});}
  }
 }
 return clone(value);
}

const equal=sameScheduleValue;
const rowAt=(time,collection,id)=>time[collection]?.find(row=>row.id===id)??null;
const setRow=(time,collection,id,value)=>{time[collection]??=[];const index=time[collection].findIndex(row=>row.id===id);if(value===null){if(index>=0)time[collection].splice(index,1);}else if(index<0)time[collection].push(clone(value));else time[collection][index]=clone(value);};
const sourcePairs=row=>row?((row.sourceKeys??[row.sourceKey]).map((key,index)=>({key,source:(row.sources??[row.source])[index]}))):[];
const candidateContent=row=>{if(!row)return row;const {source,sourceKey,sources,sourceKeys,...content}=row;return content;};
function withSources(row,pairs){
 if(!row||!pairs.length)return null;
 return {...clone(row),sourceKey:pairs[0].key,source:clone(pairs[0].source),sourceKeys:pairs.map(pair=>pair.key),sources:pairs.map(pair=>clone(pair.source))};
}
// Independent summary backfill may append provenance to a round candidate.
// Treat only business-field changes as manual edits, and preserve those sources
// when the round source disappears or returns.
function candidateTransition(current,from,to,{reverse=false}={}){
 if(equal(current,from))return {ok:true,value:clone(to)};
 const template=from??to;
 // A missing baseline source may have been withdrawn by another importer.
 // Replay only this receipt's source delta, never restore removed foreign proof.
 if(!current){
  if(!from||!to)return {ok:false};
  const keys=new Set(sourcePairs(from).map(pair=>pair.key)),added=sourcePairs(to).filter(pair=>!keys.has(pair.key));
  return added.length?{ok:true,value:withSources(to,added)}:{ok:false};
 }
 if(!template||!equal(candidateContent(current),candidateContent(template)))return {ok:false};
 const fromKeys=new Set(sourcePairs(from).map(pair=>pair.key)),toKeys=new Set(sourcePairs(to).map(pair=>pair.key));
 const kept=sourcePairs(current).filter(pair=>!fromKeys.has(pair.key)||toKeys.has(pair.key));
 const added=sourcePairs(to).filter(pair=>!fromKeys.has(pair.key)&&!kept.some(saved=>saved.key===pair.key));
 const merged=[...kept,...added];
 if(!to)return reverse?{ok:true,value:withSources(current,merged)}:{ok:false};
 return {ok:true,value:withSources(to,merged)};
}

export function reconcileScheduleLedger(time,{isRetained,isActive}){
 if(!time.scheduleTracking)return time;
 const state=time.scheduleTracking,locked=new Set(state.lockedIds);
 for(const receipt of state.receipts.slice().reverse()){
  if(!receipt.active)continue;
  for(const change of receipt.changes.slice().reverse()){
   if(locked.has(change.id))continue;
   const current=rowAt(time,change.collection,change.id),transition=change.collection==='candidates'?candidateTransition(current,change.after,change.before,{reverse:true}):{ok:equal(current,change.after),value:change.before};
   if(transition.ok)setRow(time,change.collection,change.id,transition.value);else locked.add(change.id);
  }
 }
 state.lockedIds=[...locked];
 if(locked.size){const keys=new Set(state.lockedKeys??[]);for(const receipt of state.receipts)for(const change of receipt.changes)if(locked.has(change.id))for(const record of [change.before,change.after])if(record)keys.add(calendarCandidateKey(record));state.lockedKeys=[...keys];}
 state.receipts=state.receipts.filter(row=>isRetained(row.sourceSnapshot));
 const activeIds=new Set();
 for(const receipt of state.receipts){
  receipt.active=isActive(receipt.sourceSnapshot);
  if(!receipt.active)continue;
  const projected=[];
  for(const change of receipt.changes){
   if(locked.has(change.id))continue;
   const current=rowAt(time,change.collection,change.id),transition=change.collection==='candidates'?candidateTransition(current,change.before,change.after):{ok:equal(current,change.before),value:change.after};
   if(change.parentId!==null&&!activeIds.has(change.parentId)||!transition.ok){receipt.active=false;break;}
   projected.push({...change,value:transition.value});
  }
  if(!receipt.active)continue;
  for(const change of projected)setRow(time,change.collection,change.id,change.value);
  activeIds.add(receipt.id);
 }
 return time;
}

// Branching already decides which summary batches are inherited. Pending
// candidates must retain only that same set of batch evidence; reviewed rows
// and explicit manual edits remain user-owned.
export function retainScheduleSummarySources(time,batchIds=[]){
 if(!Array.isArray(batchIds)||batchIds.some(id=>!text(id)))throw new Error('继承批来源身份无效');
 if(!time.candidates)return time;
 const retained=new Set(batchIds),locked=new Set(time.scheduleTracking?.lockedIds??[]);
 time.candidates=time.candidates.flatMap(candidate=>{
  if(candidate.status!=='pending'||candidate.manual===true||locked.has(candidate.id))return [candidate];
  const original=sourcePairs(candidate),pairs=original.filter(pair=>pair.source.kind!=='summary'||retained.has(pair.source.batchId));
  if(pairs.length===original.length)return [candidate];
  const remaining=withSources(candidate,pairs);return remaining?[remaining]:[];
 });
 return time;
}
