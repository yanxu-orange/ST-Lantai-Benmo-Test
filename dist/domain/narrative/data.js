import {assertRawSummarySource, durableSourceMessages, sourceFingerprint} from '../summary/source.js';
import {clone, same, integer, text, range, exact, assertKind, mergeRanges, assertNarrativeSource, storedNarrativeSource, matchesNarrativeSource, matchesStoredNarrativeSource, narrativeMemoryRows, matchesNarrativeMemory} from './core.js';
import {parseNarrativeResponse, validateNarrativeEntries} from './requests.js';
export function emptyNarrative() {
  return {schema: 1, revision: 0, preferences: {
    self: {readMemory: true, readOriginal: true, readCard: true, background: '', budget: 30000, depth: 9999, prompt: '', characters: []},
    outline: {readMemory: true, readOriginal: true, background: '', budget: 30000, depth: 9999, prompt: ''},
    run: {auto: true, batchSize: 10},
  }, self: [], outline: [], progress: {self: null, outline: null}};
}
export function assertNarrativePreferences(value, kind) {
  assertKind(kind);
  const keys = ['readMemory', 'readOriginal', 'background', 'budget', 'depth', 'prompt', ...(kind === 'self' ? ['readCard', 'characters'] : [])];
  if (!exact(value, keys) || typeof value.readMemory !== 'boolean' || typeof value.readOriginal !== 'boolean' || !value.readMemory && !value.readOriginal
    || typeof value.background !== 'string' || typeof value.prompt !== 'string' || !integer(value.budget, 1)) throw new Error('自述或大纲设置无效，至少开启记忆或原文');
  if (!integer(value.depth) || value.depth > 10000) throw new Error('请填写 0—10000 的整数注入深度');
  if (kind === 'self') {
    if (typeof value.readCard !== 'boolean' || !Array.isArray(value.characters)) throw new Error('角色自述设置无效');
    const ids = new Set(), names = new Set();
    for (const row of value.characters) {
      if (!exact(row, ['id', 'name', 'inject']) || !text(row.id) || !text(row.name) || typeof row.inject !== 'boolean' || ids.has(row.id) || names.has(row.name.trim())) throw new Error('指定角色身份或姓名重复、无效');
      ids.add(row.id); names.add(row.name.trim());
    }
  }
  return clone(value);
}
function assertEntries(entries, ids) {
  if (!Array.isArray(entries)) throw new Error('自述或大纲条目无效');
  for (const entry of entries) {
    if (!exact(entry, ['id', 'text', 'sources', 'createdAt', 'updatedAt']) || ![entry.id, entry.text, entry.createdAt, entry.updatedAt].every(text)
      || ids.has(entry.id) || !Array.isArray(entry.sources) || !entry.sources.length || !entry.sources.every(range) || !same(entry.sources, mergeRanges(entry.sources))) throw new Error('自述或大纲条目身份或来源无效');
    ids.add(entry.id);
  }
}
export function assertNarrative(value) {
  if (!exact(value, ['schema', 'revision', 'preferences', 'self', 'outline', 'progress', ...(Object.hasOwn(value??{}, 'pendingRun') ? ['pendingRun'] : [])]) || value.schema !== 1 || !integer(value.revision)
    || !exact(value.preferences, ['self', 'outline', ...(Object.hasOwn(value.preferences??{}, 'run') ? ['run'] : [])]) || !exact(value.progress, ['self', 'outline']) || !Array.isArray(value.self)) throw new Error('自述或大纲数据结构无效');
  if (value.preferences.run !== undefined && (!exact(value.preferences.run, ['auto', 'batchSize']) || typeof value.preferences.run.auto !== 'boolean' || !integer(value.preferences.run.batchSize, 1))) throw new Error('叙事分批设置无效');
  for (const kind of ['self', 'outline']) assertNarrativePreferences(value.preferences[kind], kind);
  if (value.pendingRun !== undefined && value.pendingRun !== null) {
    const pending = value.pendingRun;
    if (!exact(pending, ['ranges', 'index', 'kinds', 'failedKinds', 'restart', 'summary', 'status']) || !Array.isArray(pending.ranges) || !pending.ranges.length
      || pending.ranges.some(item => !exact(item, ['startFloor', 'endFloor']) || !integer(item.startFloor) || !integer(item.endFloor, item.startFloor))
      || !integer(pending.index) || pending.index >= pending.ranges.length || !Array.isArray(pending.kinds) || !pending.kinds.length || new Set(pending.kinds).size !== pending.kinds.length || pending.kinds.some(kind => !['self', 'outline'].includes(kind))
      || !Array.isArray(pending.failedKinds) || new Set(pending.failedKinds).size !== pending.failedKinds.length || pending.failedKinds.some(kind => !pending.kinds.includes(kind))
      || typeof pending.restart !== 'boolean' || typeof pending.summary !== 'boolean' || !['paused', 'failed'].includes(pending.status)) throw new Error('叙事批次断点无效');
  }
  const ids = new Set(), characters = new Set();
  for (const row of value.self) {
    if (!exact(row, ['id', 'name', 'entries']) || !text(row.id) || !text(row.name) || characters.has(row.id)) throw new Error('角色自述记录身份无效');
    characters.add(row.id); assertEntries(row.entries, ids);
  }
  assertEntries(value.outline, ids);
  for (const kind of ['self', 'outline']) {
    const progress = value.progress[kind];
    if (progress === null) continue;
    if (!exact(progress, ['lastProcessedFloor', 'sourceSnapshot', 'taskId', 'updatedAt', 'materialsReport', 'memorySnapshot']) || !integer(progress.lastProcessedFloor) || !text(progress.taskId) || !text(progress.updatedAt)) throw new Error('自述或大纲生成进度无效');
    assertNarrativeSource(progress.sourceSnapshot);
    if (progress.lastProcessedFloor !== progress.sourceSnapshot.requestedRange.end || !same(progress.memorySnapshot, narrativeMemoryRows(progress.memorySnapshot, progress.lastProcessedFloor))) throw new Error('自述或大纲进度与来源不一致');
    const report = progress.materialsReport;
    if (report !== null && (!exact(report, ['budget', 'tokens', 'estimated', 'trimmed', 'originalRanges', 'memoryRanges', 'omittedMemoryCount', 'unavailableMemoryCount', 'requiredTokens', 'promptTokens', 'outputReserve', 'tokenMethod'])
      || !integer(report.budget, 1) || ['tokens', 'requiredTokens', 'promptTokens', 'outputReserve', 'omittedMemoryCount', 'unavailableMemoryCount'].some(key => !integer(report[key]))
      || typeof report.estimated !== 'boolean' || typeof report.trimmed !== 'boolean' || report.tokens > report.budget || report.requiredTokens > report.tokens
      || !['host', 'estimate'].includes(report.tokenMethod) || report.estimated !== (report.tokenMethod === 'estimate')
      || !Array.isArray(report.originalRanges) || !report.originalRanges.every(range) || !Array.isArray(report.memoryRanges) || !report.memoryRanges.every(range)
      || [...report.originalRanges, ...report.memoryRanges].some(item => item.end > progress.lastProcessedFloor))) throw new Error('自述或大纲材料报告无效');
    const entries = kind === 'self' ? value.self.flatMap(row => row.entries) : value.outline;
    if (entries.some(entry => entry.sources.some(source => source.end > progress.lastProcessedFloor))) throw new Error('自述或大纲进度落后于结果');
  }
  return clone(value);
}
export function narrativeOf(root) { return root.narrative === undefined ? emptyNarrative() : assertNarrative(root.narrative); }
function retainSafeProof(domain, kind, floor) {
  const progress = domain.progress[kind];
  if (!progress || progress.lastProcessedFloor < floor) return;
  const entries = kind === 'self' ? domain.self.flatMap(row => row.entries) : domain.outline;
  if (!entries.length) { domain.progress[kind] = null; return; }
  const end = Math.max(...entries.flatMap(row => row.sources.map(source => source.end)));
  const rawMessages = progress.sourceSnapshot.rawMessages.filter(row => row.floor <= end);
  domain.progress[kind] = {...progress, lastProcessedFloor: end,
    sourceSnapshot: {requestedRange: {start: 0, end}, rawMessages, fingerprint: sourceFingerprint(rawMessages)},
    materialsReport: null, memorySnapshot: progress.memorySnapshot.filter(row => row.sources.every(source => source.end <= end))};
}
export function inheritNarrative(value, floor) {
  if (!integer(floor)) throw new Error('分支楼层无效');
  const domain = assertNarrative(value), safe = entry => entry.sources.every(source => source.end < floor);
  domain.self = domain.self.map(row => ({...row, entries: row.entries.filter(safe)}));
  domain.outline = domain.outline.filter(safe);
  for (const kind of ['self', 'outline']) retainSafeProof(domain, kind, floor);
  if (Object.hasOwn(domain, 'pendingRun')) domain.pendingRun = null;
  domain.revision = 0;
  return assertNarrative(domain);
}
// This is a read-only safe projection. The caller persists only as part of a
// guarded write; there is no guessed restoration of superseded prose.
export function reconcileNarrativeSource(value, raw) {
  const domain = assertNarrative(value), current = assertRawSummarySource(raw), byFloor = new Map(durableSourceMessages(current.messages).map(row => [row.floor, row]));
  const staleKinds = []; let firstChangedFloor = null;
  for (const kind of ['self', 'outline']) {
    const progress = domain.progress[kind];
    if (!progress || matchesStoredNarrativeSource(progress.sourceSnapshot, raw)) continue;
    const changed = progress.sourceSnapshot.rawMessages.find(row => !same(row, byFloor.get(row.floor)))?.floor ?? 0;
    const safe = entry => entry.sources.every(source => source.end < changed);
    if (kind === 'self') domain.self = domain.self.map(row => ({...row, entries: row.entries.filter(safe)})); else domain.outline = domain.outline.filter(safe);
    retainSafeProof(domain, kind, changed); staleKinds.push(kind);
    firstChangedFloor = firstChangedFloor === null ? changed : Math.min(firstChangedFloor, changed);
  }
  return {domain: assertNarrative(domain), staleKinds, firstChangedFloor};
}
export function applyNarrativeResponse(value, ticket, response, raw, {events, makeId = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  const domain = assertNarrative(value), kind = assertKind(ticket?.kind);
  if (ticket.revision !== domain.revision || !same(ticket.preferences, domain.preferences[kind]) || !same(ticket.previous, domain[kind])
    || !same(ticket.progress, domain.progress[kind]) || !matchesNarrativeSource(ticket.source, raw)) throw new Error('自述或大纲来源、设置或结果已变化，请重新生成');
  if (!matchesNarrativeMemory(ticket, events)) throw new Error('自述或大纲记忆材料已变化，请重新生成');
  const parsed = parseNarrativeResponse(response, {kind}), ids = new Set([...domain.outline, ...domain.self.flatMap(row => row.entries)].map(row => row.id));
  if (!text(now)) throw new Error('自述或大纲保存时间无效');
  const freshId = () => { const id = makeId(); if (!text(id) || ids.has(id)) throw new Error('自述或大纲生成身份重复'); ids.add(id); return id; };
  const update = (entries, texts) => {
    const previous = entries.map(row => row.text);
    validateNarrativeEntries(previous, texts);
    // Match each retained occurrence once. Legacy equal text can have distinct
    // IDs, timestamps and provenance; finding by text alone reuses the first ID.
    const retainedIds = new Set();
    const unchanged = texts.map((body, index) => {
      const entry = entries[index];
      if (entry?.text !== body) return null;
      retainedIds.add(entry.id);
      return entry;
    });
    const available = new Map();
    for (const entry of entries) {
      if (retainedIds.has(entry.id)) continue;
      if (!available.has(entry.text)) available.set(entry.text, []);
      available.get(entry.text).push(entry);
    }
    for (let index = 0; index < texts.length; index++) {
      if (unchanged[index]) continue;
      unchanged[index] = available.get(texts[index])?.shift() ?? null;
      if (unchanged[index]) retainedIds.add(unchanged[index].id);
    }
    return texts.map((body, index) => {
      if (unchanged[index]) return clone(unchanged[index]);
      const existing = entries[index] && !retainedIds.has(entries[index].id) ? entries[index] : null, sources = mergeRanges([...(existing?.sources ?? []), ticket.source.requestedRange]);
      return {id: existing?.id ?? freshId(), text: body, sources, createdAt: existing?.createdAt ?? now, updatedAt: now};
    });
  };
  if (kind === 'outline') domain.outline = update(domain.outline, parsed.entries);
  else {
    const selected = domain.preferences.self.characters;
    if (parsed.characters.length !== selected.length || selected.some(row => !parsed.characters.some(item => item.id === row.id))) throw new Error('角色自述必须完整包含全部指定角色');
    for (const character of selected) {
      const index = domain.self.findIndex(row => row.id === character.id), existing = index < 0 ? [] : domain.self[index].entries;
      const record = {id: character.id, name: character.name, entries: update(existing, parsed.characters.find(row => row.id === character.id).entries)};
      if (index < 0) domain.self.push(record); else domain.self[index] = record;
    }
  }
  domain.progress[kind] = {lastProcessedFloor: ticket.source.requestedRange.end, sourceSnapshot: storedNarrativeSource(ticket.source), taskId: freshId(), updatedAt: now, materialsReport: clone(ticket.usage), memorySnapshot: clone(ticket.memorySnapshot)};
  domain.revision++;
  return assertNarrative(domain);
}
