// Result identity is supplied by the host's persisted reply-version identity.
// Visible floor numbers and text are never used as the result identity.
const clone = structuredClone;
const required = value => typeof value === 'string' && value.trim().length > 0;

export function extractResults(text, captureTag) {
  if (typeof text !== 'string' || !/^[gch][1-9]\d*$/.test(captureTag)) return [];
  const found = [];
  const pattern = /<tkm_result(?=\s|>)([^>]*)>([\s\S]*?)<\/tkm_result\s*>/gi;
  for (const match of text.matchAll(pattern)) {
    const attrs = [...match[1].matchAll(/(?:^|\s)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)];
    const modules = attrs.filter(attr => attr[1].toLowerCase() === 'module');
    if (modules.length === 1 && (modules[0][2] ?? modules[0][3] ?? modules[0][4]) === captureTag && match[2].trim()) found.push(match[2].trim());
  }
  return found;
}

export function reconcileResults(previous, snapshots, { makeId = () => crypto.randomUUID(), moduleIds = null } = {}) {
  const next = clone(previous);
  const active = new Set(), seenSources = new Set();
  for (const snapshot of snapshots) {
    if (!required(snapshot.moduleId) || !required(snapshot.replyId)
      || !Number.isSafeInteger(snapshot.floor) || snapshot.floor < 0
      || !Array.isArray(snapshot.values) || snapshot.values.some(value => typeof value !== 'string')) {
      throw new Error('工坊结果来源无效');
    }
    const sourceKey = JSON.stringify([snapshot.moduleId, snapshot.replyId]);
    if (seenSources.has(sourceKey)) throw new Error('工坊结果来源重复');
    seenSources.add(sourceKey);
    if (!snapshot.values.length) continue;
    // One module in one reply is one editable result; preserve every captured
    // block in source order, without inventing identities for AI-written blocks.
    const value = snapshot.values.join('\n\n');
    let item = next.find(row => row.moduleId === snapshot.moduleId && row.replyId === snapshot.replyId);
    if (!item) {
      item = { id: makeId(), moduleId: snapshot.moduleId, replyId: snapshot.replyId, index: 0,
        floor: snapshot.floor, value, manualValue: null, deleted: false, active: true };
      if (!required(item.id) || next.some(row => row.id === item.id)) throw new Error('工坊结果身份重复');
      next.push(item);
    }
    item.value = value;
    item.floor = snapshot.floor;
    active.add(item.id);
  }
  for (const item of next) if(moduleIds === null || moduleIds.includes(item.moduleId)) item.active = active.has(item.id);
  return next;
}

export function visibleResults(results, moduleId) {
  return results.filter(item => item.moduleId === moduleId && item.active && !item.deleted)
    .sort((a, b) => a.floor - b.floor || a.index - b.index).map(item => clone(item));
}
export function currentResult(results, moduleId) { return visibleResults(results, moduleId).at(-1) ?? null; }
export function resultText(result) { return result.manualValue ?? result.value; }
export function editResult(results, id, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写结果正文');
  const next = clone(results), item = next.find(row => row.id === id && row.active && !row.deleted);
  if (!item) throw new Error('结果已变化，请重新打开');
  item.manualValue = value;
  return next;
}
export function deleteResult(results, id) {
  const next = clone(results), item = next.find(row => row.id === id && row.active && !row.deleted);
  if (!item) throw new Error('结果已变化，请重新打开');
  item.deleted = true;
  return next;
}
