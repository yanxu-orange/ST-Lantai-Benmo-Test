import {sameTarget} from '../../domain/memory/repository.js';
import {cumulativeGenerationSupported} from './cumulative-runtime.js';

const messageRole = item => item?.is_system === true || typeof item?.is_user !== 'boolean' || item.extra?.type || item.extra?.tool_invocations ? null : item.is_user ? 'user' : 'assistant';
const messageId = item => (typeof item?.id === 'string' && item.id || Number.isSafeInteger(item?.id)) ? item.id : null;
const messageDate = item => item?.send_date == null ? null : String(item.send_date);
function locator(item) {
  try {
    const value=JSON.parse(item.identity);
    if(!Array.isArray(value)||value.length!==3||value[0]!==item.floor||value[2]!==item.date
      || !(value[1]===null || typeof value[1]==='string'&&value[1] || Number.isSafeInteger(value[1])))return null;
    if(value[1]===null && (typeof value[2]!=='string'||!value[2]))return null;
    return {id:value[1],date:value[2],role:item.role};
  }catch{return null;}
}
function matches(item, key) {
  return messageRole(item)===key.role && (key.id===null || messageId(item)===key.id)
    && (key.date===null || messageDate(item)===key.date);
}
// Ephemeral per-call indices preserve ambiguity checks without scanning the
// entire chat once for every hidden floor. Never cache across chat mutations.
function identityIndex(messages) {
  const exact=new Map(),byId=new Map(),byDate=new Map();
  const add=(map,key,index)=>{const prior=map.get(key);map.set(key,prior===undefined?index:-1);};
  messages.forEach((message,index)=>{
    const role=messageRole(message);if(role!=='user'&&role!=='assistant')return;
    const id=messageId(message),date=messageDate(message);
    add(exact,JSON.stringify([role,id,date]),index);
    if(id!==null)add(byId,JSON.stringify([role,id]),index);
    if(date!==null)add(byDate,JSON.stringify([role,date]),index);
  });
  return key=>key.id===null?byDate.get(JSON.stringify([key.role,key.date])):
    key.date===null?byId.get(JSON.stringify([key.role,key.id])):
    exact.get(JSON.stringify([key.role,key.id,key.date]));
}
// Match identities in both arrays; a saved floor is never a current array index.
export function filterCumulativePromptCopy({prompt, original, hiddenSegments=[], type='normal'} = {}) {
  const retained=reason=>({status:'retained',reason,prompt,removed:0});
  if(!cumulativeGenerationSupported(prompt,type))return retained('background-or-unsupported');
  if(!Array.isArray(prompt)||!Array.isArray(original)||prompt===original)return retained('not-a-prompt-copy');
  const originalObjects=new Set(original);
  if(prompt.some(item=>originalObjects.has(item)))return retained('not-a-prompt-copy');
  const removed=new Set();
  let originalIndex,promptIndex;
  for(const segment of hiddenSegments)for(const item of segment.messages) {
    const key=locator(item);if(!key)continue;
    if(key.role==='user'||key.role==='assistant') {
      promptIndex??=identityIndex(prompt);
      const index=promptIndex(key);if(!(index>=0))continue;
      originalIndex??=identityIndex(original);
      if(originalIndex(key)>=0)removed.add(index);
    }else{
      // Preserve the existing conservative behavior for non-domain inputs.
      if(original.filter(message=>matches(message,key)).length!==1)continue;
      const indices=prompt.flatMap((message,index)=>matches(message,key)?[index]:[]);
      if(indices.length===1)removed.add(indices[0]);
    }
  }
  const filtered=prompt.filter((_,index)=>!removed.has(index));
  return {status:removed.size?'filtered':'retained',reason:removed.size?null:'no-unique-hidden-message',prompt:filtered,removed:removed.size};
}
export function createCumulativeHistoryHook({repository,settings,getContext,getReplacementProof=()=>null} = {}) {
  let disposed=false,serial=0,status={status:'retained',reason:'no-replacement-consumer',removed:0};
  const valid=proof=>{
    try{return !disposed && getReplacementProof()===proof && sameTarget(proof.target,repository.captureTarget())
      && repository.matchesCumulative(proof.target,proof.selection) && settings.matchesCumulativeGeneration(proof.config);}
    catch{return false;}
  };
  return Object.freeze({
    async intercept(prompt,_size,_abort,type='normal') {
      if(disposed)return;
      const ticket=++serial;
      const keep=reason=>{if(ticket===serial)status={status:'retained',reason,removed:0};};
      let proof;try{proof=getReplacementProof();}catch{keep('authority-unavailable');return;}
      if(!proof||!valid(proof)){keep('no-replacement-consumer');return;}
      if(!cumulativeGenerationSupported(prompt,type)){keep('background-or-unsupported');return;}
      try {
        const selection=await repository.captureCumulative(proof.target);
        if(ticket!==serial||!valid(proof))return;
        const result=filterCumulativePromptCopy({prompt,original:getContext()?.chat,hiddenSegments:selection.cumulative.hiddenSegments??[],type});
        if(ticket!==serial||!valid(proof))return;
        if(result.status==='filtered')prompt.splice(0,prompt.length,...result.prompt);
        status={status:result.status,reason:result.reason,removed:result.removed};
      }catch{keep('authority-unavailable');}
    },
    inspect:()=>({...status}),dispose(){disposed=true;serial++;}
  });
}
