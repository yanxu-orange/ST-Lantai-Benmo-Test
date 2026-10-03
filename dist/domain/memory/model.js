import {emptySummary,assertSummary,summaryOf} from '../summary/data.js';
const clone = value => structuredClone(value);
export const SCHEMA = 1;
export function emptyRoot(rootId) { return { schema: SCHEMA, rootId, revision: 0, events: [], summary:emptySummary() }; }
export function blankEvent(id = crypto.randomUUID()) {
  return { id, createdAt: null, updatedAt: null, mode: 'trigger', title: '', body: '', startTime: '', endTime: '', sources: [], people: [], places: [], eventWords: [], detailWords: [], batch: null };
}
export function splitWords(value) { return [...new Set(String(value).split(/[,，]/u).map(word => word.trim()).filter(Boolean))]; }
export function detailWordError(term, terms) {
  if(typeof term.word!=='string'||!term.word.trim())return '细节词不能为空';
  if(terms.filter(other=>typeof other.word==='string'&&other.word.trim()===term.word.trim()).length>1)return '细节词重复';
  if(!Array.isArray(term.aliases))return '简称无效';
  if(new Set(term.aliases).size!==term.aliases.length)return '同一细节词的简称不能重复';
  if(term.aliases.some(alias=>typeof alias!=='string'||! /^[\p{Script=Han}0-9]+$/u.test(alias)||alias===term.word||!term.word.includes(alias)))return '简称须为细节词中的连续汉字或数字片段，且不能等于完整细节词';
  return '';
}
export function validateEvent(event) {
  if (!event || typeof event.id !== 'string' || !event.id || !['resident', 'trigger'].includes(event.mode)) throw new Error('记忆身份或召回方式无效');
  for (const key of ['title','body','startTime','endTime']) if (typeof event[key] !== 'string') throw new Error('记忆字段无效');
  if (!event.body.trim()) throw new Error('请填写正文');
  if (!Array.isArray(event.sources) || !event.sources.every(validRange)) throw new Error('来源楼层须为完整的非负整数区间，起点不能晚于终点');
  for (const key of ['people','places','eventWords']) if (!Array.isArray(event[key]) || event[key].some(word => typeof word !== 'string' || !word.trim())) throw new Error('词条不能为空');
  if (!Array.isArray(event.detailWords)) throw new Error('细节词无效');
  const ids = new Set();
  for (const term of event.detailWords) {
    if (!term || typeof term.id !== 'string' || !term.id || ids.has(term.id)) throw new Error('细节词身份无效');
    ids.add(term.id);
    const error=detailWordError(term,event.detailWords);if(error)throw new Error(error);
  }
  if (event.supersededBy != null && (typeof event.supersededBy !== 'string' || !event.supersededBy.trim() || event.supersededBy === event.id)) throw new Error('合并来源关系无效');
  if (event.mergedFrom != null && (!Array.isArray(event.mergedFrom) || event.mergedFrom.length < 2 || new Set(event.mergedFrom).size !== event.mergedFrom.length || event.mergedFrom.some(id => typeof id !== 'string' || !id.trim() || id === event.id) || event.supersededBy)) throw new Error('合并结果关系无效');
  if (event.mergedFrom && event.batch !== null) throw new Error('合并结果不能属于总结批次');
  return clone(event);
}
// Hidden originals remain hidden even after an explicitly deleted merge result.
export const activeEvents = events => events.filter(event => !event.supersededBy);
export function assertMergeRelations(events, deletedMergeIds = []) {
  if (!Array.isArray(deletedMergeIds) || new Set(deletedMergeIds).size !== deletedMergeIds.length || deletedMergeIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('合并删除证明无效');
  const byId = new Map(events.map(event => [event.id, event])), deleted = new Set(deletedMergeIds);
  for (const id of deleted) if (byId.has(id) || events.filter(event => event.supersededBy === id).length < 2) throw new Error('合并删除证明与来源不一致');
  for (const event of events) {
    if (event.mergedFrom) {
      for (const id of event.mergedFrom) {
        const source = byId.get(id);
        if (!source || source.mergedFrom || source.supersededBy !== event.id) throw new Error('合并来源关系已变化');
      }
    }
    if (event.supersededBy) {
      const result = byId.get(event.supersededBy);
      if (result ? !result.mergedFrom?.includes(event.id) : !deleted.has(event.supersededBy)) throw new Error('合并来源缺少有效结果或删除证明');
    }
  }
}
export function validRange(range) { return range && Number.isSafeInteger(range.start) && range.start >= 0 && Number.isSafeInteger(range.end) && range.end >= range.start; }
// Saving rules must not invalidate legacy roots during reads or other saves.
export function validateEventForSave(event) {
  const snapshot = validateEvent(event);
  if (!snapshot.startTime.trim() && !snapshot.endTime.trim()) throw new Error('请至少填写一个故事时间');
  return snapshot;
}
export function assertRoot(root, target) {
  if (!root || root.schema !== SCHEMA || root.rootId !== target.rootId || (!Number.isSafeInteger(root.revision) || root.revision < 0) || !Array.isArray(root.events)) throw new Error('数据版本或归属无法确认，已停止读取和写入');
  const ids = new Set();
  for (const event of root.events) { validateEvent(event); if(ids.has(event.id)) throw new Error('重复记忆身份'); ids.add(event.id); }
  assertMergeRelations(root.events, Object.hasOwn(root, 'deletedMergeIds') ? root.deletedMergeIds : []);
  if(Object.hasOwn(root,'summary'))assertSummary(root.summary,root.events);
  return clone(root);
}
export function inheritEvents(events, floor) {
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('分支楼层无效');
  const before = ranges => Array.isArray(ranges) && ranges.length > 0 && ranges.every(range => validRange(range) && range.end < floor);
  const groups = new Map();
  for (const event of events) if (event.batch?.id) { const group = groups.get(event.batch.id) ?? []; group.push(event); groups.set(event.batch.id, group); }
  const safeBatches = new Set();
  for (const [id, group] of groups) {
    const snapshot = JSON.stringify(group[0].batch.sources);
    if (group.every(event => before(event.batch.sources) && JSON.stringify(event.batch.sources) === snapshot && before(event.sources) && event.sources.every(range => event.batch.sources.some(batch => range.start >= batch.start && range.end <= batch.end)))) safeBatches.add(id);
  }
  const selected = new Set(events.filter(event => event.batch ? !!event.batch.id && safeBatches.has(event.batch.id) : before(event.sources)).map(event => event.id));
  const mergeGroups = events.filter(event => event.mergedFrom).map(event => [event.id, ...event.mergedFrom]);
  // Orphaned hidden sources belong to deleted results: no complete group can inherit.
  const resultIds = new Set(events.filter(event => event.mergedFrom).map(event => event.id));
  for (const event of events) if (event.supersededBy && !resultIds.has(event.supersededBy)) selected.delete(event.id);
  // Batch and merge membership can overlap; removal must propagate to a fixed point.
  const closureGroups = [...groups.values()].map(group => group.map(event => event.id)).concat(mergeGroups);
  let changed;
  do {
    changed = false;
    for (const group of closureGroups) if (group.some(id => !selected.has(id))) for (const id of group) if (selected.delete(id)) changed = true;
  } while (changed);
  return clone(events.filter(event => selected.has(event.id)));
}
export function inheritMemoryRoot(root,rootId,floor) {
  const summary=summaryOf(root), known=new Set(summary.batches.map(batch=>batch.id));
  let selected=inheritEvents(root.events,floor), previous;
  summary.batches=summary.batches.filter(batch=>batch.requestedRange.end<floor&&batch.actualRange.end<floor);
  // A ledger's requested tail can cross the branch even when its event range
  // does not. Removing that batch must also remove overlapping merge groups.
  do {
    previous=JSON.stringify([selected.map(event=>event.id),summary.batches.map(batch=>batch.id)]);
    const inherited=new Set(selected.map(event=>event.id));
    summary.batches=summary.batches.filter(batch=>root.events.filter(event=>batch.eventIds.includes(event.id)).every(event=>inherited.has(event.id)));
    const allowed=new Set(summary.batches.map(batch=>batch.id));
    selected=inheritEvents(selected.filter(event=>!known.has(event.batch?.id)||allowed.has(event.batch.id)),floor);
  } while(previous!==JSON.stringify([selected.map(event=>event.id),summary.batches.map(batch=>batch.id)]));
  summary.excludedFloors=summary.excludedFloors.filter(item=>item.floor<floor);
  summary.revision=0;
  summary.progress={startFloor:Math.min(summary.progress.startFloor,floor),lastProcessedFloor:summary.batches.length?Math.max(...summary.batches.map(batch=>batch.actualRange.end)):null,nextBatchOrdinal:summary.batches.length?Math.max(...summary.batches.map(batch=>batch.ordinal))+1:1};
  summary.preferences.manual.startFloor=Math.min(summary.preferences.manual.startFloor,floor);
  summary.preferences.manual.endFloor=null;
  summary.preferences.auto.startFloor=Math.min(summary.preferences.auto.startFloor,floor);
  return {...emptyRoot(rootId),events:selected,summary};
}
