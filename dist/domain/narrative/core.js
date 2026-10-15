import {assertRawSummarySource, durableSourceMessages, sourceFingerprint} from '../summary/source.js';
export const clone = value => structuredClone(value);
export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
export const text = value => typeof value === 'string' && !!value.trim();
export const range = value => exact(value, ['start', 'end']) && integer(value.start) && integer(value.end) && value.end >= value.start;
export const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function assertKind(kind) { if (!['self', 'outline'].includes(kind)) throw new Error('自述或大纲类别无效'); return kind; }
export function mergeRanges(ranges) {
  const result = [];
  for (const item of clone(ranges).sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!range(item)) throw new Error('自述或大纲来源范围无效');
    const last = result.at(-1);
    if (last && item.start <= last.end + 1) last.end = Math.max(last.end, item.end); else result.push(item);
  }
  return result;
}
export function assertNarrativeSource(value, {copy = true} = {}) {
  if (!value || !range(value.requestedRange)) throw new Error('自述或大纲来源范围无效');
  const result={requestedRange:{...value.requestedRange}};
  return result;
}
export function storedNarrativeSource(source) { return assertNarrativeSource(source); }
export function matchesNarrativeSource(snapshot, raw) {
  try {
    const current = assertRawSummarySource(raw);
    return current.epoch === snapshot.epoch && same(current.messages.filter(row => row.floor <= snapshot.requestedRange.end).sort((a, b) => a.floor - b.floor), snapshot.rawMessages);
  } catch { return false; }
}
export function matchesStoredNarrativeSource(snapshot, raw, owner) {
  try { const range=resolveNarrativeSource(snapshot,owner).requestedRange; return raw.messages.some(row=>row.floor===range.end); } catch { return false; }
}
export function narrativeMemoryRefs(rows,endFloor=Infinity) {
  return rows.filter(row=>row.sources.every(source=>source.end<=endFloor)).map(row=>({id:row.id,sources:mergeRanges(row.sources)})).sort((a,b)=>a.sources[0].start-b.sources[0].start||a.sources.at(-1).end-b.sources.at(-1).end||a.id.localeCompare(b.id));
}
export function narrativeMemoryRows(events, endFloor) {
  if (!Array.isArray(events)) throw new Error('自述或大纲记忆来源无效');
  const seen = new Set();
  return events.flatMap(event => {
    if (event?.supersededBy || !text(event?.id) || !text(event?.body) || !Array.isArray(event.sources) || !event.sources.length || !event.sources.every(range) || event.sources.some(source => source.end > endFloor)) return [];
    if (seen.has(event.id)) throw new Error('自述或大纲记忆身份重复');
    seen.add(event.id);
    return [{id: event.id, title: typeof event.title === 'string' ? event.title : '', body: event.body, startTime: typeof event.startTime === 'string' ? event.startTime : '', endTime: typeof event.endTime === 'string' ? event.endTime : '', sources: mergeRanges(event.sources)}];
  }).sort((a, b) => a.sources[0].start - b.sources[0].start || a.sources.at(-1).end - b.sources.at(-1).end || a.id.localeCompare(b.id));
}

export function matchesNarrativeMemory(ticket, events) {
  try {
    if (!ticket.preferences.readMemory && !ticket.memorySnapshot?.length) return true;
    const selected = ticket.memorySnapshot, ids = new Set(selected.map(row => row.id));
    return same(selected, narrativeMemoryRows(events, ticket.source.requestedRange.end).filter(row => ids.has(row.id)));
  } catch { return false; }
}

export function resolveNarrativeSource(snapshot, owner) {
  if (!snapshot || !Object.hasOwn(snapshot, 'sourceRef')) return snapshot;
  const item = owner?.sourcePool?.[snapshot.sourceRef];
  if (!exact(snapshot, ['requestedRange', 'sourceRef']) || !range(snapshot.requestedRange)
    || !integer(snapshot.sourceRef) || !item || item.rawMessages.at(-1)?.floor !== snapshot.requestedRange.end) throw new Error('叙事共享来源引用无效');
  return {requestedRange: snapshot.requestedRange, rawMessages: item.rawMessages, fingerprint: item.fingerprint};
}
