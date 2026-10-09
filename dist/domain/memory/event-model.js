// Pure event shape and validation; no chat aggregate or summary dependencies.
const clone = value => structuredClone(value);
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
