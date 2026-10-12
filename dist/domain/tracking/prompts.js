export const LEGACY_TRACKING_PROMPTS = Object.freeze({
  item: '仅追踪有意义、可辨识的重要物品，忽略无关杂物。只依据本轮正文更新已提供的资料；未知留空，不猜测、不续写。同名但不能确认是同一物品时，不要合并。未变化的事实不要重复或清空，别名只填明确的名称、称呼或简称，不填泛词。精简介绍物品；区分位置、保管者和所属者。发生赠送或转移时记录转出方、接收方和精简原因，不扩写历史。',
  npc: '仅追踪有意义、可辨识的 NPC，忽略路人、背景群众。只依据本轮正文更新已提供的资料；未知留空，不猜测、不续写。同名但不能确认是同一角色时，不要合并。未变化的事实不要重复或清空，别名只填明确的姓名、称呼或简称，不填泛词。只追踪 NPC，不为 user 或 char 建记录；不按缺席自动删除。',
});
export const DEFAULT_TRACKING_PROMPTS = Object.freeze({"item": "根据本轮剧情和已有物品记录，新增或更新有意义、可辨识的重要物品，忽略无关杂物。\n\n新增记录时，填写剧情能够确认的信息，未知内容留空。更新已有记录时，只返回有新依据、需要改变的字段；其余字段保持原值，不必返回。清空已有内容也应有剧情依据。\n\n结合名称、别名和已有信息辨认物品。同名但无法确认是同一物品时，不合并记录。别名使用剧情中明确出现的名称、称呼或简称。\n\n简洁介绍物品，分别记录位置、保管者与所属者。借用或代管不等于所有权转移。剧情明确发生赠送、转移或归属改变时，记录转出方、接收方及简要原因；计划和承诺不当作已完成的变化。", "npc": "根据本轮剧情和已有角色记录，新增或更新有意义、可辨识的 NPC，忽略路人和背景群众。不为 {{user}} 或 {{char}} 建立NPC记录。\n\n新增记录时，填写剧情能够确认的信息，未知内容留空。更新已有记录时，只返回有新依据、需要改变的字段；其余字段保持原值，不必返回。清空已有内容也应有剧情依据。\n\n结合姓名、别名和已有信息辨认角色。同名但无法确认是同一角色时，不合并记录。别名使用剧情中明确出现的姓名、称呼或简称。\n\n简洁记录角色的外表、身份，以及与 {{user}}、{{char}} 的关系；区分人物的说法、打算与剧情已确认的身份或关系。不因角色缺席而删除记录。"});
export function migrateTrackingPrompts(value){return Object.fromEntries(Object.entries(value).map(([key,text])=>[key,text===LEGACY_TRACKING_PROMPTS[key]?DEFAULT_TRACKING_PROMPTS[key]:text]));}
export function assertTrackingPrompts(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2
    || !['item', 'npc'].every(key => typeof value[key] === 'string' && !!value[key].trim() && value[key].length <= 20000)) throw new Error('请填写有效的追踪要求（最多 20000 字）');
  return structuredClone(value);
}
