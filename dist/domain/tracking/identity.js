import { normalizeTrackingName } from './exclusions.js';

const descriptors = { item: ['introduction'], npc: ['appearance', 'identity'] };
export const trackingIdentityLabels = row => [row?.name, ...(Array.isArray(row?.aliases) ? row.aliases : [])].map(normalizeTrackingName).filter(Boolean);

// These are recognition references, not a historical state or a second store.
export function trackingIdentityReference(records) {
  return records.map(({ id, kind, name, aliases, ...fields }) => ({ id, kind, name, aliases: [...aliases],
    ...Object.fromEntries(descriptors[kind].filter(key => fields[key]?.trim()).map(key => [key, fields[key]])) }));
}

export function matchTrackingIdentity(change, references, kind) {
  const labels = trackingIdentityLabels(change);
  const candidates = references.filter(row => row.kind === kind && trackingIdentityLabels(row).some(label => labels.includes(label)));
  if (!candidates.length) return null;
  // No fuzzy identity inference: matching descriptions can support an exact
  // label, but different wording cannot prove either sameness or difference.
  const compatible = candidates.filter(row => {
    const compared = descriptors[kind].filter(key => normalizeTrackingName(change[key]) && normalizeTrackingName(row[key]));
    return compared.every(key => normalizeTrackingName(change[key]) === normalizeTrackingName(row[key]));
  });
  const supported = compatible.filter(row => {
    const compared = descriptors[kind].filter(key => normalizeTrackingName(change[key]) && normalizeTrackingName(row[key]));
    return compared.length > 0 && compared.every(key => normalizeTrackingName(change[key]) === normalizeTrackingName(row[key]));
  });
  if (supported.length === 1 && compatible.length === 1) return supported[0];
  throw new Error('名称或别名关联已有身份，无法确认是否同一对象；请沿用已确认的记录 ID 或使用能区分新对象的名称');
}

// Rebase protection copies preserve later facts; they are not new results at
// the successor's floor. Undo unchanged copies using the existing provenance.
export function trackingResultIds(snapshot, records = null) {
  let changes = snapshot.changes;
  for (const proof of [...(snapshot.batchRebases ?? [])].reverse()) {
    changes = Object.fromEntries(['items', 'npcs'].map(list => [list, changes[list].flatMap(row => {
      const original = proof.changes[list].find(old => old.id === row.id);
      const protectedRow = proof.protectedChanges?.[list].find(old => old.id === row.id);
      if (!proof.protectedChanges || JSON.stringify(row) === JSON.stringify(protectedRow)) return original ? [original] : [];
      return [row];
    })]));
  }
  const byId = records && new Map(records.map(row => [row.id, row]));
  return [...changes.items, ...changes.npcs].filter(row => row.create || Object.entries(row).some(([key, value]) =>
    !['id', 'create'].includes(key) && (key !== 'lastAppearanceTurn' || !byId || JSON.stringify(byId.get(row.id)?.[key]) !== JSON.stringify(value)))).map(row => row.id);
}
