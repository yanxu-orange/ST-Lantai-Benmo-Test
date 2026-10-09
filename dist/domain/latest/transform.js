import {assertLatest} from './data.js';
import {matchesStoredLatestSource} from './source.js';
import {assertRawSummarySource} from '../summary/source.js';
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const specialKeys=['reasoning','reasoning_content','thinking','tool_calls','function_call','tool_invocations','image','images','media','file','files','attachments','audio','video'];
const present=value=>value!==undefined&&value!==null&&value!==false&&value!==''&&(!Array.isArray(value)||value.length>0);
function plainMessage(message,source){
  if(!message||!source||source.system||source.role==='system'||source.specialPayload===true||message.is_system===true||message.role==='system'||message.role==='tool')return null;
  if(specialKeys.some(key=>present(message[key])||present(message.extra?.[key]))||present(message.extra?.type))return null;
  const keys=['mes','content'].filter(key=>Object.hasOwn(message,key));
  if(keys.length!==1||typeof message[keys[0]]!=='string')return null;
  const role=message.role??(typeof message.is_user==='boolean'?(message.is_user?'user':'assistant'):null);
  return role===source.role?keys[0]:null;
}
export function formatLatestSummary(body){return `[最新摘要]\n${body.trim()}`;}

// The host owns mapping. Never infer floors from compacted prompt positions,
// duplicate text, or an assistant/user alternation that may no longer exist.
export function transformLatestMessages({messages,sourceMap,raw,latest}={}){
  if(!Array.isArray(messages))throw new Error('最新摘要发送消息无效');
  const output=messages.map(message=>message&&typeof message==='object'?{...message}:message);
  const domain=assertLatest(latest),source=assertRawSummarySource(raw);
  if(!domain.preferences.enabled||!source.messages.length||!(Array.isArray(sourceMap)||sourceMap instanceof Map))return output;
  const mapping=messages.map((_,index)=>sourceMap instanceof Map?sourceMap.get(index):sourceMap[index]),counts=new Map();
  for(const floor of mapping)if(integer(floor))counts.set(floor,(counts.get(floor)??0)+1);
  const byFloor=new Map(source.messages.map(message=>[message.floor,message])),indexByFloor=new Map();
  mapping.forEach((floor,index)=>{if(integer(floor)&&counts.get(floor)===1&&byFloor.has(floor))indexByFloor.set(floor,index);});
  const recentStart=Math.max(...source.messages.map(message=>message.floor))+1-domain.preferences.recentFloors,removed=new Set(),recordsByFloor=new Map();
  for(const record of domain.records){const snapshot=record.sourceSnapshot,current=byFloor.get(snapshot.assistantFloor);if(current?.replyId===snapshot.replyId)recordsByFloor.set(snapshot.assistantFloor,record);}
  for(const [floor,index] of indexByFloor){
    const original=byFloor.get(floor),key=plainMessage(messages[index],original);
    if(!key||original.role!=='assistant')continue;
    const record=recordsByFloor.get(floor);if(!record)continue;
    const relevant={epoch:source.epoch,messages:record.sourceSnapshot.rawMessages.flatMap(item=>byFloor.has(item.floor)?[byFloor.get(item.floor)]:[])};
    if(!matchesStoredLatestSource(record.sourceSnapshot,relevant))continue;
    const userFloor=record.sourceSnapshot.userFloor,userIndex=indexByFloor.get(userFloor);
    // A summary that covered a hidden or unrepresentable user floor would leak
    // that omitted content back into the send copy. Keep the original reply.
    if(userFloor!==null&&(userIndex===undefined||userIndex>=index||!plainMessage(messages[userIndex],byFloor.get(userFloor))))continue;
    const summary=formatLatestSummary(record.body),existing=messages[index][key];
    if(floor>=recentStart){output[index][key]=existing.endsWith(`\n\n${summary}`)?existing:`${existing}\n\n${summary}`;continue;}
    output[index][key]=summary;
    if(userFloor!==null&&userFloor<recentStart&&userIndex!==undefined&&userIndex<index&&plainMessage(messages[userIndex],byFloor.get(userFloor))&&byFloor.get(userFloor)?.role==='user')removed.add(userIndex);
  }
  return output.filter((_,index)=>!removed.has(index));
}
