import { trackingExclusionsOf, assertTrackingExclusions, effectiveTrackingExclusions, filterTrackingChanges, normalizeTrackingName } from './exclusions.js';
import { assertRawSummarySource, storedSourceMessages, assertStoredSourceMessages, matchesSourceMetadata, sourceFingerprint, matchesStoredSummarySource } from '../summary/source.js';
import { prepareLatestSource, storedLatestSource, assertLatestSource, matchesLatestSource, matchesStoredLatestSource } from '../latest/source.js';
import { assertTrackingRecord, blankTrackingRecord, assertTrackingPatch, assertTrackingChanges, applyTrackingCustomFieldValues, trackingExact, trackingText, trackingInteger, npcAbsenceTurns, TRACKING_FIELDS } from './model.js';
import { trackingResultIds } from './identity.js';
const clone = structuredClone;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const generatedId = () => crypto.randomUUID();
export function emptyTracking() { return { schema: 1, revision: 0, preferences: { itemsEnabled: false, npcsEnabled: false }, snapshots: [], manual: [] }; }
export function assertTrackingPreferences(value) {
  if (!trackingExact(value, ['itemsEnabled', 'npcsEnabled']) || typeof value.itemsEnabled !== 'boolean' || typeof value.npcsEnabled !== 'boolean') throw new Error('追踪设置无效');
  return clone(value);
}
export function assertTracking(value) {
  if (!trackingExact(value, ['schema', 'revision', 'preferences', 'snapshots', 'manual', ...(Object.hasOwn(value ?? {}, 'exclusions') ? ['exclusions'] : []), ...(Object.hasOwn(value ?? {}, 'tailHistory') ? ['tailHistory'] : [])]) || value.schema !== 1 || !trackingInteger(value.revision)
    || !Array.isArray(value.snapshots) || !Array.isArray(value.manual)) throw new Error('追踪数据结构无效');
  assertTrackingPreferences(value.preferences);
  if (Object.hasOwn(value, 'exclusions')) assertTrackingExclusions(value.exclusions);
  const ids = new Set(), replies = new Set();
  for (const snapshot of value.snapshots) {
    if (!trackingExact(snapshot, ['id', 'sourceSnapshot', 'aiTurn', 'baseKey', 'changes', ...(snapshot?.sourceSnapshot?.kind === 'batch' ? ['batchId'] : []), ...(Object.hasOwn(snapshot ?? {}, 'batchRebases') ? ['batchRebases'] : [])]) || !trackingText(snapshot.id) || ids.has(snapshot.id)
      || !trackingInteger(snapshot.aiTurn) || snapshot.aiTurn < 1 || !(snapshot.baseKey === null || trackingText(snapshot.baseKey)) || snapshot.baseKey === snapshot.id) throw new Error('追踪版本无效');
    if (Object.hasOwn(snapshot, 'batchRebases')) {
      if (!Array.isArray(snapshot.batchRebases) || !snapshot.batchRebases.length) throw new Error('批追踪恢复证据无效');
      const rebases = new Set();
      for (const proof of snapshot.batchRebases) {
        if (!trackingExact(proof, ['batchSnapshotId', 'baseKey', 'changes', ...(Object.hasOwn(proof ?? {}, 'protectedChanges') ? ['protectedChanges'] : [])]) || !trackingText(proof.batchSnapshotId) || rebases.has(proof.batchSnapshotId) || !(proof.baseKey === null || trackingText(proof.baseKey))) throw new Error('批追踪恢复证据无效');
        assertTrackingChanges(proof.changes, { stored: true });
        if (proof.protectedChanges) assertTrackingChanges(proof.protectedChanges, { stored: true });
        rebases.add(proof.batchSnapshotId);
      }
    }
    const batch = snapshot.sourceSnapshot?.kind === 'batch';
    if (batch) { assertBatchTrackingSource(snapshot.sourceSnapshot); if (!trackingText(snapshot.batchId)) throw new Error('批追踪身份无效'); } else assertLatestSource(snapshot.sourceSnapshot);
    assertTrackingChanges(snapshot.changes, { stored: true });
    if (snapshot.changes.npcs.some(change => change.lastAppearanceTurn != null && change.lastAppearanceTurn > snapshot.aiTurn)) throw new Error('NPC 出场回合超出追踪版本');
    const replyKey = batch ? `batch:${snapshot.batchId}` : snapshot.sourceSnapshot.replyId;
    if (replies.has(replyKey)) throw new Error('追踪回复版本重复');
    ids.add(snapshot.id); replies.add(replyKey);
  }
  const recordIds = new Map();
  for (const snapshot of value.snapshots) for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) for (const change of snapshot.changes[list]) {
    if (ids.has(change.id) || recordIds.has(change.id) && recordIds.get(change.id).kind !== kind) throw new Error('追踪身份混用');
    const prior = recordIds.get(change.id);
    if (change.create && prior?.created) throw new Error('追踪创建身份重复');
    recordIds.set(change.id, { kind, created: change.create || prior?.created === true });
  }
  const manualIds = new Set();
  for (const row of value.manual) {
    if (!trackingExact(row, ['id', 'kind', 'record', 'patch', 'deleted', 'afterSnapshotId']) || !trackingText(row.id) || manualIds.has(row.id) || typeof row.deleted !== 'boolean' || !(row.afterSnapshotId === null || trackingText(row.afterSnapshotId))) throw new Error('人工追踪修改无效');
    assertTrackingPatch(row.kind, row.patch);
    if (row.record !== null) { assertTrackingRecord(row.record); if (row.record.id !== row.id || row.record.kind !== row.kind) throw new Error('人工追踪身份不符'); }
    if (ids.has(row.id) || recordIds.has(row.id) && (recordIds.get(row.id).kind !== row.kind || row.record !== null && recordIds.get(row.id).created)) throw new Error('人工追踪身份重复');
    manualIds.add(row.id);
  }
  if (value.tailHistory !== undefined) assertTrackingTailHistory(value.tailHistory);
  return clone(value);
}
export function trackingOf(root) { return assertTracking(root.tracking === undefined ? emptyTracking() : root.tracking); }
// Visibility is a generation eligibility flag, not a chronological deletion.
// The host supplies the semantic speaker; never infer it from hidden text.
function trackingSource(raw) {
  return {...raw, messages: raw.messages.map(row => ['user', 'assistant', 'system'].includes(row.semanticRole)
    ? {...row, role: row.semanticRole, system: row.semanticRole === 'system'} : row)};
}
export function countTrackingAiTurns(raw, { beforeFloor = Infinity } = {}) {
  if (!(beforeFloor === Infinity || trackingInteger(beforeFloor))) throw new Error('追踪楼层无效');
  return trackingSource(assertRawSummarySource(raw)).messages.filter(row => row.floor < beforeFloor && row.role === 'assistant' && !row.system).length;
}
export function applyChanges(records, changes, aiTurn, { mutate = false, index = null, stored = false } = {}) {
  const next = mutate ? records : clone(records);
  index ??= new Map(next.map((row, at) => [row.id, at]));
  for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) for (const change of changes[list]) {
    const { id, create, appeared, ...patch } = change;
    const at = index.get(id) ?? -1;
    if (create ? at !== -1 : at === -1 || next[at].kind !== kind) throw new Error('追踪更新须指向已确认的记录 ID');
    if (!stored && Object.hasOwn(patch, 'customFields')) {
      if (create) throw new Error('模型不能为新记录创建自定义字段');
      patch.customFields = applyTrackingCustomFieldValues(next[at], patch.customFields);
    }
    const record = create ? blankTrackingRecord(kind, id, patch) : assertTrackingRecord({ ...next[at], ...patch });
    if (kind === 'npc' && appeared === true) record.lastAppearanceTurn = aiTurn;
    if (create) { index.set(id, next.length); next.push(record); } else next[at] = record;
  }
  return next;
}
// Store only the facts changed relative to the preceding reply. During a retry
// this includes still-valid facts from the old result and the user's corrections.
function changesBetween(before, after, aiTurn) {
  const changes = { items: [], npcs: [] };
  for (const record of after) {
    const prior = before.find(row => row.id === record.id), create = !prior;
    const patch = {};
    for (const key of ['name', 'aliases', ...TRACKING_FIELDS[record.kind]]) {
      if (create || JSON.stringify(prior[key]) !== JSON.stringify(record[key])) patch[key] = clone(record[key]);
    }
    // Snapshot diffs are trusted replay data, not model deltas. Keeping the full
    // array here preserves manual add/rename/remove edits on same-reply retries.
    if (JSON.stringify(prior?.customFields ?? []) !== JSON.stringify(record.customFields ?? [])) patch.customFields = clone(record.customFields ?? []);
    if (record.kind === 'npc' && record.lastAppearanceTurn === aiTurn && prior?.lastAppearanceTurn !== aiTurn) patch.appeared = true;
    if (create || Object.keys(patch).length) changes[record.kind === 'item' ? 'items' : 'npcs'].push({ id: record.id, create, ...patch });
  }
  return changes;
}
function sourceIndex(source, beforeFloor = Infinity) {
  if (!(beforeFloor === Infinity || trackingInteger(beforeFloor))) throw new Error('追踪楼层无效');
  const byFloor = new Map(), turns = new Map(); let aiTurn = 0, visibleTurns = 0;
  for (const row of source.messages.slice().sort((a, b) => a.floor - b.floor)) {
    byFloor.set(row.floor, row);
    if (row.role === 'assistant' && !row.system) { aiTurn++; if (row.floor < beforeFloor) visibleTurns++; }
    turns.set(row.floor, aiTurn);
  }
  const relevant = snapshot => ({ epoch: source.epoch, messages: snapshot.rawMessages.flatMap(row => byFloor.has(row.floor) ? [byFloor.get(row.floor)] : []) });
  return { byFloor, turns, aiTurn: visibleTurns, relevant };
}
// Only versions whose exact reply evidence and predecessor are currently active
// contribute. A reroll keeps the AI ordinal and can restore its old version later.
export function currentTracking(value, raw, { beforeFloor = Infinity, includeResultFloors = false } = {}) {
  const domain = assertTracking(value), source = trackingSource(assertRawSummarySource(raw)), indexed = sourceIndex(source, beforeFloor);
  const records = domain.manual.filter(row => row.record !== null).map(row => row.record), index = new Map(records.map((row, at) => [row.id, at]));
  const manualById = new Map(domain.manual.map(row => [row.id, row])), manualBySnapshot = new Map();
  for (const row of domain.manual) {
    if (!manualBySnapshot.has(row.afterSnapshotId)) manualBySnapshot.set(row.afterSnapshotId, []);
    manualBySnapshot.get(row.afterSnapshotId).push(row);
  }
  const applyManual = snapshotId => {
    for (const row of manualBySnapshot.get(snapshotId) ?? []) {
      const at = index.get(row.id); if (at === undefined) continue;
      if (row.kind !== records[at].kind) throw new Error('人工追踪身份不符');
      records[at] = assertTrackingRecord({ ...records[at], ...row.patch });
    }
  };
  const resultFloors = {};
  let baseKey = null; const activeKeys = new Set([null]); applyManual(null);
  const invalidBatches = new Set(domain.snapshots.filter(row => row.sourceSnapshot.kind === 'batch' && (row.aiTurn !== indexed.turns.get(row.sourceSnapshot.assistantFloor) || !matchesBatchTrackingSource(row.sourceSnapshot, source))).map(row => row.id));
  const snapshots = restoreTrackingBatchRebases(domain.snapshots, invalidBatches).filter(row => row.sourceSnapshot.assistantFloor < beforeFloor).sort((a, b) => a.sourceSnapshot.assistantFloor - b.sourceSnapshot.assistantFloor);
  for (const snapshot of snapshots) {
    if (snapshot.baseKey !== baseKey || snapshot.aiTurn !== indexed.turns.get(snapshot.sourceSnapshot.assistantFloor)
      || !(snapshot.sourceSnapshot.kind === 'batch' ? matchesBatchTrackingSource(snapshot.sourceSnapshot, source) : matchesStoredLatestSource(snapshot.sourceSnapshot, indexed.relevant(snapshot.sourceSnapshot)))) continue;
    if (includeResultFloors) for (const id of trackingResultIds(snapshot, records)) Object.defineProperty(resultFloors, id, { value: snapshot.sourceSnapshot.assistantFloor, enumerable: true, configurable: true });
    applyChanges(records, snapshot.changes, snapshot.aiTurn, { mutate: true, index, stored: true });
    // A manual anchor is not an edit timestamp. Historical backfill cannot
    // overwrite corrections merely because they were anchored to an old reply.
    if (snapshot.sourceSnapshot.kind === 'batch') for (const key of activeKeys) applyManual(key);
    applyManual(snapshot.id); activeKeys.add(snapshot.id); baseKey = snapshot.id;
  }
  const visible = records.filter(record => !manualById.get(record.id)?.deleted).map(record => {
    const edit = manualById.get(record.id);
    return edit && Object.hasOwn(edit.patch, 'pinned') ? { ...record, pinned: edit.patch.pinned } : record;
  });
  return { ...(includeResultFloors ? { resultFloors } : {}), records: visible, items: visible.filter(row => row.kind === 'item'), npcs: visible.filter(row => row.kind === 'npc'), aiTurn: indexed.aiTurn, baseKey,
    absenceTurns: Object.fromEntries(visible.filter(row => row.kind === 'npc').map(row => [row.id, npcAbsenceTurns(row, indexed.aiTurn)])) };
}
export function prepareTrackingUpdate(value, raw, { floor, rules } = {}) {
  const domain = assertTracking(value);
  if (domain.snapshots.some(row => row.sourceSnapshot.kind === 'batch' && floor >= row.sourceSnapshot.requestedRange.start && floor <= row.sourceSnapshot.requestedRange.end && matchesBatchTrackingSource(row.sourceSnapshot, raw))) throw new Error('该楼层已属于批追踪，请重跑整批以保留完整来源');
  const source = prepareLatestSource(raw, { floor, rules });
  const prior = currentTracking(domain, raw, { beforeFloor: floor }), current = currentTracking(domain, raw, { beforeFloor: floor + 1 });
  return freeze({ source, aiTurn: countTrackingAiTurns(raw, { beforeFloor: floor + 1 }), baseKey: prior.baseKey,
    revision: domain.revision, current: current.records, preferences: domain.preferences, exclusions: effectiveTrackingExclusions(domain, current.records) });
}
export function applyTrackingResponse(value, ticket, response, raw, { makeId = generatedId, errors = {} } = {}) {
  const domain = assertTracking(value); let changes = assertTrackingChanges(response);
  if (domain.snapshots.some(row => row.sourceSnapshot.kind === 'batch' && ticket?.source?.assistantFloor >= row.sourceSnapshot.requestedRange.start && ticket.source.assistantFloor <= row.sourceSnapshot.requestedRange.end && matchesBatchTrackingSource(row.sourceSnapshot, raw))) throw new Error('该楼层已属于批追踪，请重跑整批以保留完整来源');
  if (!ticket || ticket.revision !== domain.revision || (ticket.exclusions?.epoch ?? 0) !== trackingExclusionsOf(domain).epoch || !matchesLatestSource(ticket.source, raw)
    || ticket.aiTurn !== countTrackingAiTurns(raw, { beforeFloor: ticket.source.assistantFloor + 1 })
    || currentTracking(domain, raw, { beforeFloor: ticket.source.assistantFloor }).baseKey !== ticket.baseKey) throw new Error('追踪来源或资料已变化，请重新运行');
  if (!domain.preferences.itemsEnabled && changes.items.length || !domain.preferences.npcsEnabled && changes.npcs.length) throw new Error('追踪类别未开启');
  if (['items', 'npcs'].every(list => !domain.preferences[`${list}Enabled`] || errors[list])) return domain;
  const capturedRecords = currentTracking(domain, raw, { beforeFloor: ticket.source.assistantFloor + 1 }).records;
  changes = filterTrackingChanges(changes, capturedRecords, effectiveTrackingExclusions(domain, capturedRecords));
  const previous = domain.snapshots.find(row => row.sourceSnapshot.replyId === ticket.source.replyId && row.baseKey === ticket.baseKey && matchesStoredLatestSource(row.sourceSnapshot, raw));
  const existingIds = new Set([...domain.manual.map(row => row.id), ...domain.snapshots.flatMap(row => [...row.changes.items, ...row.changes.npcs].map(change => change.id)), ...domain.snapshots.map(row => row.id)]);
  const freshId = () => { const id = makeId(); if (!trackingText(id) || existingIds.has(id)) throw new Error('追踪身份重复'); existingIds.add(id); return id; };
  for (const list of ['items', 'npcs']) changes[list] = errors[list] || !domain.preferences[`${list}Enabled`] ? [] : changes[list].map(change => ({ ...change, id: change.id ?? freshId(), create: change.id === null }));
  // Validate against the current baseline too; a caller-supplied ticket cannot
  // invent a record that was never present in the captured chat.
  const baseline = currentTracking(domain, raw, { beforeFloor: ticket.source.assistantFloor }).records;
  const current = currentTracking(domain, raw, { beforeFloor: ticket.source.assistantFloor + 1 }).records;
  if (JSON.stringify(current) !== JSON.stringify(ticket.current)) throw new Error('追踪资料快照已变化，请重新运行');
  const updated = applyChanges(current, changes, ticket.aiTurn);
  // Explicit negative evidence on a retry corrects this reply's former positive
  // appearance; omission still preserves the already confirmed current value.
  if (previous) for (const change of changes.npcs) if (change.appeared === false) {
    const record = updated.find(row => row.id === change.id);
    if (record?.lastAppearanceTurn === ticket.aiTurn) record.lastAppearanceTurn = baseline.find(row => row.id === change.id)?.lastAppearanceTurn ?? null;
  }
  ensureTrackingTailHistory(domain);
  const snapshot = { id: freshId(), sourceSnapshot: storedLatestSource(ticket.source), aiTurn: ticket.aiTurn, baseKey: ticket.baseKey, changes: changesBetween(baseline, updated, ticket.aiTurn) };
  domain.snapshots = domain.snapshots.filter(row => row.sourceSnapshot.replyId !== snapshot.sourceSnapshot.replyId);
  domain.snapshots.push(snapshot);
  if (previous) for (const row of domain.manual) if (row.afterSnapshotId === previous.id) {
    recordTrackingManualInverse(domain, row.id);
    row.afterSnapshotId = snapshot.id;
    const record = updated.find(item => item.id === row.id);
    if (record) { const { id, kind, ...fields } = record; row.patch = clone(fields); }
  }
  checkpointTrackingGeneration(domain, snapshot.id);
  domain.revision++;
  return assertTracking(domain);
}
export function setTrackingPreferences(value, preferences) {
  const domain = assertTracking(value); domain.preferences = assertTrackingPreferences(preferences); domain.revision++; return domain;
}
export function addTrackingRecord(value, draft, { makeId = generatedId } = {}) {
  const domain = assertTracking(value), { kind, ...fields } = draft ?? {}, id = makeId();
  if (domain.manual.some(row => row.id === id) || domain.snapshots.some(row => row.id === id || [...row.changes.items, ...row.changes.npcs].some(change => change.id === id))) throw new Error('追踪身份重复');
  const record = blankTrackingRecord(kind, id, fields);
  recordTrackingManualInverse(domain, id);
  domain.manual.push({ id, kind, record, patch: {}, deleted: false, afterSnapshotId: null }); domain.revision++; return domain;
}
export function editTrackingRecord(value, raw, id, patch) {
  const domain = assertTracking(value), current = currentTracking(domain, raw), record = current.records.find(row => row.id === id);
  if (!record) throw new Error('追踪记录已变化，请重新打开');
  assertTrackingPatch(record.kind, patch); assertTrackingRecord({ ...record, ...patch });
  recordTrackingManualInverse(domain, id);
  let row = domain.manual.find(item => item.id === id);
  if (!row) { row = { id, kind: record.kind, record: null, patch: {}, deleted: false, afterSnapshotId: current.baseKey }; domain.manual.push(row); }
  const { id: ignoredId, kind: ignoredKind, ...fields } = record;
  row.patch = { ...fields, ...clone(patch) }; row.afterSnapshotId = current.baseKey; domain.revision++; return domain;
}
export function setTrackingPinned(value, raw, id, pinned) { return editTrackingRecord(value, raw, id, { pinned }); }
export function deleteTrackingRecord(value, raw, id) {
  const domain = editTrackingRecord(value, raw, id, {}); domain.manual.find(row => row.id === id).deleted = true; return domain;
}
export function inheritTracking(value, floor) {
  if (!trackingInteger(floor)) throw new Error('分支楼层无效');
  const domain = assertTracking(value); domain.revision = 0;
  domain.snapshots = restoreTrackingBatchRebases(domain.snapshots, new Set(domain.snapshots.filter(row => row.sourceSnapshot.rawMessages.some(message => message.floor >= floor)).map(row => row.id)));
  const ids = new Set([...domain.manual.filter(row => row.record).map(row => row.id), ...domain.snapshots.flatMap(row => [...row.changes.items, ...row.changes.npcs].map(change => change.id))]);
  domain.manual = domain.manual.filter(row => ids.has(row.id)); resetTrackingTailHistory(domain); return domain;
}
export function invalidateTrackingFloors(value, floors) {
  if (!Array.isArray(floors) || floors.some(floor => !trackingInteger(floor))) throw new Error('追踪失效楼层无效');
  const domain = assertTracking(value), affected = new Set(floors), removed = new Set();
  for (const row of domain.snapshots) if (row.sourceSnapshot.rawMessages.some(message => affected.has(message.floor))) removed.add(row.id);
  domain.snapshots = restoreTrackingBatchRebases(domain.snapshots, removed);
  if (floors.length) resetTrackingTailHistory(domain);
  return domain;
}
// Parse errors and unknown/mismatched IDs are isolated by category. A failed
// category keeps its existing same-reply version instead of erasing its facts.
export function applyTrackingResponseParts(value, ticket, parts, raw, options = {}) {
  const changes = { items: [], npcs: [] }, errors = { items: parts?.errors?.items ?? null, npcs: parts?.errors?.npcs ?? null };
  for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) {
    if (errors[list] || !ticket.preferences[`${list}Enabled`]) continue;
    try {
      changes[list] = assertTrackingChanges({ items: [], npcs: [], [list]: parts?.changes?.[list] })[list];
      changes[list] = filterTrackingChanges({ items: [], npcs: [], [list]: changes[list] }, ticket.current, effectiveTrackingExclusions(assertTracking(value), ticket.current))[list];
      for (const change of changes[list]) if (change.id !== null) {
        const record = ticket.current.find(row => row.id === change.id && row.kind === kind);
        if (!record) throw new Error('追踪更新须指向已确认的记录 ID');
        if (Object.hasOwn(change, 'customFields')) applyTrackingCustomFieldValues(record, change.customFields);
      }
    } catch (error) { changes[list] = []; errors[list] = error.message; }
  }
  return { tracking: applyTrackingResponse(value, ticket, changes, raw, { ...options, errors }), errors };
}
export function pruneTrackingSnapshots(value, raw, { replyVersions = raw?.replyVersions } = {}) {
  const domain = assertTracking(value), source = trackingSource(assertRawSummarySource(raw)), indexed = sourceIndex(source), { byFloor } = indexed;
  if (replyVersions !== undefined && (!Array.isArray(replyVersions) || replyVersions.some(row => !trackingText(row?.replyId) || !trackingInteger(row.floor) || !trackingInteger(row.swipeId)))) throw new Error('追踪回复版本证据无效');
  const counts = new Map(), byReply = new Map();
  for (const row of replyVersions ?? []) { counts.set(row.replyId, (counts.get(row.replyId) ?? 0) + 1); byReply.set(row.replyId, row); }
  const retained = domain.snapshots.filter(snapshot => {
    const saved = snapshot.sourceSnapshot;
    // Old per-turn snapshots counted only visible predecessors. Preserve a
    // lower legacy ordinal when its actual source still passes ownership
    // checks below; projection stays strict and never guesses NPC history.
    const currentTurn = indexed.turns.get(saved.assistantFloor);
    if (snapshot.aiTurn !== currentTurn && !(saved.kind !== 'batch' && snapshot.aiTurn < currentTurn)) return false;
    if (saved.kind === 'batch') return matchesBatchTrackingSource(saved, source);
    if (matchesStoredLatestSource(saved, indexed.relevant(saved))) return replyVersions === undefined || counts.get(saved.replyId) === 1;
    const current = byFloor.get(saved.assistantFloor), version = byReply.get(saved.replyId);
    if (!current || current.role !== 'assistant' || current.system || current.replyId === saved.replyId || !version || counts.get(saved.replyId) !== 1 || version.floor !== saved.assistantFloor) return false;
    const user = saved.userFloor === null ? null : saved.rawMessages[0], currentUser = user ? byFloor.get(user.floor) : null;
    return !user || !!currentUser && !currentUser.specialPayload && matchesSourceMetadata([currentUser], [user]);
  });
  const retainedIds = new Set(retained.map(row => row.id)), originalSnapshots = JSON.stringify(domain.snapshots);
  domain.snapshots = restoreTrackingBatchRebases(domain.snapshots, new Set(domain.snapshots.filter(row => !retainedIds.has(row.id)).map(row => row.id)));
  let changed = true;
  while (changed) { const ids = new Set(domain.snapshots.map(row => row.id)), length = domain.snapshots.length;
    domain.snapshots = domain.snapshots.filter(row => row.baseKey === null || ids.has(row.baseKey)); changed = length !== domain.snapshots.length; }
  if (JSON.stringify(domain.snapshots) !== originalSnapshots) resetTrackingTailHistory(domain);
  return domain;
}

export function setTrackingExclusionNames(value, kind, names) {
  const domain = assertTracking(value), exclusions = trackingExclusionsOf(domain);
  if (!['item', 'npc'].includes(kind) || !Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('追踪排除名称无效');
  const normalized = [...new Set(names.map(normalizeTrackingName).filter(Boolean))];
  if (JSON.stringify(normalized) === JSON.stringify(exclusions[kind].names)) return domain;
  exclusions[kind].names = normalized; exclusions.epoch++;
  domain.exclusions = assertTrackingExclusions(exclusions); domain.revision++; return domain;
}
export function setTrackingRecordExcluded(value, raw, kind, id, excluded) {
  const domain = assertTracking(value), exclusions = trackingExclusionsOf(domain);
  if (!['item', 'npc'].includes(kind) || typeof excluded !== 'boolean' || !trackingText(id)) throw new Error('追踪排除身份无效');
  if (!currentTracking(domain, raw).records.some(row => row.id === id && row.kind === kind) && !(exclusions[kind].ids.includes(id) && !excluded)) throw new Error('追踪记录已变化，请重新读取');
  if (exclusions[kind].ids.includes(id) === excluded) return domain;
  exclusions[kind].ids = excluded ? [...exclusions[kind].ids, id] : exclusions[kind].ids.filter(value => value !== id);
  // Keep identity labels captured at pause even if source pruning or a later
  // same-reply retry replaces the historical snapshot that supplied them.
  const labels = { ...(exclusions[kind].labels ?? {}) };
  if (excluded) {
    const evidence = { ...domain, exclusions: { ...trackingExclusionsOf(domain), [kind]: { names: [], ids: [id] } } };
    Object.defineProperty(labels, id, { value: effectiveTrackingExclusions(evidence, currentTracking(domain, raw).records)[kind].names, enumerable: true, configurable: true, writable: true });
  } else delete labels[id];
  if (Object.keys(labels).length) exclusions[kind].labels = labels; else delete exclusions[kind].labels;
  exclusions.epoch++; domain.exclusions = assertTrackingExclusions(exclusions); domain.revision++; return domain;
}

// Batch snapshots retain floor ownership and send participation, never chat text.
export function assertBatchTrackingSource(value) {
  if (!trackingExact(value, ['kind', 'assistantFloor', 'requestedRange', 'actualRange', 'rawMessages', 'sentFloors', 'fingerprint', 'replyIds']) || value.kind !== 'batch') throw new Error('批追踪来源无效');
  for (const range of [value.requestedRange, value.actualRange]) if (!trackingExact(range, ['start', 'end']) || !trackingInteger(range.start) || !trackingInteger(range.end) || range.end < range.start) throw new Error('批追踪范围无效');
  if (value.actualRange.start !== value.requestedRange.start || value.actualRange.end > value.requestedRange.end || value.assistantFloor !== value.actualRange.end) throw new Error('批追踪范围不符');
  assertStoredSourceMessages(value.rawMessages);
  assertStoredSourceMessages(value.sentFloors);
  if (value.rawMessages.length !== value.requestedRange.end - value.requestedRange.start + 1 || value.rawMessages.some((row, index) => row.floor !== value.requestedRange.start + index) || value.fingerprint !== sourceFingerprint(value.rawMessages)) throw new Error('批追踪来源指纹不符');
  if (!Array.isArray(value.replyIds) || value.replyIds.some(row => !trackingExact(row, ['floor', 'replyId']) || !trackingInteger(row.floor) || !(row.replyId === null || trackingText(row.replyId))) || new Set(value.replyIds.map(row => row.floor)).size !== value.replyIds.length) throw new Error('批追踪回复证据无效');
  const endpoint = value.rawMessages.find(row => row.floor === value.assistantFloor);
  if (endpoint?.role !== 'assistant' || endpoint.system || !value.sentFloors.some(row => row.role === 'assistant' && !row.system)) throw new Error('批追踪缺少 AI 正文');
  for (const row of value.sentFloors) {
    const original = value.rawMessages.find(item => item.floor === row.floor);
    if (!original || row.floor > value.actualRange.end || row.system || row.role === 'system' || ['identity', 'role', 'system', 'date', 'swipeId'].some(key => row[key] !== original[key])) throw new Error('批追踪发送正文无效');
  }
  return clone(value);
}
export function storedBatchTrackingSource(source) {
  return assertBatchTrackingSource({ kind: 'batch', assistantFloor: source.actualRange.end, requestedRange: clone(source.requestedRange), actualRange: clone(source.actualRange), rawMessages: storedSourceMessages(source.rawMessages), sentFloors: storedSourceMessages(source.sentFloors), fingerprint: sourceFingerprint(source.rawMessages), replyIds: source.rawMessages.filter(row => row.role === 'assistant' && !row.system).map(row => ({ floor: row.floor, replyId: row.replyId ?? null })) });
}
export function matchesBatchTrackingSource(source, raw) {
  try {
    assertBatchTrackingSource(source);
    const current = trackingSource(raw);
    // Older batches predate reply UUID initialization. Their strict floor,
    // speaker, date and swipe locators still apply; known UUIDs stay exact.
    return matchesStoredSummarySource(source, current) && source.replyIds.every(row => row.replyId === null || (current.messages.find(message => message.floor === row.floor)?.replyId ?? null) === row.replyId);
  } catch { return false; }
}

// Inserting a historical batch must not make pre-existing later facts depend
// irreversibly on its source. Unwind saved rebase layers before cascading.
export function restoreTrackingBatchRebases(snapshots, removedIds) {
  const result = clone(snapshots), removed = new Set(removedIds), byId = new Map(result.map(row => [row.id, row]));
  const retainedInsertionBefore = (id, seen = new Set()) => {
    if (seen.has(id)) return null; seen.add(id);
    const predecessor = byId.get(id)?.batchRebases?.at(-1)?.batchSnapshotId;
    if (!predecessor) return null;
    return removed.has(predecessor) ? retainedInsertionBefore(predecessor, seen) : predecessor;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of result) {
      if (removed.has(row.id)) continue;
      while (row.batchRebases?.length && removed.has(row.batchRebases.at(-1).batchSnapshotId)) {
        const proof = row.batchRebases.pop();
        const retained = retainedInsertionBefore(proof.batchSnapshotId);
        row.baseKey = retained ?? proof.baseKey;
        row.changes = clone(retained ? (proof.protectedChanges ?? proof.changes) : proof.changes);
        // An earlier batch inserted through the now-invalid batch is still
        // authoritative. Transfer the restoration proof to that surviving
        // insertion, instead of creating a competing old-base branch.
        if (retained) row.batchRebases.push({ ...proof, batchSnapshotId: retained });
        changed = true;
        if (!row.batchRebases.length) delete row.batchRebases;
      }
      if (removed.has(row.baseKey)) { removed.add(row.id); changed = true; }
    }
  }
  return result.filter(row => !removed.has(row.id));
}


// A journal entry holds only the touched manual row, never a copy of the
// tracking collection or AI evidence. Anchors are replay locations, not clocks.
function ensureTrackingTailHistory(domain) {
  domain.tailHistory ??= { schema: 1, sequence: 0, baseline: domain.snapshots.length === 0 && domain.manual.length === 0,
    checkpoints: [], inverse: [] };
  return domain.tailHistory;
}
function assertTrackingTailHistory(history) {
  if (!trackingExact(history, ['schema', 'sequence', 'baseline', 'checkpoints', 'inverse']) || history.schema !== 1
    || !trackingInteger(history.sequence) || typeof history.baseline !== 'boolean'
    || !Array.isArray(history.checkpoints) || !Array.isArray(history.inverse)) throw new Error('追踪回退记录无效');
  const sequences = new Set(), snapshots = new Set();
  for (const [rows, type] of [[history.checkpoints, 'checkpoint'], [history.inverse, 'inverse']]) {
    let previous = 0;
    for (const row of rows) {
      if (!trackingInteger(row.sequence) || row.sequence <= previous || row.sequence > history.sequence || sequences.has(row.sequence)) throw new Error('追踪回退顺序无效');
      previous = row.sequence; sequences.add(row.sequence);
      if (type === 'checkpoint') {
        if (!trackingExact(row, ['sequence', 'snapshotId', 'throughFloor']) || !trackingText(row.snapshotId) || !trackingInteger(row.throughFloor) || snapshots.has(row.snapshotId)) throw new Error('追踪回退边界无效');
        snapshots.add(row.snapshotId);
      } else {
        if (!trackingExact(row, ['sequence', 'id', 'before']) || !trackingText(row.id)) throw new Error('追踪人工逆操作无效');
        const before = row.before;
        if (before !== null) {
          if (!trackingExact(before, ['id', 'kind', 'record', 'patch', 'deleted', 'afterSnapshotId']) || before.id !== row.id
            || typeof before.deleted !== 'boolean' || !(before.afterSnapshotId === null || trackingText(before.afterSnapshotId))) throw new Error('追踪人工逆操作无效');
          assertTrackingPatch(before.kind, before.patch);
          if (before.record !== null) { assertTrackingRecord(before.record); if (before.record.id !== row.id || before.record.kind !== before.kind) throw new Error('追踪人工逆操作身份无效'); }
        }
      }
    }
  }
}
function recordTrackingManualInverse(domain, id) {
  const history = ensureTrackingTailHistory(domain);
  const sequence = ++history.sequence, boundary = history.checkpoints.at(-1)?.sequence ?? 0;
  // Several edits to one row between successful generations need only its
  // first pre-edit value. This bounds journal growth by touched identities.
  if (!history.inverse.some(row => row.id === id && row.sequence > boundary))
    history.inverse.push({ sequence, id, before: clone(domain.manual.find(row => row.id === id) ?? null) });
}
// Called only after a successful AI commit, including a valid empty response.
export function checkpointTrackingGeneration(domain, snapshotId) {
  const history = ensureTrackingTailHistory(domain), snapshot = domain.snapshots.find(row => row.id === snapshotId);
  const prior = history.checkpoints.at(-1), previous = domain.snapshots.find(row => row.id === prior?.snapshotId);
  const start = snapshot.sourceSnapshot.kind === 'batch' ? snapshot.sourceSnapshot.requestedRange.start : snapshot.sourceSnapshot.assistantFloor;
  // Replacing/retrying an old result or inserting a historical batch destroys
  // append-only coverage. The committed state becomes a new, honest boundary.
  if (prior && (!previous || previous.id === snapshotId || prior.throughFloor >= start)) {
    history.baseline = false; history.checkpoints = []; history.inverse = [];
  }
  history.checkpoints.push({ sequence: ++history.sequence, snapshotId, throughFloor: Math.max(...domain.snapshots.map(row => row.sourceSnapshot.requestedRange?.end ?? row.sourceSnapshot.assistantFloor)) });
}

// The root transaction supplies verified host-object deletion evidence. This
// additional guard rejects a changed prefix; length alone never triggers undo.
export function rollbackTrackingTail(value, beforeRaw, afterRaw) {
  const domain = assertTracking(value), before = assertRawSummarySource(beforeRaw), after = assertRawSummarySource(afterRaw);
  if (after.messages.length >= before.messages.length || before.messages.some((row, index) => row.floor !== index)
    || after.messages.some((row, index) => row.floor !== index || JSON.stringify(row) !== JSON.stringify(before.messages[index]))) throw new Error('追踪尾部删除来源无效');
  const fromFloor = after.messages.length, history = domain.tailHistory;
  // Remove the whole affected generation and its dependent chain. This also
  // works for older saves without a manual inverse journal: no unavailable
  // state, synthetic checkpoint, or mandatory rebuild is introduced.
  const removed = new Set(domain.snapshots.filter(snapshot => snapshot.sourceSnapshot.rawMessages.some(row => row.floor >= fromFloor)).map(row => row.id));
  const retained = restoreTrackingBatchRebases(domain.snapshots, removed), retainedIds = new Set(retained.map(row => row.id));
  const boundary = history?.checkpoints.filter(row => retainedIds.has(row.snapshotId) && row.throughFloor < fromFloor).at(-1);
  const sequence = boundary?.sequence ?? 0;
  const manual = new Map(domain.manual.map(row => [row.id, row]));
  // Known inverse entries undo every manual mutation after the retained
  // generation, even edits anchored to an older snapshot or to null.
  for (const inverse of history?.inverse.slice().reverse() ?? []) if (inverse.sequence > sequence) {
    if (inverse.before === null) manual.delete(inverse.id); else manual.set(inverse.id, clone(inverse.before));
  }
  const generatedIds = new Set(retained.flatMap(row => [...row.changes.items, ...row.changes.npcs].map(change => change.id)));
  domain.manual = [...manual.values()].filter(row => row.record !== null || generatedIds.has(row.id)).map(row => {
    if (row.afterSnapshotId === null || retainedIds.has(row.afterSnapshotId)) return row;
    // A surviving manual seed remains independent; a patch tied to a removed
    // generated version is not carried onto a different predecessor.
    return { ...row, patch: {}, deleted: false, afterSnapshotId: null };
  });
  domain.snapshots = retained;
  if (history) {
    history.inverse = history.inverse.filter(row => row.sequence <= sequence);
    history.checkpoints = history.checkpoints.filter(row => row.sequence <= sequence && retainedIds.has(row.snapshotId));
    history.sequence = sequence;
  }
  const changed = JSON.stringify(domain) !== JSON.stringify(value);
  if (changed) domain.revision++;
  return { tracking: assertTracking(domain), rolledBack: changed, unavailable: false, fromFloor };
}

function resetTrackingTailHistory(domain) {
  if (domain.tailHistory) domain.tailHistory = { schema: 1, sequence: 0, baseline: false, checkpoints: [], inverse: [] };
}
// Explicit non-tail source transitions have no chronological inverse guarantee.
export function invalidateTrackingTailHistory(value) {
  const domain = assertTracking(value); resetTrackingTailHistory(domain); return domain;
}

