import { assertTracking, assertTrackingPreferences, currentTracking, countTrackingAiTurns, applyChanges, storedBatchTrackingSource, matchesBatchTrackingSource } from './data.js';
import { assertRawSummarySource, matchesSummarySource } from '../summary/source.js';
import { assertTrackingChanges, applyTrackingCustomFieldValues, trackingInteger, trackingText, TRACKING_FIELDS } from './model.js';
import { effectiveTrackingExclusions, filterTrackingChanges, trackingExclusionsOf } from './exclusions.js';
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


function successorBaseline(domain, raw, snapshot) {
  const byId = new Map(domain.snapshots.map(row => [row.id, row])), ancestors = [], seen = new Set();
  let key = snapshot.baseKey;
  while (key !== null) {
    const row = byId.get(key);
    if (!row || seen.has(key)) throw new Error('追踪前置版本链无效，无法安全合并');
    seen.add(key); ancestors.unshift(row); key = row.baseKey;
  }
  // Same-base siblings are alternative chains even when their floors differ.
  // Replay only this successor's ancestors; never borrow the visible branch.
  // Restore saved source versions so dormant swipe ancestors can be protected
  // independently without taking another swipe's record IDs.
  const messages = new Map(raw.messages.map(row => [row.floor, clone(row)]));
  for (const row of ancestors) {
    const source = row.sourceSnapshot;
    for (const saved of source.rawMessages) messages.set(saved.floor, { ...messages.get(saved.floor), ...clone(saved) });
    if (source.kind === 'batch') for (const reply of source.replyIds) {
      if (reply.replyId !== null) messages.get(reply.floor).replyId = reply.replyId;
    } else messages.get(source.assistantFloor).replyId = source.replyId;
  }
  const evidence = { ...raw, messages: [...messages.values()].sort((a, b) => a.floor - b.floor) };
  return currentTracking({ ...domain, snapshots: ancestors, manual: domain.manual.map(row => ({ ...row, deleted: false })) }, evidence, { beforeFloor: snapshot.sourceSnapshot.assistantFloor }).records;
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
  const changes = { items: [], npcs: [] };
  for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) {
    if (!enabled(list) || errors[list]) { changes[list] = clone(previous?.changes[list] ?? []); continue; }
    try {
      if (!Array.isArray(parts?.changes?.[list])) throw new Error('批追踪输出列表无效');
      const appearances = new Map();
      const input = parts.changes[list].map((change, index) => {
        const { lastAppearanceFloor, ...fields } = change;
        if (Object.hasOwn(change, 'appeared') || kind === 'item' && Object.hasOwn(change, 'lastAppearanceFloor')) throw new Error('批追踪出场证据无效');
        if (kind === 'npc' && lastAppearanceFloor !== undefined) {
          if (lastAppearanceFloor !== null && (!trackingInteger(lastAppearanceFloor) || !ticket.source.sentFloors.some(row => row.floor === lastAppearanceFloor && row.role === 'assistant' && !row.system))) throw new Error('NPC 出场楼层须为本批实际发送的 AI 楼层');
          appearances.set(index, lastAppearanceFloor);
        }
        return fields;
      });
      assertTrackingChanges({ items: [], npcs: [], [list]: input });
      const oldCreates = previous?.changes[list].filter(row => row.create) ?? [];
      const rows = input.map((change, index) => {
        const record = ticket.current.find(row => row.id === change.id && row.kind === kind);
        if (change.id !== null && !record) throw new Error('追踪更新须指向批开始前已确认的记录 ID');
        const matches = change.id === null ? oldCreates.filter(old => old.name === change.name) : [];
        if (matches.length > 1) throw new Error('已有批追踪名称对应多个身份，无法安全重跑');
        const patch = { ...change, id: change.id ?? matches[0]?.id ?? freshId(), create: change.id === null };
        if (Object.hasOwn(change, 'customFields')) patch.customFields = applyTrackingCustomFieldValues(record, change.customFields);
        if (kind === 'npc' && appearances.has(index)) patch.lastAppearanceTurn = appearances.get(index) === null ? (record?.lastAppearanceTurn ?? null) : countTrackingAiTurns(raw, { beforeFloor: appearances.get(index) + 1 });
        return patch;
      });
      changes[list] = filterTrackingChanges({ items: [], npcs: [], [list]: rows }, ticket.current, ticket.exclusions)[list];
      // Omitted prior creations stay alive: successors/manual patches may refer
      // to them. A rerun can update them but cannot silently delete identities.
      for (const old of previous?.changes[list] ?? []) {
        const at = changes[list].findIndex(row => row.id === old.id);
        if (at < 0) changes[list].push(clone(old));
        else changes[list][at] = { ...clone(old), ...changes[list][at] };
      }
      applyChanges(ticket.current, { items: [], npcs: [], [list]: changes[list] }, ticket.aiTurn, { stored: true });
    } catch (error) { errors[list] = error.message; changes[list] = clone(previous?.changes[list] ?? []); }
  }
  if (lists.every(list => !enabled(list) || errors[list])) return { tracking: domain, errors };
  const id = previous?.id ?? freshId();
  const snapshot = { id, batchId, sourceSnapshot: source, aiTurn: ticket.aiTurn, baseKey: ticket.baseKey, changes, ...(previous?.batchRebases ? { batchRebases: clone(previous.batchRebases) } : {}) };
  const successorBase = previous?.id ?? ticket.baseKey;
  const successors = domain.snapshots.filter(row => row !== previous && row.sourceSnapshot.assistantFloor > source.requestedRange.end && row.baseKey === successorBase);
  const protection = new Map(successors.map(row => {
    const baseline = successorBaseline(domain, raw, row);
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
  domain.revision++;
  try { return { tracking: assertTracking(domain), errors }; } catch (error) {
    return { tracking: assertTracking(value), errors: Object.fromEntries(lists.map(list => [list, enabled(list) ? `批追踪无法安全合并：${error.message}` : errors[list]])) };
  }
}
