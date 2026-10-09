import {assertRawSummarySource, sourceFingerprint, durableSourceMessages} from '../summary/source.js';
import {cleanSummaryFloors} from '../summary/cleaning.js';
import {effectiveBatchPositions} from '../summary/source-positions.js';
import {assertNarrative} from './data.js';
import {clone, same, integer, text, range, freeze, assertKind, mergeRanges, narrativeMemoryRows, matchesStoredNarrativeSource} from './core.js';
import {buildNarrativeRequest, narrativeMaterialParts} from './requests.js';
export {matchesNarrativeSource, matchesStoredNarrativeSource, storedNarrativeSource, matchesNarrativeMemory} from './core.js';
export function narrativeCardFields(card) {
  if (!card || typeof card !== 'object') return null;
  const base = card.data && typeof card.data === 'object' ? card.data : card;
  const result = Object.fromEntries(['description', 'personality', 'scenario'].map(key => [key, typeof base[key] === 'string' ? base[key] : typeof card[key] === 'string' ? card[key] : '']));
  const name = typeof base.name === 'string' ? base.name : typeof card.name === 'string' ? card.name : '';
  return Object.values(result).some(text) ? {name, ...result} : null;
}
// Apply the authoritative deletion overlay before any cutoff decision. A
// crossing, unlinked or manually re-ranged merged source is never guessed.
export function projectNarrativeMemory(root, raw = null) {
  const events = clone(root.events ?? []), summary = root.summary ?? {batches: []}, batches = new Map((summary.batches ?? []).map(row => [row.id, row]));
  const current = raw === null ? null : new Map(durableSourceMessages(assertRawSummarySource(raw).messages).map(row => [row.floor, row]));
  const projected = events.map(event => {
    if (!event.batch?.id) return clone(event);
    const batch = batches.get(event.batch.id);
    if (!batch) return {...event, sources: []};
    const positions = effectiveBatchPositions(batch, summary), originals = batch.sourceSnapshot.rawMessages;
    if (current && positions.some((position, index) => position === null || !same({...durableSourceMessages([originals[index]])[0], floor: position.floor, identity: position.identity}, current.get(position.floor)))) return {...event, sources: []};
    const byFloor = new Map(originals.map((row, index) => [row.floor, positions[index]]));
    const sources = (event.sources ?? []).map(source => {
      if (!range(source)) return null;
      const points = Array.from({length: source.end - source.start + 1}, (_, offset) => byFloor.get(source.start + offset));
      if (points.some((point, index) => !point || index > 0 && point.floor !== points[index - 1].floor + 1)) return null;
      return {start: points[0].floor, end: points.at(-1).floor};
    });
    return {...event, sources: sources.some(source => source === null) ? [] : mergeRanges(sources)};
  });
  for (const event of projected.filter(row => row.mergedFrom)) {
    const originals = events.filter(row => event.mergedFrom.includes(row.id)), sources = projected.filter(row => event.mergedFrom.includes(row.id));
    if (originals.length !== event.mergedFrom.length || sources.some(row => !row.sources?.length) || !same(mergeRanges(originals.flatMap(row => row.sources)), mergeRanges(event.sources))) event.sources = [];
    else event.sources = mergeRanges(sources.flatMap(row => row.sources));
  }
  return projected;
}
function estimatedUnits(value) {
  let units = 0;
  for (const char of value) units += char.codePointAt(0) > 127 ? 4 : 1;
  return units;
}
export function estimateNarrativeTokens(value) {
  // Keep unrounded quarter-token units until all fragments are combined. This
  // exactly matches the full-text estimate, including JSON punctuation.
  return Math.ceil(estimatedUnits(value) / 4);
}
function materialsText(materials) { return narrativeMaterialParts(materials).map(row => row.content).join('\n\n'); }
function memoryPayload(row, originalRanges) {
  const overlaps = [];
  for (const source of row.sources) for (const original of originalRanges) {
    const start = Math.max(source.start, original.start), end = Math.min(source.end, original.end);
    if (start <= end) overlaps.push({start, end});
  }
  return {...clone(row), overlapsOriginal: mergeRanges(overlaps)};
}
export async function prepareNarrativeUpdate(value, raw, {kind, startFloor, endFloor, events = [], card = null, countTokens = null, rules, isCurrent = () => true} = {}) {
  assertKind(kind);
  const guard = () => {
    let current = false;
    try { current = typeof isCurrent === 'function' && isCurrent() === true; } catch { /* Expired work is cancelled, never retried as a tokenizer fallback. */ }
    if (!current) { const error = new Error('自述或大纲任务已取消或来源已变化'); error.code = 'NARRATIVE_CANCELLED'; throw error; }
  };
  let workUnits = 0;
  const cooperate = async () => {
    guard();
    if (++workUnits % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    guard();
  };
  guard();
  // Capture every mutable input before awaiting a possibly asynchronous host
  // tokenizer. The runtime rechecks its target/settings/source after this call.
  const domain = assertNarrative(value), preferences = clone(domain.preferences[kind]), source = assertRawSummarySource(raw), requestedRange = {start: startFloor, end: endFloor};
  if (!range(requestedRange)) throw new Error('自述或大纲本批范围无效');
  if (kind === 'self' && !preferences.characters.length) throw new Error('请先指定要生成自述的角色');
  const previous = clone(domain[kind]), previousEntries = kind === 'outline' ? previous : previous.flatMap(row => row.entries);
  if (previousEntries.some(entry => entry.sources.some(item => item.end > endFloor)) || domain.progress[kind]?.lastProcessedFloor > endFloor) throw new Error('已有结果包含截止楼层之后的内容，请选择更晚的结束楼层');
  if (domain.progress[kind] && !matchesStoredNarrativeSource(domain.progress[kind].sourceSnapshot, raw)) throw new Error('已有自述或大纲来源已变化，请先更新来源投影');
  const rawMessages = source.messages.filter(row => row.floor <= endFloor).sort((a, b) => a.floor - b.floor);
  if (rawMessages.length !== endFloor + 1 || rawMessages.some((row, index) => row.floor !== index)) throw new Error('截至本批的原文前缀不可用，无法验证来源');
  const sentFloors = preferences.readOriginal ? cleanSummaryFloors(rawMessages.filter(row => row.floor >= startFloor && row.role !== 'system' && !row.system), {includeUser: true, rules: clone(rules)}) : [];
  const originalRanges = mergeRanges(sentFloors.map(row => ({start: row.floor, end: row.floor})));
  const allEvents = clone(events), eventsSnapshot = preferences.readMemory ? narrativeMemoryRows(allEvents, endFloor) : [];
  const requiredMemory = eventsSnapshot.filter(row => row.sources.some(item => item.end >= startFloor));
  const historicalMemory = eventsSnapshot.filter(row => row.sources.every(item => item.end < startFloor)).sort((a, b) => b.sources.at(-1).end - a.sources.at(-1).end || b.sources[0].start - a.sources[0].start || a.id.localeCompare(b.id));
  if (!sentFloors.length && !eventsSnapshot.length) throw new Error('所选范围没有可读取的原文或记忆');
  const background = {initialCharacter: kind === 'self' && preferences.readCard ? narrativeCardFields(clone(card)) : null, supplement: preferences.background};
  const previousPayload = kind === 'outline' ? previous.map(row => row.text) : preferences.characters.map(character => ({id: character.id, name: character.name, entries: previous.find(row => row.id === character.id)?.entries.map(row => row.text) ?? []}));
  const base = {background, previous: previousPayload, memory: [], original: sentFloors.map(row => ({floor: row.floor, speaker: row.role === 'user' ? '用户' : 'AI', time: row.date, text: row.text}))};
  const ticket = {kind, revision: domain.revision, preferences, previous, progress: clone(domain.progress[kind]), source: {epoch: source.epoch, requestedRange, rawMessages, fingerprint: sourceFingerprint(rawMessages)}, eventsSnapshot};
  // Serialize fixed data and each memory exactly once. Older candidates change
  // neither the background nor existing prose nor original-message payloads.
  const parts = narrativeMaterialParts(base).map(row => row.content);
  const prefix = `${parts[0]}\n\n${parts[1]}\n\n${parts[2].slice(0, -2)}`;
  const suffix = `\n\n${parts[3]}`;
  const fixedUnits = estimatedUnits(prefix) + estimatedUnits(suffix) + 2;
  const encoded = new Map();
  for (let index = 0; index < eventsSnapshot.length; index++) {
    const row = eventsSnapshot[index], payload = memoryPayload(row, originalRanges), json = JSON.stringify(payload);
    encoded.set(row.id, {row, payload, json, index, units: estimatedUnits(json)});
    await cooperate();
  }
  const fullText = items => `${prefix}[${items.map(item => item.json).join(',')}]${suffix}`;
  const insertionIndex = (items, index) => {
    let low = 0, high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle].index < index) low = middle + 1; else high = middle; }
    return low;
  };
  const unavailableMemoryCount = preferences.readMemory ? allEvents.filter(row => !row.supersededBy && (!Array.isArray(row.sources) || !row.sources.length || !row.sources.every(range))).length : 0;
  const select = async useHost => {
    const count = async value => {
      guard();
      if (!useHost) return estimateNarrativeTokens(value);
      const result = await countTokens(value);
      guard();
      if (!Number.isFinite(result) || result < 0) throw new TypeError('宿主 token 计数不可用');
      return Math.ceil(result);
    };
    const selected = requiredMemory.map(row => encoded.get(row.id)).sort((a, b) => a.index - b.index);
    let units = fixedUnits + selected.reduce((sum, item) => sum + item.units, 0) + Math.max(0, selected.length - 1);
    let tokens = useHost ? await count(fullText(selected)) : Math.ceil(units / 4);
    const requiredTokens = tokens;
    if (tokens > preferences.budget) {
      const error = new Error(`必要材料需要${useHost ? '' : '约'} ${tokens} token，超过材料预算 ${preferences.budget}；请提高预算或减少本批范围、背景及已有内容`);
      error.code = 'NARRATIVE_BUDGET_EXCEEDED'; error.requiredTokens = tokens; error.budget = preferences.budget; error.estimated = !useHost;
      throw error;
    }
    let omittedMemoryCount = 0;
    for (const memory of historicalMemory) {
      await cooperate();
      const item = encoded.get(memory.id), proposedUnits = units + item.units + (selected.length ? 1 : 0);
      if (!useHost) {
        // Additive estimate units avoid O(n²) cloning/encoding/token scans. Sort
        // accepted rows just once for chronological delivery below.
        const proposedTokens = Math.ceil(proposedUnits / 4);
        if (proposedTokens <= preferences.budget) { selected.push(item); units = proposedUnits; tokens = proposedTokens; } else omittedMemoryCount++;
      } else {
        // A host tokenizer is not necessarily additive across JSON boundaries.
        // Reuse cached encodings but keep exact candidate counts and unchanged
        // nearest-first skip/accept semantics rather than inventing a bound.
        const at = insertionIndex(selected, item.index);
        selected.splice(at, 0, item);
        const proposedTokens = await count(fullText(selected));
        if (proposedTokens <= preferences.budget) { units = proposedUnits; tokens = proposedTokens; }
        else { selected.splice(at, 1); omittedMemoryCount++; }
      }
    }
    selected.sort((a, b) => a.index - b.index);
    const materials = {...base, memory: selected.map(item => item.payload)};
    // One full final check also guards the incremental accounting against a
    // future change in prompt framing or material serialization.
    const actualTokens = await count(materialsText(materials));
    if (actualTokens > preferences.budget || !useHost && actualTokens !== tokens) {
      const error = new Error('最终材料预算校验失败，请调整预算或重试'); error.code = 'NARRATIVE_BUDGET_EXCEEDED'; throw error;
    }
    tokens = actualTokens;
    // A memory-only request must actually send memory, not just its settings.
    if (!materials.original.length && !selected.length) {
      const error = new Error('预算内没有可读取的记忆，请提高预算或提供本批记忆'); error.code = 'NARRATIVE_NO_MATERIAL'; throw error;
    }
    const draft = {...ticket, materials}, request = buildNarrativeRequest({ticket: draft});
    const promptTokens = await count(request.previewParts.filter(part => part.role === 'system').map(part => part.content).join('\n\n'));
    const previousOutput = kind === 'self' ? {characters: base.previous.map(({id, entries}) => ({id, entries}))} : {entries: base.previous};
    // Returning the complete history needs space for existing prose as well as
    // this batch's additions and JSON. This is an extra context allowance, not
    // a claim that an unknown model context window has been verified.
    const existingOutputTokens = await count(JSON.stringify(previousOutput));
    const incrementalOutputTokens = await count('新'.repeat((kind === 'self' ? 100 * preferences.characters.length : 150)));
    const outputReserve = Math.max(1024, existingOutputTokens + incrementalOutputTokens + 256);
    return {...draft, memorySnapshot: selected.map(item => item.row), usage: {budget: preferences.budget, tokens, estimated: !useHost, trimmed: omittedMemoryCount > 0, originalRanges, memoryRanges: mergeRanges(selected.flatMap(item => item.row.sources)), omittedMemoryCount, unavailableMemoryCount, requiredTokens, promptTokens, outputReserve, tokenMethod: useHost ? 'host' : 'estimate'}};
  };
  if (typeof countTokens === 'function') {
    try { return freeze(await select(true)); } catch (error) { if (error.code?.startsWith('NARRATIVE_')) throw error; }
  }
  return freeze(await select(false));
}
