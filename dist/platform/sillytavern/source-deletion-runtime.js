import {sameTarget} from '../../domain/memory/repository.js';
import {isVerifiedTailDeletion} from '../../domain/summary/source-deletion.js';

// Host emits once for a suffix removal. Coalesce adjacent notifications before
// reconciling; duplicate notifications without an actual splice yield no receipt.
export function createSourceDeletionRuntime({adapter,repository,dialog,onNotice=()=>{},onCommitted=()=>{},onPending=()=>{},delay=0}={}) {
  let disposed=false,timer=null,pending=[],generation=0,operation=0,flight=null,queue=Promise.resolve(),carry=null,backlog=[],pumping=false,reviewRetry=null;
  const rollbacks=new Set();
  const current=(target,serial)=>{try{return !disposed&&serial===generation&&sameTarget(target,repository.captureTarget());}catch{return false;}};
  function cancel(){generation++;rollbacks.clear();if(timer!==null)clearTimeout(timer);timer=null;pending=[];carry=null;backlog=[];reviewRetry=null;flight?.abort();flight=null;}
  async function process(records,serial,version,review=null){
    const target=records[0]?.target;if(!target||disposed||serial!==generation)return;
    if(!current(target,serial)){try{await adapter.prepare();}catch{return;}if(!current(target,serial))return;}
    const controller=new AbortController();flight=controller;let reconciled=false,proposal=null;
    const valid=()=>!controller.signal.aborted&&current(target,serial)&&operation===version;
    try{
      proposal=review?await repository.refreshSummarySourceDeletion(target,review):await repository.reconcileSummarySourceDeletion(target,records.map(record=>record.deletion),{isCurrent:()=>current(target,serial)});
      reconciled=true;
      if(!current(target,serial))return true;
      // Release maintenance only after the entire root transaction confirms.
      // Only non-tail deletions can still need an event-card review.
      const synchronized=records.some(record=>rollbacks.has(record));
      for(const record of records)rollbacks.delete(record);
      if(!review&&(proposal.rollbackApplied||synchronized)){
        onCommitted(proposal);
        if(proposal.retractedBatchIds?.length)onNotice(`已同步撤回 ${proposal.retractedBatchIds.length} 个总结批次、${proposal.removed??0} 条相关记忆${proposal.restoredIds?.length?`；恢复 ${proposal.restoredIds.length} 条未受影响的原记忆`:''}`);
        const labels={latest:'最新摘要',workshop:'工坊',tracking:'物品与 NPC 追踪',schedule:'日程',self:'角色自述',outline:'故事大纲',cumulative:'古法'};
        const unavailable=(proposal.rollbackOutcomes??[]).filter(outcome=>outcome.status==='unavailable');
        if(unavailable.length)onNotice(unavailable.map(outcome=>outcome.kind==='tracking'?'物品与 NPC 追踪历史不足，无法回退；可从第 0 楼手动总结并开启原有追踪类别重建，成功采用后会替换旧追踪记录及其自定义字段':`${labels[outcome.kind]??outcome.kind}历史不足，无法回退；${Number.isSafeInteger(outcome.rebuildFrom)?`请从第 ${outcome.rebuildFrom} 楼重新生成`:'请重新生成'}`).join('；'));
      }
      if(carry){
        const ids=new Set([...carry.normal,...carry.merged,...proposal.normal,...proposal.merged].map(event=>event.id)),normal=new Map(),merged=new Map();
        for(const id of ids){const member=proposal.events.find(event=>event.id===id),active=member?.supersededBy?proposal.events.find(event=>event.id===member.supersededBy):member;if(active&&!active.supersededBy)(active.mergedFrom?merged:normal).set(active.id,active);}
        const batchIds=[...new Set([...carry.batchIds,...proposal.batchIds])];
        proposal={...proposal,normal:[...normal.values()],merged:[...merged.values()],batchIds,batchCount:batchIds.length,unresolved:[...new Set([...carry.unresolved,...proposal.unresolved])]};
      }
      carry=proposal;
      if(!valid())return;
      carry=null;
      const unresolved=proposal.unresolved.filter(id=>!id.startsWith('deleted-merge:')),deletedMerges=proposal.unresolved.filter(id=>id.startsWith('deleted-merge:')).map(id=>id.slice('deleted-merge:'.length));
      if(unresolved.length)onNotice(`以下来源位置无法确认，相关记忆已保留：${unresolved.join('、')}`);
      if(deletedMerges.length)onNotice(`合并结果已被删除，保留原删除状态，原成员未恢复：${deletedMerges.join('、')}`);
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
    if(isVerifiedTailDeletion(record.deletion)){rollbacks.add(record);onPending(record);}
    pending.push(record);
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;const records=pending;pending=[];const serial=generation,version=operation;backlog.push({records,serial,version});queue=queue.then(pump);},delay);
  });
  const releaseTarget=adapter.subscribe(()=>cancel());
  return {retry,hasPendingRollback:()=>rollbacks.size>0,dispose(){if(disposed)return;cancel();disposed=true;release();releaseTarget();dialog.dispose();},idle:()=>queue};
}
