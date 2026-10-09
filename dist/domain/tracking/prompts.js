export const DEFAULT_TRACKING_PROMPTS = Object.freeze({
  item: '仅追踪有意义、可辨识的重要物品，忽略无关杂物。只依据本轮正文更新已提供的资料；未知留空，不猜测、不续写。同名但不能确认是同一物品时，不要合并。未变化的事实不要重复或清空，别名只填明确的名称、称呼或简称，不填泛词。精简介绍物品；区分位置、保管者和所属者。发生赠送或转移时记录转出方、接收方和精简原因，不扩写历史。',
  npc: '仅追踪有意义、可辨识的 NPC，忽略路人、背景群众。只依据本轮正文更新已提供的资料；未知留空，不猜测、不续写。同名但不能确认是同一角色时，不要合并。未变化的事实不要重复或清空，别名只填明确的姓名、称呼或简称，不填泛词。只追踪 NPC，不为 user 或 char 建记录；不按缺席自动删除。',
});
export function assertTrackingPrompts(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2
    || !['item', 'npc'].every(key => typeof value[key] === 'string' && !!value[key].trim() && value[key].length <= 20000)) throw new Error('请填写有效的追踪要求（最多 20000 字）');
  return structuredClone(value);
}
