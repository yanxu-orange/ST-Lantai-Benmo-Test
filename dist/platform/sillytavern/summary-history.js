import {sameTarget} from '../../domain/memory/repository.js';
import {matchesStoredSummarySource} from '../../domain/summary/source.js';
import {summaryOf} from '../../domain/summary/data.js';

// ST rewrites mes and supplies a filtered index. Neither is a source identity.
export function mapSummaryPromptFloors(prompt,original) {
  if(!Array.isArray(prompt)||!Array.isArray(original)||prompt===original)return null;
  const originalObjects=new Set(original);if(prompt.some(message=>originalObjects.has(message)))return null;
  const byId=new Map(),byDate=new Map();
  const add=(map,key,value)=>{const items=map.get(key);if(items)items.push(value);else map.set(key,[value]);};
  original.forEach((source,floor)=>{if(!source)return;const item={source,floor};
    if(typeof source.id==='string'||Number.isSafeInteger(source.id))add(byId,source.id,item);
    if(typeof source.send_date==='string'||Number.isFinite(source.send_date))add(byDate,source.send_date,item);
  });
  const used=new Set(),floors=[];
  for(const message of prompt) {
    const hasId=typeof message.id==='string'||Number.isSafeInteger(message.id),hasDate=typeof message.send_date==='string'||Number.isFinite(message.send_date);
    if(!hasId&&!hasDate)return null;
    const matches=((hasId?byId.get(message.id):byDate.get(message.send_date))??[]).filter(({source})=>source&&source.is_user===message.is_user&&source.name===message.name
      &&(hasId?source.id===message.id:source.send_date===message.send_date)
      &&(!message.extra||source.extra===message.extra));
    if(matches.length!==1||used.has(matches[0].floor))return null;
    used.add(matches[0].floor);floors.push(matches[0].floor);
  }
  return floors;
}
export function filterSummaryPromptCopy({prompt,original,root,raw,replacementEventIds,type='normal'}={}) {
  const retained=reason=>({status:'retained',reason,prompt,removed:0});
  if(type==='quiet'||prompt?.some(item=>typeof item.mes==='string'&&item.mes.includes('[LANTAI_BACKGROUND_TASK:')))return retained('background-task');
  if(!(replacementEventIds instanceof Set)||!replacementEventIds.size)return retained('no-replacement-consumer');
  const mapping=mapSummaryPromptFloors(prompt,original);if(!mapping)return retained('source-mapping-unavailable');
  const floors=new Set();
  for(const batch of summaryOf(root).batches) {
    const members=root.events.filter(event=>batch.eventIds.includes(event.id)&&!event.supersededBy);
    if(!batch.hideOriginal||!members.length||members.length!==batch.eventIds.length||members.some(event=>!replacementEventIds.has(event.id))||!matchesStoredSummarySource(batch.sourceSnapshot,raw))continue;
    for(const message of batch.sourceSnapshot.sentFloors)floors.add(message.floor);
  }
  const filtered=prompt.filter((_,index)=>!floors.has(mapping[index]));
  return {status:filtered.length===prompt.length?'retained':'filtered',reason:filtered.length===prompt.length?'no-qualified-batch':null,prompt:filtered,removed:prompt.length-filtered.length};
}
export function createSummaryHistoryHook({repository,captureSource,getContext,getReplacementProof=()=>null}={}) {
  let disposed=false,snapshot={status:'retained',reason:'no-replacement-consumer',removed:0};
  return {
    async intercept(prompt,_contextSize,_abort,type) {
      if(disposed)return;
      const proof=getReplacementProof();
      if(!proof){snapshot={status:'retained',reason:'no-replacement-consumer',removed:0};return;}
      try {
        const target=repository.captureTarget();if(!sameTarget(target,proof.target))return;
        const root=await repository.read(target),raw=captureSource(target),context=getContext();
        if(disposed||!sameTarget(target,repository.captureTarget())||getReplacementProof()!==proof||proof.revision!==undefined&&root.revision!==proof.revision)return;
        const result=filterSummaryPromptCopy({prompt,original:context.chat,root,raw,replacementEventIds:proof.eventIds,type});
        if(result.status==='filtered')prompt.splice(0,prompt.length,...result.prompt);
        snapshot={status:result.status,reason:result.reason,removed:result.removed};
      }catch{snapshot={status:'retained',reason:'source-unavailable',removed:0};}
    },
    inspect:()=>({...snapshot}),dispose(){disposed=true;}
  };
}
