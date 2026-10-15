import {latestSourceKey,storedLatestSource} from '../latest/source.js';

// Old schedule keys embedded the complete original pair. Preserve their outcome
// discriminator while replacing that nested key with source locators only.
export function migrateScheduleSourceKey(value){
 if(typeof value!=='string')return value;
 let key;
 try{key=JSON.parse(value);}catch{return value;}
 if(!Array.isArray(key)||key[0]!=='round'||typeof key[1]!=='string')return value;
 let source;
 try{source=JSON.parse(key[1]);}catch{return value;}
 if(!Array.isArray(source)||source.length!==2||typeof source[0]!=='string'||!Array.isArray(source[1]))return value;
 key[1]=latestSourceKey({replyId:source[0],rawMessages:source[1]});
 return JSON.stringify(key);
}

const hasBody=messages=>Array.isArray(messages)&&messages.some(row=>row&&['text','content','mes'].some(key=>Object.hasOwn(row,key)));
function normalizeRecord(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value)){for(let index=0;index<value.length;index++)value[index]=normalizeRecord(value[index]);return value;}
 if(typeof value.replyId==='string'&&Number.isSafeInteger(value.assistantFloor)&&Array.isArray(value.rawMessages)&&Array.isArray(value.sentFloors)){
  // Current locators still pass their normal strict validation later. A legacy
  // body-bearing proof is projected once, including its obsolete text digest.
  if(hasBody(value.rawMessages)||hasBody(value.sentFloors))return storedLatestSource(value);
  return value;
 }
 for(const key of Object.keys(value))value[key]=normalizeRecord(value[key]);
 if(value.kind==='summary'&&typeof value.batchId==='string'&&value.evidence)delete value.fingerprint;
 if(Object.hasOwn(value,'sourceKey'))value.sourceKey=migrateScheduleSourceKey(value.sourceKey);
 if(Array.isArray(value.sourceKeys)){
  const keys=value.sourceKeys.map(migrateScheduleSourceKey),unique=[],sources=[],seen=new Set();
  for(let index=0;index<keys.length;index++)if(!seen.has(keys[index])){seen.add(keys[index]);unique.push(keys[index]);if(Array.isArray(value.sources))sources.push(value.sources[index]);}
  value.sourceKeys=unique;
  if(Array.isArray(value.sources))value.sources=sources;
 }
 return value;
}

// Mutates only an already-owned time projection. Callers must clone host/root
// data before using this helper; no write or original-chat mutation occurs here.
export function migrateTimeSources(value){
 if(!value||typeof value!=='object')return value;
 normalizeRecord(value);
 if(Array.isArray(value.manualAnchor?.boundary))value.manualAnchor.boundary=value.manualAnchor.boundary.map(message=>{
  if(!message||typeof message!=='object')return message;
  const {floor,identity,role,system=role==='system',date=null,swipeId=null}=message;
  return {floor,identity,role,system,date,swipeId};
 });
 return value;
}
