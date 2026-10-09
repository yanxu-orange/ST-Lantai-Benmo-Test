import {sameTarget} from '../../domain/memory/repository.js';

// Host emits once for a suffix removal. Coalesce adjacent notifications before
// opening UI; duplicate notifications without an actual splice yield no receipt.
export function createSourceDeletionRuntime({adapter,repository,dialog,onNotice=()=>{},onCommitted=()=>{},delay=0}={}) {
  let disposed=false,timer=null,pending=[],generation=0,operation=0,flight=null,queue=Promise.resolve(),carry=null,backlog=[],pumping=false,reviewRetry=null;
  const current=(target,serial)=>{try{return !disposed&&serial===generation&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  function cancel(){generation++;if(timer!==null)clearTimeout(timer);timer=null;pending=[];carry=null;backlog=[];reviewRetry=null;flight?.abort();flight=null;}
  async function process(records,serial,version,review=null){
    const target=records[0]?.target;if(!target||disposed||serial!==generation)return;
    if(!current(target,serial)){try{await adapter.prepare();}catch{return;}if(!current(target,serial))return;}
    const controller=new AbortController();flight=controller;let reconciled=false,proposal=null;
    const valid=()=>!controller.signal.aborted&&current(target,serial)&&operation===version;
    try{
      proposal=review?await repository.refreshSummarySourceDeletion(target,review):await repository.reconcileSummarySourceDeletion(target,records.map(record=>record.deletion),{isCurrent:()=>current(target,serial)});
      reconciled=true;
      if(!current(target,serial))return true;
      if(carry){
        const ids=new Set([...carry.normal,...carry.merged,...proposal.normal,...proposal.merged].map(event=>event.id)),normal=new Map(),merged=new Map();
        for(const id of ids){const member=proposal.events.find(event=>event.id===id),active=member?.supersededBy?proposal.events.find(event=>event.id===member.supersededBy):member;if(active&&!active.supersededBy)(active.mergedFrom?merged:normal).set(active.id,active);}
        const batchIds=[...new Set([...carry.batchIds,...proposal.batchIds])];
        proposal={...proposal,normal:[...normal.values()],merged:[...merged.values()],batchIds,batchCount:batchIds.length,unresolved:[...new Set([...carry.unresolved,...proposal.unresolved])]};
      }
      carry=proposal;
      if(!valid())return;
      carry=null;
      if(proposal.unresolved.length)onNotice('部分来源位置无法确认，相关记忆已保留');
      if(!proposal.normal.length&&!proposal.merged.length){if(review)onNotice('相关记忆已无待删除项目');return;}
      const choice=await dialog.show({proposal,signal:controller.signal});
      if(!choice||!valid())return;
      const result=await repository.removeSummarySourceSelection(target,proposal,choice,{isCurrent:valid});
      if(valid()){onCommitted(result);onNotice(`已删除 ${result.removed} 条相关记忆`);}
    }catch(error){if(current(target,serial)){if(reconciled&&proposal&&operation===version)reviewRetry={records,serial,version,proposal};onNotice(error?.code==='COMMIT_UNCONFIRMED'?'保存结果尚未确认，请重新读取记忆':error?.message??'删除未完成，记忆已保留',!reconciled||!!reviewRetry);}return reconciled;}
    finally{if(flight===controller)flight=null;}
    return true;
  }
  async function pump(){
    if(pumping||disposed)return;pumping=true;
    try{while(backlog.length&&!disposed){const job=backlog[0];if(disposed||job.serial!==generation){backlog.shift();continue;}const result=await process(job.records,job.serial,job.version,job.proposal);if(result===false)break;if(backlog[0]===job)backlog.shift();}}finally{pumping=false;}
  }
  function retry(){if(disposed)return false;if(reviewRetry){backlog.push(reviewRetry);reviewRetry=null;}if(!backlog.length)return false;queue=queue.then(pump);return true;}
  const release=adapter.subscribeSourceDeletions(record=>{
    if(disposed)return;
    if(record.error){onNotice(record.error);return;}
    if(!record.deletion||!record.target)return;
    // A new physical deletion invalidates a previously displayed frozen choice.
    operation++;reviewRetry=null;if(flight){flight.abort();flight=null;}
    if(pending.length&&!sameTarget(pending[0].target,record.target))cancel();
    pending.push(record);
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;const records=pending;pending=[];const serial=generation,version=operation;backlog.push({records,serial,version});queue=queue.then(pump);},delay);
  });
  const releaseTarget=adapter.subscribe(()=>cancel());
  return {retry,dispose(){if(disposed)return;cancel();disposed=true;release();releaseTarget();dialog.dispose();},idle:()=>queue};
}
