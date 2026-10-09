import { assertRawSummarySource, durableSourceMessages } from '../summary/source.js';
import { prepareLatestSource, storedLatestSource, assertLatestSource, matchesLatestSource, matchesStoredLatestSource } from '../latest/source.js';
import { assertTrackingRecord, blankTrackingRecord, assertTrackingPatch, assertTrackingChanges, applyTrackingCustomFieldValues, trackingExact, trackingText, trackingInteger, npcAbsenceTurns, TRACKING_FIELDS } from './model.js';
const clone = structuredClone;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const generatedId = () => crypto.randomUUID();
export function emptyTracking() { return { schema: 1, revision: 0, preferences: { itemsEnabled: false, npcsEnabled: false }, snapshots: [], manual: [] }; }
export function assertTrackingPreferences(value) {
  if (!trackingExact(value, ['itemsEnabled', 'npcsEnabled']) || typeof value.itemsEnabled !== 'boolean' || typeof value.npcsEnabled !== 'boolean') throw new Error('追踪设置无效');
  return clone(value);
}
export function assertTracking(value) {
  if (!trackingExact(value, ['schema', 'revision', 'preferences', 'snapshots', 'manual']) || value.schema !== 1 || !trackingInteger(value.revision)
    || !Array.isArray(value.snapshots) || !Array.isArray(value.manual)) throw new Error('追踪数据结构无效');
  assertTrackingPreferences(value.preferences);
  const ids = new Set(), replies = new Set();
  for (const snapshot of value.snapshots) {
    if (!trackingExact(snapshot, ['id', 'sourceSnapshot', 'aiTurn', 'baseKey', 'changes']) || !trackingText(snapshot.id) || ids.has(snapshot.id)
      || !trackingInteger(snapshot.aiTurn) || snapshot.aiTurn < 1 || !(snapshot.baseKey === null || trackingText(snapshot.baseKey)) || snapshot.baseKey === snapshot.id) throw new Error('追踪版本无效');
    assertLatestSource(snapshot.sourceSnapshot); assertTrackingChanges(snapshot.changes, { stored: true });
    if (replies.has(snapshot.sourceSnapshot.replyId)) throw new Error('追踪回复版本重复');
    ids.add(snapshot.id); replies.add(snapshot.sourceSnapshot.replyId);
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
  return clone(value);
}
export function trackingOf(root) { return assertTracking(root.tracking === undefined ? emptyTracking() : root.tracking); }
export function countTrackingAiTurns(raw, { beforeFloor = Infinity } = {}) {
  if (!(beforeFloor === Infinity || trackingInteger(beforeFloor))) throw new Error('追踪楼层无效');
  return assertRawSummarySource(raw).messages.filter(row => row.floor < beforeFloor && row.role === 'assistant' && !row.system).length;
}
function applyChanges(records, changes, aiTurn, { mutate = false, index = null, stored = false } = {}) {
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
export function currentTracking(value, raw, { beforeFloor = Infinity } = {}) {
  const domain = assertTracking(value), source = assertRawSummarySource(raw), indexed = sourceIndex(source, beforeFloor);
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
  let baseKey = null; applyManual(null);
  const snapshots = domain.snapshots.filter(row => row.sourceSnapshot.assistantFloor < beforeFloor).sort((a, b) => a.sourceSnapshot.assistantFloor - b.sourceSnapshot.assistantFloor);
  for (const snapshot of snapshots) {
    if (snapshot.baseKey !== baseKey || snapshot.aiTurn !== indexed.turns.get(snapshot.sourceSnapshot.assistantFloor)
      || !matchesStoredLatestSource(snapshot.sourceSnapshot, indexed.relevant(snapshot.sourceSnapshot))) continue;
    applyChanges(records, snapshot.changes, snapshot.aiTurn, { mutate: true, index, stored: true }); applyManual(snapshot.id); baseKey = snapshot.id;
  }
  const visible = records.filter(record => !manualById.get(record.id)?.deleted).map(record => {
    const edit = manualById.get(record.id);
    return edit && Object.hasOwn(edit.patch, 'pinned') ? { ...record, pinned: edit.patch.pinned } : record;
  });
  return { records: visible, items: visible.filter(row => row.kind === 'item'), npcs: visible.filter(row => row.kind === 'npc'), aiTurn: indexed.aiTurn, baseKey,
    absenceTurns: Object.fromEntries(visible.filter(row => row.kind === 'npc').map(row => [row.id, npcAbsenceTurns(row, indexed.aiTurn)])) };
}
export function prepareTrackingUpdate(value, raw, { floor, rules } = {}) {
  const domain = assertTracking(value), source = prepareLatestSource(raw, { floor, rules });
  const prior = currentTracking(domain, raw, { beforeFloor: floor }), current = currentTracking(domain, raw, { beforeFloor: floor + 1 });
  return freeze({ source, aiTurn: countTrackingAiTurns(raw, { beforeFloor: floor + 1 }), baseKey: prior.baseKey,
    revision: domain.revision, current: current.records, preferences: domain.preferences });
}
export function applyTrackingResponse(value, ticket, response, raw, { makeId = generatedId, errors = {} } = {}) {
  const domain = assertTracking(value), changes = assertTrackingChanges(response);
  if (!ticket || ticket.revision !== domain.revision || !matchesLatestSource(ticket.source, raw)
    || ticket.aiTurn !== countTrackingAiTurns(raw, { beforeFloor: ticket.source.assistantFloor + 1 })
    || currentTracking(domain, raw, { beforeFloor: ticket.source.assistantFloor }).baseKey !== ticket.baseKey) throw new Error('追踪来源或资料已变化，请重新运行');
  if (!domain.preferences.itemsEnabled && changes.items.length || !domain.preferences.npcsEnabled && changes.npcs.length) throw new Error('追踪类别未开启');
  if (['items', 'npcs'].every(list => !domain.preferences[`${list}Enabled`] || errors[list])) return domain;
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
  const snapshot = { id: freshId(), sourceSnapshot: storedLatestSource(ticket.source), aiTurn: ticket.aiTurn, baseKey: ticket.baseKey, changes: changesBetween(baseline, updated, ticket.aiTurn) };
  domain.snapshots = domain.snapshots.filter(row => row.sourceSnapshot.replyId !== snapshot.sourceSnapshot.replyId);
  domain.snapshots.push(snapshot);
  if (previous) for (const row of domain.manual) if (row.afterSnapshotId === previous.id) {
    row.afterSnapshotId = snapshot.id;
    const record = updated.find(item => item.id === row.id);
    if (record) { const { id, kind, ...fields } = record; row.patch = clone(fields); }
  }
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
  domain.manual.push({ id, kind, record, patch: {}, deleted: false, afterSnapshotId: null }); domain.revision++; return domain;
}
export function editTrackingRecord(value, raw, id, patch) {
  const domain = assertTracking(value), current = currentTracking(domain, raw), record = current.records.find(row => row.id === id);
  if (!record) throw new Error('追踪记录已变化，请重新打开');
  assertTrackingPatch(record.kind, patch); assertTrackingRecord({ ...record, ...patch });
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
  domain.snapshots = domain.snapshots.filter(row => row.sourceSnapshot.rawMessages.every(message => message.floor < floor));
  const ids = new Set([...domain.manual.filter(row => row.record).map(row => row.id), ...domain.snapshots.flatMap(row => [...row.changes.items, ...row.changes.npcs].map(change => change.id))]);
  domain.manual = domain.manual.filter(row => ids.has(row.id)); return domain;
}
export function invalidateTrackingFloors(value, floors) {
  if (!Array.isArray(floors) || floors.some(floor => !trackingInteger(floor))) throw new Error('追踪失效楼层无效');
  const domain = assertTracking(value), affected = new Set(floors), removed = new Set();
  for (const row of domain.snapshots) if (row.sourceSnapshot.rawMessages.some(message => affected.has(message.floor))) removed.add(row.id);
  let changed = true;
  while (changed) { changed = false; for (const row of domain.snapshots) if (removed.has(row.baseKey) && !removed.has(row.id)) { removed.add(row.id); changed = true; } }
  domain.snapshots = domain.snapshots.filter(row => !removed.has(row.id)); return domain;
}
// Parse errors and unknown/mismatched IDs are isolated by category. A failed
// category keeps its existing same-reply version instead of erasing its facts.
export function applyTrackingResponseParts(value, ticket, parts, raw, options = {}) {
  const changes = { items: [], npcs: [] }, errors = { items: parts?.errors?.items ?? null, npcs: parts?.errors?.npcs ?? null };
  for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) {
    if (errors[list] || !ticket.preferences[`${list}Enabled`]) continue;
    try {
      changes[list] = assertTrackingChanges({ items: [], npcs: [], [list]: parts?.changes?.[list] })[list];
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
  const domain = assertTracking(value), source = assertRawSummarySource(raw), indexed = sourceIndex(source), { byFloor } = indexed;
  if (replyVersions !== undefined && (!Array.isArray(replyVersions) || replyVersions.some(row => !trackingText(row?.replyId) || !trackingInteger(row.floor) || !trackingInteger(row.swipeId) || typeof row.text !== 'string'))) throw new Error('追踪回复版本证据无效');
  const counts = new Map(), byReply = new Map();
  for (const row of replyVersions ?? []) { counts.set(row.replyId, (counts.get(row.replyId) ?? 0) + 1); byReply.set(row.replyId, row); }
  domain.snapshots = domain.snapshots.filter(snapshot => {
    const saved = snapshot.sourceSnapshot;
    if (snapshot.aiTurn !== indexed.turns.get(saved.assistantFloor)) return false;
    if (matchesStoredLatestSource(saved, indexed.relevant(saved))) return replyVersions === undefined || counts.get(saved.replyId) === 1;
    const current = byFloor.get(saved.assistantFloor), version = byReply.get(saved.replyId), original = saved.rawMessages.at(-1);
    if (!current || current.role !== 'assistant' || current.system || current.replyId === saved.replyId || !version || counts.get(saved.replyId) !== 1 || version.floor !== saved.assistantFloor || version.text !== original.text) return false;
    const user = saved.userFloor === null ? null : saved.rawMessages[0], currentUser = user ? byFloor.get(user.floor) : null;
    return !user || !!currentUser && !currentUser.specialPayload && JSON.stringify(durableSourceMessages([currentUser])) === JSON.stringify([user]);
  });
  let changed = true;
  while (changed) { const ids = new Set(domain.snapshots.map(row => row.id)), length = domain.snapshots.length;
    domain.snapshots = domain.snapshots.filter(row => row.baseKey === null || ids.has(row.baseKey)); changed = length !== domain.snapshots.length; }
  return domain;
}
