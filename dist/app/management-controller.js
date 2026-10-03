import { sameTarget, mergeRanges } from '../domain/memory/repository.js';
import { activeEvents } from '../domain/memory/model.js';
import { originalSnapshot,equalData } from '../domain/memory/management-validation.js';

// Owned by the host, not by a mounted view. No controller action writes data.
export function createManagementController({ service, repository, originalAvailable = () => false, getSettingsEpoch = null, getOriginalSnapshot = null } = {}) {
  const listeners = new Set(), operations = new Map(), notices=new Set(), notified=new Set();
  let current = null;
  const emit = () => { for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const notify=(entry,task,phase)=>{
    if(entry.kind!=='keywords'||!liveTarget(entry)||!taskCurrent(entry,task))return;
    const token=JSON.stringify([task.taskId,task.attempt,phase]);if(notified.has(token))return;notified.add(token);
    for(const listener of [...notices]){try{listener({taskId:task.taskId,count:entry.ids.length,phase});}catch{}}
  };
  const release = service?.subscribe(task => {
    task=service.inspect(task.taskId);if(!task)return;
    const entry=[...operations.values()].find(entry=>entry.taskId===task.taskId);
    if(entry){if(task.status==='awaiting-user'&&!task.reviewPending)notify(entry,task,'complete');else if(task.status==='failed'&&task.outcome!=='unconfirmed')notify(entry,task,'failed');}
    if(current?.taskId===task.taskId)emit();
  });
  const key = (kind, target, ids) => JSON.stringify([kind,target, [...ids].sort()]);
  const liveTarget = entry => { try { return sameTarget(entry.target, repository.captureTarget()); } catch { return false; } };
  const taskCurrent=(entry,task)=>{try{return liveTarget(entry)&&repository.matchesSelection(task.target,task.snapshot.selection,{hidden:entry.kind==='undo'})&&(!task.snapshot.settings||typeof getSettingsEpoch==='function'&&getSettingsEpoch()===task.snapshot.settings.epoch)&&(task.snapshot.sourceMode!=='original'||typeof getOriginalSnapshot==='function'&&equalData(originalSnapshot(getOriginalSnapshot(task.target,task.snapshot.ranges),task.snapshot.ranges),task.snapshot.original));}catch{return false;}};
  return {
    async open(kind, ids, returnTo) {
      const target = repository.captureTarget(), root = await repository.read(target);
      if (!sameTarget(target,repository.captureTarget())) throw new Error('聊天目标已变化，请重新进入');
      const events = ids.map(id => activeEvents(root.events).find(event => event.id === id));
      if (!ids.length || events.some(event => !event)) throw new Error('所选记忆已变化，请重新读取');
      if (kind === 'merge' && (ids.length < 2 || events.some(event => event.mergedFrom))) throw new Error('请至少选择两条未合并的记忆');
      const operationKey = key(kind,target,ids), previous = operations.get(operationKey), previousTask=previous?.taskId?service.inspect(previous.taskId):null;
      if (previousTask && (previousTask.outcome==='unconfirmed'&&!previous.recovered||previousTask.status==='committing'||previousTask.outcome!=='unconfirmed'&&!['succeeded','cancelled','stale'].includes(previousTask.status)&&taskCurrent(previous,previousTask))) current = previous;
      else {
        if(previousTask&&!['succeeded','cancelled','stale'].includes(previousTask.status))service.cancel(previous.taskId);
        const selection=await repository.captureSelection(target,ids);
        current = {kind,ids:[...ids],target,selection,events:structuredClone(selection.events),returnTo:structuredClone(returnTo),taskId:null,fields:null,error:'',busy:false,scroll:0};
        operations.set(operationKey,current);
      }
      emit(); return this.inspect();
    },
    inspect() {
      if (!current) return null;
      if (!liveTarget(current)) return {kind:current.kind, target:current.target, status:'stale', error:'聊天目标已变化，请返回原工作面', returnTo:current.returnTo};
      const task = current.taskId ? service.inspect(current.taskId) : null;
      if(!task&&!repository.matchesSelection(current.target,current.selection))return {...current,status:'stale',error:'所选记忆已变化，请返回后重新发起'};
      if(task && !['succeeded','committing','cancelled','stale'].includes(task.status) && task.outcome!=='unconfirmed' && !taskCurrent(current,task))return {...current,taskId:task.taskId,status:'stale',error:'记忆来源或设置已变化，请返回后重新发起'};
      const fields = task?.reviewPending ? current.fields ?? task.candidate.fields : current.fields;
      if(task?.candidate?.kind==='keywords'&&!task.reviewPending&&!current.indexes)current.indexes=structuredClone(task.candidate.results).map(item=>({...item,detailWords:item.detailWords.map(term=>({...term,aliasesText:term.aliases.join('，')}))}));
      let available=false;try{available=current.kind==='merge'&&!!originalAvailable(current.target,mergeRanges(current.events.flatMap(event=>event.sources)));}catch{}
      return {...current, ...task, error:current.error||task?.error||'', status:task?.status ?? 'preflight', fields, originalAvailable:available};
    },
    async start(sourceMode) {
      const entry=current;if(!entry||entry.busy||entry.taskId||this.inspect()?.status==='stale')return false;
      if (!service) { entry.error='请先在 API 设置中选择来源并完成配置。';emit();return false; }
      entry.busy=true;entry.error='';emit();
      try {
        entry.taskId=entry.kind==='keywords'?await service.rebuildKeywords(entry.ids):entry.kind==='merge'?await service.merge(entry.ids,{sourceMode}):await service.undoMerge(entry.ids[0]);
        const task=service.inspect(entry.taskId);if(task&&!['stale','cancelled'].includes(task.status))notify(entry,task,'started');
        if(task?.status==='awaiting-user'&&!task.reviewPending)notify(entry,task,'complete');else if(task?.status==='failed')notify(entry,task,'failed');
        return true;
      } catch { entry.error='无法发起，请检查 API 设置与记忆来源。';return false; }
      finally {entry.busy=false;emit();}
    },
    change(mutator) {const state=this.inspect();if(!state?.reviewPending||!current)return;current.fields=structuredClone(state.fields);mutator(current.fields);current.error='';},
    changeIndexes(mutator){const state=this.inspect();if(!current||state?.candidate?.kind!=='keywords'||!['awaiting-user','failed'].includes(state.status)||state.outcome==='unconfirmed'||state.busy)return false;mutator(current.indexes);current.error='';current.errorIndex=null;return true;},
    openTerm(value){if(current)current.openIndexTerm=value;},
    review() {const state=this.inspect();if(!state?.reviewPending)return false;const accepted=service.review(current.taskId,structuredClone(state.fields));if(!accepted)current.error='请检查正文、人物地点，并至少填写一个故事时间。';emit();return accepted;},
    async confirm() {const entry=current,state=this.inspect();if(!entry||entry.busy||!state?.taskId||state.reviewPending||state.status==='stale'||state.outcome==='unconfirmed')return null;entry.busy=true;emit();try {
      const options=state.candidate?.kind==='keywords'?{reviewedIndexes:state.indexes.map(item=>({id:item.id,eventWords:[...item.eventWords],detailWords:item.detailWords.map(term=>({id:term.id,word:term.word,aliases:term.aliasesText.split(/[，,]/).map(value=>value.trim()).filter(Boolean)}))}))}:undefined;
      const result=await service.confirm(entry.taskId,options);if(result?.status==='invalid'){entry.error=result.error;entry.errorIndex=result.errorIndex;}return result;
    }finally{entry.busy=false;emit();}},
    cancel() {if(current?.taskId)service.cancel(current.taskId);if(current)current.error='';emit();},
    retry() {if(!current?.taskId)return false;current.error='';const retried=service.retry(current.taskId);if(retried){current.fields=null;current.indexes=null;notify(current,service.inspect(current.taskId),'started');}emit();return retried;},
    resume(taskId){const entry=[...operations.values()].find(entry=>entry.taskId===taskId),task=service?.inspect(taskId);if(!entry||!task||!taskCurrent(entry,task)||['succeeded','cancelled','stale'].includes(task.status))return false;current=entry;emit();return true;},
    resumeCurrent(){return current?.taskId?this.resume(current.taskId):!!current?.busy&&liveTarget(current)&&repository.matchesSelection(current.target,current.selection);},
    subscribeNotices(listener){notices.add(listener);return()=>notices.delete(listener);},
    back() {const returnTo=current?.returnTo;current=null;return returnTo;},
    setScroll(value) {if(current)current.scroll=value;},
    async recover() {const entry=current;if(!entry)return null;try{const root=await repository.read(entry.target);if(!liveTarget(entry))throw new Error();entry.error='';entry.recovered=true;return root;}catch{entry.error='保存结果仍待确认，请恢复连接后重新读取。';emit();return null;}},
    subscribe(listener) {listeners.add(listener);return ()=>listeners.delete(listener);},
    refresh() {emit();},
    settled() {return current?.taskId?service.settled(current.taskId):Promise.resolve(null);},
    dispose() {release?.();listeners.clear();notices.clear();},
  };
}
