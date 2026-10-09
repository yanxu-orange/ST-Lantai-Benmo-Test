import { TRACKING_KINDS, trackingExact, trackingInteger, trackingText } from './model.js';
const clone = structuredClone;
export const normalizeTrackingName = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
export function emptyTrackingExclusions() { return { epoch: 0, item: { names: [], ids: [] }, npc: { names: [], ids: [] } }; }
export function assertTrackingExclusions(value) {
  if (!trackingExact(value, ['epoch', 'item', 'npc']) || !trackingInteger(value.epoch)) throw new Error('追踪排除名单无效');
  for (const kind of TRACKING_KINDS) {
    const group = value[kind];
    if (!trackingExact(group, ['names', 'ids', ...(Object.hasOwn(group ?? {}, 'labels') ? ['labels'] : [])]) || !Array.isArray(group.names) || !Array.isArray(group.ids)
      || group.names.length > 500 || group.ids.length > 5000
      || group.names.some(name => !trackingText(name) || name.length > 160 || !normalizeTrackingName(name))
      || group.ids.some(id => !trackingText(id))
      || new Set(group.names.map(normalizeTrackingName)).size !== group.names.length || new Set(group.ids).size !== group.ids.length) throw new Error('追踪排除名称或身份无效');
    if (Object.hasOwn(group, 'labels') && (!group.labels || Object.getPrototypeOf(group.labels) !== Object.prototype || Object.entries(group.labels).some(([id, names]) => !group.ids.includes(id) || !Array.isArray(names) || names.some(name => !trackingText(name) || name.length > 3200) || new Set(names).size !== names.length))) throw new Error('暂停追踪名称证据无效');
  }
  return clone(value);
}
export function trackingExclusionsOf(domain) { return assertTrackingExclusions(domain?.exclusions ?? emptyTrackingExclusions()); }
export function trackingRecordExcluded(record, exclusions = emptyTrackingExclusions()) {
  const group = exclusions[record.kind];
  if (!group) return false;
  const names = new Set(group.names.map(normalizeTrackingName));
  return group.ids.includes(record.id) || [record.name, ...(record.aliases ?? [])].some(name => names.has(normalizeTrackingName(name)));
}
// ID pauses also remember all known labels in retained history. A new model ID
// cannot evade a pause by re-creating the same named entity after a swipe/edit.
// These labels are matching evidence only; no old record fields enter prompts.
export function effectiveTrackingExclusions(domain, records = []) {
  const result = trackingExclusionsOf(domain);
  if (TRACKING_KINDS.every(kind => !result[kind].ids.length)) return result;
  const rows = [...records, ...domain.manual.flatMap(row => [row.record, { id: row.id, kind: row.kind, ...row.patch }].filter(Boolean)),
    ...domain.snapshots.flatMap(snapshot => ['items', 'npcs'].flatMap(list => snapshot.changes[list].map(change => ({ ...change, kind: list === 'items' ? 'item' : 'npc' }))))];
  for (const kind of TRACKING_KINDS) {
    const names = new Set([...result[kind].names, ...Object.values(result[kind].labels ?? {}).flat()].map(normalizeTrackingName));
    for (const row of rows) if (row.kind === kind && result[kind].ids.includes(row.id)) for (const name of [row.name, ...(row.aliases ?? [])]) {
      const normalized = normalizeTrackingName(name); if (normalized) names.add(normalized);
    }
    result[kind].names = [...names];
  }
  return result;
}
export function filterTrackingChanges(changes, records, exclusions) {
  return Object.fromEntries(['items', 'npcs'].map(list => [list, changes[list].filter(change => {
    const kind = list === 'items' ? 'item' : 'npc', existing = records.find(row => row.id === change.id && row.kind === kind);
    if (existing && trackingRecordExcluded(existing, exclusions)) return false;
    return !trackingRecordExcluded({ ...existing, ...change, kind }, exclusions);
  })]));
}
