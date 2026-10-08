import {sameTarget} from '../domain/memory/repository.js';
import {automaticCumulativePlan} from '../domain/cumulative/auto-runner.js';
import {buildCumulativeRequest} from '../domain/cumulative/requests.js';

const copy=value=>structuredClone(value);
const patchOf=version=>({body:version.body,startTime:version.startTime,endTime:version.endTime});
const active=task=>['starting','running','awaiting-user','committing'].includes(task?.status);
const sameParams=(a,b)=>!!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.is(a[key],b[key]));
const PARAMETER_SAVE_DELAY=250;
// Host owns the controller, service and runner. Unmounting a page is independent.
export function createCumulativeController({repository,service,runner,captureSource,control=null,onCommitted=()=>{}}={}) {
  const listeners=new Set(),retiredTasks=new Set();let parameterDrafts={},parameterTimer=null;let disposed=false,serial=0,opening=0,queue=Promise.resolve(),parameterError=null,visible=false,reloadBinding=null,reloadSequence=0,taskError=null;
  const state={target:null,selection:null,cumulative:null,route:'root',origin:'manual',params:null,latestFloor:null,taskId:null,task:null,draft:null,editDraft:null,editSelection:null,restore:null,preview:null,previewOpen:false,previewView:'source',busy:false,unconfirmed:false,error:'',message:'',noticeSequence:0,scroll:{},opened:{}};
  const inspect=()=>copy({...state,reloadInvalidated:!!reloadBinding,parameterReadRequired:parameterDrafts[state.origin]?.readRequired===true,automatic:runner.inspect()});
  const notify=()=>{if(!disposed)for(const listener of [...listeners])try{listener(inspect());}catch{/* display only */}};
  const current=(ticket,target)=>{try{return !disposed&&!reloadBinding&&ticket===serial&&sameTarget(target,state.target)&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  const adopt=selection=>{
    const previous=state.cumulative?.preferences;
    for(const [origin,draft] of Object.entries(parameterDrafts)){
      // Refresh clean modes, but never replace a pending revert or an in-flight
      // successor just because it happens to equal the last confirmed value.
      if(previous&&!draft.queued&&!draft.error&&draft.revision<=draft.attempted&&sameParams(draft.baseline,previous[origin])&&sameParams(draft.params,previous[origin])){
        draft.params=copy(selection.cumulative.preferences[origin]);draft.baseline=copy(draft.params);if(state.origin===origin)state.params=draft.params;
      }
    }
    state.selection=selection;state.cumulative=selection.cumulative;
  };
  const feedback=message=>{state.message=message;state.noticeSequence++;};
  async function refresh(){const ticket=serial,target=state.target;if(!target)return false;const selection=await repository.captureCumulative(target);if(!current(ticket,target))return false;adopt(selection);state.latestFloor=captureSource(target).messages.at(-1)?.floor??0;return true;}
  async function action(work,recovery=false){if(state.busy||disposed||reloadBinding||(state.unconfirmed||state.task?.outcome==='unconfirmed')&&!recovery)return false;const controlProof=control?.capture(),ticket=serial,target=state.target;state.busy=true;state.error='';taskError=null;notify();try{return await work(()=>current(ticket,target)&&(!control||control.matches(controlProof)));}catch(error){if(current(ticket,target)){taskError=null;state.unconfirmed=state.unconfirmed||error.code==='COMMIT_UNCONFIRMED';state.error=state.unconfirmed?'保存结果尚未确认，请重新读取':error.message;}return false;}finally{if(current(ticket,target)){state.busy=false;notify();}}}
  function acceptTask(taskId){if(retiredTasks.has(taskId))return false;if(state.taskId&&state.taskId!==taskId)retiredTasks.add(state.taskId);state.taskId=taskId;return true;}
  function taskChanged(task){if(!task||disposed||reloadBinding||!sameTarget(task.target,state.target)||task.taskId!==state.taskId)return;const newSuccess=task.status==='succeeded'&&(state.task?.taskId!==task.taskId||state.task?.status!=='succeeded');state.task=task;
    // A new accepted task retires the old task's alert, not unrelated validation
    // or uncertain-write errors. Runner observation may repeat the old failure
    // while start() is still awaiting the new service ticket.
    if(taskError&&taskError.taskId!==task.taskId&&state.error===taskError.message&&task.outcome!=='unconfirmed'&&!state.unconfirmed){state.error='';taskError=null;}
    if(task.status==='awaiting-user'&&task.candidate&&!state.draft){state.draft=patchOf(task.candidate.version);state.route='review';}
    if(task.status==='succeeded'){state.draft=null;state.route=state.origin;if(newSuccess)feedback('本批总结已保存');void refresh().then(ok=>{if(ok){notify();if(visible)onCommitted();}});}
    if(['failed','stale','cancelled'].includes(task.status)){state.error=task.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':task.errorMessage||'本批未完成，请明确重新发起';taskError={taskId:task.taskId,message:state.error};}
    notify();
  }
  const offService=service.subscribe(taskChanged),offRunner=runner.subscribe(value=>{if(!reloadBinding&&value.taskId&&sameTarget(value.target,state.target)&&acceptTask(value.taskId))taskChanged(service.inspect(value.taskId));notify();});
  const cancelParameterTimer=()=>{clearTimeout(parameterTimer);parameterTimer=null;};
  const parameterDraft=()=>parameterDrafts[state.origin];
  function selectParameters(origin){state.params=parameterDrafts[origin].params;parameterError=parameterDrafts[origin].error;if(!state.unconfirmed)state.error=parameterError?.message??'';}
  function resetParameters(selection,preserve=false){
    const previous=state.cumulative?.preferences;
    parameterDrafts=Object.fromEntries(['manual','auto'].map(origin=>{
      const draft=parameterDrafts[origin],keep=preserve&&draft&&(draft.error||draft.revision>draft.attempted||!sameParams(draft.params,previous?.[origin]));
      // A read confirms authority; it never schedules another write of a retained draft.
      return [origin,{params:copy(keep?draft.params:selection.cumulative.preferences[origin]),baseline:copy(selection.cumulative.preferences[origin]),revision:0,attempted:0,requested:0,queued:false,error:null,readRequired:false}];
    }));
  }
  function queueParams(){
    cancelParameterTimer();
    const draft=parameterDraft(),ticket=serial,target=state.target,origin=state.origin;
    if(!draft||!current(ticket,target)||state.unconfirmed)return queue;
    draft.requested=draft.revision;
    if(draft.queued||draft.requested<=draft.attempted)return queue;
    draft.queued=true;
    queue=queue.then(async()=>{
      let validated=false;
      try{
        // Capture at execution, not at each keystroke. At most one latest successor
        // is requested while a previous write is in flight.
        while(current(ticket,target)&&!state.unconfirmed&&draft.requested>draft.attempted){
          const params=copy(draft.params);draft.attempted=draft.revision;validated=false;
          if(!Number.isSafeInteger(params.startFloor)||params.startFloor<0||origin==='manual'&&!(params.endFloor===null||Number.isSafeInteger(params.endFloor)&&params.endFloor>=params.startFloor)||origin==='auto'&&(!Number.isSafeInteger(params.batchSize)||params.batchSize<1))throw new Error('总结范围参数无效');
          validated=true;
          if(!sameParams(state.cumulative.preferences[origin],params)){
            if(!sameParams(draft.baseline,state.cumulative.preferences[origin]))throw new Error('总结参数已变化，请重新读取');
            const receipt=await repository.updateCumulativePreferences(target,state.selection,{[origin]:params},{isCurrent:()=>current(ticket,target)});
            if(!current(ticket,target))return;draft.baseline=copy(receipt.selection.cumulative.preferences[origin]);adopt(receipt.selection);
          }
          draft.baseline=copy(state.cumulative.preferences[origin]);
          if(state.origin===origin){if(parameterError&&state.error===parameterError.message)state.error='';parameterError=null;}draft.error=null;draft.readRequired=false;
        }
      }catch(error){if(current(ticket,target)){
        // Stop already queued successors too. A duplicate change/blur, unmount or
        // timer must not retry a failed or uncertain write behind the user's back.
        cancelParameterTimer();draft.attempted=draft.revision;draft.requested=draft.attempted;draft.error=error;draft.readRequired=validated;
        if(state.origin===origin)parameterError=error;
        state.unconfirmed=error.code==='COMMIT_UNCONFIRMED';state.error=state.unconfirmed?'保存结果尚未确认，请重新读取':error.message;notify();
      }}finally{draft.queued=false;}
    });
    return queue;
  }
  async function readReload(){
    const binding=reloadBinding,ticket=serial;
    if(!binding||disposed||state.busy)return false;
    const valid=()=>!disposed&&ticket===serial&&reloadBinding===binding&&sameTarget(binding.nextTarget,repository.captureTarget());
    state.busy=true;notify();
    try{
      await queue;if(!valid())return false;
      // Old service tickets may still own a chat-level activity/unknown lock.
      // Only the service's explicit reload readback can release that lock.
      const observed=state.taskId?service.inspect(state.taskId):null;
      let receipt;
      if(service.readReboundTarget)receipt=await service.readReboundTarget({...binding,...(state.taskId?{taskId:state.taskId}:{}),isCurrent:valid});
      else {if(active(observed)||observed?.outcome==='unconfirmed')throw new Error('原总结任务尚待重新读取确认');await repository.read(binding.nextTarget);}
      if(!valid())return false;
      const selection=receipt?.selection??await repository.captureCumulative(binding.nextTarget);if(!valid())return false;
      let restoredTask=null;
      if(selection.cumulative.pending){restoredTask=await service.restorePending();if(!valid())return false;}
      if(receipt)runner.settleRebind?.(receipt);
      resetParameters(selection,true);state.target=copy(binding.nextTarget);reloadBinding=null;adopt(selection);state.latestFloor=captureSource(state.target).messages.at(-1)?.floor??0;
      state.unconfirmed=false;selectParameters(state.origin);
      if(state.editDraft)state.editSelection=selection;
      if(state.restore){const index=selection.cumulative.versions.findIndex(version=>version.id===state.restore.id);state.restore=index<0||index===selection.cumulative.versions.length-1?null:{id:state.restore.id,version:copy(selection.cumulative.versions[index]),removed:selection.cumulative.versions.length-index-1,selection};}
      state.task=null;state.taskId=null;state.preview=null;state.previewOpen=false;
      if(restoredTask){state.taskId=restoredTask;taskChanged(service.inspect(restoredTask));}
      else if(state.draft){state.draft=null;state.route=state.origin;}
      state.error='';feedback(receipt?.reviewResolution==='discarded'?'已确认放弃本批草稿':receipt?.outcome==='recovered-committed'?'已确认本批总结保存成功':receipt?.outcome==='recovered-previous'?'已确认保留原版，本批未保存':selection.cumulative.pending?'已恢复待采用草稿':'已重新读取');return true;
    }catch(error){if(valid()||current(ticket,state.target))state.error=error.message;return false;}
    finally{if(valid()||current(ticket,state.target)){state.busy=false;notify();}}
  }
  const controller={inspect,
    invalidateReload({previousTarget,nextTarget,reloadSequence:sequence}={}){
      if(disposed||!visible||!Number.isSafeInteger(sequence)||sequence<=reloadSequence||!sameTarget(previousTarget,state.target)||!sameTarget(nextTarget,repository.captureTarget())||previousTarget?.chatId!==nextTarget?.chatId||previousTarget?.rootId!==nextTarget?.rootId||!(nextTarget.epoch>previousTarget.epoch))return false;
      cancelParameterTimer();reloadSequence=sequence;reloadBinding={previousTarget:copy(previousTarget),nextTarget:copy(nextTarget),reloadSequence:sequence};serial++;opening++;state.busy=false;state.error='聊天已重新加载，请重新读取';runner.invalidateTarget?.(previousTarget);notify();return true;
    },
    async open(route='root'){if(disposed||!['root','manual','auto'].includes(route))return false;const request=++opening,next=repository.captureTarget();await queueParams();if(disposed||request!==opening||!sameTarget(next,repository.captureTarget()))return false;
      if(reloadBinding&&sameTarget(next,reloadBinding.nextTarget))return false;
      if(sameTarget(state.target,next)){
        const observed=state.taskId?service.inspect(state.taskId):null;
        if(route==='root')state.route=state.editDraft?'edit':'root';
        else if(active(observed)&&sameTarget(observed.target,next)){
          // Root viewing never changes the task's mode, parameters or review draft.
          // Restore the registered task rather than starting a task for the clicked mode.
          taskChanged(observed);state.route=observed.status==='awaiting-user'&&observed.candidate?'review':state.origin;
        }else{state.origin=route;state.route=route;selectParameters(route);state.preview=null;state.previewOpen=false;}
        notify();return true;
      }
      const ticket=++serial;reloadBinding=null;state.target=next;state.busy=true;state.task=null;state.taskId=null;state.draft=null;state.editDraft=null;state.editSelection=null;state.restore=null;state.error='';state.message='';state.unconfirmed=false;state.scroll={};state.opened={};notify();
      try{const selected=await repository.captureCumulative(next);if(!current(ticket,next))return false;resetParameters(selected);adopt(selected);state.latestFloor=captureSource(next).messages.at(-1)?.floor??0;state.route=route;state.origin=route==='auto'?'auto':'manual';selectParameters(state.origin);state.preview=null;state.previewOpen=false;parameterError=null;
        if(selected.cumulative.pending){try{state.taskId=await service.restorePending();if(!current(ticket,next))return false;taskChanged(service.inspect(state.taskId));}catch(error){if(current(ticket,next))state.error=error.message;}}return true;
      }catch(error){if(current(ticket,next))state.error=error.message;return false;}finally{if(current(ticket,next)){state.busy=false;notify();}}
    },
    refresh:()=>action(async valid=>{await refresh();if(valid()){if(parameterError)state.error=state.unconfirmed?'保存结果尚未确认，请重新读取':parameterError.message;return true;}}),
    changeParams(mutator,{defer=false}={}){
      if(reloadBinding||state.busy||state.unconfirmed||!current(serial,state.target)||active(state.task)||['running','waiting','awaiting-user'].includes(runner.inspect().status))return queue;
      const previous=copy(state.params);mutator(state.params);
      if(!sameParams(previous,state.params)){
        const draft=parameterDraft();draft.revision++;draft.error=null;draft.readRequired=false;parameterError=null;state.preview=null;state.error='';
        if(defer){cancelParameterTimer();parameterTimer=setTimeout(()=>{parameterTimer=null;void queueParams();},PARAMETER_SAVE_DELAY);return queue;}
      }
      return defer?queue:queueParams();
    },
    flushParams:queueParams,
    async saveParams(){
      if(reloadBinding)throw new Error('聊天已重新加载，请重新读取');
      if(state.unconfirmed)throw parameterError??new Error('保存结果尚未确认，请重新读取');
      const draft=parameterDraft();
      // Only this explicit action can retry a retained failed/read-back draft.
      if(draft&&!sameParams(draft.params,state.cumulative.preferences[state.origin])&&draft.revision<=draft.attempted)draft.revision++;
      await queueParams();if(state.unconfirmed||parameterError)throw parameterError??new Error('保存结果尚未确认，请重新读取');
    },
    start(){return action(async valid=>{await controller.saveParams();if(!valid())return false;state.draft=null;if(state.origin==='auto')return runner.start();const id=await service.start('manual',copy(state.params));if(valid()&&acceptTask(id))taskChanged(service.inspect(id));return true;});},
    regenerate(versionId){return action(async valid=>{await queueParams();if(!valid()||state.unconfirmed)return false;state.draft=null;const id=await service.start('regeneration',{versionId});if(valid()&&acceptTask(id))taskChanged(service.inspect(id));return true;});},
    preview(){return action(async valid=>{if(active(state.task)&&state.task.snapshot){const snapshot=state.task.snapshot;state.preview={...buildCumulativeRequest({source:snapshot.source,previousSummary:snapshot.baseSnapshot?.body??null,settings:snapshot.settings.generation}),snapshot};state.previewOpen=true;return true;}await controller.saveParams();if(!valid())return false;let options=copy(state.params);if(state.origin==='auto'){const plan=automaticCumulativePlan(state.cumulative,captureSource(state.target));if(plan.status!=='ready')throw new Error('尚无可总结的完整批次');options={...options,...plan};}const preview=await service.preview(state.origin,options);if(valid()){state.preview=preview;state.previewOpen=true;}return true;});},
    togglePreview(){state.previewOpen=!state.previewOpen;notify();},previewView(value){if(['source','prompt'].includes(value)){state.previewView=value;notify();}},
    changeDraft(mutator){if(!state.busy&&state.draft&&state.task?.outcome!=='unconfirmed')mutator(state.draft);},
    confirm(){return action(async valid=>{const result=await service.confirm(state.taskId,copy(state.draft));if(!valid())return false;if(result.status==='invalid')state.error=result.error;else if(result.status==='succeeded'){runner.afterReview();await refresh();}else state.error=result.outcome==='unconfirmed'?'保存结果尚未确认，请重新读取':'未能采用本批结果';return result.status==='succeeded';});},
    retry(){return action(async valid=>{const id=await service.retry(state.taskId);if(!valid())return false;if(!id)throw new Error('来源或配置已变化，请重新发起');if(!acceptTask(id))return false;if(state.task?.origin==='auto')runner.transferTask?.(id);taskChanged(service.inspect(id));return true;});},
    beginEdit(){if(reloadBinding||state.busy||state.unconfirmed)return false;const version=state.cumulative?.versions.at(-1);if(!version)return false;state.editDraft=patchOf(version);state.editSelection=state.selection;state.route='edit';notify();return true;},
    changeEdit(mutator){if(!state.busy&&!state.unconfirmed&&state.editDraft)mutator(state.editDraft);},
    cancelEdit(){if(state.busy)return false;state.editDraft=null;state.editSelection=null;state.route='root';notify();return true;},
    saveEdit(){return action(async valid=>{const receipt=await repository.editCurrentCumulative(state.target,state.editSelection,copy(state.editDraft),{isCurrent:valid});if(!valid())return false;adopt(receipt.selection);state.editDraft=null;state.editSelection=null;state.route='root';feedback('已保存');onCommitted();return true;});},
    requestRestore(id){if(reloadBinding||state.busy||state.unconfirmed)return false;const index=state.cumulative.versions.findIndex(version=>version.id===id);if(index<0||index===state.cumulative.versions.length-1)return false;state.restore={id,version:copy(state.cumulative.versions[index]),removed:state.cumulative.versions.length-index-1,selection:state.selection};notify();return true;},
    cancelRestore(){if(state.busy)return false;state.restore=null;notify();return true;},
    confirmRestore(){if(!state.restore)return false;return action(async valid=>{const receipt=await repository.restoreCumulative(state.target,state.restore.selection,state.restore.id,{isCurrent:valid});if(!valid())return false;adopt(receipt.selection);state.restore=null;state.task=null;state.taskId=null;state.draft=null;feedback('已恢复');onCommitted();return true;});},
    read(){cancelParameterTimer();if(reloadBinding)return readReload();return action(async valid=>{await queue;const previousTask=state.taskId,wasAuto=state.task?.origin==='auto';if(state.task?.outcome==='unconfirmed')await service.reconcile(previousTask);await repository.read(state.target);if(!valid())return false;const selection=await repository.captureCumulative(state.target);if(!valid())return false;resetParameters(selection,true);adopt(selection);state.latestFloor=captureSource(state.target).messages.at(-1)?.floor??0;
      const observed=previousTask?service.inspect(previousTask):null,outcome=observed?.outcome,resolution=observed?.reviewResolution;
      if(resolution==='committed'||resolution==='discarded'||outcome==='recovered-committed')runner.resolveReview?.({resume:false});
      state.unconfirmed=false;selectParameters(state.origin);if(state.editDraft){const version=state.cumulative.versions.at(-1);if(version&&JSON.stringify(patchOf(version))===JSON.stringify(state.editDraft)){state.editDraft=null;state.route='root';}else state.editSelection=state.selection;}
      state.restore=null;if(outcome?.startsWith('recovered-')||resolution==='discarded'){
        const pending=state.cumulative.pending;
        // A readback may have restored the existing live review, rather than ended it.
        const reusable=pending&&observed?.status==='awaiting-user'&&sameTarget(observed.target,state.target)&&observed.candidate?.version?.taskId===pending.version.taskId;
        if(reusable){state.taskId=previousTask;taskChanged(observed);state.route='review';}
        else {if(pending&&active(observed))throw new Error('本批审核仍在处理中，请等待任务完成后重新读取');state.taskId=null;state.task=null;if(pending){state.taskId=await service.restorePending();if(!valid())return false;if(wasAuto&&runner.inspect().taskId===previousTask)runner.transferTask?.(state.taskId);taskChanged(service.inspect(state.taskId));}else{state.draft=null;state.route=state.origin;}}
      }
      state.error='';feedback(resolution==='discarded'?'已确认放弃本批草稿':outcome==='recovered-committed'?'已确认本批总结保存成功':outcome==='recovered-previous'?'已确认保留原版，本批未保存':outcome==='recovered-pending'?'已恢复待采用草稿':'已重新读取');return true;},true);},
    discardPending(){return action(async valid=>{if(!await service.discardPending())return false;if(!valid())return false;await refresh();if(!valid())return false;runner.resolveReview?.({resume:false});state.task=null;state.taskId=null;state.draft=null;state.route=state.origin;state.error='';feedback('已放弃本批草稿');return true;});},
    async back(){if(state.route==='edit')return controller.cancelEdit();if(state.route!=='review'){void queueParams();return true;}return action(async valid=>{if(!await service.discard(state.taskId))return false;if(!valid())return false;runner.resolveReview?.({resume:false});state.task=null;state.taskId=null;state.draft=null;state.route=state.origin;await refresh();state.error='';feedback('已放弃本批草稿');return false;});},
    stop:()=>runner.stop(),wake:()=>runner.wake(),setVisible(value){visible=value===true;if(!visible)void queueParams();},
    setScroll(route,value){state.scroll[route]=value;},setOpen(key,value){state.opened[key]=!!value;},
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    dispose(){cancelParameterTimer();disposed=true;serial++;offService();offRunner();listeners.clear();}
  };return Object.freeze(controller);
}
