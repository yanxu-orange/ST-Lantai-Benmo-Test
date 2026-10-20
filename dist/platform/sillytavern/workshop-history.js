import {sameTarget} from '../../domain/memory/repository.js';
import {cumulativeOf} from '../../domain/cumulative/data.js';
import {emptyLatest} from '../../domain/latest/data.js';
import {transformLatestMessages} from '../../domain/latest/transform.js';
import {filterSummaryPromptCopy,mapSummaryPromptFloors} from './summary-history.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ordinary=(message,row)=>message&&row&&!message.is_system&&!row.system&&row.semanticRole!=='system'&&['user','assistant'].includes(row.role)&&(!row.specialPayload||row.role==='assistant'&&row.latestTextOnly===true)&&!message.extra?.type&&!message.extra?.tool_invocations&&typeof message.mes==='string'&&!!message.mes.trim();
function mapped(messages,original,raw){
 if(!Array.isArray(messages))return null;
 const byFloor=new Map(raw.messages.map(row=>[row.floor,row]));
 // Ignore non-chat envelopes, but never infer a plain chat row's ownership.
 const plain=messages.filter(message=>!message?.is_system&&typeof message?.is_user==='boolean'&&!message.extra?.type&&!message.extra?.tool_invocations);
 const floors=mapSummaryPromptFloors(plain,original);if(!floors)return null;
 return floors.filter((floor,index)=>ordinary(plain[index],byFloor.get(floor)));
}
function cumulativeAuthority(root){
 const domain=cumulativeOf(root);
 return {currentVersionId:domain.currentVersionId,version:domain.versions.find(row=>row.id===domain.currentVersionId)??null,hiddenSegments:domain.hiddenSegments??[]};
}
// Only actual pre-latest send-copy visibility is sealed. No prompt text or
// unrelated injection slots are retained, and no fallback revives all raw chat.
export function createWorkshopHistoryTicket({before,afterSummary,afterCumulative,type='normal',cumulativeProof=null,getCurrent}={}){
 try{
  const initial=getCurrent(),{target,original,raw}=initial;
  const input=mapped(before,original,raw),summary=mapped(afterSummary,original,raw),visible=mapped(afterCumulative,original,raw);
  if(!input||!summary||!visible)return null;
  const inputSet=new Set(input),summarySet=new Set(summary),visibleSet=new Set(visible);
  if(summary.some(floor=>!inputSet.has(floor))||visible.some(floor=>!summarySet.has(floor)))return null;
  const eventRemoved=input.filter(floor=>!summarySet.has(floor)),ancientRemoved=summary.filter(floor=>!visibleSet.has(floor));
  if(ancientRemoved.length&&!cumulativeProof)return null;
  const ancient=cumulativeProof?cumulativeAuthority(initial.root):null,ancientProof=cumulativeProof?{config:structuredClone(cumulativeProof.config)}:null;
  if(ancient&&(ancient.currentVersionId!==cumulativeProof.selection.cumulative.currentVersionId||!initial.cumulativeCurrent(cumulativeProof)))return null;
  const capture=()=>{
   const value=getCurrent();if(!sameTarget(target,value.target))return null;
   const byFloor=new Map(value.raw.messages.map(row=>[row.floor,row]));
   const copies=input.map(floor=>value.original[floor]).filter((message,index)=>ordinary(message,byFloor.get(input[index]))).map(message=>({...message}));
   const mappedInput=mapSummaryPromptFloors(copies,value.original);if(!mappedInput||!equal(mappedInput,input))return null;
   const filtered=value.eventEnabled?filterSummaryPromptCopy({prompt:copies,original:value.original,root:value.root,raw:value.raw,type}).prompt:copies;
   const remaining=mapSummaryPromptFloors(filtered,value.original);if(!remaining||!equal(input.filter(floor=>!remaining.includes(floor)),eventRemoved))return null;
   if(ancient&&(!value.cumulativeCurrent(ancientProof)||!equal(cumulativeAuthority(value.root),ancient)))return null;
   return value;
  };
  const ticket={isCurrent:()=>{try{return !!capture();}catch{return false;}},prepare(source){
   try{
    const value=capture();if(!value)return {status:'unavailable',messages:[]};
    const pair=new Set(source.rawMessages.map(row=>row.floor)),allowed=new Set([...visible,...pair]),byFloor=new Map(value.raw.messages.map(row=>[row.floor,row]));
    const messages=value.original.flatMap((message,floor)=>floor<=source.assistantFloor&&allowed.has(floor)&&ordinary(message,byFloor.get(floor))?[{...message}]:[]);
    const sourceMap=mapSummaryPromptFloors(messages,value.original);if(!sourceMap)return {status:'unavailable',messages:[]};
    const raw={...value.raw,messages:value.raw.messages.filter(row=>row.floor<=source.assistantFloor)},latest=value.root.latest??emptyLatest();
    const transformed=transformLatestMessages({messages,sourceMap,raw,latest:{...latest,preferences:{...latest.preferences,enabled:value.summaryEnabled}}});
    const resultMap=mapSummaryPromptFloors(transformed,value.original);if(!resultMap)return {status:'unavailable',messages:[]};
    const history=transformed.flatMap((message,index)=>!pair.has(resultMap[index])?[{role:message.is_user?'user':'assistant',content:message.mes}]:[]);
    if(ancient?.version?.body?.trim())history.unshift({role:'assistant',content:ancient.version.body});
    return {status:'available',messages:history,policy:{enabled:value.summaryEnabled,recentFloors:latest.preferences.recentFloors}};
   }catch{return {status:'unavailable',messages:[]};}
  }};
  return ticket.isCurrent()?Object.freeze(ticket):null;
 }catch{return null;}
}
