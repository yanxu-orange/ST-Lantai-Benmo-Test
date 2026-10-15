import {normalizeNarrativeStorage} from './source-pool.js';
import {narrativeMemoryRefs} from './core.js';
import {assertNarrativeRollback, recordNarrativeInverse, invalidateNarrativeRollback} from './rollback.js';
import {compactNarrativePool, resolveNarrativeSource, importNarrativeSource, importNarrativeProgress, semanticProgress, validateNarrativePool, visitNarrativeSources} from './source-pool.js';
import {assertRawSummarySource, durableSourceMessages, sourceFingerprint} from '../summary/source.js';
import {clone, same, integer, text, range, exact, assertKind, mergeRanges, assertNarrativeSource, storedNarrativeSource, matchesNarrativeSource, matchesStoredNarrativeSource, narrativeMemoryRows, matchesNarrativeMemory} from './core.js';
import {parseNarrativeResponse, validateNarrativeEntries} from './requests.js';
export function emptyNarrative() {
  return {schema: 1, revision: 0, preferences: {
    self: {readMemory: true, readOriginal: false, autoSource: 'event', readCard: true, background: '', budget: 30000, depth: 9999, prompt: '', characters: []},
    outline: {readMemory: true, readOriginal: false, autoSource: 'event', background: '', budget: 30000, depth: 9999, prompt: ''},
    run: {auto: true, batchSize: 10},
  }, self: [], outline: [], progress: {self: null, outline: null}};
}
// Legacy booleans remain stored unchanged; ambiguous values resolve to memory.
export function narrativeSourceChoice(preferences, originalOnly = false) {
  return originalOnly || preferences.autoSource === 'cumulative' || preferences.readOriginal === true && preferences.readMemory === false ? 'original' : 'memory';
}
// Existing kinds order records the manual entry page, including after reload.
export function narrativeBatchSourceChoice(preferences, kinds, {summary = false, summarySource} = {}) {
  if (kinds.some(kind => (summarySource ?? preferences[kind].autoSource) === 'cumulative')) return 'original';
  const choices = kinds.map(kind => narrativeSourceChoice(preferences[kind]));
  return summary ? (choices.every(choice => choice === 'original') ? 'original' : 'memory') : choices[0];
}
export function assertNarrativePreferences(value, kind) {
  assertKind(kind);
  const keys = ['readMemory', 'readOriginal', 'background', 'budget', 'depth', 'prompt', ...(kind === 'self' ? ['readCard', 'characters'] : []), ...(Object.hasOwn(value??{}, 'autoSource') ? ['autoSource'] : [])];
  if (!exact(value, keys) || typeof value.readMemory !== 'boolean' || typeof value.readOriginal !== 'boolean'
    || typeof value.background !== 'string' || typeof value.prompt !== 'string' || !integer(value.budget, 1)) throw new Error('自述或大纲设置无效');
  if (value.autoSource !== undefined && !['event', 'cumulative', 'none'].includes(value.autoSource)) throw new Error('叙事自动来源无效');
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
function assertNarrativeContent(value, owner = value) {
  const ids = new Set(), characters = new Set();
  for (const row of value.self) {
    if (!exact(row, ['id', 'name', 'entries']) || !text(row.id) || !text(row.name) || characters.has(row.id)) throw new Error('角色自述记录身份无效');
    characters.add(row.id); assertEntries(row.entries, ids);
  }
  assertEntries(value.outline, ids);
  for (const kind of ['self', 'outline']) {
    const progress = value.progress[kind];
    if (progress === null) continue;
    if (!exact(progress, ['lastProcessedFloor', 'sourceSnapshot', 'taskId', 'updatedAt', 'materialsReport']) || !integer(progress.lastProcessedFloor) || !text(progress.taskId) || !text(progress.updatedAt)) throw new Error('自述或大纲生成进度无效');
    checkSource(progress.sourceSnapshot, owner);
    if (progress.lastProcessedFloor !== progress.sourceSnapshot.requestedRange.end) throw new Error('自述或大纲进度与来源不一致');
    const report = progress.materialsReport;
    if (report !== null && (!exact(report, ['budget', 'tokens', 'estimated', 'trimmed', 'originalRanges', 'memoryRanges', 'omittedMemoryCount', 'unavailableMemoryCount', 'requiredTokens', 'promptTokens', 'outputReserve', 'tokenMethod', ...(Object.hasOwn(report, 'joint') ? ['joint'] : [])])
      || !integer(report.budget, 1) || ['tokens', 'requiredTokens', 'promptTokens', 'outputReserve', 'omittedMemoryCount', 'unavailableMemoryCount'].some(key => !integer(report[key]))
      || typeof report.estimated !== 'boolean' || typeof report.trimmed !== 'boolean' || report.tokens > report.budget || report.requiredTokens > report.tokens
      || !['host', 'estimate'].includes(report.tokenMethod) || report.estimated !== (report.tokenMethod === 'estimate')
      || !Array.isArray(report.originalRanges) || !report.originalRanges.every(range) || !Array.isArray(report.memoryRanges) || !report.memoryRanges.every(range)
      || [...report.originalRanges, ...report.memoryRanges].some(item => item.end > progress.lastProcessedFloor))) throw new Error('自述或大纲材料报告无效');
    if (report && Object.hasOwn(report, 'joint')) {
      const joint = report.joint;
      if (!exact(joint, ['budget', 'inputTokens', 'outputReserve', 'totalTokens', 'estimated', 'tokenMethod'])
        || !integer(joint.budget, 1) || ['inputTokens', 'outputReserve', 'totalTokens'].some(key => !integer(joint[key]))
        || joint.totalTokens !== joint.inputTokens + joint.outputReserve || joint.totalTokens > joint.budget
        || typeof joint.estimated !== 'boolean' || !['host', 'estimate'].includes(joint.tokenMethod) || joint.estimated !== (joint.tokenMethod === 'estimate')
        || report.budget !== joint.budget || report.estimated !== joint.estimated || report.tokenMethod !== joint.tokenMethod || report.outputReserve > joint.outputReserve) throw new Error('自述或大纲联合材料报告无效');
    }
    const entries = kind === 'self' ? value.self.flatMap(row => row.entries) : value.outline;
    if (entries.some(entry => entry.sources.some(source => source.end > progress.lastProcessedFloor))) throw new Error('自述或大纲进度落后于结果');
  }
}
function checkSource(snapshot, owner) {
  if (snapshot && Object.hasOwn(snapshot, 'sourceRef')) return resolveNarrativeSource(snapshot, owner);
  return assertNarrativeSource(snapshot);
}
// Validation borrows input only for checks; normalization and ownership copies
// remain in assertNarrative for callers that consume its returned document.
export function validateNarrative(value) {
  if (!exact(value, ['schema', 'revision', 'preferences', 'self', 'outline', 'progress', ...(Object.hasOwn(value??{}, 'sourcePool') ? ['sourcePool'] : []), ...(Object.hasOwn(value??{}, 'pendingRun') ? ['pendingRun'] : []), ...(Object.hasOwn(value??{}, 'highWater') ? ['highWater'] : []), ...(Object.hasOwn(value??{}, 'generationRecords') ? ['generationRecords'] : []), ...(Object.hasOwn(value??{}, 'latestGeneration') ? ['latestGeneration'] : []), ...(Object.hasOwn(value??{}, 'rollback') ? ['rollback'] : []), ...(Object.hasOwn(value??{}, 'rollbackUnavailable') ? ['rollbackUnavailable'] : [])]) || value.schema !== 1 || !integer(value.revision)
    || !exact(value.preferences, ['self', 'outline', ...(Object.hasOwn(value.preferences??{}, 'run') ? ['run'] : [])]) || !exact(value.progress, ['self', 'outline']) || !Array.isArray(value.self)) throw new Error('自述或大纲数据结构无效');
  validateNarrativePool(value);
  assertNarrativeRollback(value.rollback);
  if(value.rollbackUnavailable!==undefined&&(!exact(value.rollbackUnavailable,['self','outline'])||Object.values(value.rollbackUnavailable).some(item=>item!==null&&(!exact(item,['rebuildFrom'])||item.rebuildFrom!==0))))throw new Error('叙事回退状态无效');
  if (value.preferences.run !== undefined && (!exact(value.preferences.run, ['auto', 'batchSize', ...(Object.hasOwn(value.preferences.run, 'jointBudget') ? ['jointBudget'] : [])]) || typeof value.preferences.run.auto !== 'boolean' || !integer(value.preferences.run.batchSize, 1) || Object.hasOwn(value.preferences.run, 'jointBudget') && !integer(value.preferences.run.jointBudget, 1))) throw new Error('叙事分批设置无效');
  if (value.highWater !== undefined && (!exact(value.highWater, ['self', 'outline']) || Object.values(value.highWater).some(floor => floor !== null && !integer(floor)))) throw new Error('叙事后续起点无效');
  for (const kind of ['self', 'outline']) assertNarrativePreferences(value.preferences[kind], kind);
  if (value.pendingRun !== undefined && value.pendingRun !== null) {
    const pending = value.pendingRun;
    if (!exact(pending, ['ranges', 'index', 'kinds', 'failedKinds', 'restart', 'summary', 'status', ...(Object.hasOwn(pending, 'jointBudget') ? ['jointBudget'] : []), ...(Object.hasOwn(pending, 'summarySource') ? ['summarySource'] : []), ...(Object.hasOwn(pending, 'sentFloors') ? ['sentFloors'] : []), ...(Object.hasOwn(pending, 'summarySnapshot') ? ['summarySnapshot'] : []), ...['reviewBeforeCommit', 'regenerateLatest', 'pauseRequested', 'review', 'pairId'].filter(key => Object.hasOwn(pending, key))]) || !Array.isArray(pending.ranges) || !pending.ranges.length
      || pending.ranges.some(item => !exact(item, ['startFloor', 'endFloor']) || !integer(item.startFloor) || !integer(item.endFloor, item.startFloor))
      || !integer(pending.index) || pending.index >= pending.ranges.length || !Array.isArray(pending.kinds) || !pending.kinds.length || new Set(pending.kinds).size !== pending.kinds.length || pending.kinds.some(kind => !['self', 'outline'].includes(kind))
      || !Array.isArray(pending.failedKinds) || new Set(pending.failedKinds).size !== pending.failedKinds.length || pending.failedKinds.some(kind => !pending.kinds.includes(kind))
      || typeof pending.restart !== 'boolean' || typeof pending.summary !== 'boolean' || !['paused', 'failed', 'awaiting-review'].includes(pending.status)) throw new Error('叙事批次断点无效');
    for (const key of ['reviewBeforeCommit', 'regenerateLatest', 'pauseRequested']) if (Object.hasOwn(pending, key) && typeof pending[key] !== 'boolean') throw new Error('叙事批次检查选项无效');
    if (Object.hasOwn(pending, 'pairId') && !text(pending.pairId)) throw new Error('叙事批次身份无效');
    if (pending.reviewBeforeCommit && pending.summary) throw new Error('自动续接不能进入手动检查');
    if (pending.status === 'awaiting-review' || Object.hasOwn(pending, 'review')) assertNarrativeReview(pending, value);
    if (Object.hasOwn(pending, 'jointBudget') && !integer(pending.jointBudget, 1)) throw new Error('叙事批次联合预算无效');
    if (pending.summarySource !== undefined && !['event', 'cumulative'].includes(pending.summarySource)) throw new Error('叙事批次来源无效');
    if (pending.summarySnapshot !== undefined) checkSource(pending.summarySnapshot, value);
    if (pending.sentFloors !== undefined) {
      if(!Array.isArray(pending.sentFloors))throw new Error('古法楼层无效');
      checkSource(pending.summarySnapshot, value);
      if (pending.summarySource !== 'cumulative') throw new Error('古法叙事来源不一致');
    }
  }
  assertNarrativeContent(value);
  assertGenerationHistory(value);
}
export function assertNarrative(value) {
  const result = normalizeNarrativeStorage(clone(value));
  validateNarrative(result);
  visitNarrativeSources(result, snapshot => Object.hasOwn(snapshot, 'sourceRef') ? snapshot : importNarrativeSource(result, snapshot));
  compactNarrativePool(result);
  return result;
}
export function narrativeOf(root) { return root.narrative === undefined ? emptyNarrative() : assertNarrative(root.narrative); }
function retainSafeProof(domain, kind, floor) {
  const progress = domain.progress[kind];
  if (!progress || progress.lastProcessedFloor < floor) return;
  const entries = kind === 'self' ? domain.self.flatMap(row => row.entries) : domain.outline;
  if (!entries.length) { domain.progress[kind] = null; return; }
  const end = Math.max(...entries.flatMap(row => row.sources.map(source => source.end)));
  domain.progress[kind] = {...progress, lastProcessedFloor: end,
    sourceSnapshot: {requestedRange: {start: 0, end}},
    materialsReport: null};
}
export function inheritNarrative(value, floor) {
  if (!integer(floor)) throw new Error('分支楼层无效');
  const domain = assertNarrative(value), safe = entry => entry.sources.every(source => source.end < floor);
  domain.self = domain.self.map(row => ({...row, entries: row.entries.filter(safe)}));
  domain.outline = domain.outline.filter(safe);
  for (const kind of ['self', 'outline']) retainSafeProof(domain, kind, floor);
  if (Object.hasOwn(domain, 'pendingRun')) domain.pendingRun = null;
  if (domain.highWater) for (const kind of ['self', 'outline']) domain.highWater[kind] = domain.highWater[kind] === null || floor === 0 ? null : Math.min(domain.highWater[kind], floor - 1);
  for (const kind of ['self', 'outline']) {
    if (domain.generationRecords) domain.generationRecords[kind] = domain.generationRecords[kind].filter(row => row.endFloor < floor);
    const latest = domain.latestGeneration?.[kind];
    if (latest && (latest.range.endFloor >= floor || latest.sourceSnapshot.requestedRange.end >= floor
      || latest.baseline.progress?.lastProcessedFloor >= floor
      || entriesForKind(latest.baseline.entries, kind).some(entry => !safe(entry)))) domain.latestGeneration[kind] = null;
  }
  invalidateNarrativeRollback(domain);
  domain.revision = 0;
  return assertNarrative(domain);
}
// This is a read-only safe projection. The caller persists only as part of a
// guarded write; there is no guessed restoration of superseded prose.
export function reconcileNarrativeSource(value, raw) {
  // Editing chat text does not invalidate saved outcomes. Verified deletion owns rollback.
  return {domain:assertNarrative(value),staleKinds:[],firstChangedFloor:null};
}
export function applyNarrativeResponse(value, ticket, response, raw, {events, makeId = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  const domain = assertNarrative(value), kind = assertKind(ticket?.kind);
  if (ticket.revision !== domain.revision || !same(ticket.preferences, domain.preferences[kind]) || !same(ticket.previous, domain[kind])
    || !same(ticket.progress, semanticProgress(domain.progress[kind], domain)) || !matchesNarrativeSource(ticket.source, raw)) throw new Error('自述或大纲来源、设置或结果已变化，请重新生成');
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
  domain.progress[kind] = {lastProcessedFloor: ticket.source.requestedRange.end, sourceSnapshot: storedNarrativeSource(ticket.source), taskId: freshId(), updatedAt: now, materialsReport: clone(ticket.usage)};
  domain.highWater = {...(domain.highWater ?? {self: domain.progress.self?.lastProcessedFloor ?? null, outline: domain.progress.outline?.lastProcessedFloor ?? null}), [kind]: Math.max(narrativeHighWater(value, kind), ticket.source.requestedRange.end)};
  domain.revision++;
  return assertNarrative(domain);
}

// Continuation is a successful-processing cursor, never evidence for retained prose.
export function narrativeHighWater(domain, kind) { return Math.max(domain.highWater?.[kind] ?? -1, domain.progress[kind]?.lastProcessedFloor ?? -1); }

// Missing shared budgets retain the previous larger-allowance default without
// rewriting stored preferences or either category's independent budget.
export function narrativeJointBudget(domain) { return domain.preferences.run?.jointBudget ?? Math.max(domain.preferences.self.budget, domain.preferences.outline.budget); }

const kinds = ['self', 'outline'];
const entriesForKind = (entries, kind) => kind === 'self' ? entries.flatMap(row => row.entries) : entries;
const floorRange = value => exact(value, ['startFloor', 'endFloor']) && integer(value.startFloor) && integer(value.endFloor, value.startFloor);
function assertKindContent(entries, progress, kind, owner) {
  const content = emptyNarrative(); content[kind] = entries; content.progress[kind] = progress;
  assertNarrativeContent(content, owner);
}
function assertGenerationHistory(domain) {
  if (Object.hasOwn(domain, 'generationRecords')) {
    if (!exact(domain.generationRecords, kinds)) throw new Error('叙事生成记录无效');
    for (const kind of kinds) {
      const records = domain.generationRecords[kind], ids = new Set();
      if (!Array.isArray(records)) throw new Error('叙事生成记录无效');
      for (const row of records) {
        if (!exact(row, ['id', 'startFloor', 'endFloor', 'updatedAt', 'source']) || !text(row.id) || ids.has(row.id)
          || !integer(row.startFloor) || !integer(row.endFloor, row.startFloor) || !text(row.updatedAt) || !['event', 'cumulative'].includes(row.source)) throw new Error('叙事生成记录无效');
        ids.add(row.id);
      }
    }
  }
  if (Object.hasOwn(domain, 'latestGeneration')) {
    if (!exact(domain.latestGeneration, kinds)) throw new Error('叙事最新生成基版无效');
    for (const kind of kinds) {
      const latest = domain.latestGeneration[kind]; if (latest === null) continue;
      if (!exact(latest, ['recordId', 'pairId', 'baseline', 'range', 'sourceSnapshot']) || !text(latest.recordId) || !text(latest.pairId)
        || !floorRange(latest.range) || !exact(latest.baseline, ['entries', 'progress'])) throw new Error('叙事最新生成基版无效');
      assertKindContent(latest.baseline.entries, latest.baseline.progress, kind, domain);
      checkSource(latest.sourceSnapshot, domain);
      const record = domain.generationRecords?.[kind]?.at(-1);
      if (!record || record.id !== latest.recordId || record.startFloor !== latest.range.startFloor || record.endFloor !== latest.range.endFloor
        || latest.sourceSnapshot.requestedRange.start !== latest.range.startFloor || latest.sourceSnapshot.requestedRange.end !== latest.range.endFloor) throw new Error('叙事最新生成记录与基版不一致');
    }
  }
}
// Only successful processing produces records. Legacy prose coverage is not a batch log.
export function narrativeGenerationRecords(value, kind) {
  assertKind(kind); return clone(assertNarrative(value).generationRecords?.[kind] ?? []);
}
export function recordNarrativeGeneration(value, before, kind, {range: selectedRange, pairId, source = 'event', regenerateLatest = false, persistedBefore = before, nonlinear = false} = {}) {
  const domain = assertNarrative(value), previous = assertNarrative(before); assertKind(kind);
  const progress = domain.progress[kind];
  if (!progress || !floorRange(selectedRange) || !text(pairId) || !['event', 'cumulative'].includes(source)
    || !same(progress.sourceSnapshot.requestedRange, {start: selectedRange.startFloor, end: selectedRange.endFloor})) throw new Error('叙事生成记录缺少成功来源');
  const old = previous.latestGeneration?.[kind];
  if (regenerateLatest && (!old || !same(old.range, selectedRange))) throw new Error('缺少最新生成前基版，不能重新生成');
  domain.generationRecords ??= {self: [], outline: []};
  domain.latestGeneration ??= {self: null, outline: null};
  const id = regenerateLatest ? old.recordId : progress.taskId;
  const record = {id, ...clone(selectedRange), updatedAt: progress.updatedAt, source};
  if (regenerateLatest) {
    if (domain.generationRecords[kind].at(-1)?.id !== id) throw new Error('最新生成记录已变化');
    domain.generationRecords[kind][domain.generationRecords[kind].length - 1] = record;
  } else domain.generationRecords[kind].push(record);
  domain.latestGeneration[kind] = {recordId: id, pairId, baseline: regenerateLatest ? {...clone(old.baseline), progress: importNarrativeProgress(domain, old.baseline.progress, previous)} : {entries: clone(previous[kind]), progress: importNarrativeProgress(domain, previous.progress[kind], previous)}, range: clone(selectedRange), sourceSnapshot: clone(progress.sourceSnapshot)};
  // Replaying a historical range must never move the automatic continuation cursor backward.
  domain.highWater = {...(domain.highWater ?? {self: null, outline: null}), [kind]: Math.max(narrativeHighWater(previous, kind), narrativeHighWater(domain, kind))};
  recordNarrativeInverse(domain, assertNarrative(persistedBefore), kind, {range:selectedRange,pairId,nonlinear:nonlinear||regenerateLatest});
  return assertNarrative(domain);
}

function assertNarrativeReview(pending, owner) {
  const review = pending.review, digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (pending.status !== 'awaiting-review' || pending.reviewBeforeCommit !== true || pending.summary
    || !exact(review, ['kinds', 'range', 'results', 'progress', 'bindings', 'pairId']) || !text(review.pairId) || pending.pairId !== undefined && pending.pairId !== review.pairId
    || !Array.isArray(review.kinds) || !review.kinds.length || new Set(review.kinds).size !== review.kinds.length
    || review.kinds.some(kind => !pending.kinds.includes(kind)) || !floorRange(review.range) || !same(review.range, pending.ranges[pending.index])
    || !exact(review.results, review.kinds) || !exact(review.progress, review.kinds)
    || !exact(review.bindings, ['generation', 'card', 'categories']) || !digest(review.bindings.generation)
    || !(review.bindings.card === null || digest(review.bindings.card)) || !exact(review.bindings.categories, review.kinds)) throw new Error('叙事待采用内容无效');
  const ids = new Set();
  for (const kind of review.kinds) {
    const binding = review.bindings.categories[kind], progress = review.progress[kind];
    if (!exact(binding, ['preferences', 'entries', 'progress', 'memory', 'memoryIds', 'readMemory', 'latestGeneration'])
      || ['preferences', 'entries'].some(key => !digest(binding[key])) || ['progress','memory','latestGeneration'].some(key=>binding[key]!==null&&!digest(binding[key]))
      || typeof binding.readMemory !== 'boolean' || !Array.isArray(binding.memoryIds) || binding.memoryIds.some(id => !text(id)) || new Set(binding.memoryIds).size !== binding.memoryIds.length) throw new Error('叙事待采用来源绑定无效');
    assertKindContent(review.results[kind], progress, kind, owner);
    assertEntries(entriesForKind(review.results[kind], kind), ids);
    if (!progress || !same(progress.sourceSnapshot.requestedRange, {start: review.range.startFloor, end: review.range.endFloor})) throw new Error('叙事待采用进度与范围不一致');
  }
}
