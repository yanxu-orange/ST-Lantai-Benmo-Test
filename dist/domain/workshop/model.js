const clone = structuredClone;
const text = value => typeof value === 'string' && value.trim().length > 0;
export const WORKSHOP_KINDS = ['prompt', 'collect', 'sync'];
export const WORKSHOP_SCOPES = ['global', 'character', 'chat'];
export function emptyWorkshop() { return { schema: 1, revision: 0, modules: [], results: [], imports: [], captureCounters: { global: 0, character: 0, chat: 0 } }; }
export function validateModule(value) {
  if (!value || !text(value.id) || !text(value.name) || typeof value.content !== 'string'
    || !WORKSHOP_KINDS.includes(value.lifecycle) || !WORKSHOP_SCOPES.includes(value.scope)
    || !['system', 'user', 'assistant'].includes(value.role) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.depth) || value.depth < 0 || value.depth > 10000
    || (value.lifecycle === 'prompt' ? value.captureTag !== null : !/^[gch][1-9]\d*$/.test(value.captureTag))) {
    throw new Error('工坊模块字段无效');
  }
  if(value.moveVersion!==undefined&&(!Number.isSafeInteger(value.moveVersion)||value.moveVersion<0))throw new Error('模块移动版本无效');
  if(value.captureAliases!==undefined&&(!Array.isArray(value.captureAliases)||value.captureAliases.some(alias=>!text(alias?.rootId)||! /^[gch][1-9]\d*$/.test(alias?.tag))))throw new Error('历史回收标签无效');
  if (value.scope === 'character' && !text(value.characterKey)) throw new Error('请选择角色');
  return clone(value);
}
export function assertWorkshop(value) {
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.modules) || !Array.isArray(value.results) || !Array.isArray(value.imports)) {
    throw new Error('工坊数据结构无效');
  }
  if (!value.captureCounters || WORKSHOP_SCOPES.some(scope => !Number.isSafeInteger(value.captureCounters[scope]) || value.captureCounters[scope] < 0)) throw new Error('工坊标签计数无效');
  const ids = new Set(), tags = new Set();
  for (const module of value.modules) {
    validateModule(module);
    if (ids.has(module.id)) throw new Error('工坊模块身份重复');
    ids.add(module.id);
    if(module.captureTag !== null){
      const tagKey=JSON.stringify([module.scope,module.characterKey??null,module.captureTag]);
      if(tags.has(tagKey)) throw new Error('工坊回收标签重复');
      tags.add(tagKey);
    }
  }
  const resultIds = new Set(), sources = new Set();
  for (const row of value.results) {
    if (!row || !text(row.id) || resultIds.has(row.id) || !text(row.moduleId) || !text(row.replyId)
      || !Number.isSafeInteger(row.index) || row.index < 0 || !Number.isSafeInteger(row.floor) || row.floor < 0
      || typeof row.value !== 'string' || !(row.manualValue === null || typeof row.manualValue === 'string')
      || typeof row.deleted !== 'boolean' || typeof row.active !== 'boolean') throw new Error('工坊结果字段无效');
    resultIds.add(row.id);
    const source = JSON.stringify([row.moduleId,row.replyId]);
    if(sources.has(source)) throw new Error('工坊结果来源重复');
    sources.add(source);
  }
  if (value.imports.some(id => !text(id)) || new Set(value.imports).size !== value.imports.length) throw new Error('工坊导入记录无效');
  return clone(value);
}
export function workshopOf(root) { return assertWorkshop(root.workshop ?? emptyWorkshop()); }
export function allocateCaptureTag(value, scope) {
  const workshop = assertWorkshop(value), modules = workshop.modules;
  const prefix = { global: 'g', character: 'c', chat: 'h' }[scope];
  if (!prefix) throw new Error('工坊作用范围无效');
  const maximum = modules.reduce((max, item) => {
    const match = new RegExp(`^${prefix}([1-9]\\d*)$`).exec(item.captureTag ?? '');
    return match ? Math.max(max, Number(match[1])) : max;
  }, workshop.captureCounters[scope]);
  if (!Number.isSafeInteger(maximum + 1)) throw new Error('回收标签编号超出范围');
  workshop.captureCounters[scope] = maximum + 1;
  return { tag: `${prefix}${maximum + 1}`, workshop };
}
export function inheritWorkshop(value, floor) {
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('分支楼层无效');
  const next = assertWorkshop(value);
  next.revision = 0;
  next.results = next.results.filter(row => row.floor < floor).map(row => ({ ...row, active: false }));
  return next;
}
