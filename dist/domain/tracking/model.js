const clone = structuredClone;
const own = (value, key) => Object.hasOwn(value, key);
export const TRACKING_KINDS = Object.freeze(['item', 'npc']);
export const TRACKING_FIELDS = Object.freeze({
  item: Object.freeze(['introduction', 'location', 'custodian', 'owner', 'transferFrom', 'transferTo', 'transferReason']),
  npc: Object.freeze(['appearance', 'identity', 'relationToUser', 'relationToChar']),
});
export const TRACKING_CUSTOM_FIELD_LIMITS = Object.freeze({ count: 50, id: 160, name: 80, requirement: 1000, value: 2000 });
export const trackingText = value => typeof value === 'string' && Boolean(value.trim());
export const trackingInteger = value => Number.isSafeInteger(value) && value >= 0;
export const trackingObject = value => value && Object.getPrototypeOf(value) === Object.prototype;
export function trackingExact(value, keys) {
  return trackingObject(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}
// Definitions belong to one record and are edited only by the user. Model
// deltas deliberately have a smaller shape, so they cannot rename or add them.
export function assertTrackingCustomFields(value, { model = false } = {}) {
  if (!Array.isArray(value) || value.length > TRACKING_CUSTOM_FIELD_LIMITS.count) throw new Error('自定义字段列表无效');
  const ids = new Set(), names = new Set();
  for (const field of value) {
    if (!trackingExact(field, model ? ['id', 'value'] : ['id', 'name', 'requirement', 'value'])
      || !trackingText(field.id) || field.id.length > TRACKING_CUSTOM_FIELD_LIMITS.id || ids.has(field.id)
      || typeof field.value !== 'string' || field.value.length > TRACKING_CUSTOM_FIELD_LIMITS.value) throw new Error('自定义字段内容或身份无效');
    ids.add(field.id);
    if (!model) {
      if (!trackingText(field.name) || field.name.length > TRACKING_CUSTOM_FIELD_LIMITS.name
        || !trackingText(field.requirement) || field.requirement.length > TRACKING_CUSTOM_FIELD_LIMITS.requirement
        || names.has(field.name.trim())) throw new Error('请填写字段名和追踪要求，字段名不要重复');
      names.add(field.name.trim());
    }
  }
  return clone(value);
}
export function applyTrackingCustomFieldValues(record, updates) {
  updates = assertTrackingCustomFields(updates, { model: true });
  const fields = record.customFields ?? [], ids = new Set(fields.map(field => field.id));
  if (updates.some(field => !ids.has(field.id))) throw new Error('自定义字段更新须指向这条记录已有的字段 ID');
  const values = new Map(updates.map(field => [field.id, field.value]));
  return fields.map(field => ({ ...field, ...(values.has(field.id) ? { value: values.get(field.id) } : {}) }));
}
function assertField(key, value) {
  if (key === 'aliases') {
    if (!Array.isArray(value) || value.length > 12 || value.some(alias => !trackingText(alias) || alias.length > 160)
      || new Set(value).size !== value.length) throw new Error('追踪别名无效');
  } else if (key === 'pinned') {
    if (typeof value !== 'boolean') throw new Error('追踪常驻状态无效');
  } else if (key === 'lastAppearanceTurn') {
    if (!(value === null || trackingInteger(value) && value > 0)) throw new Error('NPC 出场回合无效');
  } else if (typeof value !== 'string' || value.length > (key === 'name' ? 160 : 600)
    || key === 'name' && !value.trim()) throw new Error('追踪资料字段无效');
}
export function assertTrackingPatch(kind, value, { model = false, stored = false } = {}) {
  if (!TRACKING_KINDS.includes(kind) || !trackingObject(value)) throw new Error('追踪修改无效');
  const allowed = ['name', 'aliases', ...TRACKING_FIELDS[kind], 'customFields', ...(model ? [] : ['pinned', ...(kind === 'npc' ? ['lastAppearanceTurn'] : [])])];
  for (const [key, field] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error('追踪修改包含未知字段');
    if (key === 'customFields') assertTrackingCustomFields(field, { model: model && !stored });
    else assertField(key, field);
  }
  return clone(value);
}
export function blankTrackingRecord(kind, id, fields = {}) {
  if (!TRACKING_KINDS.includes(kind) || !trackingText(id)) throw new Error('追踪身份无效');
  return assertTrackingRecord({ id, kind, name: '', aliases: [], pinned: false, customFields: [],
    ...Object.fromEntries(TRACKING_FIELDS[kind].map(key => [key, ''])),
    ...(kind === 'npc' ? { lastAppearanceTurn: null } : {}), ...assertTrackingPatch(kind, fields) });
}
export function assertTrackingRecord(value) {
  if (!TRACKING_KINDS.includes(value?.kind) || !trackingText(value?.id)
    || !trackingExact(value, ['id', 'kind', 'name', 'aliases', 'pinned', ...TRACKING_FIELDS[value.kind], ...(value.kind === 'npc' ? ['lastAppearanceTurn'] : []), ...(own(value, 'customFields') ? ['customFields'] : [])])) throw new Error('追踪记录无效');
  const { id, kind, ...fields } = value;
  assertTrackingPatch(kind, fields);
  return clone(value);
}
// Unknown is represented by an empty string, never a made-up identity or fact.
// Model updates can omit unchanged fields; a supplied empty value explicitly clears it.
export function assertTrackingChanges(value, { stored = false } = {}) {
  if (!trackingExact(value, ['items', 'npcs'])) throw new Error('追踪输出须包含 items 和 npcs');
  const ids = new Set();
  for (const [list, kind] of [['items', 'item'], ['npcs', 'npc']]) {
    if (!Array.isArray(value[list]) || value[list].length > 50) throw new Error('追踪输出列表无效');
    for (const change of value[list]) {
      if (!trackingObject(change) || !own(change, 'id') || !(trackingText(change.id) || !stored && change.id === null)
        || stored && typeof change.create !== 'boolean') throw new Error('追踪输出身份无效');
      if (change.id !== null && ids.has(change.id)) throw new Error('追踪输出身份重复');
      if (change.id !== null) ids.add(change.id);
      const { id, appeared, ...fields } = change;
      if (stored) delete fields.create;
      if (kind === 'npc' && appeared !== undefined && typeof appeared !== 'boolean' || kind === 'item' && own(change, 'appeared')) throw new Error('NPC 出场证据无效');
      assertTrackingPatch(kind, fields, { model: true, stored });
      if (!stored && id === null && own(fields, 'customFields')) throw new Error('模型不能为新记录创建自定义字段');
      if ((stored ? change.create : id === null) && !trackingText(fields.name)) throw new Error('新追踪记录须有名称');
    }
  }
  return clone(value);
}
export function npcAbsenceTurns(record, currentAiTurn) {
  assertTrackingRecord(record);
  if (record.kind !== 'npc' || !trackingInteger(currentAiTurn)) throw new Error('NPC 缺席计算无效');
  return record.lastAppearanceTurn === null ? null : Math.max(0, currentAiTurn - record.lastAppearanceTurn);
}
