import {assertTime} from './data.js';
import {createCalendar} from './calendar.js';
import {durableSourceMessages} from '../summary/source.js';
import {storedLatestSource,latestSourceKey,matchesLatestSource,createStoredLatestSourceMatcher} from '../latest/source.js';
import {calendarCandidateKey,hasScheduleDateClue,emptyScheduleLedger,reconcileScheduleLedger,sameScheduleValue as equal} from './schedule-model.js';
export {calendarCandidateKey} from './schedule-model.js';
const clone=structuredClone,text=value=>typeof value==='string'&&!!value.trim();
const generatedId=()=>crypto.randomUUID();
const ledger=time=>time.scheduleTracking??emptyScheduleLedger();
const rowAt=(time,collection,id)=>time[collection]?.find(row=>row.id===id)??null;
const setRow=(time,collection,id,value)=>{time[collection]??=[];const index=time[collection].findIndex(row=>row.id===id);if(value===null){if(index>=0)time[collection].splice(index,1);}else if(index<0)time[collection].push(clone(value));else time[collection][index]=clone(value);};
const lastChange=(time,id)=>ledger(time).receipts.findLast(row=>row.active&&row.changes.some(change=>change.id===id));
const owned=(time,id)=>ledger(time).receipts.some(row=>row.changes.some(change=>change.id===id&&change.before===null));

function sourceRetained(saved,source,versionsByReply){
 if(source.matches(saved))return versionsByReply===undefined||versionsByReply.get(saved.replyId)?.length===1;
 const current=source.messageAt(saved.assistantFloor);
 if(versionsByReply===undefined)return !!current&&current.role==='assistant'&&!current.system&&current.replyId!==saved.replyId;
 const versions=versionsByReply.get(saved.replyId)??[],version=versions[0],original=saved.rawMessages.at(-1);
 if(versions.length!==1||version.floor!==saved.assistantFloor||version.text!==original.text||!current||current.role!=='assistant'||current.system||current.replyId===saved.replyId)return false;
 const user=saved.userFloor===null?null:saved.rawMessages[0],currentUser=user?source.messageAt(user.floor):null;
 return !user||!!currentUser&&!currentUser.specialPayload&&equal(durableSourceMessages([currentUser]),[user]);
}
// Roll back only changes still equal to our saved output, then replay currently
// proven sources and predecessor links. Manual changes are never overwritten.
export function pruneScheduleSources(value,raw,{replyVersions=raw?.replyVersions,invalidatedFloors=[]}={}){
 const time=assertTime(value);if(!time.scheduleTracking)return time;
 const source=createStoredLatestSourceMatcher(raw);
 if(!Array.isArray(invalidatedFloors)||invalidatedFloors.some(floor=>!Number.isSafeInteger(floor)||floor<0)||replyVersions!==undefined&&(!Array.isArray(replyVersions)||replyVersions.some(row=>!text(row?.replyId)||!Number.isSafeInteger(row.floor)||row.floor<0||!Number.isSafeInteger(row.swipeId)||row.swipeId<0||typeof row.text!=='string')))throw new Error('日程来源版本证据无效');
 const invalid=new Set(invalidatedFloors),versionsByReply=replyVersions===undefined?undefined:new Map();
 for(const version of replyVersions??[]){const versions=versionsByReply.get(version.replyId)??[];versions.push(version);versionsByReply.set(version.replyId,versions);}
 reconcileScheduleLedger(time,{isRetained:saved=>!saved.rawMessages.some(message=>invalid.has(message.floor))&&sourceRetained(saved,source,versionsByReply),isActive:saved=>source.matches(saved)});
 return assertTime(time);
}
export function scheduleState(value,raw){
 const time=raw?pruneScheduleSources(value,raw):assertTime(value),receipts=ledger(time).receipts;
 return {time,items:time.items,candidates:time.candidates??[],receipts,activeIds:new Set(receipts.filter(row=>row.active).map(row=>row.id))};
}
export function prepareSchedulePlan(value,source,{categories=['schedule','anniversary'],advanceDays=3}={}){
 const time=assertTime(value);storedLatestSource(source);
 if(!Array.isArray(categories)||categories.some(kind=>!['schedule','anniversary'].includes(kind))||new Set(categories).size!==categories.length||!Number.isSafeInteger(advanceDays)||advanceDays<0||advanceDays>365)throw new Error('日程提取类别无效');
 const items=time.items.filter(row=>categories.includes(row.kind)),candidates=(time.candidates??[]).filter(row=>categories.includes(row.kind)&&row.status==='pending');
 const protectedIds=[...new Set([...ledger(time).lockedIds,...items.filter(row=>!owned(time,row.id)).map(row=>row.id),...items.filter(row=>(lastChange(time,row.id)?.sourceSnapshot.assistantFloor??-1)>source.assistantFloor).map(row=>row.id)])];
 return clone({source,categories,advanceDays,calendars:time.calendars,activeCalendarId:time.activeCalendarId,currentDate:time.currentDate,current:{items,candidates},protectedIds});
}
const allowedFields=['id','kind','action','title','dateText','startDate','repeat','durationDays','description','reason','certainty','evidence'];
export function parseScheduleResult(value,plan){
 if(typeof value==='string'){try{value=JSON.parse(value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu,'$1'));}catch{throw new Error('日程输出不是有效 JSON');}}
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==1||!Array.isArray(value.changes)||value.changes.length>100)throw new Error('日程输出结构无效');
 const ids=new Set();
 for(const row of value.changes){
  if(!row||Object.getPrototypeOf(row)!==Object.prototype||Object.keys(row).some(key=>!allowedFields.includes(key))||!(row.id===null||text(row.id))||!['schedule','anniversary'].includes(row.kind)||!['upsert','cancel','complete'].includes(row.action)||!text(row.evidence))throw new Error('日程输出身份或依据无效');
  if(plan&&!plan.categories.includes(row.kind))throw new Error('日程类别未开启');
  if(row.id!==null){if(ids.has(row.id))throw new Error('同一日程不能重复更新');ids.add(row.id);}
  if(row.action!=='upsert'&&row.id===null)throw new Error('取消或完成须指向已有日程');
  for(const key of ['title','dateText','description','reason'])if(Object.hasOwn(row,key)&&typeof row[key]!=='string')throw new Error('日程文字字段无效');
  if(row.title!==undefined&&(!row.title.trim()||row.title.length>160)||row.repeat!==undefined&&!['once','yearly','weekly','monthly','unknown'].includes(row.repeat)||row.durationDays!==undefined&&(!Number.isSafeInteger(row.durationDays)||row.durationDays<1||row.durationDays>366)||row.certainty!==undefined&&!['confirmed','uncertain'].includes(row.certainty))throw new Error('日程日期或确认状态无效');
  if(row.startDate!==undefined&&row.startDate!==null&&(!row.startDate||Object.getPrototypeOf(row.startDate)!==Object.prototype||Object.keys(row.startDate).some(key=>!['calendarId','year','month','day'].includes(key))||typeof row.startDate.calendarId!=='string'||!['year','month','day'].every(key=>Number.isSafeInteger(row.startDate[key])&&row.startDate[key]>0)))throw new Error('日程结构化日期无效');
  if(row.id===null&&row.action==='upsert'&&!text(row.title))throw new Error('新日程缺少名称');
 }
 return clone(value);
}
function calendarMatches(time,plan,id){return equal(time.calendars.find(row=>row.id===id),plan.calendars.find(row=>row.id===id));}
function assertPlan(time,plan,result,raw){
 if(!plan||!matchesLatestSource(plan.source,raw)||time.activeCalendarId!==plan.activeCalendarId||!calendarMatches(time,plan,plan.activeCalendarId))throw new Error('日程来源或历法已变化');
 for(const row of result.changes){
  if(!plan.source.sentFloors.some(message=>message.text.includes(row.evidence)))throw new Error('日程依据不是本轮已发送正文');
  if(row.startDate&&!calendarMatches(time,plan,row.startDate.calendarId))throw new Error('日程使用的历法已变化');
  if(row.id===null)continue;
  const collection=plan.current.items.some(item=>item.id===row.id)?'items':'candidates',original=plan.current[collection].find(item=>item.id===row.id);
  if(!original||original.kind!==row.kind)throw new Error('日程更新须使用真实已有 ID');
  if(original.targetItem&&(!equal(rowAt(time,'items',original.itemId),original.targetItem)||ledger(time).lockedIds.includes(original.itemId)))throw new Error('候选对应的原事项已修改或删除，请重新读取');
  if(plan.protectedIds.includes(row.id)||ledger(time).lockedIds.includes(row.id)||!equal(rowAt(time,collection,row.id),original))throw new Error('日程已由用户或其他回合修改，请重新读取');
 }
}
function candidateMatch(time,record){
 const normalize=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/gu,' ');
 return (time.candidates??[]).find(row=>(row.targetItem?.id??null)===(record.targetItem?.id??null)&&(calendarCandidateKey(row)===calendarCandidateKey(record)||row.kind===record.kind&&normalize(row.title)===normalize(record.title)&&normalize(row.dateText)===normalize(record.dateText)&&(row.calendarId===null||record.calendarId===null)&&(!row.startDate||!record.startDate||equal(row.startDate,record.startDate))));
}
export function applyScheduleResult(value,{plan,result,source,messages,replyVersions,makeId=generatedId}={}){
 const raw=source?.messages?source:{epoch:plan?.source?.epoch,messages:messages??source};
 const time=pruneScheduleSources(value,raw,{replyVersions});result=parseScheduleResult(result,plan);assertPlan(time,plan,result,raw);
 time.scheduleTracking??=emptyScheduleLedger();time.candidates??=[];
 const sourceSnapshot=storedLatestSource(plan.source),proof={kind:'round',sourceSnapshot},allIds=new Set([...time.items,...time.candidates,...time.scheduleTracking.receipts].map(row=>row.id));
 const fresh=()=>{const id=makeId();if(!text(id)||allIds.has(id))throw new Error('日程身份重复');allIds.add(id);return id;};
 const receipt={id:fresh(),sourceSnapshot,counts:{added:0,updated:0,candidates:0},changes:[],active:true};
 const change=(collection,id,after,count)=>{
  const before=rowAt(time,collection,id);if(equal(before,after))return;
  const existing=receipt.changes.find(row=>row.id===id);
  if(existing)existing.after=clone(after);else receipt.changes.push({collection,id,before:clone(before),after:clone(after),parentId:lastChange(time,id)?.id??null});
  setRow(time,collection,id,after);if(count)receipt.counts[count]++;
 };
 for(const row of result.changes){
  const original=row.id===null?null:(rowAt(time,'items',row.id)??rowAt(time,'candidates',row.id)),isItem=original&&time.items.some(item=>item.id===original.id);
  if(row.action!=='upsert'){
   if(isItem){const yearlyComplete=row.action==='complete'&&original.repeat==='yearly';change('items',original.id,{...original,status:yearlyComplete?'active':row.action==='cancel'?'cancelled':'completed',enabled:yearlyComplete?original.enabled:false,lastOutcome:row.action==='cancel'?'cancelled':'completed'},'updated');}
   else change('candidates',original.id,{...original,status:'ignored'},'updated');
   continue;
  }
  const dateText=row.dateText??original?.dateText??'';
  // A complete-looking model date cannot manufacture a missing date clue.
  if(!hasScheduleDateClue(dateText)&&original===null)continue;
  if(row.dateText&& !row.evidence.includes(row.dateText))throw new Error('日期线索须保留本轮依据中的原文');
  let startDate=row.startDate===undefined?clone(original?.startDate??null):clone(row.startDate),calendarId=startDate?.calendarId??original?.calendarId??plan.activeCalendarId,validDate=false;
  if(startDate){const definition=time.calendars.find(item=>item.id===calendarId);if(!definition){startDate=null;calendarId=null;}else try{startDate=createCalendar(definition).validate(startDate);validDate=true;}catch{startDate=null;}}
  const repeat=row.repeat??original?.repeat??'once',title=(row.title??original?.title??'').trim(),description=row.description??original?.description??'',reason=row.reason??row.evidence,durationDays=row.kind==='anniversary'?1:row.durationDays??original?.durationDays??1;
  if(original===null){
   const key=calendarCandidateKey({kind:row.kind,title,dateText,calendarId,startDate});
   const protectedHistory=ledger(time).lockedKeys?.includes(key)||ledger(time).receipts.flatMap(receipt=>receipt.changes).some(change=>ledger(time).lockedIds.includes(change.id)&&[change.before,change.after].some(record=>record&&calendarCandidateKey(record)===key));
   if(protectedHistory)continue;
  }
  const priorCandidate=original===null?candidateMatch(time,{kind:row.kind,title,dateText,calendarId,startDate}):null;
  if(priorCandidate&&priorCandidate.status!=='pending')continue;
  const arrangementChanged=!!isItem&&['dateText','startDate','repeat','durationDays'].some(key=>Object.hasOwn(row,key)&&!equal(row[key],original[key]));
  const certainty=row.certainty??(isItem&&!arrangementChanged?'confirmed':'uncertain');
  const formal=row.kind==='schedule'&&validDate&&['once','yearly'].includes(repeat)&&certainty==='confirmed';
  if(formal){
   if(priorCandidate)continue;
   const prior=isItem?original:original?.targetItem?rowAt(time,'items',original.itemId):null;
   const match=prior??time.items.find(item=>item.kind===row.kind&&calendarCandidateKey({...item,dateText})===calendarCandidateKey({kind:row.kind,title,calendarId,startDate,dateText}));
   if(match&&!prior){if(original)change('candidates',original.id,{...original,status:'adopted',itemId:match.id},'updated');continue;}
   const reactivate=!!prior&&['cancelled','completed'].includes(prior.status)&&(arrangementChanged||row.certainty==='confirmed');
   const item={...(prior??{}),id:prior?.id??fresh(),kind:row.kind,title,calendarId,startDate,repeat,durationDays,advanceDays:prior?.advanceDays??plan.advanceDays,enabled:reactivate?true:prior?.enabled??true,remind:prior?.remind??true,show:prior?.show??true,description,instruction:prior?.instruction??'',status:reactivate||!prior?'active':prior.status??'active',dateText};
   change('items',item.id,item,prior?'updated':'added');if(original&&!isItem)change('candidates',original.id,{...original,status:'adopted',itemId:item.id},null);continue;
  }
  // An uncertain update cannot demote or erase a confirmed date. Keep its
  // proposed correction as a separate reviewable candidate.
  const sourceKey=JSON.stringify(['round',latestSourceKey(sourceSnapshot),row.kind,title,dateText,startDate]);
  const binding=isItem?{itemId:original.id,targetItem:clone(original)}:original?.targetItem?{itemId:original.itemId,targetItem:clone(original.targetItem)}:{itemId:null};
  const candidate={id:!isItem&&original?original.id:fresh(),kind:row.kind,title,dateText,reason,description,calendarId,startDate,repeat,durationDays,status:'pending',sourceKey,source:proof,...binding};
  const match=!isItem&&original?original:candidateMatch(time,candidate);
  if(match){
   const keys=match.sourceKeys??[match.sourceKey];if(keys.includes(sourceKey))continue;
   const mutable=original&&match.status==='pending'&&!ledger(time).lockedIds.includes(match.id);
   const merged={...match,...(mutable?{title,dateText,reason,description,calendarId,startDate,repeat,durationDays,...(isItem?binding:{})}:{}),sourceKeys:[...keys,sourceKey],sources:[...(match.sources??[match.source]),proof]};
   change('candidates',match.id,merged,original?'updated':null);
  }else change('candidates',candidate.id,candidate,'candidates');
 }
 time.scheduleTracking.receipts.push(receipt);
 return {time:assertTime(time),receipt:clone(receipt),validate:latest=>{assertPlan(pruneScheduleSources(latest,raw,{replyVersions}),plan,result,raw);return true;}};
}
export function markScheduleManual(value,id){
 const time=assertTime(value);if(!text(id))throw new Error('日程身份无效');
 time.scheduleTracking??=emptyScheduleLedger();if(!time.scheduleTracking.lockedIds.includes(id))time.scheduleTracking.lockedIds.push(id);
 const keys=new Set(time.scheduleTracking.lockedKeys??[]),records=[rowAt(time,'items',id),rowAt(time,'candidates',id),...time.scheduleTracking.receipts.flatMap(receipt=>receipt.changes.filter(change=>change.id===id).flatMap(change=>[change.before,change.after]))];for(const record of records)if(record)keys.add(calendarCandidateKey(record));time.scheduleTracking.lockedKeys=[...keys];return time;
}
export function ignoreScheduleCandidate(value,id){
 let time=assertTime(value);const candidate=time.candidates?.find(row=>row.id===id);if(!candidate||candidate.status!=='pending')throw new Error('候选已处理，请重新读取');candidate.status='ignored';time=markScheduleManual(time,id);return assertTime(time);
}
export function adoptScheduleCandidate(value,id,item){
 let time=assertTime(value);const candidate=time.candidates?.find(row=>row.id===id);if(!candidate||candidate.status!=='pending'||item?.kind!==candidate.kind)throw new Error('候选或事项身份已变化');
 if(candidate.targetItem){
  const current=time.items.find(row=>row.id===candidate.itemId);
  if(item.id!==candidate.itemId||!equal(current,candidate.targetItem)||ledger(time).lockedIds.includes(candidate.itemId))throw new Error('候选对应的原事项已修改或删除，请重新读取');
  time.items=time.items.map(row=>row.id===item.id?clone(item):row);
 }else{if(time.items.some(row=>row.id===item.id))throw new Error('候选或事项身份已变化');time.items.push(clone(item));}
 candidate.status='adopted';candidate.itemId=item.id;time=markScheduleManual(markScheduleManual(time,id),item.id);return assertTime(time);
}
export function scheduleItemState(value,item){
 if(['completed','cancelled'].includes(item?.status))return item.status;
 if(item?.enabled===false)return 'paused';
 if(item?.repeat!=='once'||!item.startDate||!value.currentDate?.day||value.currentDate.calendarId!==item.calendarId)return 'active';
 const definition=value.calendars.find(row=>row.id===item.calendarId);if(!definition)return 'active';
 const calendar=createCalendar(definition),end=calendar.shiftDays(item.startDate,(item.durationDays??1)-1);return end&&calendar.compare(value.currentDate,end)>0?'expired':'active';
}
