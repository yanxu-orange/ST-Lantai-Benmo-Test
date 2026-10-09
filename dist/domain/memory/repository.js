import {narrativeOf,assertNarrative} from '../narrative/data.js';
import {trackingOf,assertTracking} from '../tracking/data.js';
import {latestOf,assertLatest,assertLatestPreferences,assertLatestRecord} from '../latest/data.js';
import {storedLatestSource} from '../latest/source.js';
import {affectedSummaryDeletion} from '../summary/source-deletion.js';
import {rebaseSummaryPositions} from '../summary/source-positions.js';
import {assertChatControls,defaultChatControls} from '../controls/model.js';
import {workshopOf,assertWorkshop} from '../workshop/model.js';
import {timeOf,assertTime} from '../time/data.js';
import { assertRoot, validateEvent, validateEventForSave, activeEvents } from './model.js';
import {summaryOf,assertSummaryPreferences,assertExcludedFloors,assertBatch,assertGeneratedEvidence,assertSummaryPending,publicSummarySettingsEvidence} from '../summary/data.js';
import {matchesStoredSummarySource} from '../summary/source.js';
import {cumulativeOf,assertCumulativePreferences,assertCumulativeExclusions,assertCumulativePending,assertCumulativeVersion,baseSnapshotOf,cumulativeCoverage} from '../cumulative/data.js';
export function sameTarget(a, b) { return !!a && !!b && !!a.chatId && !!a.rootId && Number.isSafeInteger(a.epoch) && a.chatId === b.chatId && a.rootId === b.rootId && a.epoch === b.epoch; }
const copy = value => structuredClone(value);
const equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function selectedIds(ids, unique = false) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim()) || unique && new Set(ids).size !== ids.length) throw new Error('请选择有效且唯一的记忆');
  return new Set(ids);
}
function select(root, ids, hidden = false) {
  const events = ids.map(id => root.events.find(event => event.id === id));
  if (events.some(event => !event || !hidden && event.supersededBy)) throw new Error('所选记忆已变化，请重新读取');
  return events;
}
function matchSnapshot(root, target, snapshot, hidden = false) {
  if (!snapshot || !sameTarget(target, snapshot.target) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.events)) throw new Error('来源快照无效');
  const ids = [...selectedIds(snapshot.events.map(event => event?.id), true)];
  const current = select(root, ids, hidden);
  if (!equal(current, snapshot.events)) throw new Error('所选记忆来源已变化，请重新读取');
  return current;
}
export function mergeRanges(ranges) {
  const ordered = copy(ranges).sort((a, b) => a.start - b.start || a.end - b.end), merged = [];
  for (const range of ordered) {
    const last = merged.at(-1);
    if (last && (range.start <= last.end || range.start - last.end === 1)) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}
// Initial candidate values only; reviewed participant edits are authoritative.
export function mergeParticipants(events) {
  return { people: [...new Set(events.flatMap(event => event.people))], places: [...new Set(events.flatMap(event => event.places))] };
}
export function createRepository(adapter, now = () => new Date().toISOString()) {
  let queue = Promise.resolve();
  const sourceDeletionReceipts=new Map();
  const requireTarget = target => { if (!sameTarget(target, adapter.captureTarget())) throw new Error('聊天目标已变化，请返回列表重新进入'); };
  const enqueue = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const read = async target => { requireTarget(target); const root = assertRoot(await adapter.read(target), target); requireTarget(target); return root; };
  const commit = async (target, root, next, guard = () => true, options = {}) => {
    const check = current => { requireTarget(target); if (guard(current) !== true) throw new Error('任务已取消或来源已失效'); return true; };
    assertRoot(next, target); check(root);
    const committed = await adapter.commit(target, next, root.revision, { ...options, guard: check });
    requireTarget(target);
    return assertRoot(committed, target);
  };
  const sourceGuard = (target, snapshot, options, hidden = false) => current => {
    if ((options.isCurrent ?? (() => true))() !== true) throw new Error('任务已取消或来源已失效');
    matchSnapshot(current, target, snapshot, hidden);
    return true;
  };
  const matchSummary=(root,target,snapshot)=>{
    if(!snapshot||!sameTarget(target,snapshot.target)||!equal(summaryOf(root),snapshot.summary))throw new Error('总结参数或批历史已变化');
    if(snapshot.batch){const batch=summaryOf(root).batches.find(item=>item.id===snapshot.batch.id);if(!equal(batch,snapshot.batch)||!equal(root.events.filter(event=>batch.eventIds.includes(event.id)),snapshot.events))throw new Error('所属批成员已变化');}
  };
  const summaryGuard=(target,snapshot,options)=>current=>{if(typeof options.isCurrent!=='function'||options.isCurrent()!==true)throw new Error('总结来源或配置已失效');matchSummary(current,target,snapshot);return true;};
  const consumePending=(summary,options,draft,candidates)=>{
    if(summary.pending){const pending=summary.pending;
      if(options.pendingId!==pending.id||draft.id!==pending.batchId||draft.sourceType!==pending.origin||draft.generationMode!==pending.generationMode||draft.hideOriginal!==pending.params.hideOriginal||!equal(draft.generatedCandidates,pending.generatedCandidates)||!equal(publicSummarySettingsEvidence(draft.settingsEvidence),pending.settingsEvidence)||!equal(draft.requestedRange,pending.sourceSnapshot.requestedRange)||!equal(draft.actualRange,pending.sourceSnapshot.actualRange)||draft.sourceSnapshot?.includeUser!==pending.sourceSnapshot.includeUser||!equal(draft.sourceSnapshot?.excludedFloors,pending.sourceSnapshot.excludedFloors)||!matchesStoredSummarySource(pending.sourceSnapshot,{epoch:draft.sourceSnapshot?.epoch,messages:draft.sourceSnapshot?.rawMessages})||candidates.some(event=>!pending.events.some(previous=>previous.id===event.id)))throw new Error('待审核草稿身份或证据不符，不得覆盖');}
    else if(options.pendingId!==undefined)throw new Error('待审核草稿已变化');
    const result={...summary};delete result.pending;return result;
  };
  const batchEvents=(root,events,id,actualRange)=>{
    if(!Array.isArray(events)||!events.length)throw new Error('至少保留一条事件切片');
    const ids=new Set(),timestamp=now();
    return events.map(candidate=>{if(ids.has(candidate?.id)||root.events.some(event=>event.id===candidate?.id)||root.deletedMergeIds?.includes(candidate?.id)||candidate?.mergedFrom!=null||candidate?.supersededBy!=null)throw new Error('生成切片身份或关系无效');ids.add(candidate.id);return validateEventForSave({...copy(candidate),createdAt:timestamp,updatedAt:timestamp,sources:[copy(actualRange)],batch:{id,sources:[copy(actualRange)]}});});
  };
  const captureCumulativeRoot=(target,root)=>freeze({target:copy(target),cumulative:cumulativeOf(root)});
  const matchCumulative=(root,target,snapshot)=>{
    if(!snapshot||!sameTarget(target,snapshot.target)||!equal(cumulativeOf(root),snapshot.cumulative))throw new Error('古法基版、配置或进度已变化');
  };
  const cumulativeGuard=(target,snapshot,options,required=false)=>current=>{
    if(required&&typeof options.isCurrent!=='function'||(options.isCurrent??(()=>true))()!==true)throw new Error('古法来源或配置已失效');
    matchCumulative(current,target,snapshot);return true;
  };
  const cumulativeMutation=(target,selection,options,change,required=false)=>{
    const frozen=copy(target),snapshot=copy(selection);
    return enqueue(async()=>{const root=await read(frozen);matchCumulative(root,frozen,snapshot);const domain=cumulativeOf(root),guard=cumulativeGuard(frozen,snapshot,options,required);guard(root);
      const changed=change(domain);if(!changed)return {status:'unchanged',root,selection:captureCumulativeRoot(frozen,root)};
      const next={...root,revision:root.revision+1,cumulative:{...changed,revision:domain.revision+1}};
      const committed=await commit(frozen,root,next,guard);
      return {status:'committed',root:committed,selection:captureCumulativeRoot(frozen,committed)};
    });
  };
  const consumeCumulativePending=(domain,draft,operation,options)=>{
    if(domain.pending){const pending=domain.pending,original=pending.version;
      if(options.pendingId!==pending.id||pending.operation!==operation||draft.id!==original.id||draft.taskId!==original.taskId||!equal(draft.baseSnapshot,original.baseSnapshot)||!equal(draft.sourceSnapshot,original.sourceSnapshot)||!equal(draft.coverageRanges,original.coverageRanges)||!equal(draft.settingsEvidence,original.settingsEvidence))throw new Error('古法待审核身份或来源已变化');
    }else if(options.pendingId!==undefined)throw new Error('古法待审核已变化');
    const next={...domain};delete next.pending;return next;
  };
  const latestMutation=(target,selection,options,change)=>{
    const frozen=copy(target),snapshot=copy(selection);
    const guard=root=>{requireTarget(frozen);if((options.isCurrent??(()=>true))()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(latestOf(root),snapshot.latest))throw new Error('最新摘要来源或配置已变化');return true;};
    return enqueue(async()=>{
      const root=await read(frozen);guard(root);const current=latestOf(root),candidate=assertLatest(change(copy(current))),nextLatest={...candidate,revision:current.revision};
      if(!options.forceSave&&equal(current,nextLatest))return {status:'unchanged',root,selection:freeze({target:frozen,latest:current})};
      nextLatest.revision++;
      const saved=await commit(frozen,root,{...root,revision:root.revision+1,latest:nextLatest},guard,{workshopProof:options.workshopProof,requireConfirmation:options.requireConfirmation??false});
      return {status:'committed',root:saved,selection:freeze({target:frozen,latest:latestOf(saved)})};
    });
  };
  return {
    async captureNarrative(target){const frozen=copy(target);return freeze({target:frozen,narrative:narrativeOf(await read(frozen))});},
    matchesNarrative(target,selection){try{requireTarget(target);const root=assertRoot(adapter.peekConfirmed(target),target);return !!selection&&sameTarget(target,selection.target)&&equal(narrativeOf(root),selection.narrative);}catch{return false;}},
    updateNarrative(target,selection,value,{isCurrent=()=>true,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertNarrative(value);
      const guard=root=>{requireTarget(frozen);if(!isCurrent()||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(narrativeOf(root),snapshot.narrative))throw new Error('自述或大纲资料已变化，请重新读取');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=narrativeOf(root),next={...candidate,revision:current.revision};
        if(equal(current,next))return {status:'unchanged',root,selection:freeze({target:frozen,narrative:current})};
        next.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,narrative:next},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,narrative:narrativeOf(saved)})};
      });
    },
    async captureTracking(target){const frozen=copy(target);return freeze({target:frozen,tracking:trackingOf(await read(frozen))});},
    updateTracking(target,selection,value,{isCurrent=()=>true,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertTracking(value);
      const guard=root=>{requireTarget(frozen);if(!isCurrent()||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(trackingOf(root),snapshot.tracking))throw new Error('追踪来源或资料已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=trackingOf(root),next={...candidate,revision:current.revision};
        if(equal(current,next))return {status:'unchanged',root,selection:freeze({target:frozen,tracking:current})};
        next.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,tracking:next},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,tracking:trackingOf(saved)})};
      });
    },
    async captureLatest(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,latest:latestOf(root)});},
    matchesLatest(target,selection){try{requireTarget(target);const current=assertRoot(adapter.peekConfirmed(target),target);return !!selection&&sameTarget(target,selection.target)&&equal(latestOf(current),selection.latest);}catch{return false;}},
    updateLatest(target,selection,value,options={}){const candidate=assertLatest(value);return latestMutation(target,selection,options,()=>candidate);},
    updateLatestPreferences(target,selectionOrPatch,patchOrOptions={},options={}){
      const selected=selectionOrPatch?.latest!==undefined,patch=selected?patchOrOptions:selectionOrPatch,opts=selected?options:patchOrOptions,draft=copy(patch);
      if(!draft||Object.getPrototypeOf(draft)!==Object.prototype||Object.keys(draft).some(key=>!['enabled','recentFloors','prompt'].includes(key)))throw new Error('最新摘要设置无效');
      const apply=selection=>latestMutation(target,selection,opts,domain=>{if(opts.expectedLatestRevision!==undefined&&domain.revision!==opts.expectedLatestRevision)throw new Error('最新摘要设置已变化');return {...domain,preferences:assertLatestPreferences({...domain.preferences,...draft})};});
      if(selected)return apply(selectionOrPatch);
      const frozen=copy(target);return read(frozen).then(root=>apply(freeze({target:frozen,latest:latestOf(root)})));
    },
    upsertLatestRecord(target,selection,record,options={}){
      const draft=assertLatestRecord({...copy(record),sourceSnapshot:storedLatestSource(record.sourceSnapshot)});return latestMutation(target,selection,options,domain=>{
        const previous=domain.records.find(item=>item.sourceSnapshot.replyId===draft.sourceSnapshot.replyId);
        if(domain.records.some(item=>item.id===draft.id&&item.id!==previous?.id))throw new Error('最新摘要记录身份已占用');
        const timestamp=now(),next={...draft,id:previous?.id??draft.id,createdAt:previous?.createdAt??timestamp,updatedAt:timestamp};
        return {...domain,records:previous?domain.records.map(item=>item.id===previous.id?next:item):[...domain.records,next]};
      });
    },
    editLatestRecord(target,selection,id,body,options={}){
      if(typeof body!=='string'||!body.trim())throw new Error('最新摘要正文不能为空');
      return latestMutation(target,selection,options,domain=>{if(!domain.records.some(item=>item.id===id))throw new Error('最新摘要记录已变化');return {...domain,records:domain.records.map(item=>item.id===id?{...item,body,edited:true,updatedAt:now()}:item)};});
    },
    removeLatestRecords(target,selection,ids,options={}){
      const selected=selectedIds(ids,true);return latestMutation(target,selection,options,domain=>{if([...selected].some(id=>!domain.records.some(item=>item.id===id)))throw new Error('最新摘要记录已变化');return {...domain,records:domain.records.filter(item=>!selected.has(item.id))};});
    },
    async captureControls(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,controls:root.controls??defaultChatControls()});},
    updateControls(target,selection,value,{isCurrent=()=>true}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertChatControls(value);
      const guard=root=>{requireTarget(frozen);if(isCurrent()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(root.controls??defaultChatControls(),snapshot.controls))throw new Error('当前聊天开关已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);
        if(equal(root.controls??defaultChatControls(),candidate))return {status:'unchanged',selection:freeze({target:frozen,controls:candidate})};
        await commit(frozen,root,{...root,revision:root.revision+1,controls:candidate},guard);
        return {status:'committed',selection:freeze({target:frozen,controls:candidate})};
      });
    },
    async captureTime(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,time:timeOf(root)});},
    updateTime(target,selection,value,{isCurrent=()=>true}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertTime(value);
      const guard=root=>{requireTarget(frozen);if(isCurrent()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(timeOf(root),snapshot.time))throw new Error('时间来源或配置已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=timeOf(root);
        const nextTime={...candidate,revision:current.revision};
        if(equal(current,nextTime))return {status:'unchanged',root,selection:freeze({target:frozen,time:current})};
        nextTime.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,time:nextTime},guard);
        return {status:'committed',root:saved,selection:freeze({target:frozen,time:timeOf(saved)})};
      });
    },
    async captureWorkshop(target){const frozen=copy(target);return freeze({target:frozen,workshop:workshopOf(await read(frozen))});},
    updateWorkshop(target,selection,value,{isCurrent=()=>true,workshopProof,forceSave=false,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertWorkshop(value);
      const guard=root=>{requireTarget(frozen);if(isCurrent()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(workshopOf(root),snapshot.workshop))throw new Error('工坊来源或配置已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=workshopOf(root);
        const nextWorkshop={...candidate,revision:current.revision};
        if(!forceSave&&equal(current,nextWorkshop))return {status:'unchanged',root,selection:freeze({target:frozen,workshop:current})};
        nextWorkshop.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,workshop:nextWorkshop},guard,{workshopProof,requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,workshop:workshopOf(saved)})};
      });
    },
    captureTarget: () => { const target = adapter.captureTarget(); requireTarget(target); return copy(target); },
    read,
    async captureCumulative(target){const frozen=copy(target);return captureCumulativeRoot(frozen,await read(frozen));},
    matchesCumulative(target,snapshot){try{requireTarget(target);matchCumulative(assertRoot(adapter.peekConfirmed(target),target),target,snapshot);requireTarget(target);return true;}catch{return false;}},
    updateCumulativePreferences(target,selection,patch,options={}) {
      const draft=copy(patch);
      if(!draft||Object.getPrototypeOf(draft)!==Object.prototype||Object.keys(draft).some(key=>!['manual','auto'].includes(key))||Object.values(draft).some(item=>!item||Object.getPrototypeOf(item)!==Object.prototype))throw new Error('古法参数按模式保存');
      return cumulativeMutation(target,selection,options,domain=>({...domain,preferences:assertCumulativePreferences({...domain.preferences,...Object.fromEntries(Object.entries(draft).map(([mode,item])=>[mode,{...domain.preferences[mode],...item}]))})}));
    },
    setCumulativeExcludedFloors(target,selection,records,options={}) {
      const excludedFloors=assertCumulativeExclusions(records);return cumulativeMutation(target,selection,options,domain=>({...domain,excludedFloors}));
    },
    saveCumulativePending(target,selection,pending,options={}) {
      const draft=assertCumulativePending(pending);return cumulativeMutation(target,selection,options,domain=>{
        if(domain.pending&&!equal(domain.pending,draft))throw new Error('已有其他或变化的古法待审核版本');
        return {...domain,pending:draft};
      },true);
    },
    clearCumulativePending(target,selection,options={}) {
      return cumulativeMutation(target,selection,options,domain=>{if(!domain.pending)return null;const next={...domain};delete next.pending;return next;});
    },
    removeCumulativeHiddenSegments(target,selection,ids,options={}) {
      const selected=selectedIds(ids,true);
      return cumulativeMutation(target,selection,options,domain=>{
        const segments=domain.hiddenSegments??[];if([...selected].some(id=>!segments.some(segment=>segment.id===id)))throw new Error('古法隐藏段已变化');
        return {...domain,hiddenSegments:segments.filter(segment=>!selected.has(segment.id))};
      });
    },
    appendCumulative(target,selection,version,options={}) {
      const draft=assertCumulativeVersion(version);return cumulativeMutation(target,selection,options,domain=>{
        const previous=domain.versions.at(-1);
        if(domain.versions.some(item=>item.id===draft.id||item.taskId===draft.taskId)||!equal(draft.baseSnapshot,baseSnapshotOf(previous))||!equal(draft.coverageRanges,cumulativeCoverage([...(previous?.coverageRanges??[]),draft.sourceSnapshot.requestedRange])))throw new Error('古法完整基版或累计来源已变化');
        const record={...draft,createdAt:now(),updatedAt:now()};
        const next={...consumeCumulativePending(domain,draft,'append',options),versions:[...domain.versions,record],currentVersionId:record.id,progress:{lastProcessedFloor:Math.max(...record.coverageRanges.map(range=>range.end))}};
        if(draft.settingsEvidence.hideSource===true){
          if(domain.hiddenSegments?.some(segment=>segment.id===draft.taskId))throw new Error('古法隐藏任务已采用，不得重复提交');
          next.hiddenSegments=[...(domain.hiddenSegments??[]),{id:draft.taskId,messages:draft.sourceSnapshot.sentFloors.map(({floor,identity,role,date})=>({floor,identity,role,date}))}];
        }
        return next;
      },true);
    },
    replaceCumulative(target,selection,version,options={}) {
      const draft=assertCumulativeVersion(version);return cumulativeMutation(target,selection,options,domain=>{
        const previous=domain.versions.at(-1);
        if(!previous||draft.id!==previous.id||domain.versions.slice(0,-1).some(item=>item.taskId===draft.taskId)||!equal(draft.baseSnapshot,previous.baseSnapshot)||!equal(draft.sourceSnapshot,previous.sourceSnapshot)||!equal(draft.coverageRanges,previous.coverageRanges))throw new Error('古法再生成必须保留冻结基版和原始来源');
        if(!domain.pending||domain.pending.operation!=='replace')throw new Error('古法再生成须明确审核采用');
        const record={...draft,createdAt:previous.createdAt,updatedAt:now()};
        return {...consumeCumulativePending(domain,draft,'replace',options),versions:[...domain.versions.slice(0,-1),record]};
      },true);
    },
    editCurrentCumulative(target,selection,patch,options={}) {
      const draft=copy(patch);if(!draft||Object.keys(draft).some(key=>!['body','startTime','endTime'].includes(key)))throw new Error('古法仅允许编辑正文及起止时间');
      return cumulativeMutation(target,selection,options,domain=>{
        const previous=domain.versions.at(-1);if(!previous)throw new Error('没有已确认古法版本');
        const record=assertCumulativeVersion({...previous,...draft,updatedAt:now()}),next={...domain,versions:[...domain.versions.slice(0,-1),record]};delete next.pending;return next;
      });
    },
    restoreCumulative(target,selection,id,options={}) {
      return cumulativeMutation(target,selection,options,domain=>{
        const index=domain.versions.findIndex(item=>item.id===id);if(index<0)throw new Error('没有可恢复的古法祖先');
        const versions=domain.versions.slice(0,index+1),version=versions.at(-1),next={...domain,versions,currentVersionId:id,progress:{lastProcessedFloor:Math.max(...version.coverageRanges.map(range=>range.end))}};delete next.pending;return next;
      });
    },
    async captureSummaryView(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,revision:root.revision,summary:summaryOf(root),formalIds:root.events.map(event=>event.id)});},
    async captureSummary(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,revision:root.revision,summary:summaryOf(root)});},
    async captureBatch(target,id){const frozen=copy(target),root=await read(frozen),summary=summaryOf(root),batch=summary.batches.find(item=>item.id===id);if(!batch)throw new Error('没有可确认的独立批记录');return freeze({target:frozen,revision:root.revision,summary,batch:copy(batch),events:copy(root.events.filter(event=>batch.eventIds.includes(event.id)))});},
    matchesSummary(target,snapshot){try{requireTarget(target);matchSummary(assertRoot(adapter.peekConfirmed(target),target),target,snapshot);requireTarget(target);return true;}catch{return false;}},
    saveSummaryPending(target,selection,pending,options={}) {
      const frozen=copy(target),snapshot=copy(selection),draft=assertSummaryPending(pending);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot);const summary=summaryOf(root);
        if(summary.pending){const previous=summary.pending;if(previous.id!==draft.id||previous.batchId!==draft.batchId||previous.createdAt!==draft.createdAt||previous.origin!==draft.origin||previous.generationMode!==draft.generationMode||!equal(previous.params,draft.params)||!equal(previous.generatedCandidates,draft.generatedCandidates)||!equal(previous.sourceSnapshot.excludedFloors,draft.sourceSnapshot.excludedFloors)||!equal(previous.settingsEvidence,draft.settingsEvidence)||!equal(previous.sourceSnapshot.requestedRange,draft.sourceSnapshot.requestedRange)||!equal(previous.sourceSnapshot.actualRange,draft.sourceSnapshot.actualRange)||!matchesStoredSummarySource(previous.sourceSnapshot,{epoch:draft.sourceSnapshot.epoch,messages:draft.sourceSnapshot.rawMessages})||previous.completedStages.length>draft.completedStages.length||draft.events.some(event=>!previous.events.some(item=>item.id===event.id)))throw new Error('已有其他、变化或更新阶段待审核草稿');}
        const nextSummary={...summary,revision:summary.revision+1,pending:draft};
        const committed=await commit(frozen,root,{...root,revision:root.revision+1,summary:nextSummary},summaryGuard(frozen,snapshot,options));
        return {status:'committed',root:committed,selection:freeze({target:copy(frozen),revision:committed.revision,summary:summaryOf(committed)})};
      });
    },
    clearSummaryPending(target,selection,options={}) {
      const frozen=copy(target),snapshot=copy(selection);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot);const summary=summaryOf(root);
        summaryGuard(frozen,snapshot,options)(root);
        if(!summary.pending)return {status:'unchanged',root};
        const nextSummary={...summary,revision:summary.revision+1};delete nextSummary.pending;
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,summary:nextSummary},summaryGuard(frozen,snapshot,options))};
      });
    },
    updateSummaryPreferences(target,patch,{expectedSummaryRevision,isCurrent=()=>true}={}) {
      const frozen=copy(target),draft=copy(patch);
      return enqueue(async()=>{const root=await read(frozen),summary=summaryOf(root),revision=summary.revision;
        if(expectedSummaryRevision!==undefined&&revision!==expectedSummaryRevision)throw new Error('总结设置已变化');
        const preferences=assertSummaryPreferences({...summary.preferences,...Object.fromEntries(Object.entries(draft).map(([key,value])=>[key,{...summary.preferences[key],...value}]))});
        const nextSummary={...summary,revision:revision+1,preferences};
        const guard=current=>{if(isCurrent()!==true||summaryOf(current).revision!==revision)throw new Error('总结设置已变化');return true;};
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,summary:nextSummary},guard)};
      });
    },
    setSummaryExcludedFloors(target,records,{expectedSummaryRevision,isCurrent=()=>true}={}) {
      const frozen=copy(target),excludedFloors=assertExcludedFloors(records);
      return enqueue(async()=>{const root=await read(frozen),summary=summaryOf(root),revision=summary.revision;if(expectedSummaryRevision!==undefined&&revision!==expectedSummaryRevision)throw new Error('排除策略已变化');
        const guard=current=>{if(isCurrent()!==true||summaryOf(current).revision!==revision)throw new Error('排除策略已变化');return true;};
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,summary:{...summary,revision:revision+1,excludedFloors}},guard)};
      });
    },
    appendBatch(target,selection,events,batch,options={}) {
      const frozen=copy(target),snapshot=copy(selection),draft=copy(batch),candidates=copy(events);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot);const summary=summaryOf(root);
        if(summary.batches.some(item=>item.id===draft.id||item.taskId===draft.taskId))throw new Error('该总结任务已入库，不得重复提交');
        const timestamp=now(),created=batchEvents(root,candidates,draft.id,draft.actualRange);
        const record=assertBatch({...draft,ordinal:summary.progress.nextBatchOrdinal,eventIds:created.map(event=>event.id),createdAt:timestamp,completedAt:timestamp,generatedCandidates:assertGeneratedEvidence(draft.generatedCandidates)});
        if(record.sourceType==='auto'&&record.actualRange.start!==(summary.progress.lastProcessedFloor===null?summary.preferences.auto.startFloor:summary.progress.lastProcessedFloor+1))throw new Error('自动批次不从当前未完成处开始');
        const nextSummary={...consumePending(summary,options,draft,candidates),revision:summary.revision+1,batches:[...summary.batches,record],progress:{...summary.progress,lastProcessedFloor:Math.max(summary.progress.lastProcessedFloor??-1,record.actualRange.end),nextBatchOrdinal:record.ordinal+1}};
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,events:[...root.events,...created],summary:nextSummary},summaryGuard(frozen,snapshot,options)),batch:copy(record),events:copy(created)};
      });
    },
    replaceBatch(target,selection,events,batch,options={}) {
      const frozen=copy(target),snapshot=copy(selection),draft=copy(batch),candidates=copy(events);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot);const previous=snapshot.batch;if(!previous)throw new Error('替换缺少原始批快照');
        const members=root.events.filter(event=>previous.eventIds.includes(event.id));if(members.some(event=>event.supersededBy||event.mergedFrom))throw new Error('批成员参与合并，不能破坏撤销关系');
        if(!equal(draft.requestedRange,previous.requestedRange)||!equal(draft.actualRange,previous.actualRange))throw new Error('不能改变所属批原始范围');
        const created=batchEvents(root,candidates,previous.id,previous.actualRange),summary=summaryOf(root);
        const record=assertBatch({...draft,id:previous.id,ordinal:previous.ordinal,sourceType:previous.sourceType,eventIds:created.map(event=>event.id),createdAt:previous.createdAt,completedAt:now(),generatedCandidates:assertGeneratedEvidence(draft.generatedCandidates)});
        const nextSummary={...consumePending(summary,options,draft,candidates),revision:summary.revision+1,batches:summary.batches.map(item=>item.id===previous.id?record:item)};
        if(nextSummary.sourcePositions){nextSummary.sourcePositions={...nextSummary.sourcePositions};delete nextSummary.sourcePositions[previous.id];if(!Object.keys(nextSummary.sourcePositions).length)delete nextSummary.sourcePositions;}
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,events:[...root.events.filter(event=>!previous.eventIds.includes(event.id)),...created],summary:nextSummary},summaryGuard(frozen,snapshot,options)),batch:copy(record),events:copy(created)};
      });
    },
    matchesSelection(target, snapshot, { hidden = false } = {}) {
      try { requireTarget(target); matchSnapshot(assertRoot(adapter.peekConfirmed(target), target), target, snapshot, hidden); requireTarget(target); return true; }
      catch { return false; }
    },
    async captureSelection(target, ids) {
      const frozenTarget = copy(target), selected = [...selectedIds(ids, true)], root = await read(frozenTarget);
      return freeze({ target: frozenTarget, revision: root.revision, events: copy(select(root, selected)) });
    },
    async captureMerge(target, id) {
      const frozenTarget = copy(target), root = await read(frozenTarget), result = select(root, [...selectedIds([id])])[0];
      if (!result.mergedFrom) throw new Error('该记忆不是合并结果');
      return freeze({ target: frozenTarget, revision: root.revision, events: copy(select(root, [id, ...result.mergedFrom], true)) });
    },
    setModeMany(target, ids, mode) {
      const frozenTarget = copy(target), selected = selectedIds(ids);
      if (!['resident', 'trigger'].includes(mode)) throw new Error('未知的记忆模式');
      return enqueue(async () => {
        const root = await read(frozenTarget); select(root, [...selected]);
        const changed = root.events.filter(event => selected.has(event.id) && event.mode !== mode).length;
        if (!changed) return { root, changed: 0 };
        const updatedAt = now();
        const next = { ...root, revision: root.revision + 1, events: root.events.map(event => selected.has(event.id) && event.mode !== mode ? { ...event, mode, updatedAt } : event) };
        return { root: await commit(frozenTarget, root, next), changed };
      });
    },
    reconcileSummarySourceDeletion(target,deletions,{isCurrent=()=>true}={}) {
      const frozen=copy(target),evidence=copy(deletions),key=JSON.stringify([frozen,evidence.map(item=>[item.before.epoch,item.after.epoch,item.removedFloors])]);
      return enqueue(async()=>{
        const recovery=sourceDeletionReceipts.get(key);
        if(recovery){
          if(recovery.superseded)throw new Error('该来源删除操作已处理');
          const current=await read(frozen);
          if(!isCurrent())throw new Error('聊天目标已变化');
          if(equal(current.events,recovery.events)&&equal(summaryOf(current),recovery.nextSummary))return recovery.proposal;
          if(!equal(current.events,recovery.events)||!equal(summaryOf(current),recovery.previousSummary))throw new Error('来源定位保存后数据已变化，请重新查看记忆');
        }
        const root=await read(frozen),normal=new Map(),merged=new Map(),batchIds=new Set(),unresolved=new Set();let next=root;
        for(const deletion of evidence){
          const affected=affectedSummaryDeletion(next,deletion);
          for(const kind of ['normal','merged'])for(const event of affected[kind])(kind==='normal'?normal:merged).set(event.id,event);
          affected.batchIds.forEach(id=>batchIds.add(id));affected.unresolved.forEach(id=>unresolved.add(id));
          next=rebaseSummaryPositions(next,deletion);
        }
        const guard=current=>{if(!isCurrent()||!equal(summaryOf(current),summaryOf(root))||!equal(current.events,root.events))throw new Error('来源删除期间记忆已变化，请重新查看');return true;};
        guard(root);
        const candidate=equal(next,root)?root:{...next,revision:root.revision+1,summary:{...summaryOf(next),revision:summaryOf(root).revision+1}};
        const proposal=freeze({target:frozen,normal:[...normal.values()],merged:[...merged.values()],batchIds:[...batchIds],batchCount:batchIds.size,unresolved:[...unresolved],summary:summaryOf(candidate),events:copy(candidate.events),deletedMergeIds:copy(candidate.deletedMergeIds??[])});
        for(const oldKey of sourceDeletionReceipts.keys())if(oldKey!==key)sourceDeletionReceipts.set(oldKey,{superseded:true});
        sourceDeletionReceipts.set(key,{previousSummary:summaryOf(root),nextSummary:summaryOf(candidate),events:copy(root.events),proposal});
        if(candidate!==root)await commit(frozen,root,candidate,guard);
        return proposal;
      });
    },
    async refreshSummarySourceDeletion(target,proposal) {
      const frozen=copy(target),snapshot=copy(proposal);if(!sameTarget(frozen,snapshot.target))throw new Error('聊天目标已变化');
      const root=await read(frozen),rows=kind=>snapshot[kind].flatMap(previous=>{const event=root.events.find(item=>item.id===previous.id&&!item.supersededBy);return event&&!!event.mergedFrom===(kind==='merged')?[copy(event)]:[];});
      return freeze({...snapshot,normal:rows('normal'),merged:rows('merged'),summary:summaryOf(root),events:copy(root.events),deletedMergeIds:copy(root.deletedMergeIds??[])});
    },
    removeSummarySourceSelection(target,proposal,selection,{isCurrent=()=>true}={}) {
      const frozen=copy(target),snapshot=copy(proposal),choice=copy(selection);
      if(!choice||typeof choice.normal!=='boolean'||typeof choice.merged!=='boolean')throw new Error('请选择要删除的记忆类别');
      const ids=[...(choice.normal?snapshot.normal:[]),...(choice.merged?snapshot.merged:[])].map(event=>event.id),selected=selectedIds(ids,true);
      const guard=root=>{
        if(!isCurrent()||!sameTarget(frozen,snapshot.target)||!equal(root.events,snapshot.events)||!equal(summaryOf(root),snapshot.summary)||!equal(root.deletedMergeIds??[],snapshot.deletedMergeIds))throw new Error('记忆或批次已变化，未执行删除，请重新查看');
        select(root,[...selected]);return true;
      };
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);
        const deleted=select(root,[...selected]).filter(event=>event.mergedFrom).map(event=>event.id);
        const next={...root,revision:root.revision+1,events:root.events.filter(event=>!selected.has(event.id))};
        if(deleted.length)next.deletedMergeIds=[...(root.deletedMergeIds??[]),...deleted];
        return {status:'committed',root:await commit(frozen,root,next,guard),removed:selected.size};
      });
    },
    removeMany(target, ids) {
      const frozenTarget = copy(target), selected = selectedIds(ids);
      return enqueue(async () => {
        const root = await read(frozenTarget), events = select(root, [...selected]);
        const deleted = events.filter(event => event.mergedFrom).map(event => event.id);
        const next = { ...root, revision: root.revision + 1, events: root.events.filter(event => !selected.has(event.id)) };
        if (deleted.length) next.deletedMergeIds = [...(root.deletedMergeIds ?? []), ...deleted];
        return { root: await commit(frozenTarget, root, next), removed: selected.size };
      });
    },
    save(target, draft) {
      const frozenTarget = copy(target), snapshot = validateEventForSave(draft);
      return enqueue(async () => {
        const root = await read(frozenTarget), old = root.events.find(event => event.id === snapshot.id);
        if (old?.supersededBy || root.deletedMergeIds?.includes(snapshot.id)) throw new Error('该记忆已合并或删除，不能直接编辑');
        if (snapshot.supersededBy || snapshot.mergedFrom && !equal(snapshot.mergedFrom, old?.mergedFrom)) throw new Error('合并关系只能通过合并事务修改');
        const event = { ...old, ...snapshot, createdAt: old?.createdAt ?? now(), updatedAt: now(), batch: old ? old.batch : snapshot.batch };
        if (old?.mergedFrom) event.mergedFrom = copy(old.mergedFrom);
        const next = { ...root, revision: root.revision + 1, events: old ? root.events.map(item => item.id === event.id ? event : item) : [...root.events, event] };
        return { root: await commit(frozenTarget, root, next), event: copy(event) };
      });
    },
    rebuildKeywords(target, selection, results, options = {}) {
      const frozenTarget = copy(target), snapshot = copy(selection), candidate = copy(results);
      return enqueue(async () => {
        const root = await read(frozenTarget), sources = matchSnapshot(root, frozenTarget, snapshot);
        if (!Array.isArray(candidate)) throw new Error('关键词结果无效');
        const ids = [...selectedIds(candidate.map(result => result?.id), true)];
        if (ids.length !== sources.length || ids.some(id => !sources.some(event => event.id === id))) throw new Error('关键词结果必须完整覆盖所选记忆');
        const updatedAt = now(), changes = new Map(candidate.map(result => {
          if (!Object.hasOwn(result, 'eventWords') || !Object.hasOwn(result, 'detailWords')) throw new Error('关键词结果缺少完整词条');
          const old = sources.find(event => event.id === result.id);
          const event = validateEvent({ ...old, eventWords: result.eventWords, detailWords: result.detailWords, updatedAt });
          return [event.id, event];
        }));
        const next = { ...root, revision: root.revision + 1, events: root.events.map(event => changes.get(event.id) ?? event) };
        return { status: 'committed', root: await commit(frozenTarget, root, next, sourceGuard(frozenTarget, snapshot, options)), changed: sources.length };
      });
    },
    merge(target, selection, draft, options = {}) {
      const frozenTarget = copy(target), snapshot = copy(selection), candidate = copy(draft);
      return enqueue(async () => {
        const root = await read(frozenTarget), sources = matchSnapshot(root, frozenTarget, snapshot);
        if (sources.length < 2 || sources.some(event => event.mergedFrom)) throw new Error('合并至少需要两条未合并的活动记忆');
        if (!candidate || root.events.some(event => event.id === candidate.id) || root.deletedMergeIds?.includes(candidate.id) || candidate.mergedFrom != null || candidate.supersededBy != null) throw new Error('合并结果身份或关系无效');
        const timestamp = now();
        const event = validateEventForSave({ ...candidate, createdAt: timestamp, updatedAt: timestamp, batch: null,
          sources: mergeRanges(sources.flatMap(source => source.sources)),
          mode: sources.every(source => source.mode === 'resident') ? 'resident' : 'trigger', mergedFrom: sources.map(source => source.id) });
        const ids = new Set(event.mergedFrom);
        const next = { ...root, revision: root.revision + 1, events: [...root.events.map(source => ids.has(source.id) ? { ...source, supersededBy: event.id } : source), event] };
        return { status: 'committed', root: await commit(frozenTarget, root, next, sourceGuard(frozenTarget, snapshot, options)), event: copy(event) };
      });
    },
    undoMerge(target, selection, options = {}) {
      const frozenTarget = copy(target), snapshot = copy(selection);
      return enqueue(async () => {
        const root = await read(frozenTarget), sources = matchSnapshot(root, frozenTarget, snapshot, true);
        const result = sources.find(event => event.mergedFrom);
        if (!result || sources.length !== result.mergedFrom.length + 1 || sources.some(event => event.id !== result.id && !result.mergedFrom.includes(event.id))) throw new Error('撤销合并快照不完整');
        const ids = new Set(result.mergedFrom);
        const next = { ...root, revision: root.revision + 1, events: root.events.filter(event => event.id !== result.id).map(event => {
          if (!ids.has(event.id)) return event;
          const restored = { ...event }; delete restored.supersededBy; return restored;
        }) };
        return { status: 'committed', root: await commit(frozenTarget, root, next, sourceGuard(frozenTarget, snapshot, options, true)), restored: ids.size };
      });
    },
    activeEvents
  };
}
