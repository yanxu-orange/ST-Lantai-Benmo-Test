import {mergeLocationAliases} from './location-aliases.js';
import {normalizeResultSources} from './results-persistence.js';
import {rollbackNarrativeTail, invalidateNarrativeRollback} from '../narrative/rollback.js';
import {rollbackTrackingTail,invalidateTrackingTailHistory} from '../tracking/data.js';
import {narrativeOf,assertNarrative} from '../narrative/data.js';
import {trackingOf,assertTracking} from '../tracking/data.js';
import {latestOf,assertLatest,assertLatestPreferences,assertLatestRecord,migrateLatestPreferences} from '../latest/data.js';
import {storedLatestSource} from '../latest/source.js';
import {affectedSummaryDeletion,isVerifiedTailDeletion} from '../summary/source-deletion.js';
import {rebaseSummaryPositions,effectiveBatchPositions} from '../summary/source-positions.js';
import {assertChatControls,defaultChatControls} from '../controls/model.js';
import {workshopOf,assertWorkshop} from '../workshop/model.js';
import {timeOf,assertTime} from '../time/data.js';
import {importSummaryCandidates} from '../time/summary-candidates.js';
import { assertRoot, validateEvent, validateEventForSave, activeEvents } from './model.js';
import {summaryOf,assertSummaryPreferences,assertExcludedFloors,assertBatch,assertGeneratedEvidence,assertSummaryPending,publicSummarySettingsEvidence,normalizedSummarySettingsEvidence} from '../summary/data.js';
import {matchesStoredSummarySource,matchesSourceMetadata,matchesSummarySource} from '../summary/source.js';
import {matchesCumulativeSource} from '../cumulative/source.js';
import {cumulativeOf,assertCumulativePreferences,assertCumulativeExclusions,assertCumulativePending,assertCumulativeVersion,baseSnapshotOf,cumulativeCoverage,matchesCumulativeReplacementSource} from '../cumulative/data.js';
export function sameTarget(a, b) { return !!a && !!b && !!a.chatId && !!a.rootId && Number.isSafeInteger(a.epoch) && a.chatId === b.chatId && a.rootId === b.rootId && a.epoch === b.epoch; }
const copy = value => structuredClone(value);
// Normalize only the domain being compared, after the caller's currentness
// callback. Cloning authority before that callback could hide a synchronous edit.
const comparisonRoot=(root,...keys)=>({...root,...normalizeResultSources(Object.fromEntries(keys.filter(key=>Object.hasOwn(root,key)).map(key=>[key,copy(root[key])]))) });
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
  const places = [...new Set(events.flatMap(event => event.places))];
  return { people: [...new Set(events.flatMap(event => event.people))], places, ...(events.some(event => Object.hasOwn(event,'locationAliases')) ? {locationAliases:mergeLocationAliases(events,places)} : {}) };
}
export function createRepository(adapter, now = () => new Date().toISOString()) {
  let queue = Promise.resolve();
  const panelReads=new WeakMap();
  const sourceDeletionReceipts=new Map();
  const eventCommitListeners=new Set();
  const requireTarget = target => { if (!sameTarget(target, adapter.captureTarget())) throw new Error('聊天目标已变化，请返回列表重新进入'); };
  const enqueue = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const read = async (target, waitOptions) => { requireTarget(target); const root = assertRoot(await adapter.read(target, waitOptions), target); requireTarget(target); return root; };
  // One explicit display/maintenance pass may share a validated root. The
  // private proof checks exact host content, including same-revision edits.
  // No mutation method accepts this view; its read/commit path stays fresh.
  async function capturePanelData(target){
    if(!adapter.captureReadToken||!adapter.matchesReadToken)return undefined;
    const frozen=copy(target);
    let token;try{token=adapter.captureReadToken(frozen);}catch{/* Resolve uncertain persistence through the ordinary read first. */}
    let root=await read(frozen);
    if(!token){token=adapter.captureReadToken(frozen);root=await read(frozen);}
    if(!adapter.matchesReadToken(frozen,token))throw new Error('聊天资料读取期间已变化，请重新读取');
    const view=Object.freeze({target:freeze(frozen)});panelReads.set(view,{root:freeze(root),token});return view;
  }
  // The view is one fixed read snapshot, never silently advanced underneath
  // consumers that already projected an earlier domain. Awaiting coordinators
  // check its exact proof once before adoption and recapture all domains if stale.
  function readPanelRoot(target,view){
    requireTarget(target);
    const captured=panelReads.get(view);
    if(!captured||!sameTarget(view.target,target))throw new Error('聊天读取快照无效');
    return captured.root;
  }
  function matchesPanelData(target,view){
    try{requireTarget(target);const captured=panelReads.get(view);return !!captured&&sameTarget(view.target,target)&&adapter.matchesReadToken(target,captured.token);}catch{return false;}
  }
  const panelRead=(target,view)=>view===undefined?read(target):readPanelRoot(target,view);
  const commit = async (target, root, next, guard = () => true, options = {}) => {
    const check = current => { requireTarget(target); if (guard(current) !== true) throw new Error('任务已取消或来源已失效'); return true; };
    const candidate=assertRoot(next, target); check(root);
    const committed = await adapter.commit(target, candidate, root.revision, { ...options, guard: check });
    requireTarget(target);
    const saved=assertRoot(committed,target);
    if(eventCommitListeners.size&&!equal(root.events,saved.events)){
      const notice=freeze({target:copy(target),before:copy(root.events),events:copy(saved.events)});
      queueMicrotask(()=>{for(const listener of [...eventCommitListeners])try{Promise.resolve(listener(notice)).catch(()=>{});}catch{/* Derived maintenance cannot turn confirmed memory saves into failures. */}});
    }
    return saved;
  };
  const sourceGuard = (target, snapshot, options, hidden = false) => current => {
    if ((options.isCurrent ?? (() => true))() !== true) throw new Error('任务已取消或来源已失效');
    matchSnapshot(current, target, snapshot, hidden);
    return true;
  };
  const taskDomain=value=>{const {revision,preferences,excludedFloors,...evidence}=value;return evidence;};
  const matchSummary=(root,target,snapshot,task=false)=>{
    root=comparisonRoot(root,'summary');
    if(!snapshot||!sameTarget(target,snapshot.target)||!equal(task?taskDomain(summaryOf(root)):summaryOf(root),task?taskDomain(snapshot.summary):snapshot.summary))throw new Error('总结参数或批历史已变化');
    if(snapshot.batch){const batch=summaryOf(root).batches.find(item=>item.id===snapshot.batch.id);if(!equal(batch,snapshot.batch)||!equal(root.events.filter(event=>batch.eventIds.includes(event.id)),snapshot.events))throw new Error('所属批成员已变化');}
  };
  const summaryGuard=(target,snapshot,options)=>current=>{if(typeof options.isCurrent!=='function'||options.isCurrent()!==true)throw new Error('总结来源或配置已失效');matchSummary(current,target,snapshot,options.executionSnapshot===true);if(options.trackingUpdate&&trackingOf(comparisonRoot(current,'tracking')).revision!==options.trackingUpdate.expectedRevision)throw new Error('同步追踪资料已变化，请重新总结');return true;};
  const summaryTracking=(root,options)=>{if(!options.trackingUpdate)return {};const current=trackingOf(root),update=options.trackingUpdate;if(current.revision!==update.expectedRevision)throw new Error('同步追踪资料已变化，请重新总结');const tracking=assertTracking(update.value);if(equal(current,tracking))return {};if(tracking.revision<current.revision||tracking.revision>current.revision+1)throw new Error('同步追踪版本无效');return {tracking};};
  const summaryTime=(root,batch)=>{const current=timeOf(root),next=importSummaryCandidates(current,[batch]);return equal(current,next)?{}:{time:{...next,revision:current.revision+1}};};
  const consumePending=(summary,options,draft,candidates)=>{
    if(summary.pending){const pending=summary.pending;
      if(options.pendingId!==pending.id||draft.id!==pending.batchId||draft.sourceType!==pending.origin||draft.generationMode!==pending.generationMode||draft.hideOriginal!==pending.params.hideOriginal||!equal(draft.generatedCandidates,pending.generatedCandidates)||!equal(normalizedSummarySettingsEvidence(draft.settingsEvidence),normalizedSummarySettingsEvidence(pending.settingsEvidence))||!equal(draft.requestedRange,pending.sourceSnapshot.requestedRange)||!equal(draft.actualRange,pending.sourceSnapshot.actualRange)||draft.sourceSnapshot?.includeUser!==pending.sourceSnapshot.includeUser||!equal(draft.sourceSnapshot?.excludedFloors,pending.sourceSnapshot.excludedFloors)||!matchesStoredSummarySource(pending.sourceSnapshot,{epoch:draft.sourceSnapshot?.epoch,messages:draft.sourceSnapshot?.rawMessages})||candidates.some(event=>!pending.events.some(previous=>previous.id===event.id)))throw new Error('待审核草稿身份或证据不符，不得覆盖');}
    else if(options.pendingId!==undefined)throw new Error('待审核草稿已变化');
    const result={...summary};delete result.pending;return result;
  };
  const batchEvents=(root,events,id,actualRange)=>{
    if(!Array.isArray(events)||!events.length)throw new Error('至少保留一条事件切片');
    const ids=new Set(),timestamp=now();
    return events.map(candidate=>{if(ids.has(candidate?.id)||root.events.some(event=>event.id===candidate?.id)||root.deletedMergeIds?.includes(candidate?.id)||candidate?.mergedFrom!=null||candidate?.supersededBy!=null)throw new Error('生成切片身份或关系无效');ids.add(candidate.id);return validateEventForSave({...copy(candidate),createdAt:timestamp,updatedAt:timestamp,sources:[copy(actualRange)],batch:{id,sources:[copy(actualRange)]}});});
  };
  const captureCumulativeRoot=(target,root)=>freeze({target:copy(target),cumulative:cumulativeOf(root)});
  const matchCumulative=(root,target,snapshot,task=false)=>{
    root=comparisonRoot(root,'cumulative');
    if(!snapshot||!sameTarget(target,snapshot.target)||!equal(task?taskDomain(cumulativeOf(root)):cumulativeOf(root),task?taskDomain(snapshot.cumulative):snapshot.cumulative))throw new Error('古法基版、配置或进度已变化');
  };
  const cumulativeGuard=(target,snapshot,options,required=false,task=false)=>current=>{
    if(required&&typeof options.isCurrent!=='function'||(options.isCurrent??(()=>true))()!==true)throw new Error('古法来源或配置已失效');
    matchCumulative(current,target,snapshot,task);if(options.trackingUpdate&&trackingOf(comparisonRoot(current,'tracking')).revision!==options.trackingUpdate.expectedRevision)throw new Error('同步追踪资料已变化，请重新总结');return true;
  };
  const cumulativeMutation=(target,selection,options,change,required=false,allowTask=required)=>{
    const task=allowTask&&options.executionSnapshot===true;
    const frozen=copy(target),snapshot=copy(selection);
    return enqueue(async()=>{const root=await read(frozen);matchCumulative(root,frozen,snapshot,task);const domain=cumulativeOf(root),guard=cumulativeGuard(frozen,snapshot,options,required,task);guard(root);
      const changed=change(domain);if(!changed)return {status:'unchanged',root,selection:captureCumulativeRoot(frozen,root)};
      const next={...root,revision:root.revision+1,cumulative:{...changed,revision:domain.revision+1},...summaryTracking(root,options)};
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
    // Host adapters guard against the raw stored root. Compare the same
    // normalized read view as the captured selection, including old defaults.
    const guard=root=>{
      requireTarget(frozen);
      if((options.isCurrent??(()=>true))()!==true||!snapshot||!sameTarget(frozen,snapshot.target))throw new Error('最新摘要来源或配置已变化');
      const current=latestOf(comparisonRoot(root,'latest'));current.preferences=migrateLatestPreferences(current.preferences);
      if(!equal(current,snapshot.latest))throw new Error('最新摘要来源或配置已变化');return true;
    };
    return enqueue(async()=>{
      const root=await read(frozen);guard(root);const current=latestOf(root),candidate=assertLatest(change(copy(current))),nextLatest={...candidate,revision:current.revision};
      if(!options.forceSave&&equal(current,nextLatest))return {status:'unchanged',root,selection:freeze({target:frozen,latest:current})};
      nextLatest.revision++;
      const saved=await commit(frozen,root,{...root,revision:root.revision+1,latest:nextLatest},guard,{workshopProof:options.workshopProof,requireConfirmation:options.requireConfirmation??false});
      return {status:'committed',root:saved,selection:freeze({target:frozen,latest:latestOf(saved)})};
    });
  };
  return {
    subscribeEventCommits(listener){if(typeof listener!=='function')throw new TypeError('成果监听无效');eventCommitListeners.add(listener);return()=>eventCommitListeners.delete(listener);},
    capturePanelData,readPanelRoot,matchesPanelData,
    async captureNarrative(target,readView){const frozen=copy(target);return freeze({target:frozen,narrative:narrativeOf(await panelRead(frozen,readView))});},
    matchesNarrative(target,selection){try{requireTarget(target);const root=assertRoot(adapter.peekConfirmed(target),target);return !!selection&&sameTarget(target,selection.target)&&equal(narrativeOf(root),selection.narrative);}catch{return false;}},
    updateNarrative(target,selection,value,{isCurrent=()=>true,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertNarrative(value);
      const guard=root=>{requireTarget(frozen);if(!isCurrent()||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(narrativeOf(comparisonRoot(root,'narrative')),snapshot.narrative))throw new Error('自述或大纲资料已变化，请重新读取');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=narrativeOf(root),next={...candidate,revision:current.revision};
        if(equal(current,next))return {status:'unchanged',root,selection:freeze({target:frozen,narrative:current})};
        next.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,narrative:next},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,narrative:narrativeOf(saved)})};
      });
    },
    matchesTrackingRevision(target,revision){try{requireTarget(target);return trackingOf(assertRoot(adapter.peekConfirmed(target),target)).revision===revision;}catch{return false;}},
    async captureTracking(target,readView){const frozen=copy(target);return freeze({target:frozen,tracking:trackingOf(await panelRead(frozen,readView))});},
    updateTracking(target,selection,value,{isCurrent=()=>true,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertTracking(value);
      const guard=root=>{requireTarget(frozen);if(!isCurrent()||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(trackingOf(comparisonRoot(root,'tracking')),snapshot.tracking))throw new Error('追踪来源或资料已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=trackingOf(root),next={...candidate,revision:current.revision};
        if(equal(current,next))return {status:'unchanged',root,selection:freeze({target:frozen,tracking:current})};
        next.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,tracking:next},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,tracking:trackingOf(saved)})};
      });
    },
    async captureLatest(target,readView){const frozen=copy(target),root=await panelRead(frozen,readView);return freeze({target:frozen,latest:latestOf(root)});},
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
    async captureTime(target,readView){const frozen=copy(target),root=await panelRead(frozen,readView);return freeze({target:frozen,time:timeOf(root)});},
    updateTime(target,selection,value,{isCurrent=()=>true,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertTime(value);
      const guard=root=>{requireTarget(frozen);if(isCurrent()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(timeOf(root),snapshot.time))throw new Error('时间来源或配置已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=timeOf(root);
        const nextTime={...candidate,revision:current.revision};
        if(equal(current,nextTime))return {status:'unchanged',root,selection:freeze({target:frozen,time:current})};
        nextTime.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,time:nextTime},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,time:timeOf(saved)})};
      });
    },
    // Merge at the queued read boundary, so unrelated time progress and edits
    // are not replaced by a request's old whole-domain snapshot.
    updateSchedule(target,{apply,isCurrent=()=>true,requireConfirmation=true}={}){
      if(typeof apply!=='function')throw new Error('日程保存缺少更新函数');
      const frozen=copy(target);
      return enqueue(async()=>{
        const root=await read(frozen),current=timeOf(root);
        if(isCurrent()!==true)throw new Error('日程任务已取消或来源已失效');
        const applied=apply(copy(current)),candidate=assertTime(applied?.time??applied),nextTime={...candidate,revision:current.revision};
        if(equal(current,nextTime))return {status:'unchanged',root,selection:freeze({target:frozen,time:current}),...(applied?.receipt?{receipt:copy(applied.receipt)}:{})};
        nextTime.revision++;
        // The adapter may delay before actually writing. Re-run the pure guard
        // against authority; generated IDs are allocated only once.
        const guard=stored=>{requireTarget(frozen);if(isCurrent()!==true)throw new Error('日程任务已取消或来源已失效');const latest=timeOf(stored);if(typeof applied?.validate==='function'){if(applied.validate(latest)!==true)throw new Error('日程资料已变化，请重新读取');}else if(!equal(latest,current))throw new Error('日程资料已变化，请重新读取');return true;};
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,time:nextTime},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,time:timeOf(saved)}),...(applied?.receipt?{receipt:copy(applied.receipt)}:{})};
      });
    },
    updateTimeDate(target,selection,value,{isCurrent=()=>true,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertTime(value),fields=['calendars','activeCalendarId','recognition','chronology','manualAnchor','currentDate'];
      const relevant=time=>Object.fromEntries(fields.map(key=>[key,time[key]]));
      const guard=root=>{requireTarget(frozen);if(isCurrent()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(relevant(timeOf(root)),relevant(snapshot.time)))throw new Error('故事日期来源或配置已变化');return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=timeOf(root),nextTime={...current,currentDate:copy(candidate.currentDate),manualAnchor:copy(candidate.manualAnchor)};
        if(equal(current,nextTime))return {status:'unchanged',root,selection:freeze({target:frozen,time:current})};
        nextTime.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,time:nextTime},guard,{requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,time:timeOf(saved)})};
      });
    },
    hasSummaryTimeCandidateChanges(target,view){
      // A no-work decision is only valid for this exact confirmed read. It
      // never supplies the baseline of a later mutation or waits on the queue.
      if(!matchesPanelData(target,view))return null;
      const root=readPanelRoot(target,view),current=timeOf(root),next=importSummaryCandidates(current,summaryOf(root).batches);
      return matchesPanelData(target,view)?!equal(current,next):null;
    },
    importSummaryTimeCandidates(target,{isCurrent=()=>true}={}){
      const frozen=copy(target);
      return enqueue(async()=>{
        const root=await read(frozen),current=timeOf(root),batches=summaryOf(root).batches,nextTime=importSummaryCandidates(current,batches);
        const guard=stored=>{requireTarget(frozen);if(isCurrent()!==true||!equal(timeOf(stored),current)||!equal(summaryOf(comparisonRoot(stored,'summary')).batches,batches))throw new Error('纪念日补录来源已变化');return true;};guard(root);
        if(equal(current,nextTime))return {status:'unchanged',root,selection:freeze({target:frozen,time:current})};
        nextTime.revision=current.revision+1;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,time:nextTime},guard,{requireConfirmation:true});
        return {status:'committed',root:saved,selection:freeze({target:frozen,time:timeOf(saved)})};
      });
    },
    async captureWorkshop(target,readView){const frozen=copy(target);return freeze({target:frozen,workshop:workshopOf(await panelRead(frozen,readView))});},
    updateWorkshop(target,selection,value,{isCurrent=()=>true,workshopProof,forceSave=false,requireConfirmation=false}={}){
      const frozen=copy(target),snapshot=copy(selection),candidate=assertWorkshop(value);
      const guard=root=>{requireTarget(frozen);if(isCurrent()!==true||!snapshot||!sameTarget(frozen,snapshot.target)||!equal(workshopOf(comparisonRoot(root,'workshop')),snapshot.workshop))throw Object.assign(new Error('工坊来源或配置已变化'),{code:'WORKSHOP_CONFLICT'});return true;};
      return enqueue(async()=>{
        const root=await read(frozen);guard(root);const current=workshopOf(root);
        const nextWorkshop={...candidate,revision:current.revision};
        if(!forceSave&&equal(current,nextWorkshop))return {status:'unchanged',root,selection:freeze({target:frozen,workshop:current})};
        nextWorkshop.revision++;
        const saved=await commit(frozen,root,{...root,revision:root.revision+1,workshop:nextWorkshop},guard,{workshopProof,requireConfirmation});
        return {status:'committed',root:saved,selection:freeze({target:frozen,workshop:workshopOf(saved)})};
      });
    },
    async waitForPendingWrite(target, options) { requireTarget(target); if(!adapter.waitForPendingWrite)throw Object.assign(new Error('保存结果尚未确认'),{code:'COMMIT_UNCONFIRMED'}); await adapter.waitForPendingWrite(target,options); requireTarget(target); },
    captureTarget: () => { const target = adapter.captureTarget(); requireTarget(target); return copy(target); },
    read,
    captureCumulativeTask(target){requireTarget(target);const root=assertRoot(adapter.peekConfirmed(target),target);return captureCumulativeRoot(target,root);},
    matchesCumulativeTask(target,snapshot){try{requireTarget(target);matchCumulative(assertRoot(adapter.peekConfirmed(target),target),target,snapshot,true);requireTarget(target);return true;}catch{return false;}},
    matchesCumulativeTaskProof(target,snapshot,source,trackingRevision){
      if(typeof adapter.matchesSummaryTaskProof!=='function')return undefined;
      try{requireTarget(target);return adapter.matchesSummaryTaskProof(target,(root,raw)=>{matchCumulative(root,target,snapshot,true);return (trackingRevision===undefined||trackingOf(comparisonRoot(root,'tracking')).revision===trackingRevision)&&matchesCumulativeSource(source,raw);});}catch{return false;}
    },
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
      return cumulativeMutation(target,selection,options,domain=>{if(!domain.pending)return null;const next={...domain};delete next.pending;return next;},false,true);
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
        if(!previous||draft.id!==previous.id||domain.versions.slice(0,-1).some(item=>item.taskId===draft.taskId)||!equal(draft.baseSnapshot,previous.baseSnapshot)||!matchesCumulativeReplacementSource(previous,draft)||!equal(draft.coverageRanges,cumulativeCoverage([...(domain.versions.at(-2)?.coverageRanges??[]),draft.sourceSnapshot.requestedRange])))throw new Error('古法再生成必须保留冻结基版和原始来源');
        if(!domain.pending||domain.pending.operation!=='replace')throw new Error('古法再生成须明确审核采用');
        const record={...draft,createdAt:previous.createdAt,updatedAt:now()};
        return {...consumeCumulativePending(domain,draft,'replace',options),versions:[...domain.versions.slice(0,-1),record],progress:{lastProcessedFloor:Math.max(...record.coverageRanges.map(range=>range.end))}};
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
    captureSummaryTask(target,batchId){requireTarget(target);const root=assertRoot(adapter.peekConfirmed(target),target),summary=summaryOf(root),base={target:copy(target),revision:root.revision,summary};if(batchId!==undefined){const batch=summary.batches.find(item=>item.id===batchId);if(!batch)throw new Error('没有可确认的独立批记录');Object.assign(base,{batch:copy(batch),events:copy(root.events.filter(event=>batch.eventIds.includes(event.id)))});}return freeze(base);},
    matchesSummaryTask(target,snapshot){try{requireTarget(target);matchSummary(assertRoot(adapter.peekConfirmed(target),target),target,snapshot,true);requireTarget(target);return true;}catch{return false;}},
    matchesSummaryTaskProof(target,snapshot,source,trackingRevision){
      if(typeof adapter.matchesSummaryTaskProof!=='function')return undefined;
      try{requireTarget(target);return adapter.matchesSummaryTaskProof(target,(root,raw)=>{matchSummary(root,target,snapshot,true);return (trackingRevision===undefined||trackingOf(comparisonRoot(root,'tracking')).revision===trackingRevision)&&matchesSummarySource(source,raw);});}catch{return false;}
    },
    async captureSummaryView(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,revision:root.revision,summary:summaryOf(root),formalIds:root.events.map(event=>event.id)});},
    async captureSummary(target){const frozen=copy(target),root=await read(frozen);return freeze({target:frozen,revision:root.revision,summary:summaryOf(root)});},
    async captureBatch(target,id){const frozen=copy(target),root=await read(frozen),summary=summaryOf(root),batch=summary.batches.find(item=>item.id===id);if(!batch)throw new Error('没有可确认的独立批记录');return freeze({target:frozen,revision:root.revision,summary,batch:copy(batch),events:copy(root.events.filter(event=>batch.eventIds.includes(event.id)))});},
    matchesSummary(target,snapshot){try{requireTarget(target);matchSummary(assertRoot(adapter.peekConfirmed(target),target),target,snapshot);requireTarget(target);return true;}catch{return false;}},
    saveSummaryPending(target,selection,pending,options={}) {
      const frozen=copy(target),snapshot=copy(selection),draft=assertSummaryPending(pending);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot,options.executionSnapshot===true);const summary=summaryOf(root);
        if(summary.pending){const previous=summary.pending;if(previous.id!==draft.id||previous.batchId!==draft.batchId||previous.createdAt!==draft.createdAt||previous.origin!==draft.origin||previous.generationMode!==draft.generationMode||!equal(previous.params,draft.params)||!equal(previous.tracking,draft.tracking)||!equal(previous.generatedCandidates,draft.generatedCandidates)||!equal(previous.sourceSnapshot.excludedFloors,draft.sourceSnapshot.excludedFloors)||!equal(previous.settingsEvidence,draft.settingsEvidence)||!equal(previous.sourceSnapshot.requestedRange,draft.sourceSnapshot.requestedRange)||!equal(previous.sourceSnapshot.actualRange,draft.sourceSnapshot.actualRange)||!matchesStoredSummarySource(previous.sourceSnapshot,{epoch:draft.sourceSnapshot.epoch,messages:draft.sourceSnapshot.rawMessages})||previous.completedStages.length>draft.completedStages.length||draft.events.some(event=>!previous.events.some(item=>item.id===event.id)))throw new Error('已有其他、变化或更新阶段待审核草稿');}
        const nextSummary={...summary,revision:summary.revision+1,pending:draft};
        const committed=await commit(frozen,root,{...root,revision:root.revision+1,summary:nextSummary},summaryGuard(frozen,snapshot,options));
        return {status:'committed',root:committed,selection:freeze({target:copy(frozen),revision:committed.revision,summary:summaryOf(committed)})};
      });
    },
    clearSummaryPending(target,selection,options={}) {
      const frozen=copy(target),snapshot=copy(selection);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot,options.executionSnapshot===true);const summary=summaryOf(root);
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
        const guard=current=>{if(isCurrent()!==true||summaryOf(comparisonRoot(current,'summary')).revision!==revision)throw new Error('总结设置已变化');return true;};
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,summary:nextSummary},guard)};
      });
    },
    setSummaryExcludedFloors(target,records,{expectedSummaryRevision,isCurrent=()=>true}={}) {
      const frozen=copy(target),excludedFloors=assertExcludedFloors(records);
      return enqueue(async()=>{const root=await read(frozen),summary=summaryOf(root),revision=summary.revision;if(expectedSummaryRevision!==undefined&&revision!==expectedSummaryRevision)throw new Error('排除策略已变化');
        const guard=current=>{if(isCurrent()!==true||summaryOf(comparisonRoot(current,'summary')).revision!==revision)throw new Error('排除策略已变化');return true;};
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,summary:{...summary,revision:revision+1,excludedFloors}},guard)};
      });
    },
    appendBatch(target,selection,events,batch,options={}) {
      const frozen=copy(target),snapshot=copy(selection),draft=copy(batch),candidates=copy(events);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot,options.executionSnapshot===true);const summary=summaryOf(root);
        if(summary.batches.some(item=>item.id===draft.id||item.taskId===draft.taskId))throw new Error('该总结任务已入库，不得重复提交');
        const timestamp=now(),created=batchEvents(root,candidates,draft.id,draft.actualRange);
        const record=assertBatch({...draft,ordinal:summary.progress.nextBatchOrdinal,eventIds:created.map(event=>event.id),createdAt:timestamp,completedAt:timestamp,generatedCandidates:assertGeneratedEvidence(draft.generatedCandidates)});
        if(record.sourceType==='auto'&&record.actualRange.start!==(summary.progress.lastProcessedFloor===null?(options.executionSnapshot===true?snapshot.summary.preferences.auto.startFloor:summary.preferences.auto.startFloor):summary.progress.lastProcessedFloor+1))throw new Error('自动批次不从当前未完成处开始');
        const nextSummary={...consumePending(summary,options,draft,candidates),revision:summary.revision+1,batches:[...summary.batches,record],progress:{...summary.progress,lastProcessedFloor:Math.max(summary.progress.lastProcessedFloor??-1,record.actualRange.end),nextBatchOrdinal:record.ordinal+1}};
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,events:[...root.events,...created],summary:nextSummary,...summaryTracking(root,options),...summaryTime(root,record)},summaryGuard(frozen,snapshot,options),{requireConfirmation:true}),batch:copy(record),events:copy(created)};
      });
    },
    replaceBatch(target,selection,events,batch,options={}) {
      const frozen=copy(target),snapshot=copy(selection),draft=copy(batch),candidates=copy(events);
      return enqueue(async()=>{const root=await read(frozen);matchSummary(root,frozen,snapshot,options.executionSnapshot===true);const previous=snapshot.batch;if(!previous)throw new Error('替换缺少原始批快照');
        const members=root.events.filter(event=>previous.eventIds.includes(event.id));if(members.some(event=>event.supersededBy||event.mergedFrom))throw new Error('批成员参与合并，不能破坏撤销关系');
        if(!equal(draft.requestedRange,previous.requestedRange)||!equal(draft.actualRange,previous.actualRange))throw new Error('不能改变所属批原始范围');
        const created=batchEvents(root,candidates,previous.id,previous.actualRange),summary=summaryOf(root);
        const record=assertBatch({...draft,id:previous.id,ordinal:previous.ordinal,sourceType:previous.sourceType,eventIds:created.map(event=>event.id),createdAt:previous.createdAt,completedAt:now(),generatedCandidates:assertGeneratedEvidence(draft.generatedCandidates)});
        const nextSummary={...consumePending(summary,options,draft,candidates),revision:summary.revision+1,batches:summary.batches.map(item=>item.id===previous.id?record:item)};
        if(nextSummary.sourcePositions){nextSummary.sourcePositions={...nextSummary.sourcePositions};delete nextSummary.sourcePositions[previous.id];if(!Object.keys(nextSummary.sourcePositions).length)delete nextSummary.sourcePositions;}
        return {status:'committed',root:await commit(frozen,root,{...root,revision:root.revision+1,events:[...root.events.filter(event=>!previous.eventIds.includes(event.id)),...created],summary:nextSummary,...summaryTracking(root,options),...summaryTime(root,record)},summaryGuard(frozen,snapshot,options),{requireConfirmation:true}),batch:copy(record),events:copy(created)};
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
      // Receipts cover every changed domain, including merge tombstones. An
      // unknown successful save can be adopted without deleting or undoing twice.
      const receipt=raw=>{const root=comparisonRoot(raw,'summary','narrative','tracking');return {summary:summaryOf(root),events:copy(root.events),deletedMergeIds:copy(root.deletedMergeIds??[]),narrative:root.narrative===undefined?undefined:assertNarrative(root.narrative),tracking:root.tracking===undefined?undefined:assertTracking(root.tracking)};};
      return enqueue(async()=>{
        const recovery=sourceDeletionReceipts.get(key);
        if(recovery){
          if(recovery.superseded)throw new Error('该来源删除操作已处理');
          const current=await read(frozen);
          if(!isCurrent())throw new Error('聊天目标已变化');
          const confirmed=receipt(current);
          if(equal(confirmed,recovery.next))return recovery.proposal;
          if(!equal(confirmed,recovery.previous))throw new Error('来源定位保存后数据已变化，请重新查看记忆');
        }
        const root=await read(frozen),normal=new Map(),merged=new Map(),batchIds=new Set(),unresolved=new Set(),rollbackOutcomes=[],retractedBatchIds=new Set(),removedIds=new Set(),clearedPendingIds=new Set(),restoredIds=new Set();let next=root;
        for(const deletion of evidence){
          const affected=affectedSummaryDeletion(next,deletion),tail=isVerifiedTailDeletion(deletion);
          affected.batchIds.forEach(id=>batchIds.add(id));affected.unresolved.forEach(id=>unresolved.add(id));
          // Only the independently verified non-tail path opens the existing
          // review dialog. Tail outcomes are withdrawn in this root candidate.
          if(!tail)for(const kind of ['normal','merged'])for(const event of affected[kind])(kind==='normal'?normal:merged).set(event.id,event);
          next=rebaseSummaryPositions(next,deletion);
          if(tail){
            const pending=next.summary?.pending;
            if(pending){
              const removed=new Set(deletion.removedFloors),before=new Map(deletion.before.messages.map(row=>[row.floor,row]));
              const deleted=pending.sourceSnapshot.rawMessages.filter(row=>removed.has(row.floor));
              if(deleted.some(row=>before.get(row.floor)?.identity===row.identity)){
                const summary={...next.summary};delete summary.pending;next={...next,summary};clearedPendingIds.add(pending.id);
              }else if(deleted.length)unresolved.add(`pending:${pending.id}`);
            }
            if(affected.batchIds.length){
              const selected=new Set([...affected.normal,...affected.merged].map(event=>event.id)),merges=new Set(affected.merged.map(event=>event.id)),retracted=new Set(affected.batchIds);
              const members=new Set(next.summary.batches.filter(batch=>retracted.has(batch.id)).flatMap(batch=>batch.eventIds));
              selected.forEach(id=>removedIds.add(id));retracted.forEach(id=>retractedBatchIds.add(id));
              // The root validator proves complete merge ownership. Reuse undo
              // semantics, restoring unaffected originals rather than keeping a
              // contaminated result or trying to edit its generated prose.
              next={...next,events:next.events.flatMap(event=>{
                if(selected.has(event.id)||members.has(event.id)&&(!event.supersededBy||merges.has(event.supersededBy)))return [];
                if(merges.has(event.supersededBy)){const restored={...event};delete restored.supersededBy;restoredIds.add(event.id);return [restored];}
                // A previously deleted merge has no result to undo. Its hidden
                // originals remain hidden; never reverse a user's earlier delete.
                if(members.has(event.id)&&event.supersededBy)unresolved.add(`deleted-merge:${event.supersededBy}`);
                return [event];
              })};
              const summary=summaryOf(next),batches=summary.batches.filter(batch=>!retracted.has(batch.id)),sourcePositions=Object.fromEntries(Object.entries(summary.sourcePositions??{}).filter(([id])=>!retracted.has(id)));
              let lastProcessedFloor=null;
              for(const batch of batches){
                const positions=effectiveBatchPositions(batch,summary).filter((_,index)=>batch.sourceSnapshot.rawMessages[index].floor<=batch.actualRange.end);
                if(positions.length&&positions.every((position,index)=>position!==null&&(!index||position.floor===positions[index-1].floor+1)))lastProcessedFloor=Math.max(lastProcessedFloor??-1,positions.at(-1).floor);
              }
              const nextSummary={...summary,batches,progress:{...summary.progress,lastProcessedFloor}};
              delete nextSummary.sourcePositions;if(Object.keys(sourcePositions).length)nextSummary.sourcePositions=sourcePositions;
              next={...next,summary:nextSummary};
            }
            if(next.narrative){const result=rollbackNarrativeTail(next.narrative,deletion);next={...next,narrative:assertNarrative(result.domain)};rollbackOutcomes.push(...result.outcomes);}
            if(next.tracking){const result=rollbackTrackingTail(next.tracking,deletion.before,deletion.after);next={...next,tracking:assertTracking(result.tracking)};if(result.rolledBack)rollbackOutcomes.push({kind:'tracking',status:'restored'});if(result.unavailable)rollbackOutcomes.push({kind:'tracking',status:'unavailable',rebuildFrom:result.fromFloor??0,error:`追踪历史不足，无法回退；请从第 ${result.fromFloor??0} 楼重新生成`});}
          }else{if(next.narrative?.rollback)next={...next,narrative:invalidateNarrativeRollback(copy(next.narrative))};if(next.tracking?.tailHistory)next={...next,tracking:invalidateTrackingTailHistory(next.tracking)};}
        }
        const previous=receipt(root),guard=current=>{if(!isCurrent()||!equal(receipt(current),previous))throw new Error('来源删除期间记忆已变化，请重新查看');return true;};
        guard(root);
        const candidate=equal(next,root)?root:assertRoot({...next,revision:root.revision+1,...(!equal(next.summary,root.summary)?{summary:{...summaryOf(next),revision:summaryOf(root).revision+1}}:{})},frozen);
        const remaining=rows=>[...rows.values()].filter(event=>candidate.events.some(current=>current.id===event.id&&!current.supersededBy));
        const proposal=freeze({target:frozen,rollbackApplied:rollbackOutcomes.length>0||retractedBatchIds.size>0||clearedPendingIds.size>0,rollbackOutcomes,clearedPendingIds:[...clearedPendingIds],restoredIds:[...restoredIds].filter(id=>candidate.events.some(event=>event.id===id&&!event.supersededBy)),removed:removedIds.size,retractedBatchIds:[...retractedBatchIds],normal:remaining(normal),merged:remaining(merged),batchIds:[...batchIds],batchCount:batchIds.size,unresolved:[...unresolved],summary:summaryOf(candidate),events:copy(candidate.events),deletedMergeIds:copy(candidate.deletedMergeIds??[])});
        for(const oldKey of sourceDeletionReceipts.keys())if(oldKey!==key)sourceDeletionReceipts.set(oldKey,{superseded:true});
        sourceDeletionReceipts.set(key,{previous,next:receipt(candidate),proposal});
        if(candidate!==root)await commit(frozen,root,candidate,guard,{requireConfirmation:true});
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
        if(!isCurrent()||!sameTarget(frozen,snapshot.target)||!equal(root.events,snapshot.events)||!equal(summaryOf(comparisonRoot(root,'summary')),snapshot.summary)||!equal(root.deletedMergeIds??[],snapshot.deletedMergeIds))throw new Error('记忆或批次已变化，未执行删除，请重新查看');
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
