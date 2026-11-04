import {assertLatest} from './data.js';
import {matchesStoredLatestSource} from './source.js';
import {assertRawSummarySource} from '../summary/source.js';
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const specialKeys=['tool_calls','function_call','tool_invocations','image','images','media','file','files','attachments','audio','video'];
const present=value=>value!==undefined&&value!==null&&value!==false&&value!==''&&(!Array.isArray(value)||value.length>0);
function plainMessage(message,source){
  if(!message||!source||source.system||source.role==='system'||source.specialPayload===true&&(source.role!=='assistant'||source.latestTextOnly!==true)||message.is_system===true||message.role==='system'||message.role==='tool')return null;
  if(specialKeys.some(key=>present(message[key])||present(message.extra?.[key]))||present(message.extra?.type))return null;
  const keys=['mes','content'].filter(key=>Object.hasOwn(message,key));
  if(keys.length!==1||typeof message[keys[0]]!=='string')return null;
  const role=message.role??(typeof message.is_user==='boolean'?(message.is_user?'user':'assistant'):null);
  return role===source.role?keys[0]:null;
}
export function formatLatestSummary(body){return `[最新摘要]\n${body.trim()}`;}
export const LATEST_SUMMARY_GUIDANCE='以下是此前一段剧情的摘要，供你了解近期发生了什么，它的进度通常衔接在大纲之后，需要你认真核对前后逻辑。';
export const RECENT_STORY_GUIDANCE='以下是最近的完整剧情正文，其中可能包含状态栏等附加信息。请结合用户最新输入，承接当前情境继续创作。';
const withGuidance=(intro,body)=>body.startsWith(intro+'\n\n')?body:intro+'\n\n'+body;

// The host owns mapping. Never infer floors from compacted prompt positions,
// duplicate text, or an assistant/user alternation that may no longer exist.
export function transformLatestMessages({messages,sourceMap,raw,latest,diagnostics=[],guidance=false}={}){
  if(!Array.isArray(messages))throw new Error('最新摘要发送消息无效');
  const output=messages.map(message=>message&&typeof message==='object'?{...message}:message);
  const domain=assertLatest(latest),source=assertRawSummarySource(raw);
  if(!domain.preferences.enabled||!source.messages.length||!(Array.isArray(sourceMap)||sourceMap instanceof Map))return output;
  const mapping=messages.map((_,index)=>sourceMap instanceof Map?sourceMap.get(index):sourceMap[index]),counts=new Map();
  for(const floor of mapping)if(integer(floor))counts.set(floor,(counts.get(floor)??0)+1);
  const byFloor=new Map(source.messages.map(message=>[message.floor,message])),indexByFloor=new Map();
  mapping.forEach((floor,index)=>{if(integer(floor)&&counts.get(floor)===1&&byFloor.has(floor))indexByFloor.set(floor,index);});
  // Visibility and provenance are separate: native /hide changes the raw role
  // to system, but the host's semanticRole still proves the original speaker.
  // This copy is used only for identity matching, never to add hidden messages.
  const semanticByFloor=new Map(source.messages.map(message=>[message.floor,
    ['user','assistant','system'].includes(message.semanticRole)?{...message,role:message.semanticRole,system:message.semanticRole==='system'}:message]));
  const recentStart=Math.max(...source.messages.map(message=>message.floor))+1-domain.preferences.recentFloors,removed=new Set(),replaced=new Map();
  for(const record of domain.records){
    const snapshot=record.sourceSnapshot,floor=snapshot.assistantFloor,userFloor=snapshot.userFloor;
    const reply=semanticByFloor.get(floor);
    if(record.stale===true||reply?.specialPayload===true&&reply.latestTextOnly!==true)continue;
    const relevant={epoch:source.epoch,messages:snapshot.rawMessages.flatMap(item=>semanticByFloor.has(item.floor)?[semanticByFloor.get(item.floor)]:[])};
    if(!matchesStoredLatestSource(snapshot,relevant))continue;
    const pairFloors=userFloor===null?[floor]:[userFloor,floor];
    // Ambiguous or unsupported visible members are not hidden members. Never
    // consume their text or fall back to another slot on incomplete mapping.
    if(pairFloors.some(member=>(counts.get(member)??0)>1))continue;
    const slots=pairFloors.flatMap(member=>{
      const index=indexByFloor.get(member);
      return index===undefined?[]:[{floor:member,index,key:plainMessage(messages[index],byFloor.get(member))}];
    });
    const unsupported=slots.filter(slot=>!slot.key);
    if(unsupported.length){for(const slot of unsupported)diagnostics.push({floor:slot.floor,reason:'unsupported-message-payload'});continue;}
    if(slots.length===2&&slots[0].index>=slots[1].index)continue;
    // X counts original absolute floors, not visible rows or paired turns.
    // A pair straddling the boundary replaces only its eligible old member.
    const eligible=slots.filter(slot=>slot.floor<recentStart),chosen=eligible.at(-1);
    if(!chosen)continue;
    const {index,key}=chosen;
    // Allowlist the host envelope, never spread old text-bearing attachments.
    // Preserve this slot's role, including user-only replacements.
    output[index]=Object.fromEntries(['id','name','role','is_user','is_system','send_date'].filter(field=>Object.hasOwn(messages[index],field)).map(field=>[field,messages[index][field]]));
    output[index][key]=record.body;
    replaced.set(index,key);
    for(const slot of eligible)if(slot.index!==index)removed.add(slot.index);
  }
  if(guidance){
    // Guidance belongs to this send copy, never saved summaries or background
    // workshop materials. Pick actual send order, not record insertion order.
    const first=[...replaced.keys()].sort((a,b)=>a-b)[0];
    if(first!==undefined){const key=replaced.get(first);output[first][key]=withGuidance(LATEST_SUMMARY_GUIDANCE,output[first][key]);}
    // A missing old summary does not make its original a recent-story boundary.
    const recent=output.findIndex((message,index)=>{
      const floor=mapping[index],key=plainMessage(message,byFloor.get(floor));
      return integer(floor)&&floor>=recentStart&&counts.get(floor)===1&&!removed.has(index)&&!replaced.has(index)&&key&&!!message[key].trim();
    });
    if(recent!==-1){const key=plainMessage(output[recent],byFloor.get(mapping[recent]));output[recent][key]=withGuidance(RECENT_STORY_GUIDANCE,output[recent][key]);}
  }
  return output.filter((_,index)=>!removed.has(index));
}
