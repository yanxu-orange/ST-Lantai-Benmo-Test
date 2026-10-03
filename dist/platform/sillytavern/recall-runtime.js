import {sameTarget} from '../../domain/memory/repository.js';
import {buildRecall,extractRecallInputs} from '../../domain/recall/build.js';
import {mapSummaryPromptFloors} from './summary-history.js';

export const RECALL_PROMPT_KEY='lantai_benmo_memory_context';
const supported=new Set(['normal','regenerate','swipe','continue']);
const copy=value=>structuredClone(value);
const text=message=>typeof message?.mes==='string'?message.mes:typeof message?.content==='string'?message.content:'';
// These are the actual interceptor messages after ST's own transformations.
// Their filtered index is not an original floor identifier.
export function recallInputs(messages,recentFloorCount,original=null) {
  const usable=Array.isArray(messages)?messages:[],eligible=message=>message&&!message.is_system&&message.role!=='system';
  const mapping=original&&messages!==original?mapSummaryPromptFloors(messages,original):null;
  let index=-1;
  for(let i=usable.length-1;i>=0;i--)if(eligible(usable[i])&&usable[i]?.is_user&&text(usable[i]).trim()){index=i;break;}
  if(index<0)for(let i=usable.length-1;i>=0;i--)if(eligible(usable[i])&&text(usable[i]).trim()){index=i;break;}
  const recentHistory=[];
  for(let i=index-1;i>=0&&recentHistory.length<recentFloorCount;i--)if(eligible(usable[i])&&text(usable[i]).trim())recentHistory.push({floor:mapping?.[i]??i,text:text(usable[i]),distanceFromCurrent:mapping?mapping[index]-mapping[i]:index-i});
  return {input:index<0?'':text(usable[index]),recentHistory};
}
export function createRecallRuntime({repository,settings,getContext,captureSource,readInput=()=>'',build=buildRecall}={}) {
  let disposed=false,ticket=0,proof=null,flight=null;
  const records=new Map(),listeners=new Set(),releases=[];
  const key=target=>JSON.stringify([target.chatId,target.rootId]);
  const notify=()=>{for(const fn of [...listeners])try{fn();}catch{/* observers cannot break host generation */}};
  const current=(target,serial,config,source)=>!disposed&&serial===ticket&&sameTarget(target,repository.captureTarget())
    &&settings.captureRecall().epoch===config.epoch&&(!captureSource||JSON.stringify(captureSource(target))===source);
  function clear(reason='cancelled') {
    const previous=flight,oldProof=proof;ticket++;proof=null;flight=null;
    if(previous)record(previous.target,{status:'failed',type:previous.type,message:'本轮召回已取消，未注入记忆。'});
    else if(reason==='stopped'&&oldProof)record(oldProof.target,{status:'failed',type:'cancelled',message:'本轮生成已取消，未继续注入记忆。'});
    try {
      const context=getContext();if(typeof context?.setExtensionPrompt!=='function')throw new Error();
      context.setExtensionPrompt(RECALL_PROMPT_KEY,'',1,0,false,0);return true;
    }catch {
      let target;try{target=repository.captureTarget();}catch{target=previous?.target??oldProof?.target;}
      if(target)record(target,{status:'unconfirmed',type:'cleanup',message:'记忆槽清理尚未确认，可能仍保留旧内容；本轮不隐藏原文。'});
      return false;
    }
  }
  function record(target,value){records.set(key(target),copy(value));notify();}
  async function compute(messages,target,serial,previewInput=null) {
    const config=settings.captureRecall(),source=captureSource?JSON.stringify(captureSource(target)):null;
    const root=await repository.read(target);
    if(!current(target,serial,config,source))throw new Error('stale');
    const context=getContext(),inputs=previewInput===null?recallInputs(messages,config.recall.recentFloorCount,context?.chat)
      :extractRecallInputs(messages,{recentFloorCount:config.recall.recentFloorCount,input:previewInput,currentIndex:messages.length});
    const result=await build({events:root.events,batches:root.summary?.batches??[],...inputs,settings:config.recall,
      countTokens:typeof context?.getTokenCountAsync==='function'?body=>context.getTokenCountAsync(body):null});
    if(!current(target,serial,config,source))throw new Error('stale');
    const authority=await repository.read(target);
    if(!current(target,serial,config,source)||JSON.stringify(authority)!==JSON.stringify(root))throw new Error('stale');
    return {result,target,config,source,serial,revision:root.revision};
  }
  async function preview(messages) {
    const target=repository.captureTarget(),serial=ticket,input=String(readInput()??'');
    const value=await compute(messages??getContext()?.chat,target,serial,input);
    if(input!==String(readInput()??''))throw new Error('stale');
    return copy(value.result);
  }
  async function intercept(messages,_size,_abort,type='normal') {
    if(disposed)return;
    if(!clear())return;
    if(!supported.has(type)||messages?.some(message=>text(message).includes('[LANTAI_BACKGROUND_TASK:')))return;
    let target;
    const serial=ticket;
    try {
      target=repository.captureTarget();
      flight={target,type};
      const value=await compute(messages,target,serial);
      if(!current(target,serial,value.config,value.source))return;
      const context=getContext();
      if(typeof context?.setExtensionPrompt!=='function')throw new Error('injection-unavailable');
      context.setExtensionPrompt(RECALL_PROMPT_KEY,value.result.prompt,1,value.config.recall.memoryDepth,false,0);
      // Host callbacks may synchronously switch chat or settings during writing.
      if(!current(target,serial,value.config,value.source)){clear();return;}
      proof={target:copy(target),eventIds:new Set(value.result.selectedIds),revision:value.revision,serial,config:value.config,source:value.source};
      record(target,{status:'injected',type,depth:value.config.recall.memoryDepth,prompt:value.result.prompt,result:value.result});
      flight=null;
    }catch {
      if(!disposed&&serial===ticket){const cleared=clear();if(cleared&&target&&sameTarget(target,repository.captureTarget()))record(target,{status:'failed',type,message:'本轮召回失败，未注入记忆。'});}
    }
  }
  const context=getContext();
  for(const name of ['CHAT_CHANGED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED']) {
    const event=context?.eventTypes?.[name],source=context?.eventSource;
    if(!event||typeof source?.on!=='function')continue;
    const listener=()=>{clear(name==='GENERATION_STOPPED'?'stopped':name);notify();};
    source.on(event,listener);releases.push(()=>(source.off??source.removeListener)?.call(source,event,listener));
  }
  return Object.freeze({preview,intercept,clear,
    getReplacementProof(){try{return proof&&current(proof.target,proof.serial,proof.config,proof.source)?proof:null;}catch{return null;}},
    inspect(){try{return copy(records.get(key(repository.captureTarget()))??{status:'empty'});}catch{return {status:'empty'};}},
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    dispose(){if(disposed)return;clear();disposed=true;releases.forEach(fn=>fn());listeners.clear();records.clear();}
  });
}
