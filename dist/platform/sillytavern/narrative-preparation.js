import {reconcileNarrativeSource,narrativeHighWater,narrativeBatchSourceChoice} from '../../domain/narrative/data.js';
import {prepareNarrativeUpdate,prepareCombinedNarrativeRequest,projectNarrativeMemory,estimateNarrativeTokens,narrativeCardFields} from '../../domain/narrative/source.js';
import {buildCombinedNarrativeRequest} from '../../domain/narrative/requests.js';

// Effective pre-request state, also used when adopting a reviewed result.
export function projectNarrativeBatchBase(domain,raw,{kinds,restart=false,index=0,regenerateLatest=false}={}) {
  const projected=reconcileNarrativeSource(domain,raw).domain;
  if(index===0&&(restart||regenerateLatest)){
    for(const kind of kinds){
      if(regenerateLatest){
        const baseline=domain.latestGeneration?.[kind]?.baseline;
        if(!baseline||!Array.isArray(baseline.entries)||!Object.hasOwn(baseline,'progress'))throw Object.assign(new Error('最新生成缺少可用的生成前基版，无法重新生成'),{code:'NARRATIVE_REGENERATION_UNAVAILABLE'});
        projected[kind]=structuredClone(baseline.entries);projected.progress[kind]=structuredClone(baseline.progress);
      }else{projected[kind]=[];projected.progress[kind]=null;}
    }
  }
  return projected;
}

// Read-only preparation shared by the actual sender and the transient preview.
// Never retain a provider, repository, or mutable host object in the result.
export async function prepareNarrativeBatch({domain,root,raw,range,kinds,materialKinds=kinds,restart=false,index=0,summary=false,summarySource,jointBudget,sentFloors,regenerateLatest=false,card=null,rules=[],countTokens=null,isCurrent=()=>true}={}) {
  const guard=()=>{
    let current=false;try{current=typeof isCurrent==='function'&&isCurrent()===true;}catch{}
    if(!current)throw Object.assign(new Error('自述或大纲任务已取消或来源已变化'),{code:'NARRATIVE_CANCELLED'});
  };
  guard();
  if(!Array.isArray(kinds)||!kinds.length||new Set(kinds).size!==kinds.length||kinds.some(kind=>!['self','outline'].includes(kind)))throw new Error('请选择有效的叙事类别');
  // Capture all data before the first tokenizer await, including retry inputs.
  const captured=structuredClone({domain,root,raw,range,kinds,materialKinds,restart,index,summary,summarySource,jointBudget,sentFloors,regenerateLatest,card,rules});
  ({domain,root,raw,range,kinds,materialKinds,card,rules,sentFloors}=captured);
  // Exact-text memoization is local to this preparation only. A host tokenizer
  // need not be additive; every distinct budget decision is still counted.
  const counts=new Map(),hostCount=countTokens;
  const count=typeof hostCount==='function'?async text=>{
    guard();if(counts.has(text))return counts.get(text);
    const value=await hostCount(text);guard();
    if(Number.isFinite(value)&&value>=0)counts.set(text,value);
    return value;
  }:null;
  const projected=projectNarrativeBatchBase(domain,raw,{kinds,restart,index,regenerateLatest});
  const events=projectNarrativeMemory(root,raw),tasks=[];
  const joint=materialKinds.length>1;
  const originalOnly=materialKinds.some(kind=>(summarySource??projected.preferences[kind].autoSource)==='cumulative');
  const sharedChoice=narrativeBatchSourceChoice(projected.preferences,materialKinds,{summary,summarySource});
  const materialSelection=joint?{
    card:projected.preferences.self.readCard?narrativeCardFields(card):null,
    readOriginal:sharedChoice==='original',
    readMemory:sharedChoice==='memory',
  }:null;
  const sharedRange=summary&&joint?{...range,startFloor:Math.max(range.startFloor,Math.min(...kinds.map(kind=>narrativeHighWater(domain,kind)+1)))}:null;
  for(const kind of kinds){
    const taskRange=sharedRange??(summary?{...range,startFloor:Math.max(range.startFloor,narrativeHighWater(domain,kind)+1)}:range);
    tasks.push(await prepareNarrativeUpdate(projected,raw,{kind,...taskRange,events,card,originalOnly,materialSelection,sharedMaterials:joint?tasks[0]:null,...(jointBudget!==undefined?{jointBudget}:{}),...(originalOnly&&sentFloors?{sentFloors}:{}),rules,countTokens:count,deferAccounting:jointBudget!==undefined,isCurrent:()=>{guard();return true;}}));
  }
  guard();
  if(jointBudget!==undefined){
    const combined=await prepareCombinedNarrativeRequest(tasks,{jointBudget,countTokens:count,isCurrent:()=>{guard();return true;}});
    guard();
    // This exact envelope includes final joint pruning and shared-material dedup.
    return {projected,tasks:combined.tickets,request:combined.request,usage:combined.usage};
  }
  const request=buildCombinedNarrativeRequest(tasks),encoded=JSON.stringify(request.messages);
  let inputTokens;const estimated=tasks.some(task=>task.usage.estimated)||typeof countTokens!=='function';
  if(!estimated){
    try{
      inputTokens=await count(encoded);guard();
      if(!Number.isFinite(inputTokens)||inputTokens<0)throw new TypeError('宿主 token 计数不可用');
      inputTokens=Math.ceil(inputTokens);
    }catch(error){
      guard();if(error.code?.startsWith('NARRATIVE_'))throw error;
      // Use one accounting convention for materials, output, and final input.
      return prepareNarrativeBatch({...captured,countTokens:null,isCurrent});
    }
  }else inputTokens=estimateNarrativeTokens(encoded);
  guard();
  const outputReserve=tasks.reduce((sum,task)=>sum+task.usage.outputReserve,0);
  const usage={inputTokens,outputReserve,totalTokens:inputTokens+outputReserve,budget:Math.max(...tasks.map(task=>task.usage.budget)),estimated,tokenMethod:estimated?'estimate':'host'};
  return {projected,tasks,request,usage};
}
