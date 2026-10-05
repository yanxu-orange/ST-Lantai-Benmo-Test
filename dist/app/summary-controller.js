import { sameTarget } from '../domain/memory/repository.js';
import { createAutomaticSummaryRunner } from '../domain/summary/auto-runner.js';

export function createSummaryController({repository,service,captureSource,onCommitted=()=>{}}={}) {
  const runner=createAutomaticSummaryRunner({service,repository,captureSource}),listeners=new Set();
  let disposed=false,ticket=0,openRequest=0,visible=false,parameterQueue=Promise.resolve(),parameterFailure=null;
  const state={route:'manual',origin:'manual',target:null,summary:null,formalIds:[],params:null,parametersUnconfirmed:false,taskId:null,task:null,drafts:null,entries:{},openTerms:{},preview:null,previewOpen:false,previewView:'source',error:'',message:'',busy:false,scroll:0};
  const notify=()=>{if(!disposed)for(const listener of [...listeners])try{listener(inspect());}catch{/* display only */}};
  const inspect=()=>({...state,drafts:state.drafts,automatic:runner.inspect()});
  const viewCurrent=(serial,target)=>{try{return !disposed&&serial===ticket&&sameTarget(target,state.target)&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  function queueParameters(){
    const target=state.target,serial=ticket,origin=state.origin,params=structuredClone(state.params),current=()=>viewCurrent(serial,target);
    parameterQueue=parameterQueue.then(async()=>{
      if(!current()||state.parametersUnconfirmed)return;
      // Invalid intermediate typing remains editable; it is never staged.
      if(!Number.isSafeInteger(params.startFloor)||params.startFloor<0||origin==='manual'&&!(params.endFloor===null||Number.isSafeInteger(params.endFloor)&&params.endFloor>=params.startFloor)||origin==='auto'&&(!Number.isSafeInteger(params.batchSize)||params.batchSize<1||!Number.isSafeInteger(params.recentFloors)||params.recentFloors<0))throw new Error('总结范围参数无效');
      if(JSON.stringify(state.summary.preferences[origin])===JSON.stringify(params)){parameterFailure=null;return;}
      await repository.updateSummaryPreferences(target,{[origin]:params},{expectedSummaryRevision:state.summary.revision,isCurrent:current});
      const selected=await repository.captureSummary(target);if(!current())return;state.summary=selected.summary;parameterFailure=null;if(JSON.stringify(state.params)===JSON.stringify(params))state.error='';
    }).catch(error=>{if(current()){parameterFailure={serial,error};state.parametersUnconfirmed=error.code==='COMMIT_UNCONFIRMED';state.error=state.parametersUnconfirmed?'保存结果尚未确认，请重新读取':error.message;notify();}});
    return parameterQueue;
  }
  async function action(work){const serial=ticket,target=state.target;state.busy=true;state.error='';notify();const current=()=>viewCurrent(serial,target);try{await work(current);}catch(error){if(current())state.error=error.message;}finally{if(current()){state.busy=false;notify();}}}
  async function refresh(){if(!state.target)return false;const target=state.target,serial=ticket;try{const captured=await repository.captureSummary(target),root=await repository.read(target);if(disposed||serial!==ticket||!sameTarget(target,state.target)||!sameTarget(target,repository.captureTarget()))return false;state.summary=captured.summary;state.formalIds=root.events.map(event=>event.id);notify();return true;}catch(error){if(!disposed&&serial===ticket&&sameTarget(target,state.target)){state.error=error.message;notify();}return false;}}
  function taskChanged(task) {
    if(disposed||!sameTarget(task.target,state.target))return;
    if(task.origin==='auto'&&runner.inspect().taskId===task.taskId&&!state.busy){state.taskId=task.taskId;}
    if(task.taskId!==state.taskId)return;
    state.task=task;
    if(task.status==='awaiting-user'&&task.candidate&&!state.drafts){state.drafts=structuredClone(task.candidate.events);state.entries={};if(task.snapshot.params.reviewBeforeCommit||task.candidate.incomplete||task.snapshot.selection.summary.pending)state.route='review';}
    if(task.status==='awaiting-user'&&task.candidate?.incomplete)state.error=task.errorMessage||'后续阶段尚未完成，正文草稿已保留。';
    if(task.status==='succeeded'){state.message='已保存本批记忆';state.route=state.origin;state.drafts=null;const serial=ticket;void refresh().then(current=>{if(current&&visible&&serial===ticket)onCommitted();});}
    if(['failed','stale','cancelled'].includes(task.status)){state.error=task.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':task.errorMessage||'本批未完成，请重新发起';}
    notify();
  }
  const releaseService=service.subscribe(taskChanged),releaseRunner=runner.subscribe(value=>{
    if(value.taskId&&sameTarget(value.target,state.target)){state.taskId=value.taskId;const task=service.inspect(value.taskId);if(task)taskChanged(task);}
    notify();
  });
  return Object.freeze({
    inspect,runner,setVisible(value){visible=value===true;},setScroll(value){state.scroll=value;},
    async open(origin='manual') {
      if(disposed||!['manual','auto'].includes(origin))return false;
      const request=++openRequest,next=repository.captureTarget();
      if(state.target&&sameTarget(state.target,next))await parameterQueue;if(disposed||request!==openRequest||!sameTarget(next,repository.captureTarget()))return false;
      if(state.target&&sameTarget(state.target,next)&&state.taskId&&['starting','running','awaiting-user','committing'].includes(service.inspect(state.taskId)?.status)){notify();return true;}
      const serial=++ticket;state.busy=true;state.error='';notify();
      try{const selected=await repository.captureSummary(next),root=await repository.read(next);if(disposed||serial!==ticket||!sameTarget(next,repository.captureTarget()))return false;state.target=next;state.summary=selected.summary;state.parametersUnconfirmed=false;parameterFailure=null;state.formalIds=root.events.map(event=>event.id);state.origin=origin;state.route=origin;state.params=structuredClone(selected.summary.preferences[origin]);if(origin==='manual')state.params.endFloor??=captureSource(next).messages.at(-1)?.floor??0;state.taskId=null;state.task=null;state.drafts=null;state.preview=null;state.previewOpen=false;state.message='';if(selected.summary.pending){try{const id=await service.restorePending(origin);if(!viewCurrent(serial,next))return false;state.taskId=id;taskChanged(service.inspect(id));}catch(error){if(!viewCurrent(serial,next))return false;state.error=error.message;}}return true;}
      catch(error){if(!disposed&&serial===ticket)state.error=error.message;return false;}finally{if(!disposed&&serial===ticket){state.busy=false;notify();}}
    },
    changeParams(mutator){if(state.busy||state.parametersUnconfirmed||['starting','running','awaiting-user','committing'].includes(state.task?.status))return parameterQueue;mutator(state.params);state.preview=null;state.error='';return queueParameters();},
    async saveParams(){await queueParameters();if(state.parametersUnconfirmed)throw new Error('保存结果尚未确认，请重新读取');if(parameterFailure?.serial===ticket)throw parameterFailure.error;},
    async start() {
      if(state.busy)return;const origin=state.origin,params=structuredClone(state.params);state.message='';state.drafts=null;
      await action(async current=>{await this.saveParams();if(!current())return;if(origin==='auto'){runner.start();}else {const id=await service.start('manual',params);if(current()){state.taskId=id;taskChanged(service.inspect(id));}}});
    },
    async retry(){if(state.busy||!state.taskId)return;const taskId=state.taskId,drafts=structuredClone(state.drafts);await action(async current=>{const id=await service.retry(taskId,drafts);if(!current())return;if(!id)throw new Error('草稿来源或配置已变化，不能重试');state.taskId=id;state.drafts=null;state.error='';if(service.inspect(id)?.origin==='auto')runner.transferTask(id);taskChanged(service.inspect(id));});},
    async regenerate(batchId){if(state.busy)return;state.drafts=null;await action(async current=>{const id=await service.start('regeneration',{batchId});if(current()){state.taskId=id;taskChanged(service.inspect(id));}});},
    async preview(){if(state.busy)return;const origin=state.origin,params=structuredClone(state.params),summary=state.summary,target=state.target;await action(async current=>{let options=params;if(origin==='auto'){const {automaticSummaryPlan}=await import('../domain/summary/auto-runner.js');if(!current())return;const plan=automaticSummaryPlan({...summary,preferences:{...summary.preferences,auto:params}},captureSource(target));if(plan.status!=='ready')throw new Error('尚无可总结的完整批次');options={...options,...plan};}if(!current())return;const preview=await service.preview(origin,options);if(current()){state.preview=preview;state.previewOpen=true;}});},
    togglePreview(){state.previewOpen=!state.previewOpen;notify();},
    previewView(view){state.previewView=view;notify();},
    changeDrafts(mutator){if(state.busy||!state.drafts)return;mutator(state.drafts);state.error='';},
    setEntry(index,key,value){const id=state.drafts?.[index]?.id;if(id)state.entries[`${id}:${key}`]=value;},
    openTerm(index,id){state.openTerms[index]=state.openTerms[index]===id?null:id;notify();},
    async confirm(){if(state.busy||!state.taskId)return;const taskId=state.taskId,drafts=structuredClone(state.drafts);await action(async current=>{const result=await service.confirm(taskId,drafts);if(!current())return;if(result.status==='invalid')state.error=result.error;else if(result.status==='succeeded')runner.afterReview();else state.error=result.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':'未能采用本批结果';});},
    async read(){if(state.busy)return;const target=state.target;await action(async current=>{await parameterQueue;await repository.read(target);if(!current())return;await refresh();if(!current())return;if(state.parametersUnconfirmed){state.params=structuredClone(state.summary.preferences[state.origin]);state.parametersUnconfirmed=false;parameterFailure=null;}if(state.task?.outcome==='unconfirmed'){state.task=null;state.taskId=null;state.drafts=null;state.route=state.origin;runner.discard();if(state.summary.pending){const id=await service.restorePending(state.origin);if(!current())return;state.taskId=id;taskChanged(service.inspect(id));}}state.message='已重新读取';});},
    async discardPending(){if(state.busy)return;await action(async current=>{await service.discardPending();if(current())await refresh();});},
    async back(){if(state.route==='review'){const taskId=state.taskId;await action(async current=>{if(taskId)await service.discard(taskId);if(!current())return;if(state.task?.origin==='auto')runner.discard();state.route=state.origin;state.drafts=null;state.taskId=null;state.task=null;await refresh();});return false;}return true;},
    stop(){runner.stop();},wake(){runner.wake();},
    showTask(taskId){const task=service.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;state.target=task.target;state.origin=task.origin==='auto'?'auto':'manual';state.taskId=taskId;state.summary=task.snapshot.selection.summary;state.params=structuredClone(state.summary.preferences[state.origin]);taskChanged(task);void refresh();return true;},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){disposed=true;ticket++;releaseService();releaseRunner();runner.dispose();listeners.clear();}
  });
}
