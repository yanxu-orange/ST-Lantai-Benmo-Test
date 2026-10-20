import {sameTarget} from '../../domain/memory/repository.js';
import {featureGate} from '../../domain/controls/gate.js';
import {matchesStoredSummarySource} from '../../domain/summary/source.js';
import {summaryOf} from '../../domain/summary/data.js';
import {positionedSummarySnapshot} from '../../domain/summary/source-positions.js';

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
export function filterSummaryPromptCopy({prompt,original,root,raw,type='normal'}={}) {
  const retained=reason=>({status:'retained',reason,prompt,removed:0});
  if(type==='quiet'||prompt?.some(item=>[item?.mes,item?.content].some(text=>typeof text==='string'&&text.includes('[LANTAI_BACKGROUND_TASK:'))))return retained('background-task');
  if(!['normal','regenerate','swipe','continue'].includes(type))return retained('unsupported-generation');
  const mapping=mapSummaryPromptFloors(prompt,original);if(!mapping)return retained('source-mapping-unavailable');
  const floors=new Set();
  const summary=summaryOf(root);
  for(const batch of summary.batches) {
    const members=root.events.filter(event=>batch.eventIds.includes(event.id)&&!event.supersededBy);
    const source=positionedSummarySnapshot(batch,summary);
    if(!batch.hideOriginal||!members.length||members.length!==batch.eventIds.length||!source||!matchesStoredSummarySource(source,raw))continue;
    for(const message of source.sentFloors)floors.add(message.floor);
  }
  const filtered=prompt.filter((_,index)=>!floors.has(mapping[index]));
  return {status:filtered.length===prompt.length?'retained':'filtered',reason:filtered.length===prompt.length?'no-qualified-batch':null,prompt:filtered,removed:prompt.length-filtered.length};
}
export function createSummaryHistoryHook({repository,captureSource,peekConfirmed,getContext,getControls}={}) {
  const gate=featureGate(getControls,'event'),releases=[];
  let disposed=false,serial=0,snapshot={status:'retained',reason:'not-prepared',removed:0};
  const context=getContext?.();
  for(const name of ['CHAT_CHANGED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED']) {
    const event=context?.eventTypes?.[name],source=context?.eventSource;
    if(!event||typeof source?.on!=='function')continue;
    const listener=()=>{serial++;};
    source.on(event,listener);releases.push(()=>(source.off??source.removeListener)?.call(source,event,listener));
  }
  return {
    async intercept(prompt,_contextSize,_abort,type='normal') {
      if(disposed)return;
      const ticket=++serial;
      const keep=reason=>{if(ticket===serial)snapshot={status:'retained',reason,removed:0};};
      keep('not-prepared');
      if(type==='quiet'||prompt?.some(item=>[item?.mes,item?.content].some(text=>typeof text==='string'&&text.includes('[LANTAI_BACKGROUND_TASK:')))){keep('background-task');return;}
      if(!['normal','regenerate','swipe','continue'].includes(type)){keep('unsupported-generation');return;}
      try {
        if(!gate.allowed()){keep('disabled');return;}
        const target=repository.captureTarget(),control=gate.capture(),raw=captureSource(target),source=JSON.stringify(raw);
        const root=await repository.read(target);
        // The saved batch is the hiding authority, not this round's recall set.
        // Recheck the confirmed root and live source after the asynchronous read.
        const current=()=>!disposed&&ticket===serial&&gate.matches(control)&&sameTarget(target,repository.captureTarget())
          &&peekConfirmed(target).revision===root.revision&&JSON.stringify(captureSource(target))===source;
        if(!current()){keep('source-changed');return;}
        const result=filterSummaryPromptCopy({prompt,original:getContext()?.chat,root,raw,type});
        if(!current()){keep('source-changed');return;}
        if(result.status==='filtered')prompt.splice(0,prompt.length,...result.prompt);
        snapshot={status:result.status,reason:result.reason,removed:result.removed};
      }catch{keep('source-unavailable');}
    },
    inspect:()=>({...snapshot}),dispose(){disposed=true;serial++;releases.forEach(release=>release());}
  };
}
