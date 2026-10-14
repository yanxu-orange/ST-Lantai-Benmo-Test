import {changeGenerationDraft,createGenerationPreview,sameGenerationParams as sameParams} from './generation-preview.js';
import { sameTarget } from '../domain/memory/repository.js';
import { createAutomaticSummaryRunner } from '../domain/summary/auto-runner.js';

const PARAMETER_SAVE_DELAY=250;
export function createSummaryController({repository,service,captureSource,control=null,onCommitted=()=>{}}={}) {
  const runner=createAutomaticSummaryRunner({service,repository,captureSource}),listeners=new Set();
  let disposed=false,ticket=0,openRequest=0,visible=false,parameterQueue=Promise.resolve(),parameterFailure=null,parameterTimer=null,parameterDrafts={};
  const state={route:'manual',origin:'manual',target:null,summary:null,formalIds:[],params:null,parametersUnconfirmed:false,taskId:null,task:null,drafts:null,entries:{},openTerms:{},preview:null,previewOpen:false,previewView:'source',error:'',message:'',busy:false,scroll:0};
  const generationPreview=createGenerationPreview(state);
  const notify=()=>{if(!disposed)for(const listener of [...listeners])try{listener(inspect());}catch{/* display only */}};
  const inspect=()=>({...state,drafts:state.drafts,parameterReadRequired:parameterDrafts[state.origin]?.readRequired===true,automatic:runner.inspect()});
  const viewCurrent=(serial,target)=>{try{return !disposed&&serial===ticket&&sameTarget(target,state.target)&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  const cancelParameterTimer=()=>{clearTimeout(parameterTimer);parameterTimer=null;};
  function selectParameters(summary,origin,preserve){
    for(const mode of ['manual','auto']){
      let draft=preserve?parameterDrafts[mode]:null;
      const dirty=draft&&(draft.queued||draft.error||draft.revision>draft.attempted||draft.revision>0&&!sameParams(draft.params,draft.baseline));
      if(!dirty)draft={params:structuredClone(summary.preferences[mode]),baseline:structuredClone(summary.preferences[mode]),revision:0,attempted:0,requested:0,queued:false,error:null,readRequired:false};
      parameterDrafts[mode]=draft;
    }
    state.params=parameterDrafts[origin].params;
    if(origin==='manual'&&state.params.endFloor===null)state.params.endFloor=captureSource(state.target).messages.at(-1)?.floor??0;
    const error=parameterDrafts[origin].error;
    parameterFailure=error?{serial:ticket,error}:null;
    if(error)state.error=state.parametersUnconfirmed?'保存结果尚未确认，请重新读取':error.message;
  }
  function queueParameters(){
    cancelParameterTimer();
    const target=state.target,serial=ticket,origin=state.origin,draft=parameterDrafts[origin],current=()=>viewCurrent(serial,target);
    if(!draft||!current()||state.parametersUnconfirmed||draft.readRequired)return parameterQueue;
    draft.requested=draft.revision;
    if(draft.queued||draft.requested<=draft.attempted)return parameterQueue;
    draft.queued=true;
    parameterQueue=parameterQueue.then(async()=>{
      let validated=false;
      try{
        while(current()&&!state.parametersUnconfirmed&&draft.requested>draft.attempted){
          const params=structuredClone(draft.params);draft.attempted=draft.revision;validated=false;
          if(!Number.isSafeInteger(params.startFloor)||params.startFloor<0||origin==='manual'&&!(params.endFloor===null||Number.isSafeInteger(params.endFloor)&&params.endFloor>=params.startFloor)||origin==='auto'&&(!Number.isSafeInteger(params.batchSize)||params.batchSize<1||!Number.isSafeInteger(params.recentFloors)||params.recentFloors<0))throw new Error('总结范围参数无效');
          validated=true;
          if(!sameParams(state.summary.preferences[origin],params)){
            if(!sameParams(draft.baseline,state.summary.preferences[origin]))throw new Error('总结参数已变化，请重新读取');
            await repository.updateSummaryPreferences(target,{[origin]:params},{expectedSummaryRevision:state.summary.revision,isCurrent:current});
            const selected=await repository.captureSummary(target);if(!current())return;state.summary=selected.summary;
          }
          draft.baseline=structuredClone(state.summary.preferences[origin]);draft.error=null;draft.readRequired=false;
          if(state.origin===origin){parameterFailure=null;if(sameParams(state.params,params))state.error='';}
        }
      }catch(error){if(current()){
        cancelParameterTimer();draft.attempted=draft.revision;draft.requested=draft.attempted;draft.error=error;draft.readRequired=validated;
        parameterFailure={serial,error};state.parametersUnconfirmed=error.code==='COMMIT_UNCONFIRMED';state.error=state.parametersUnconfirmed?'保存结果尚未确认，请重新读取':error.message;notify();
      }}finally{draft.queued=false;}
    });
    return parameterQueue;
  }
  async function action(work){const controlProof=control?.capture(),serial=ticket,target=state.target;state.busy=true;state.error='';notify();const current=()=>viewCurrent(serial,target)&&(!control||control.matches(controlProof));try{await work(current);}catch(error){if(current())state.error=error.message;}finally{if(viewCurrent(serial,target)){state.busy=false;notify();}}}
  async function captureView(target){
    if(repository.captureSummaryView)return repository.captureSummaryView(target);
    const selected=await repository.captureSummary(target),root=await repository.read(target);
    return {...selected,formalIds:root.events.map(event=>event.id)};
  }
  async function refresh(){if(!state.target)return false;const target=state.target,serial=ticket;try{const captured=await captureView(target);if(disposed||serial!==ticket||!sameTarget(target,state.target)||!sameTarget(target,repository.captureTarget()))return false;state.summary=captured.summary;state.formalIds=captured.formalIds;notify();return true;}catch(error){if(!disposed&&serial===ticket&&sameTarget(target,state.target)){state.error=error.message;notify();}return false;}}
  function taskChanged(task) {
    if(disposed||!sameTarget(task.target,state.target))return;
    if(task.origin==='auto'&&runner.inspect().taskId===task.taskId&&!state.busy){state.taskId=task.taskId;}
    if(task.taskId!==state.taskId)return;
    state.task=task;
    if(task.status==='awaiting-user'&&task.candidate&&!state.drafts){state.drafts=structuredClone(task.candidate.events);state.entries={};if(task.snapshot.params.reviewBeforeCommit||task.candidate.incomplete||task.snapshot.selection.summary.pending)state.route='review';}
    if(task.status==='awaiting-user'&&task.candidate?.incomplete)state.error=task.errorMessage||'后续阶段尚未完成，正文草稿已保留。';
    const trackingWarnings=(task.diagnostics??[]).filter(row=>row.kind==='tracking').map(row=>`${row.category==='items'?'物品':'角色'}追踪有未采用项：${row.message}`);
    if(task.status==='awaiting-user'&&task.snapshot.tracking){const enabled=task.snapshot.tracking.ticket.preferences;state.message=`${enabled.itemsEnabled?'物品':''}${enabled.itemsEnabled&&enabled.npcsEnabled?'与':''}${enabled.npcsEnabled?'角色':''}追踪结果将在采用本批时一起保存。`;if(trackingWarnings.length)state.error=[task.candidate?.incomplete?(task.errorMessage||'后续阶段尚未完成，正文草稿已保留。'):'',...new Set(trackingWarnings)].filter(Boolean).join('；');}
    if(['narrative-running','narrative-failed'].includes(task.status)){state.busy=false;state.route=state.origin;state.drafts=null;state.message='本批记忆已保存，正在生成自述与大纲';if(task.status==='narrative-failed'){state.message='本批记忆已保存';state.error=task.errorMessage||'自述与大纲未完成，请重试或跳过';}void refresh();}
    if(task.status==='succeeded'){state.error='';state.message=task.narrative?.status==='skipped'?'本批记忆已保存，已跳过本批自述与大纲':trackingWarnings.length?'已保存本批记忆；'+[...new Set(trackingWarnings)].join('；'):'已保存本批记忆';state.route=state.origin;state.drafts=null;const serial=ticket;void refresh().then(current=>{if(current&&visible&&serial===ticket)onCommitted();});}
    if(['failed','stale','cancelled'].includes(task.status)){state.error=task.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':task.errorMessage||'本批未完成，请重新发起';}
    notify();
  }
  const releaseService=service.subscribe(taskChanged),releaseRunner=runner.subscribe(value=>{
    if(value.taskId&&sameTarget(value.target,state.target)){state.taskId=value.taskId;const task=service.inspect(value.taskId);if(task)taskChanged(task);}
    notify();
  });
  return Object.freeze({
    inspect,runner,flushParams:queueParameters,setVisible(value){visible=value===true;if(!visible)void queueParameters();},setScroll(value){state.scroll=value;},
    async open(origin='manual') {
      if(disposed||!['manual','auto'].includes(origin))return false;
      const request=++openRequest,next=repository.captureTarget();
      const preserve=!!state.target&&sameTarget(state.target,next);if(preserve)await queueParameters();else cancelParameterTimer();if(disposed||request!==openRequest||!sameTarget(next,repository.captureTarget()))return false;
      if(state.target&&sameTarget(state.target,next)&&state.taskId&&['starting','running','awaiting-user','committing','narrative-running','narrative-failed'].includes(service.inspect(state.taskId)?.status)){notify();return true;}
      const serial=++ticket;state.busy=true;state.error='';notify();
      try{const selected=await captureView(next);if(disposed||serial!==ticket||!sameTarget(next,repository.captureTarget()))return false;state.target=next;state.summary=selected.summary;if(!preserve)state.parametersUnconfirmed=false;parameterFailure=null;state.formalIds=selected.formalIds;state.origin=origin;state.route=origin;selectParameters(selected.summary,origin,preserve);state.taskId=null;state.task=null;state.drafts=null;generationPreview.invalidate({close:true});state.message='';const narrativeId=await service.restorePendingNarrative?.(origin);if(!viewCurrent(serial,next))return false;if(narrativeId){state.taskId=narrativeId;taskChanged(service.inspect(narrativeId));return true;}if(selected.summary.pending){try{const id=await service.restorePending(origin);if(!viewCurrent(serial,next))return false;state.taskId=id;taskChanged(service.inspect(id));}catch(error){if(!viewCurrent(serial,next))return false;state.error=error.message;}}return true;}
      catch(error){if(!disposed&&serial===ticket)state.error=error.message;return false;}finally{if(!disposed&&serial===ticket){state.busy=false;notify();}}
    },
    changeParams(mutator,{defer=false}={}){
      if(state.busy||state.parametersUnconfirmed||!state.params||['starting','running','awaiting-user','committing','narrative-running','narrative-failed'].includes(state.task?.status))return parameterQueue;
      const draft=parameterDrafts[state.origin];
      if(changeGenerationDraft(state.params,mutator,()=>generationPreview.invalidate())){draft.revision++;if(!draft.readRequired){draft.error=null;parameterFailure=null;state.error='';}}
      if(defer){cancelParameterTimer();parameterTimer=setTimeout(()=>{parameterTimer=null;void queueParameters();},PARAMETER_SAVE_DELAY);return parameterQueue;}
      return queueParameters();
    },
    async saveParams(){
      const draft=parameterDrafts[state.origin];
      if(draft&&!draft.readRequired&&!sameParams(draft.params,state.summary.preferences[state.origin])&&draft.revision<=draft.attempted)draft.revision++;
      await queueParameters();if(state.parametersUnconfirmed)throw new Error('保存结果尚未确认，请重新读取');if(parameterFailure?.serial===ticket)throw parameterFailure.error;
    },
    async start() {
      if(state.busy||service.isBusy?.())return;const origin=state.origin,params=structuredClone(state.params);state.message='';state.drafts=null;
      await action(async current=>{await this.saveParams();if(!current())return;if(origin==='auto'){runner.start();}else {const id=await service.start('manual',params);if(current()){state.taskId=id;taskChanged(service.inspect(id));}}});
    },
    async retryNarrative(){if(state.busy||!state.taskId)return;const id=state.taskId;await action(async current=>{const result=await service.retryNarrative(id);if(!current())return;if(!result)throw new Error('当前批次不能重试');taskChanged(service.inspect(id));if(result.status==='succeeded')runner.afterNarrative();});},
    async skipNarrative(){if(state.busy||!state.taskId)return;const id=state.taskId;await action(async current=>{const result=await service.skipNarrative(id);if(!current())return;if(!result)throw new Error('当前批次不能跳过');taskChanged(service.inspect(id));if(result.status==='succeeded')runner.afterNarrative();});},
    async retry(){if(state.busy||!state.taskId)return;const taskId=state.taskId,drafts=structuredClone(state.drafts);await action(async current=>{const id=await service.retry(taskId,drafts);if(!current())return;if(!id)throw new Error('草稿来源或配置已变化，不能重试');state.taskId=id;state.drafts=null;state.error='';if(service.inspect(id)?.origin==='auto')runner.transferTask(id);taskChanged(service.inspect(id));});},
    async regenerate(batchId){if(state.busy||service.isBusy?.())return;state.drafts=null;await action(async current=>{const id=await service.start('regeneration',{batchId});if(current()){state.taskId=id;taskChanged(service.inspect(id));}});},
    async preview(){if(state.busy)return;const origin=state.origin,params=structuredClone(state.params),summary=state.summary,target=state.target;await action(async current=>{await queueParameters();if(!current())return;if(state.parametersUnconfirmed)throw new Error('保存结果尚未确认，请重新读取');if(parameterFailure?.serial===ticket)throw parameterFailure.error;let options=params;if(origin==='auto'){const {automaticSummaryPlan}=await import('../domain/summary/auto-runner.js');if(!current())return;const plan=automaticSummaryPlan({...summary,preferences:{...summary.preferences,auto:params}},captureSource(target));if(plan.status!=='ready')throw new Error('尚无可总结的完整批次');options={...options,...plan};}if(!current())return;await generationPreview.prepare(()=>service.preview(origin,options),current);});},
    togglePreview(){generationPreview.toggle();notify();},
    previewView(view){generationPreview.view(view);notify();},
    changeDrafts(mutator){if(state.busy||!state.drafts)return;mutator(state.drafts);state.error='';},
    removeDraft(index){if(state.busy||!state.drafts?.[index])return false;const [removed]=state.drafts.splice(index,1);state.openTerms=Object.fromEntries(Object.entries(state.openTerms).filter(([key])=>Number(key)!==index).map(([key,value])=>[Number(key)>index?Number(key)-1:Number(key),value]));for(const key of Object.keys(state.entries))if(key.startsWith(`${removed.id}:`))delete state.entries[key];state.error='';return true;},
    setEntry(index,key,value){const id=state.drafts?.[index]?.id;if(id)state.entries[`${id}:${key}`]=value;},
    openTerm(index,id,{notify:shouldNotify=true}={}){state.openTerms[index]=state.openTerms[index]===id?null:id;if(shouldNotify)notify();},
    async confirm(){if(state.busy||!state.taskId)return;const taskId=state.taskId,drafts=structuredClone(state.drafts);await action(async current=>{const result=await service.confirm(taskId,drafts);if(!current())return;if(result.status==='invalid')state.error=result.error;else if(result.status==='succeeded')runner.afterReview();else if(result.status==='narrative-failed')state.error=service.inspect(taskId).errorMessage;else state.error=result.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':'未能采用本批结果';});},
    async read(){if(state.busy)return;cancelParameterTimer();const target=state.target;await action(async current=>{await parameterQueue;await repository.read(target);if(!current())return;await refresh();if(!current())return;if(state.parametersUnconfirmed||parameterDrafts[state.origin]?.readRequired){state.parametersUnconfirmed=false;parameterFailure=null;selectParameters(state.summary,state.origin,false);}if(state.task?.outcome==='unconfirmed'){state.task=null;state.taskId=null;state.drafts=null;state.route=state.origin;runner.discard();if(state.summary.pending){const id=await service.restorePending(state.origin);if(!current())return;state.taskId=id;taskChanged(service.inspect(id));}}state.message='已重新读取';});},
    async discardPending(){if(state.busy)return;await action(async current=>{await service.discardPending();if(current())await refresh();});},
    async back(){if(state.route==='review'){const taskId=state.taskId;await action(async current=>{if(taskId)await service.discard(taskId);if(!current())return;if(state.task?.origin==='auto')runner.discard();state.route=state.origin;state.drafts=null;state.taskId=null;state.task=null;await refresh();});return false;}void queueParameters();return true;},
    stop(){runner.stop();},wake(){runner.wake();},
    showTask(taskId){const task=service.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;cancelParameterTimer();state.target=task.target;state.origin=task.origin==='auto'?'auto':'manual';state.taskId=taskId;state.summary=task.snapshot.selection.summary;selectParameters(state.summary,state.origin,false);taskChanged(task);void refresh();return true;},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){cancelParameterTimer();disposed=true;ticket++;releaseService();releaseRunner();runner.dispose();listeners.clear();}
  });
}

// Both result pages and the summary page resolve a summary-owned narrative
// batch through the same service, including a checkpoint restored after reload.
export function createSummaryNarrativeActions({runtime,service,runner}={}) {
  async function resolve(action){
    if(!runtime.snapshot().run?.summary)return runtime[action]();
    const taskId=await service.restorePendingNarrative();
    if(!taskId)return runtime.snapshot();
    const result=await service[action==='skip'?'skipNarrative':'retryNarrative'](taskId);
    if(!result)throw new Error('当前自述与大纲批次正在处理中');
    if(result.status==='narrative-failed')throw new Error(result.errorMessage);
    runner.afterNarrative();return runtime.snapshot();
  }
  return {retry:()=>resolve('retry'),resume:()=>resolve('resume'),skip:()=>resolve('skip'),pause(){if(runtime.snapshot().run?.summary){runner.stop();return runtime.snapshot();}return runtime.pause();}};
}
