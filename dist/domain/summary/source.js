import {cleanSummaryFloors} from './cleaning.js';
const copy=value=>structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const range=value=>value&&Number.isSafeInteger(value.start)&&value.start>=0&&Number.isSafeInteger(value.end)&&value.end>=value.start;
export function sourceFingerprint(messages) {
  // Equality uses the complete ticket as well; this digest is an inspectable provenance label.
  const text=JSON.stringify(durableSourceMessages(messages));let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16).padStart(8,'0');
}
export function durableSourceMessages(messages){return messages.map(({floor,identity,role,system,text,date,swipeId=null})=>({floor,identity,role,system,text,date,swipeId}));}
export function matchesStoredSummarySource(snapshot,raw){
  try{const current=assertRawSummarySource(raw),range=snapshot.requestedRange;const messages=current.messages.filter(message=>message.floor>=range.start&&message.floor<=range.end).sort((a,b)=>a.floor-b.floor);return JSON.stringify(durableSourceMessages(messages))===JSON.stringify(durableSourceMessages(snapshot.rawMessages))&&sourceFingerprint(messages)===snapshot.fingerprint;}catch{return false;}
}
export function assertRawSummarySource(raw) {
  if(!raw||!Number.isSafeInteger(raw.epoch)||raw.epoch<0||!Array.isArray(raw.messages))throw new Error('总结来源能力不可用');
  const seen=new Set();
  for(const message of raw.messages){if(!message||!Number.isSafeInteger(message.floor)||message.floor<0||seen.has(message.floor)||typeof message.identity!=='string'||!message.identity||!['user','assistant','system'].includes(message.role)||typeof message.system!=='boolean'||typeof message.text!=='string'||!(message.date===null||typeof message.date==='string'))throw new Error('总结来源消息无效');seen.add(message.floor);}
  return copy(raw);
}
export function prepareSummarySource(raw,{startFloor,endFloor,includeUser=true,excludedFloors=[],rules}={}) {
  const source=assertRawSummarySource(raw),requestedRange={start:startFloor,end:endFloor};
  if(!range(requestedRange)||typeof includeUser!=='boolean'||!Array.isArray(excludedFloors))throw new Error('总结范围无效');
  const captured=source.messages.filter(message=>message.floor>=startFloor&&message.floor<=endFloor).sort((a,b)=>a.floor-b.floor);
  if(captured.length!==endFloor-startFloor+1)throw new Error('所选原始楼层不可用');
  const usable=captured.filter(message=>message.role!=='system'&&!message.system);
  const endpoint=usable.find(message=>message.floor===endFloor);if(!endpoint)throw new Error('所选结束楼层不可用');
  const last=endpoint.role==='user'?usable.filter(message=>message.role==='assistant'&&message.floor<endFloor).at(-1):endpoint;
  if(!last||!usable.some(message=>message.role==='assistant'&&message.floor<=last.floor))throw new Error('范围内尚无完整 AI 回复');
  const actualRange={start:startFloor,end:last.floor};
  const excluded=new Set();
  for(const record of excludedFloors){if(!record||!Number.isSafeInteger(record.floor)||record.floor<0||!(record.identity===null||typeof record.identity==='string'))throw new Error('排除楼层无效');const message=captured.find(item=>item.floor===record.floor);if(message&&record.identity!==null&&record.identity!==message.identity)throw new Error('排除楼层身份已变化');excluded.add(record.floor);}
  const sentFloors=cleanSummaryFloors(usable.filter(message=>message.floor<=last.floor&&!excluded.has(message.floor)),{includeUser,rules});
  if(!sentFloors.length)throw new Error('清洗后没有可发送的正文');
  return freeze({epoch:source.epoch,requestedRange,actualRange,rawMessages:captured,fingerprint:sourceFingerprint(captured),includeUser,excludedFloors:copy(excludedFloors),sentFloors});
}
export function matchesSummarySource(snapshot,raw) {
  try{const current=assertRawSummarySource(raw);if(current.epoch!==snapshot.epoch)return false;const range=snapshot.requestedRange;const messages=current.messages.filter(message=>message.floor>=range.start&&message.floor<=range.end).sort((a,b)=>a.floor-b.floor);return JSON.stringify(messages)===JSON.stringify(snapshot.rawMessages);}catch{return false;}
}
