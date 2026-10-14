import {sameTarget} from '../../domain/memory/repository.js';
import {sourceFingerprint,durableSourceMessages} from '../../domain/summary/source.js';
import {matchesStoredNarrativeSource} from '../../domain/narrative/core.js';
import {summaryOf} from '../../domain/summary/data.js';
import {emptyNarrative,assertNarrative,applyNarrativeResponse,reconcileNarrativeSource,narrativeHighWater} from '../../domain/narrative/data.js';
import {prepareNarrativeUpdate,prepareCombinedNarrativeRequest,matchesNarrativeSource,matchesNarrativeMemory,projectNarrativeMemory} from '../../domain/narrative/source.js';
import {buildNarrativeRequest,parseNarrativeResponse,buildCombinedNarrativeRequest,parseCombinedNarrativeResponse} from '../../domain/narrative/requests.js';
import {DEFAULT_NARRATIVE_PROMPTS,NARRATIVE_OUTLINE_INJECTION,narrativeSelfInjection} from '../../domain/narrative/prompts.js';

export const NARRATIVE_PROMPT_KEYS=Object.freeze({outline:'lantai_benmo_narrative_0_outline',self:'lantai_benmo_narrative_1_self'});
const kinds=['self','outline'],supported=new Set(['normal','regenerate','swipe','continue']);
const clone=value=>structuredClone(value),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const emptyStatus=()=>({status:'idle',error:'',materialReport:null,sourceStale:false,addedCount:null,changedCount:null});
const assertKind=kind=>{if(!kinds.includes(kind))throw new Error('本末类别无效');return kind;};
const content=(domain,kind)=>kind==='self'?domain.self:domain.outline;
// A host generateRaw/tokenizer promise can ignore AbortSignal indefinitely.
// Settle our logical task on cancellation so the existing queue advances; the
// abandoned host promise remains observed and never regains write authority.
function abortable(start,signal){
  const cancelled=()=>Object.assign(new Error('自述或大纲任务已取消'),{code:'NARRATIVE_CANCELLED'});
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(callback,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',stop);callback(value);};
    const stop=()=>finish(reject,cancelled());
    signal.addEventListener('abort',stop,{once:true});
    if(signal.aborted){stop();return;}
    Promise.resolve().then(()=>{if(signal.aborted)throw cancelled();return start();}).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}

// Summary commits own automatic generation. Foreground replies only invalidate
// stale work and injection; they never start independent narrative API calls.
export function createNarrativeRuntime({repository,adapter,settings,provider,getGenerationSettings,getContext,getControls,captureSource,getSummaryActive}={}) {
  let disposed=false,target=null,lastTarget=null,selection=null,serial=0,readSerial=0,injectionSerial=0,tail=Promise.resolve(),mutationTail=Promise.resolve();
  let receipt=null,foregroundEnded=false,foregroundStopped=false,foregroundType=null,foregroundActive=false,quietDepth=0;
  let state={target:null,narrative:emptyNarrative(),self:emptyStatus(),outline:emptyStatus(),writeBlocked:false,error:''};
  const listeners=new Set(),releases=[],jobs=new Set(),epochs={self:0,outline:0},seenReceipts=new Set(),automaticPaused=new Set(),runners=new Map();
  let unconfirmed=false;
  const controls=()=>getControls?.();
  const allowed=kind=>!disposed&&controls()?.allowed('enabled')===true&&controls()?.allowed(kind)===true;
  const current=t=>{try{return !disposed&&sameTarget(t,repository.captureTarget());}catch{return false;}};
  const source=t=>(captureSource??adapter.captureSummarySource?.bind(adapter))(t);
  const generation=()=>getGenerationSettings?.()??settings?.captureEventGeneration?.().generation??{epoch:0,summaryCleaning:{rules:[]}};
  const snapshot=()=>clone({...state,preferencesWriteBlocked:unconfirmed||!target||!current(target),writeBlocked:state.writeBlocked||unconfirmed||controls()?.allowed('enabled')!==true});
  const notify=()=>{for(const listener of listeners)try{listener(snapshot());}catch{/* Display observers cannot change task ownership. */}};
  const categoryStatus=(kind,patch)=>{state={...state,[kind]:{...state[kind],...patch}};notify();};
  function adopt(t,captured){
    target=clone(t);lastTarget=clone(t);selection=captured;
    state={...state,target:clone(t),narrative:clone(captured.narrative),writeBlocked:unconfirmed,error:unconfirmed?state.error:''};
    for(const kind of kinds)state[kind]={...state[kind],sourceStale:false,materialReport:captured.narrative.progress[kind]?.materialsReport??null};
    markSources(false);notify();return snapshot();
  }
  function markSources(publish=true){
    if(!target||!current(target))return;
    let stale;
    try{stale=reconcileNarrativeSource(state.narrative,source(target)).staleKinds;}catch{stale=kinds.filter(kind=>state.narrative.progress[kind]);}
    for(const kind of stale)state[kind]={...state[kind],sourceStale:true,status:'stale',error:'来源已变化，保留内容供查看；请更新后再注入',materialReport:null};
    if(publish)notify();
  }
  async function load({target:prepared,readView}={}){
    const ticket=serial,readTicket=++readSerial,t=prepared??await adapter.prepare();
    const captured=await repository.captureNarrative(t,readView);
    if(disposed||ticket!==serial||readTicket!==readSerial||!current(t))throw new Error('聊天已变化，请重新读取本末');
    unconfirmed=false;
    if(!sequencePromise){const pending=captured.narrative.pendingRun;sequenceRun=pending?{...clone(pending),target:clone(t),stage:pending.status,error:pending.status==='failed'?'上次叙事批次未完成，请重试或跳过':'已保留完成的批次，请继续',pauseRequested:false,skipped:0}:null;}
    const result=adopt(t,captured);publishRun();return snapshot();
  }
  function clearSlots(){
    injectionSerial++;let cleared=true;
    for(const key of Object.values(NARRATIVE_PROMPT_KEYS))try{getContext().setExtensionPrompt(key,'',1,0,false,0);}catch{cleared=false;}
    return cleared;
  }
  function cancel(kind){
    if(kind!==undefined)assertKind(kind);
    const affected=kind?[kind]:kinds;
    for(const key of affected){epochs[key]++;runners.delete(key);}
    for(const job of jobs)if((job.kinds??[job.kind]).some(key=>affected.includes(key)))job.controller.abort();
    for(const key of affected)if(state[key].status==='running')state[key]={...state[key],status:'idle',error:''};
    if(!kind){serial++;receipt=null;foregroundEnded=false;}
    notify();return true;
  }
  function clear({invalidate=true}={}){if(invalidate)cancel();return clearSlots();}
  function blockWrites(error){
    unconfirmed=true;cancel();clearSlots();
    for(const kind of kinds)automaticPaused.add(kind);
    state={...state,preferencesWriteBlocked:unconfirmed||!target||!current(target),writeBlocked:true,error:error.message};notify();
  }
  function proof(kind,t=repository.captureTarget()){
    return {kind,target:clone(t),serial,epoch:epochs[kind],master:controls()?.capture('enabled'),category:controls()?.capture(kind)};
  }
  function matches(received){
    try{return !!received&&current(received.target)&&received.serial===serial&&received.epoch===epochs[received.kind]&&allowed(received.kind)&&controls()?.matches(received.master)===true&&controls()?.matches(received.category)===true;}catch{return false;}
  }
  function queue(work){const next=tail.catch(()=>{}).then(work);tail=next;return next;}
  function mutate(kind,change,{original,preferences=false}={}){
    assertKind(kind);
    if(unconfirmed)throw new Error('保存结果尚未确认，请重新读取后再操作');
    const requestedTarget=clone(target),requested=selection,ticket=serial;
    const expected=clone(original??(requested?preferences?requested.narrative.preferences[kind]:content(requested.narrative,kind):null));
    const guard=preferences?null:proof(kind,requestedTarget);
    // Any setting/content mutation invalidates a previously dispatched response,
    // including a value changed away and then restored before the response lands.
    epochs[kind]++;if(guard)guard.epoch=epochs[kind];
    for(const job of jobs)if((job.kinds??[job.kind]).includes(kind))job.controller.abort();
    runners.delete(kind);clearSlots();
    const valid=()=>!unconfirmed&&current(requestedTarget)&&ticket===serial&&(preferences||matches(guard));
    const work=mutationTail.catch(()=>{}).then(async()=>{
      if(!requested||!valid())throw new Error('聊天或功能开关已变化，请重新读取本末');
      const latest=await repository.captureNarrative(requestedTarget);
      const present=preferences?latest.narrative.preferences[kind]:content(latest.narrative,kind);
      if(!valid()||!equal(present,expected))throw new Error('本末内容或设置已变化，请重新读取后修改');
      const next=assertNarrative(change(clone(latest.narrative)));
      const saved=await repository.updateNarrative(requestedTarget,latest,next,{isCurrent:valid,requireConfirmation:!preferences});
      if(!valid())throw new Error('聊天或功能开关已变化，请重新读取本末');
      state[kind]={...state[kind],status:'ready',error:''};return adopt(requestedTarget,saved.selection);
    });
    const guarded=work.catch(error=>{if(error.code==='COMMIT_UNCONFIRMED'&&current(requestedTarget))blockWrites(error);throw error;});
    mutationTail=guarded;return guarded;
  }
  function savePreferences(kind,patch,options={}){
    const value=clone(patch);
    return mutate(kind,domain=>({...domain,preferences:{...domain.preferences,[kind]:{...domain.preferences[kind],...value}}}),{...options,preferences:true});
  }
  function saveEntries(kind,entries,options={}){
    const value=clone(entries);
    return mutate(kind,domain=>{
      const previous=new Map((kind==='self'?domain.self.flatMap(row=>row.entries):domain.outline).map(row=>[row.id,row]));
      const update=rows=>rows.map(row=>({...row,updatedAt:previous.get(row.id)?.text===row.text?row.updatedAt:new Date().toISOString()}));
      return {...domain,[kind]:kind==='self'?value.map(row=>({...row,entries:update(row.entries)})):update(value)};
    },options);
  }
  function cardSnapshot(){
    const context=getContext();
    if(context.groupId!==null&&context.groupId!==undefined&&context.groupId!=='')return null;
    const character=context.characters?.[context.characterId];if(!character)return null;
    return Object.fromEntries(['name','description','personality','scenario'].map(key=>[key,String(character.data?.[key]??character[key]??'')]));
  }
  function completeFloor(row){
    const message=getContext().chat?.[row.floor];
    return row.role==='assistant'&&!row.system&&row.text.trim()&&!(message?.gen_started&&!message?.gen_finished)&&completedStream(row.floor);
  }
  function safePlan(domain,summary,raw,kind,options){
    let startFloor=options.startFloor??Math.max(summary.preferences.auto.startFloor,(domain.progress[kind]?.lastProcessedFloor??(summary.preferences.auto.startFloor-1))+1);
    const requestedEnd=options.endFloor??raw.messages.at(-1)?.floor;
    if(!Number.isSafeInteger(requestedEnd)||requestedEnd<0)throw new Error('所选结束楼层无效');
    let endFloor=raw.messages.filter(row=>row.floor>=startFloor&&row.floor<=requestedEnd&&completeFloor(row)).at(-1)?.floor;
    if(!Number.isSafeInteger(endFloor)||endFloor<startFloor)throw new Error('尚无新的完整 AI 回复可生成，请选择有效楼层范围');
    return {startFloor,endFloor};
  }
  async function run(received,options={}){
    const {kind,target:t}=received;
    if(unconfirmed)throw new Error('保存结果尚未确认，请重新读取后再生成');
    if(!matches(received))throw new Error('聊天或功能开关已变化，生成已停止');
    const controller=new AbortController(),job={kind,controller,received};jobs.add(job);
    let task,config,card,original,usesCard=false;
    const valid=()=>{
      try{
        if(unconfirmed||!matches(received)||controller.signal.aborted||config&&!equal(generation(),config))return false;
        if(task&&!matchesNarrativeSource(task.source,source(t)))return false;
        if(usesCard&&!equal(cardSnapshot(),card))return false;
        if(task&&typeof adapter.peekConfirmed==='function'&&!matchesNarrativeMemory(task,projectNarrativeMemory(adapter.peekConfirmed(t),source(t))))return false;
        return true;
      }catch{return false;}
    };
    // Preparation checks cancellation frequently while scanning materials.
    // Keep that guard constant-sized; the full settings/source/card/memory
    // proof is checked once preparation has produced its frozen ticket.
    const prepareCurrent=()=>!unconfirmed&&matches(received)&&!controller.signal.aborted;
    categoryStatus(kind,{status:'running',error:'',addedCount:null,changedCount:null});
    try{
      original=await repository.captureNarrative(t);
      const root=await repository.read(t),raw=source(t),projected=reconcileNarrativeSource(original.narrative,raw).domain;
      config=clone(generation());
      if(!valid())throw new Error('聊天或功能开关已变化，生成已停止');
      const summary=summaryOf(root),plan=safePlan(projected,summary,raw,kind,options);
      if(plan.status==='waiting'){categoryStatus(kind,{status:'waiting',error:''});return {waiting:true};}
      const events=projectNarrativeMemory(root,raw),context=getContext();
      usesCard=kind==='self'&&projected.preferences.self.readCard;card=usesCard?cardSnapshot():null;
      task=await abortable(()=>prepareNarrativeUpdate(projected,raw,{kind,startFloor:plan.startFloor,endFloor:plan.endFloor,events,card,originalOnly:projected.preferences[kind].autoSource==='cumulative',rules:config.summaryCleaning?.rules??[],countTokens:typeof context.getTokenCountAsync==='function'?text=>context.getTokenCountAsync(text):null,isCurrent:prepareCurrent}),controller.signal);
      if(!valid())throw new Error('材料、设置或聊天已变化，生成已停止');
      categoryStatus(kind,{materialReport:clone(task.usage)});
      const request=buildNarrativeRequest({ticket:task});
      const output=await abortable(()=>provider.generateText({...request,maxOutputTokens:task.usage.outputReserve,signal:controller.signal,isCurrent:valid}),controller.signal);
      if(!valid())throw new Error('材料、设置或聊天已变化，生成已停止');
      const response=parseNarrativeResponse(output.text,{kind});
      const latest=await repository.captureNarrative(t),latestRoot=await repository.read(t);
      if(!valid()||!equal(latest.narrative.preferences[kind],original.narrative.preferences[kind])||!equal(latest.narrative[kind],original.narrative[kind])||!equal(latest.narrative.progress[kind],original.narrative.progress[kind]))throw new Error('本末内容已变化，请重试');
      const applied=applyNarrativeResponse(projected,task,response,source(t),{events:projectNarrativeMemory(latestRoot,source(t))});
      // Projection is read-only. Generating one category never deletes the
      // other category's retained data, even when that other source is stale.
      const next={...latest.narrative,[kind]:applied[kind],progress:{...latest.narrative.progress,[kind]:applied.progress[kind]},highWater:{self:narrativeHighWater(latest.narrative,'self')<0?null:narrativeHighWater(latest.narrative,'self'),outline:narrativeHighWater(latest.narrative,'outline')<0?null:narrativeHighWater(latest.narrative,'outline'),[kind]:Math.max(narrativeHighWater(latest.narrative,kind),applied.progress[kind].lastProcessedFloor)}};
      const saved=await repository.updateNarrative(t,latest,next,{isCurrent:valid,requireConfirmation:true});
      if(!valid())throw new Error('聊天或功能开关已变化，生成已停止');
      categoryStatus(kind,{status:'ready',error:'',materialReport:clone(next.progress[kind]?.materialsReport??task.usage)});
      adopt(t,saved.selection);return snapshot();
    }catch(error){
      if(error.code==='COMMIT_UNCONFIRMED'&&current(t)){categoryStatus(kind,{status:'failed',error:error.message});blockWrites(error);}
      if(matches(received)&&!controller.signal.aborted)automaticPaused.add(kind);
      if(current(t)&&received.serial===serial&&received.epoch===epochs[kind])categoryStatus(kind,{status:controller.signal.aborted||!matches(received)?'idle':'failed',error:controller.signal.aborted||!matches(received)?'':error.message});
      throw error;
    }finally{jobs.delete(job);}
  }
  function generate(kind,options={}){
    assertKind(kind);if(sequencePromise) return Promise.reject(new Error('当前叙事批次尚未结束'));automaticPaused.delete(kind);const received=proof(kind);
    const copied=clone(options);return queue(()=>run(received,copied));
  }
  const runPreferences=domain=>domain.preferences.run??{auto:true,batchSize:10};
  let sequenceRun=null,sequencePromise=null;
  const publishRun=()=>{state={...state,run:sequenceRun?{status:sequenceRun.status,stage:sequenceRun.stage,target:clone(sequenceRun.target),summary:sequenceRun.summary===true,summarySource:sequenceRun.summarySource??'event',range:clone(sequenceRun.ranges[sequenceRun.index]??null),index:sequenceRun.index,total:sequenceRun.ranges.length,error:sequenceRun.error,pauseRequested:sequenceRun.pauseRequested,failedKinds:[...sequenceRun.failedKinds],skipped:sequenceRun.skipped,usage:clone(sequenceRun.usage??null)}:null};notify();};
  function pendingCheckpoint(active,completedKind=null){
    let failedKinds=active.failedKinds.filter(kind=>kind!==completedKind),index=active.index;
    if(completedKind&&!failedKinds.length){index++;failedKinds=[];}
    if(index>=active.ranges.length)return null;
    return {ranges:clone(active.ranges),index,kinds:[...active.kinds],failedKinds,restart:active.restart===true,summary:active.summary===true,status:active.status==='failed'?'failed':'paused',...(active.summarySource?{summarySource:active.summarySource}:{}),...(active.sentFloors?{sentFloors:clone(active.sentFloors),summarySnapshot:clone(active.summarySnapshot)}:{})};
  }
  async function persistCheckpoint(active){
    const t=active.target,ticket=serial;
    if(!current(t)||sequenceRun!==active)return;
    const latest=await repository.captureNarrative(t),next={...latest.narrative,pendingRun:pendingCheckpoint(active)};
    const saved=await repository.updateNarrative(t,latest,next,{isCurrent:()=>!unconfirmed&&current(t)&&ticket===serial&&sequenceRun===active,requireConfirmation:true});
    adopt(t,saved.selection);
  }
  async function saveRunPreferences(patch){
    if(unconfirmed)throw new Error('保存结果尚未确认，请重新读取后再操作');
    if(sequencePromise)throw new Error('请先暂停当前生成');
    const t=repository.captureTarget(),ticket=serial,latest=await repository.captureNarrative(t);
    const next=assertNarrative({...latest.narrative,preferences:{...latest.narrative.preferences,run:{...runPreferences(latest.narrative),...clone(patch)}}});
    const saved=await repository.updateNarrative(t,latest,next,{isCurrent:()=>current(t)&&ticket===serial,requireConfirmation:true});
    return adopt(t,saved.selection);
  }
  async function preview(options={}){
    const t=repository.captureTarget(),captured=await repository.captureNarrative(t),domain=captured.narrative,raw=source(t),active=kinds.filter(allowed);
    if(!current(t))throw new Error('聊天已变化，请重新选择范围');
    const latestFloor=raw.messages.filter(completeFloor).at(-1)?.floor??-1;
    const batchSize=options.batchSize??runPreferences(domain).batchSize;
    const processed=active.length?Math.max(...active.map(kind=>narrativeHighWater(domain,kind))):-1;
    const startFloor=options.startFloor??(options.restart?0:processed+1),endFloor=options.endFloor??latestFloor;
    if(!Number.isSafeInteger(startFloor)||startFloor<0||!Number.isSafeInteger(endFloor)||endFloor< -1||!Number.isSafeInteger(batchSize)||batchSize<1)throw new Error('请选择有效的楼层范围与每批楼数');
    if(endFloor>latestFloor)throw new Error('结束楼层尚无完整 AI 回复');
    const restart=options.restart===true||startFloor<=processed;
    const boundaries=restart?[]:active.map(kind=>narrativeHighWater(domain,kind)).filter(floor=>floor>=0);
    const ranges=[];let start=startFloor;
    while(start<=endFloor){
      const nominal=Math.min(start+batchSize-1,endFloor),endpoint=raw.messages.find(row=>row.floor>=nominal&&row.floor<=endFloor&&completeFloor(row))??raw.messages.filter(row=>row.floor>=start&&row.floor<=endFloor&&completeFloor(row)).at(-1);
      if(!endpoint)break;
      const boundary=boundaries.filter(floor=>floor>=start&&floor<endpoint.floor).sort((a,b)=>a-b)[0],end=boundary??endpoint.floor;
      ranges.push({startFloor:start,endFloor:end});start=end+1;
    }
    return {status:active.length&&ranges.length?'ready':'waiting',kinds:active,startFloor,endFloor,latestFloor,batchSize,ranges,restart};
  }
  async function runBatch(active,range,options={}){
    const t=active.target,captured=await repository.captureNarrative(t),rawAtStart=source(t),projectedAtStart=reconcileNarrativeSource(captured.narrative,rawAtStart).domain;
    const proofs=active.kinds.filter(kind=>allowed(kind)&&(!active.summary||(captured.narrative.preferences[kind].autoSource??'event')===(active.summarySource??'event'))&&(!options.only||options.only.includes(kind))&&(active.restart||(active.summary?narrativeHighWater(captured.narrative,kind):(projectedAtStart.progress[kind]?.lastProcessedFloor??-1))<range.endFloor)).map(kind=>proof(kind,t));
    if(!proofs.length)return;
    if(active.summarySnapshot&&!matchesStoredNarrativeSource(active.summarySnapshot,rawAtStart))throw new Error('已保存总结的原文来源已变化，请跳过本批');
    const controller=new AbortController(),job={kind:proofs[0].kind,kinds:proofs.map(row=>row.kind),controller,received:proofs[0],proofs};jobs.add(job);
    let config,card,original,projected;const tasks=[];
    const valid=()=>{
      try{return !unconfirmed&&!controller.signal.aborted&&proofs.every(matches)&&(!config||equal(generation(),config))&&(!card||equal(cardSnapshot(),card))&&tasks.every(task=>matchesNarrativeSource(task.source,source(t))&&(typeof adapter.peekConfirmed!=='function'||matchesNarrativeMemory(task,projectNarrativeMemory(adapter.peekConfirmed(t),source(t)))));}catch{return false;}
    };
    active.failedKinds=proofs.map(row=>row.kind);active.stage='preparing';publishRun();
    for(const {kind} of proofs)categoryStatus(kind,{status:'running',error:'',addedCount:null,changedCount:null});
    try{
      original=captured;const root=await repository.read(t),raw=source(t);
      projected=reconcileNarrativeSource(original.narrative,raw).domain;config=clone(generation());
      if(active.restart&&active.index===0){projected=clone(projected);for(const kind of active.kinds){projected[kind]=[];projected.progress[kind]=null;}}
      const events=projectNarrativeMemory(root,raw),context=getContext();
      if(proofs.some(row=>row.kind==='self')&&projected.preferences.self.readCard)card=cardSnapshot();
      for(const {kind} of proofs){
        const originalOnly=(active.summarySource??projected.preferences[kind].autoSource)==='cumulative';
        const taskRange=active.summary?{...range,startFloor:Math.max(range.startFloor,narrativeHighWater(captured.narrative,kind)+1)}:range;
        const task=await abortable(()=>prepareNarrativeUpdate(projected,raw,{kind,...taskRange,events,card,originalOnly,...(originalOnly&&active.sentFloors?{sentFloors:active.sentFloors}:{}),rules:config.summaryCleaning?.rules??[],countTokens:typeof context.getTokenCountAsync==='function'?text=>context.getTokenCountAsync(text):null,isCurrent:()=>!unconfirmed&&!controller.signal.aborted&&proofs.every(matches)}),controller.signal);
        tasks.push(task);categoryStatus(kind,{materialReport:clone(task.usage)});
      }
      if(!valid())throw new Error('材料、设置或聊天已变化，生成已停止');
      active.stage='generating';publishRun();
      let request=buildCombinedNarrativeRequest(tasks);
      if(tasks.length>1){
        const combined=await abortable(()=>prepareCombinedNarrativeRequest(tasks,{countTokens:typeof context.getTokenCountAsync==='function'?text=>context.getTokenCountAsync(text):null,isCurrent:valid}),controller.signal);
        tasks.splice(0,tasks.length,...combined.tickets);request=combined.request;active.usage=combined.usage;
        for(const task of tasks)categoryStatus(task.kind,{materialReport:clone(task.usage)});publishRun();
      }
      const output=await abortable(()=>provider.generateText({...request,maxOutputTokens:tasks.reduce((sum,task)=>sum+task.usage.outputReserve,0),signal:controller.signal,isCurrent:valid}),controller.signal);
      if(!valid())throw new Error('材料、设置或聊天已变化，生成已停止');
      const responses=parseCombinedNarrativeResponse(output.text,proofs.map(row=>row.kind)),errors=[];
      active.stage='saving';publishRun();
      for(const task of tasks){
        const kind=task.kind;
        try{
          const latest=await repository.captureNarrative(t),latestRoot=await repository.read(t);
          if(!valid()||!equal(latest.narrative.preferences[kind],original.narrative.preferences[kind])||!equal(latest.narrative[kind],original.narrative[kind])||!equal(latest.narrative.progress[kind],original.narrative.progress[kind]))throw new Error('本末内容已变化，请重试');
          const applied=applyNarrativeResponse(projected,task,responses[kind],source(t),{events:projectNarrativeMemory(latestRoot,source(t))});
          const next={...latest.narrative,[kind]:applied[kind],progress:{...latest.narrative.progress,[kind]:applied.progress[kind]},highWater:{self:narrativeHighWater(latest.narrative,'self')<0?null:narrativeHighWater(latest.narrative,'self'),outline:narrativeHighWater(latest.narrative,'outline')<0?null:narrativeHighWater(latest.narrative,'outline'),[kind]:Math.max(narrativeHighWater(latest.narrative,kind),applied.progress[kind].lastProcessedFloor)},pendingRun:pendingCheckpoint(active,kind)};
          const saved=await repository.updateNarrative(t,latest,next,{isCurrent:valid,requireConfirmation:true});
          if(!valid())throw new Error('聊天或功能开关已变化，生成已停止');
          active.failedKinds=active.failedKinds.filter(item=>item!==kind);
          const beforeEntries=kind==='self'?projected.self.flatMap(row=>row.entries):projected.outline,afterEntries=kind==='self'?applied.self.flatMap(row=>row.entries):applied.outline,beforeById=new Map(beforeEntries.map(row=>[row.id,row.text]));
          categoryStatus(kind,{status:'ready',error:'',addedCount:afterEntries.filter(row=>!beforeById.has(row.id)).length,changedCount:afterEntries.filter(row=>beforeById.has(row.id)&&beforeById.get(row.id)!==row.text).length});adopt(t,saved.selection);
        }catch(error){
          categoryStatus(kind,{status:'failed',error:error.message});errors.push(error);
          if(error.code==='COMMIT_UNCONFIRMED'){blockWrites(error);throw error;}
          if(!valid())throw error;
        }
      }
      if(errors.length)throw errors[0];
    }catch(error){
      if(current(t)&&sequenceRun===active)for(const kind of active.failedKinds)categoryStatus(kind,{status:'failed',error:error.message});throw error;
    }finally{jobs.delete(job);}
  }
  async function drive(active){
    if(sequencePromise)throw new Error('当前叙事批次尚未结束');
    const work=(async()=>{
      active.status='running';active.error='';publishRun();
      try{await persistCheckpoint(active);}catch(error){active.status='failed';active.error=error.message;publishRun();throw error;}
      while(sequenceRun===active&&active.index<active.ranges.length){
        if(active.pauseRequested){active.status='paused';await persistCheckpoint(active);break;}
        const only=active.failedKinds.length?[...active.failedKinds]:null;
        try{await runBatch(active,active.ranges[active.index],{only});}
        catch(error){active.status='failed';active.error=error.message;active.stage='failed';if(current(active.target)&&sequenceRun===active&&!unconfirmed)try{await persistCheckpoint(active);}catch(saveError){if(saveError.code==='COMMIT_UNCONFIRMED')blockWrites(saveError);}publishRun();throw error;}
        active.index++;active.failedKinds=[];publishRun();
      }
      if(active.index>=active.ranges.length){active.status='complete';active.stage='complete';await persistCheckpoint(active);}
      publishRun();return snapshot();
    })();
    sequencePromise=work;try{return await work;}finally{if(sequencePromise===work)sequencePromise=null;}
  }
  async function start(options={}){
    if(sequencePromise||sequenceRun&&['paused','failed'].includes(sequenceRun.status))throw new Error('请先继续、重试或跳过当前批次');
    if(getSummaryActive?.())throw new Error('请先完成当前记忆总结');
    // Reserve synchronously before the first read, so repeated clicks cannot overlap.
    const reservation={},requestedTarget=repository.captureTarget(),requestedSerial=serial;sequencePromise=reservation;
    let plan;
    try{plan=await preview(options);
    if(!current(requestedTarget)||serial!==requestedSerial)throw new Error('聊天已变化，请重新选择范围');
    const latest=await repository.captureNarrative(requestedTarget);
    if(!current(requestedTarget)||serial!==requestedSerial)throw new Error('聊天已变化，请重新选择范围');
    if(latest.narrative.pendingRun)throw new Error('有未完成的叙事批次，请重新读取后继续');
    }finally{if(sequencePromise===reservation)sequencePromise=null;}
    if(plan.restart&&options.restart!==true){const error=new Error('所选范围已有处理结果，请确认替换当前启用的自述与大纲');error.code='NARRATIVE_REPLACE_CONFIRMATION';throw error;}
    if(!plan.kinds.length)return snapshot();
    if(!plan.ranges.length)throw new Error('尚无新的完整 AI 回复可生成');
    sequenceRun={...plan,target:clone(requestedTarget),index:0,status:'running',stage:'preparing',error:'',failedKinds:[],pauseRequested:false,skipped:0};
    return drive(sequenceRun);
  }
  async function afterSummaryCommit({target:t,startFloor,endFloor,summarySource='event',sentFloors}){
    if(!kinds.some(allowed))return {skipped:true};
    const captured=await repository.captureNarrative(t);
    const active=kinds.filter(kind=>allowed(kind)&&(captured.narrative.preferences[kind].autoSource??'event')===summarySource);
    if(!active.length)return {skipped:true};
    if(!current(t))throw new Error('聊天已变化，生成已停止');
    if(sequencePromise||sequenceRun&&['failed','paused'].includes(sequenceRun.status))throw new Error('请先处理当前叙事批次');
    // Freeze the shared continuation start once. A newly enabled category
    // does not trigger historical catch-up, and partial retries retain this
    // exact range instead of advancing past an unsaved category.
    const sharedStart=Math.max(startFloor,...active.map(kind=>narrativeHighWater(captured.narrative,kind)+1));
    if(sharedStart>endFloor)return {skipped:true};
    const ranges=[{startFloor:sharedStart,endFloor}];
    sequenceRun={target:clone(t),kinds:active,summarySource,...(sentFloors?{sentFloors:durableSourceMessages(sentFloors),summarySnapshot:(()=>{const rawMessages=durableSourceMessages(source(t).messages.filter(row=>row.floor<=endFloor));return {requestedRange:{start:0,end:endFloor},rawMessages,fingerprint:sourceFingerprint(rawMessages)};})()}:{}),ranges,index:0,restart:false,status:'running',stage:'preparing',error:'',failedKinds:[],pauseRequested:false,skipped:0,summary:true};
    return drive(sequenceRun);
  }
  function pause(){if(sequenceRun){sequenceRun.pauseRequested=true;if(!sequencePromise&&sequenceRun.status!=='failed')sequenceRun.status='paused';publishRun();}return snapshot();}
  function resume(){if(!sequenceRun||!['paused','failed'].includes(sequenceRun.status))return Promise.resolve(snapshot());sequenceRun.pauseRequested=false;return drive(sequenceRun);}
  function skip(){
    if(sequencePromise)throw new Error('请等待当前批次结束');
    if(!sequenceRun||!['failed','paused'].includes(sequenceRun.status))return Promise.resolve(snapshot());
    sequenceRun.index++;sequenceRun.skipped++;sequenceRun.failedKinds=[];sequenceRun.pauseRequested=false;return drive(sequenceRun);
  }
  async function intercept(messages,_size,_abort,type='normal'){
    if(disposed)return;
    if(!clearSlots()||!supported.has(type)||messages?.some(row=>String(row?.mes??row?.content??'').includes('[LANTAI_BACKGROUND_TASK:')))return;
    const ticket=injectionSerial,t=repository.captureTarget(),active=kinds.filter(allowed),proofs=active.map(kind=>proof(kind,t));
    if(!active.length)return;
    try{
      const captured=await repository.captureNarrative(t),raw=source(t),projection=reconcileNarrativeSource(captured.narrative,raw);
      const valid=()=>!disposed&&ticket===injectionSerial&&current(t)&&proofs.every(matches)&&equal(source(t),raw)&&(!repository.matchesNarrative||repository.matchesNarrative(t,captured));
      if(!valid())return;
      const domain=projection.domain,parts=[];
      if(active.includes('outline')&&!projection.staleKinds.includes('outline')&&domain.outline.length)parts.push({kind:'outline',depth:domain.preferences.outline.depth,text:`${NARRATIVE_OUTLINE_INJECTION}\n\n【已发生的故事大纲】\n${domain.outline.map(row=>row.text).join('\n')}`});
      if(active.includes('self')&&!projection.staleKinds.includes('self')){
        const chosen=domain.preferences.self.characters.filter(row=>row.inject!==false),records=chosen.flatMap(character=>{const record=domain.self.find(row=>row.id===character.id);return record?.entries.length?[`${narrativeSelfInjection(character.name)}\n\n【${character.name}的阶段自述】\n${record.entries.map(row=>row.text).join('\n')}`]:[];});
        if(records.length)parts.push({kind:'self',depth:domain.preferences.self.depth,text:records.join('\n\n')});
      }
      // Equal-depth content is one payload, making outline-before-self order
      // independent of SillyTavern extension-key sorting implementation.
      if(parts.length===2&&parts[0].depth===parts[1].depth){parts[0].text+=`\n\n${parts[1].text}`;parts.pop();}
      for(const part of parts){if(!valid())return;getContext().setExtensionPrompt(NARRATIVE_PROMPT_KEYS[part.kind],part.text,1,part.depth,false,0);if(!valid()){if(ticket===injectionSerial)clearSlots();return;}}
    }catch{if(!disposed&&ticket===injectionSerial)clearSlots();}
  }
  function completedStream(floor){
    const processor=getContext()?.streamingProcessor;
    if(!processor||Number.isSafeInteger(processor.messageId)&&processor.messageId!==floor)return true;
    return processor.isFinished===true&&processor.isStopped!==true&&!processor.abortController?.signal?.aborted&&!processor.toolCalls?.length;
  }
  function flushReceipt(){receipt=null;}
  const context=getContext(),events=context?.eventSource;
  function on(name,listener){const type=context?.eventTypes?.[name];if(!type||!events?.on)return;events.on(type,listener);releases.push(()=>(events.off??events.removeListener)?.call(events,type,listener));}
  on('GENERATION_STARTED',(type,_options,dryRun)=>{if(dryRun)return;if(type==='quiet'){quietDepth++;return;}if(supported.has(type)){cancel();clearSlots();quietDepth=0;foregroundActive=true;foregroundStopped=false;foregroundType=type;}});
  // ST STOPPED has no operation identity. A nested quiet task cannot revoke
  // a complete foreground receipt or an already dispatched background task.
  on('GENERATION_STOPPED',()=>{clearSlots();if(quietDepth||!foregroundActive||receipt&&completedStream(receipt.floor))return;foregroundStopped=true;foregroundActive=false;clear();});
  on('GENERATION_ENDED',()=>{
    // A completed foreground receipt is stronger evidence than unlabelled
    // ENDED ordering. Another extension's slow quiet call must not delay it.
    if(receipt&&completedStream(receipt.floor)){foregroundEnded=true;foregroundActive=false;clearSlots();flushReceipt();return;}
    if(quietDepth){quietDepth--;return;}foregroundEnded=true;foregroundActive=false;clearSlots();flushReceipt();
  });
  on('MESSAGE_RECEIVED',(floor,type)=>{
    const normalized=type==='appendFinal'&&foregroundType==='continue'?'continue':type;
    if(foregroundStopped||!supported.has(normalized)||!Number.isSafeInteger(floor)||!completedStream(floor))return;
    try{const message=getContext().chat?.[floor],t=repository.captureTarget();if(message?.is_user===false&&!message.is_system){receipt={floor,message,target:clone(t),proofs:kinds.filter(allowed).map(kind=>proof(kind,t))};flushReceipt();}}catch{/* An unsettled chat cannot authorize automatic work. */}
  });
  for(const name of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED'])on(name,()=>{clear();markSources();});
  for(const name of ['CHAT_CHANGED','CHAT_CREATED'])on(name,()=>{clear();sequenceRun=null;readSerial++;target=null;selection=null;seenReceipts.clear();automaticPaused.clear();unconfirmed=false;foregroundActive=false;quietDepth=0;state={target:null,narrative:emptyNarrative(),self:emptyStatus(),outline:emptyStatus(),writeBlocked:false,error:''};notify();});
  return {load,snapshot,savePreferences,saveRunPreferences,saveEntries,generate,preview,start,pause,resume,retry:resume,skip,afterSummaryCommit,hasPending:()=>!!sequenceRun&&['running','paused','failed'].includes(sequenceRun.status),intercept,clear,cancel(kind){for(const key of kind?[assertKind(kind)]:kinds)automaticPaused.add(key);return cancel(kind);},defaultPrompts:DEFAULT_NARRATIVE_PROMPTS,
    controlsChanged(){clearSlots();for(const job of jobs)if(!(job.proofs??[job.received]).every(matches)){job.controller.abort();runners.delete(job.kind);if(state[job.kind].status==='running')state[job.kind]={...state[job.kind],status:'idle',error:''};}notify();},
    rebindTarget(next){const previous=target??lastTarget;if(!previous||previous.chatId!==next.chatId||previous.rootId!==next.rootId)throw new Error('聊天已变化');if(!sameTarget(target,next)){clear();target=clone(next);selection=null;state={...state,target:clone(next),writeBlocked:true,error:'聊天已重新读取，请重新打开本末'};notify();}},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){if(disposed)return;clear();disposed=true;readSerial++;for(const release of releases)release();listeners.clear();},
  };
}
