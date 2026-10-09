import {assertRawSummarySource,durableSourceMessages,sourceFingerprint} from '../summary/source.js';
import {cleanSummaryFloors} from '../summary/cleaning.js';
const clone=structuredClone;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const ordered=messages=>messages.slice().sort((a,b)=>a.floor-b.floor);

// A reply may cover only its immediately preceding user floor. A system floor,
// tool message, missing floor or another reply is never crossed to find a pair.
export function prepareLatestSource(raw,{floor,rules}={}) {
  const source=assertRawSummarySource(raw);
  if(!integer(floor))throw new Error('最新摘要须指定有效 AI 楼层');
  const reply=source.messages.find(item=>item.floor===floor);
  if(!reply||reply.role!=='assistant'||reply.system||typeof reply.replyId!=='string'||!reply.replyId||!reply.text.trim())throw new Error('该楼层没有可总结的 AI 正文');
  const previous=source.messages.find(item=>item.floor===floor-1);
  const pair=previous?.role==='user'&&!previous.system&&previous.specialPayload!==true?[previous,reply]:[reply];
  const cleaned=cleanSummaryFloors(pair,{includeUser:true,rules});
  if(!cleaned.some(item=>item.floor===floor))throw new Error('清洗后没有可总结的 AI 正文');
  const userFloor=cleaned.some(item=>item.floor===floor-1&&item.role==='user')?floor-1:null;
  const rawMessages=pair.filter(item=>item.floor===floor||item.floor===userFloor);
  const result={epoch:source.epoch,replyId:reply.replyId,assistantFloor:floor,userFloor,rawMessages:clone(rawMessages),sentFloors:cleaned.filter(item=>item.floor===floor||item.floor===userFloor),fingerprint:sourceFingerprint(rawMessages)};
  return freeze(result);
}
export function storedLatestSource(source) {
  return assertLatestSource({replyId:source.replyId,assistantFloor:source.assistantFloor,userFloor:source.userFloor,rawMessages:durableSourceMessages(source.rawMessages),sentFloors:durableSourceMessages(source.sentFloors),fingerprint:source.fingerprint});
}
export function assertLatestSource(value) {
  if(!exact(value,['replyId','assistantFloor','userFloor','rawMessages','sentFloors','fingerprint'])||typeof value.replyId!=='string'||!value.replyId||!integer(value.assistantFloor)||!(value.userFloor===null||integer(value.userFloor)&&value.userFloor===value.assistantFloor-1)||!Array.isArray(value.rawMessages)||!Array.isArray(value.sentFloors))throw new Error('最新摘要来源证据无效');
  const floors=value.userFloor===null?[value.assistantFloor]:[value.userFloor,value.assistantFloor];
  assertRawSummarySource({epoch:0,messages:value.rawMessages});
  if(value.rawMessages.length!==floors.length||value.sentFloors.length!==floors.length||value.fingerprint!==sourceFingerprint(value.rawMessages))throw new Error('最新摘要来源指纹或配对不符');
  for(let index=0;index<floors.length;index++) {
    const original=value.rawMessages[index],sent=value.sentFloors[index],role=floors[index]===value.assistantFloor?'assistant':'user';
    if(!exact(original,['floor','identity','role','system','text','date','swipeId'])||original.floor!==floors[index]||original.role!==role||original.system||!(original.swipeId===null||integer(original.swipeId)))throw new Error('最新摘要原始楼层无效');
    if(!exact(sent,['floor','identity','role','system','text','date','swipeId'])||typeof sent.text!=='string'||!sent.text.trim()||['floor','identity','role','system','date','swipeId'].some(key=>sent[key]!==original[key]))throw new Error('最新摘要发送正文无效');
  }
  return clone(value);
}
export function latestSourceKey(source) {
  // Keep full evidence in the key: a digest collision must never authorize reuse.
  return JSON.stringify([source.replyId,durableSourceMessages(source.rawMessages)]);
}
export function matchesLatestSource(snapshot,raw) {
  try {
    const current=assertRawSummarySource(raw);
    if(!integer(snapshot.epoch)||current.epoch!==snapshot.epoch)return false;
    const floors=new Set(snapshot.rawMessages.map(item=>item.floor));
    return current.messages.find(item=>item.floor===snapshot.assistantFloor)?.replyId===snapshot.replyId&&JSON.stringify(ordered(current.messages.filter(item=>floors.has(item.floor))))===JSON.stringify(snapshot.rawMessages);
  } catch {return false;}
}
export function matchesStoredLatestSource(snapshot,raw) {
  try {
    assertLatestSource(snapshot);const current=assertRawSummarySource(raw),floors=new Set(snapshot.rawMessages.map(item=>item.floor));
    const reply=current.messages.find(item=>item.floor===snapshot.assistantFloor),messages=ordered(current.messages.filter(item=>floors.has(item.floor)));
    if(reply?.replyId!==snapshot.replyId||messages.some(item=>item.role==='user'&&item.specialPayload===true))return false;
    // The persistent per-swipe UUID survives deletion/reindexing of another
    // swipe. Keep the original slot as provenance, not as identity authority.
    const comparable=messages.map(item=>item.floor===snapshot.assistantFloor?{...item,swipeId:snapshot.rawMessages.at(-1).swipeId}:item);
    return latestSourceKey({replyId:reply.replyId,rawMessages:comparable})===latestSourceKey(snapshot);
  } catch {return false;}
}

