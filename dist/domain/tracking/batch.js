import { assertTracking, assertTrackingPreferences, currentTracking, countTrackingAiTurns, applyChanges, storedBatchTrackingSource, matchesBatchTrackingSource, checkpointTrackingGeneration } from './data.js';
import { assertRawSummarySource, matchesSummarySource } from '../summary/source.js';
import { assertTrackingChanges, assertTrackingRecord, applyTrackingCustomFieldValues, trackingInteger, trackingText, TRACKING_FIELDS } from './model.js';
import { effectiveTrackingExclusions, filterTrackingChanges, trackingExclusionsOf, normalizeTrackingName, trackingRecordExcluded } from './exclusions.js';
const clone = structuredClone;
const lists = ['items', 'npcs'];
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function historicalCurrent(domain, raw, start) {
  const before = domain.snapshots.filter(row => row.sourceSnapshot.assistantFloor < start).sort((a, b) => a.sourceSnapshot.assistantFloor - b.sourceSnapshot.assistantFloor);
  // Manual anchors identify a tracking version, not the floor/time of the
  // edit. Neither seeds nor patch values establish historical facts.
  const historical = { ...domain, snapshots: before, manual: [] };
  // AI updates may refer to a manual seed; omit such changes when its historical
  // existence cannot be proved instead of leaking the present seed backwards.
  const known = new Set();
  historical.snapshots = before.map(row => ({ ...row, changes: Object.fromEntries(lists.map(list => [list, row.changes[list].filter(change => {
    if (change.create) known.add(change.id);
    return known.has(change.id);
  })])) }));
  const current = currentTracking(historical, raw, { beforeFloor: start });
  const latest = currentTracking(domain, raw).records;
  for (const record of current.records) {
    const definitions = latest.find(row => row.id === record.id)?.customFields;
    if (definitions) record.customFields = definitions.map(field => ({ ...field, value: record.customFields?.find(old => old.id === field.id)?.value ?? '' }));
  }
  return current;
}

export function prepareBatchTracking(value, raw, source, preferences, { batchId = null } = {}) {
  const domain = assertTracking(value);
  assertRawSummarySource(raw); storedBatchTrackingSource(source);
  if (!matchesSummarySource(source, raw)) throw new Error('批追踪来源已变化，请重新运行');
  const current = historicalCurrent(domain, raw, source.actualRange.start);
  return freeze({ source: clone(source), revision: domain.revision, baseKey: current.baseKey, current: current.records,
    preferences: assertTrackingPreferences(preferences ?? domain.preferences), exclusions: effectiveTrackingExclusions(domain, current.records),
    aiTurn: countTrackingAiTurns(raw, { beforeFloor: source.actualRange.end + 1 }), batchId });
}

function protectRecords(snapshot, records) {
  // A later snapshot remains authoritative for every fact it already knew.
  // Keep its identity/provenance and creations, so its manual anchors survive.
  const changes = clone(snapshot.changes);
  for (const record of records) {
    const list = record.kind === 'item' ? 'items' : 'npcs';
    const existing = changes[list].find(row => row.id === record.id);
    const patch = Object.fromEntries(['name', 'aliases', ...TRACKING_FIELDS[record.kind], ...(record.customFields ? ['customFields'] : []), ...(record.kind === 'npc' ? ['lastAppearanceTurn'] : [])].map(key => [key, clone(record[key])]));
    if (existing) Object.assign(existing, patch); else changes[list].push({ id: record.id, create: false, ...patch });
    if (existing) delete existing.appeared;
  }
  return changes;
}


function successorBaseline(domain, snapshot) {
  const byId = new Map(domain.snapshots.map(row => [row.id, row])), ancestors = [], seen = new Set();
  let key = snapshot.baseKey, nextFloor = snapshot.sourceSnapshot.assistantFloor;
  while (key !== null) {
    const row = byId.get(key);
    if (!row || seen.has(key) || row.sourceSnapshot.assistantFloor >= nextFloor) throw new Error('追踪前置版本链无效，无法安全合并');
    seen.add(key); ancestors.unshift(row); key = row.baseKey; nextFloor = row.sourceSnapshot.assistantFloor;
  }
  // Same-base siblings are alternative chains even when their floors differ.
  // Replay only this successor's ancestors; never borrow the visible branch.
  // Replay generated deltas through this exact predecessor chain. Dormant
  // swipes require no reconstructed historical chat bodies or host mutation.
  const records = domain.manual.filter(row => row.record !== null).map(row => clone(row.record));
  const index = new Map(records.map((row, at) => [row.id, at])), active = new Set([null]);
  const applyManual = key => {
    for (const row of domain.manual) if (row.afterSnapshotId === key && index.has(row.id)) {
      const at = index.get(row.id);
      if (records[at].kind !== row.kind) throw new Error('人工追踪身份不符');
      records[at] = assertTrackingRecord({ ...records[at], ...row.patch });
    }
  };
  applyManual(null);
  for (const ancestor of ancestors) {
    applyChanges(records, ancestor.changes, ancestor.aiTurn, { mutate: true, index, stored: true });
    if (ancestor.sourceSnapshot.kind === 'batch') for (const key of active) applyManual(key);
    applyManual(ancestor.id); active.add(ancestor.id);
  }
  // Pin is a presentation override across branches, as in currentTracking.
  return records.map(record => {
    const manual = domain.manual.find(row => row.id === record.id);
    return manual && Object.hasOwn(manual.patch, 'pinned') ? { ...record, pinned: manual.patch.pinned } : record;
  });
}

export function applyBatchTracking(value, ticket, parts, raw, { makeId = () => crypto.randomUUID(), batchId = ticket?.batchId } = {}) {
  const domain = assertTracking(value), errors = { items: parts?.errors?.items ?? null, npcs: parts?.errors?.npcs ?? null };
  const enabled = list => ticket?.preferences?.[`${list}Enabled`] === true;
  const conflict = message => ({ tracking: domain, errors: Object.fromEntries(lists.map(list => [list, enabled(list) ? message : errors[list]])) });
  if (!ticket || !trackingText(batchId) || ticket.revision !== domain.revision || (ticket.exclusions?.epoch ?? 0) !== trackingExclusionsOf(domain).epoch
    || !matchesSummarySource(ticket.source, raw)) return conflict('批追踪来源或资料已变化，请重新运行');
  const source = storedBatchTrackingSource(ticket.source), current = historicalCurrent(domain, raw, source.actualRange.start);
  if (!same(current.records, ticket.current) || current.baseKey !== ticket.baseKey || ticket.aiTurn !== countTrackingAiTurns(raw, { beforeFloor: source.assistantFloor + 1 })) return conflict('批追踪历史资料已变化，请重新运行');
  const previous = domain.snapshots.find(row => row.batchId === batchId);
  if (previous && (!same(previous.sourceSnapshot.requestedRange, source.requestedRange) || !matchesBatchTrackingSource(previous.sourceSnapshot, raw))) return conflict('已有批追踪的来源已变化，保留原版本');
  const overlapping = domain.snapshots.filter(row => row !== previous && row.sourceSnapshot.assistantFloor >= source.actualRange.start && (row.sourceSnapshot.kind === 'batch' ? row.sourceSnapshot.requestedRange.start : row.sourceSnapshot.assistantFloor) <= source.requestedRange.end);
  if (overlapping.length) return conflict('所选范围已有追踪版本，无法安全合并；已保留原追踪资料');
  const allIds = new Set([...domain.snapshots.flatMap(row => [row.id, ...lists.flatMap(list => row.changes[list].map(change => change.id))]), ...domain.manual.map(row => row.id)]);
  const freshId = () => { const id = makeId(); if (!trackingText(id) || allIds.has(id)) throw new Error('追踪身份重复'); allIds.add(id); return id; };
  const changes = { items: [], npcs: [] }, rejected = clone(parts?.rejected ?? { items: [], npcs: [] });
  const accepted = new Set();
  const inputRows = lists.flatMap(list => enabled(list) && Array.isArray(parts?.changes?.[list]) ? parts.changes[list] : []);
  const duplicateId = id => id !== null && inputRows.filter(row => row?.id === id).length > 1;
  const labels = row => [row?.name, ...(Array.isArray(row?.aliases) ? row.aliases : [])].map(normalizeTrackingName).filter(Boolean);
  // Identity evidence only: never copy later/manual facts into the historical patch.
  const history = list => domain.snapshots.flatMap(snapshot => [snapshot.changes, ...(snapshot.batchRebases ?? []).flatMap(proof => [proof.changes, proof.protectedChanges])].flatMap(changes => changes?.[list] ?? []))
    .concat(domain.manual.filter(row => row.kind === (list === 'items' ? 'item' : 'npc')).flatMap(row => [{ ...row.record, id: row.id }, { ...row.patch, id: row.id }]));
  for (const list of lists) for (const row of history(list)) allIds.add(row.id);
  for (const kind of ['item', 'npc']) for (const id of ticket.exclusions[kind].ids) allIds.add(id);
  for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) {
    changes[list] = clone(previous?.changes[list] ?? []);
    if (!enabled(list) || errors[list] && !rejected[list]?.length) continue;
    const input = parts?.changes?.[list];
    if (!Array.isArray(input) || input.length > 50) { errors[list] = '批追踪输出列表无效'; continue; }
    const oldCreates = previous?.changes[list].filter(row => row.create) ?? [];
    const identities = history(list), used = new Set();
    const parseRejected = parts?.rejected?.[list] ?? [];
    const rejectedIndexes = new Set(parseRejected.map(row => row.index));
    const originalIndexes = Array.from({ length: input.length + parseRejected.length }, (_, index) => index).filter(index => !rejectedIndexes.has(index));
    if (!input.length && !errors[list]) accepted.add(list);
    for (const [index, change] of input.entries()) try {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('追踪输出身份无效');
      const { lastAppearanceFloor, ...fields } = change;
      if (duplicateId(change.id)) throw new Error('追踪输出身份重复，请为每个身份只返回一条记录');
      if (Object.hasOwn(change, 'appeared') || kind === 'item' && Object.hasOwn(change, 'lastAppearanceFloor')) throw new Error('批追踪出场证据无效');
      if (kind === 'npc' && lastAppearanceFloor !== undefined && lastAppearanceFloor !== null
        && (!trackingInteger(lastAppearanceFloor) || !ticket.source.sentFloors.some(row => row.floor === lastAppearanceFloor && row.role === 'assistant' && !row.system))) throw new Error('NPC 出场楼层须为本批实际发送的 AI 楼层');
      assertTrackingChanges({ items: [], npcs: [], [list]: [fields] });
      const record = ticket.current.find(row => row.id === change.id && row.kind === kind);
      const inferred = change.id !== null && !record;
      let matches = change.id === null ? oldCreates.filter(old => old.name === change.name) : [];
      // Explicit null keeps its existing creation semantics. Only malformed IDs
      // need this conservative, exact-name/alias identity check.
      if (inferred) {
        if (!trackingText(change.name) || Object.hasOwn(change, 'customFields')) throw new Error('未知 ID 无法确认新增：须有名称且不能包含自定义字段更新');
        const names = labels(change);
        matches = oldCreates.filter(old => normalizeTrackingName(old.name) === normalizeTrackingName(change.name));
        const matchId = matches.length === 1 ? matches[0].id : null;
        if (allIds.has(change.id) && change.id !== matchId) throw new Error('追踪更新须指向批开始前已确认的记录 ID');
        if (identities.some(row => row.id !== matchId && labels(row).some(name => names.includes(name)))) throw new Error('未知 ID 的名称或别名关联已有身份，无法确认新增');
        if (input.some((other, at) => at !== index && labels(other).some(name => names.includes(name)))
          || parseRejected.some(other => labels(other.row).some(name => names.includes(name)))) throw new Error('未知 ID 的名称或别名与本批其他记录重复，无法确认新增');
        if (trackingRecordExcluded({ ...change, kind }, ticket.exclusions)) throw new Error('该身份或名称已暂停追踪，未按新记录创建');
      }
      if (matches.length > 1) throw new Error('已有批追踪名称对应多个身份，无法安全重跑');
      const create = change.id === null || inferred;
      const patch = { ...fields, id: create ? matches[0]?.id ?? freshId() : change.id, create };
      if (used.has(patch.id)) throw new Error('追踪输出对应同一身份，不能重复采用');
      if (Object.hasOwn(change, 'customFields')) patch.customFields = applyTrackingCustomFieldValues(record, change.customFields);
      if (kind === 'npc' && lastAppearanceFloor !== undefined) patch.lastAppearanceTurn = lastAppearanceFloor === null ? (record?.lastAppearanceTurn ?? null) : countTrackingAiTurns(raw, { beforeFloor: lastAppearanceFloor + 1 });
      const rows = filterTrackingChanges({ items: [], npcs: [], [list]: [patch] }, ticket.current, ticket.exclusions)[list];
      const next = clone(changes[list]);
      for (const row of rows) {
        const at = next.findIndex(old => old.id === row.id);
        if (at < 0) next.push(row); else next[at] = { ...next[at], ...row };
      }
      applyChanges(ticket.current, { items: [], npcs: [], [list]: next }, ticket.aiTurn, { stored: true });
      changes[list] = next; used.add(patch.id); accepted.add(list);
    } catch (error) {
      rejected[list] ??= [];
      const originalIndex = originalIndexes[index];
      rejected[list].push({ index: originalIndex, row: clone(change), message: error.message });
      errors[list] = [errors[list], `第 ${originalIndex + 1} 条：${error.message}`].filter(Boolean).join('；');
    }
  }
  const result = tracking => ({ tracking, errors, ...(rejected.items?.length || rejected.npcs?.length ? { rejected } : {}) });
  if (!accepted.size) return result(domain);
  // Initialize the journal before adding this generation, preserving whether
  // the pre-generation baseline is genuinely known.
  domain.tailHistory ??= { schema: 1, sequence: 0, baseline: domain.snapshots.length === 0 && domain.manual.length === 0, checkpoints: [], inverse: [] };
  const id = previous?.id ?? freshId();
  const snapshot = { id, batchId, sourceSnapshot: source, aiTurn: ticket.aiTurn, baseKey: ticket.baseKey, changes, ...(previous?.batchRebases ? { batchRebases: clone(previous.batchRebases) } : {}) };
  const successorBase = previous?.id ?? ticket.baseKey;
  const successors = domain.snapshots.filter(row => row !== previous && row.sourceSnapshot.assistantFloor > source.requestedRange.end && row.baseKey === successorBase);
  const protection = new Map(successors.map(row => {
    const baseline = successorBaseline(domain, row);
    // Replay the successor's own changes, including inactive swipe versions;
    // using the currently active reply here would steal another version's IDs.
    return [row.id, applyChanges(baseline, row.changes, row.aiTurn, { stored: true })];
  }));
  domain.snapshots = domain.snapshots.filter(row => row !== previous);
  for (const row of successors) {
    const protectedChanges = protectRecords(row, protection.get(row.id));
    if (!previous) row.batchRebases = [...(row.batchRebases ?? []), { batchSnapshotId: id, baseKey: row.baseKey, changes: clone(row.changes), protectedChanges: clone(protectedChanges) }];
    row.baseKey = id; row.changes = protectedChanges;
  }
  domain.snapshots.push(snapshot);
  checkpointTrackingGeneration(domain, snapshot.id);
  domain.revision++;
  try { return result(assertTracking(domain)); } catch (error) {
    return { tracking: assertTracking(value), errors: Object.fromEntries(lists.map(list => [list, enabled(list) ? `批追踪无法安全合并：${error.message}` : errors[list]])) };
  }
}

