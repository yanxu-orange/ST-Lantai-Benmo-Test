import { assertRoot, validateEvent, validateEventForSave, activeEvents } from './model.js';
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
  const requireTarget = target => { if (!sameTarget(target, adapter.captureTarget())) throw new Error('聊天目标已变化，请返回列表重新进入'); };
  const enqueue = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const read = async target => { requireTarget(target); const root = assertRoot(await adapter.read(target), target); requireTarget(target); return root; };
  const commit = async (target, root, next, guard = () => true) => {
    const check = current => { requireTarget(target); if (guard(current) !== true) throw new Error('任务已取消或来源已失效'); return true; };
    assertRoot(next, target); check(root);
    const committed = await adapter.commit(target, next, root.revision, { guard: check });
    requireTarget(target);
    return assertRoot(committed, target);
  };
  const sourceGuard = (target, snapshot, options, hidden = false) => current => {
    if ((options.isCurrent ?? (() => true))() !== true) throw new Error('任务已取消或来源已失效');
    matchSnapshot(current, target, snapshot, hidden);
    return true;
  };
  return {
    captureTarget: () => { const target = adapter.captureTarget(); requireTarget(target); return copy(target); },
    read,
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
