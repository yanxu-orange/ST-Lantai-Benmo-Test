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
export function assertNarrativeSource(value) {
  if (!exact(value, ['requestedRange', 'rawMessages', 'fingerprint']) || !range(value.requestedRange) || !Array.isArray(value.rawMessages) || !text(value.fingerprint)) throw new Error('自述或大纲来源证据无效');
  assertRawSummarySource({epoch: 0, messages: value.rawMessages});
  if (!value.rawMessages.length || value.rawMessages.at(-1).floor !== value.requestedRange.end
    || value.rawMessages.some((row, index) => !exact(row, ['floor', 'identity', 'role', 'system', 'text', 'date', 'swipeId']) || row.floor !== index || !(row.swipeId === null || integer(row.swipeId)))
    || sourceFingerprint(value.rawMessages) !== value.fingerprint) throw new Error('自述或大纲来源前缀不完整');
  return clone(value);
}
export function storedNarrativeSource(source) {
  return assertNarrativeSource({requestedRange: clone(source.requestedRange), rawMessages: durableSourceMessages(source.rawMessages), fingerprint: source.fingerprint});
}
export function matchesNarrativeSource(snapshot, raw) {
  try {
    const current = assertRawSummarySource(raw);
    return current.epoch === snapshot.epoch && same(current.messages.filter(row => row.floor <= snapshot.requestedRange.end).sort((a, b) => a.floor - b.floor), snapshot.rawMessages);
  } catch { return false; }
}
export function matchesStoredNarrativeSource(snapshot, raw) {
  try {
    assertNarrativeSource(snapshot);
    const current = assertRawSummarySource(raw);
    return same(durableSourceMessages(current.messages.filter(row => row.floor <= snapshot.requestedRange.end).sort((a, b) => a.floor - b.floor)), snapshot.rawMessages);
  } catch { return false; }
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
    if (!ticket.preferences.readMemory) return true;
    const selected = ticket.memorySnapshot, ids = new Set(selected.map(row => row.id));
    return same(selected, narrativeMemoryRows(events, ticket.source.requestedRange.end).filter(row => ids.has(row.id)));
  } catch { return false; }
}
