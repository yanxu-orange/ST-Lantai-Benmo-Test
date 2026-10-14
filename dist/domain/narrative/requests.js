import {assertKind, exact, text, clone} from './core.js';
import {DEFAULT_NARRATIVE_PROMPTS, NARRATIVE_BOUNDARY, NARRATIVE_PROTOCOL, NARRATIVE_SELF_PROTOCOL} from './prompts.js';
export {DEFAULT_NARRATIVE_PROMPTS} from './prompts.js';
export function narrativeSchema(kind) {
  assertKind(kind);
  const entries = {type: 'array', items: {type: 'string', minLength: 1, pattern: '\\S'}};
  const value = kind === 'outline' ? {type: 'object', additionalProperties: false, required: ['entries'], properties: {entries}}
    : {type: 'object', additionalProperties: false, required: ['characters'], properties: {characters: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['id', 'entries'], properties: {id: {type: 'string', minLength: 1}, entries}}}}};
  return {name: `narrative_${kind}`, value};
}
export const NARRATIVE_MATERIAL_SEPARATOR = '\n\n';
const kindLabel = kind => kind === 'self' ? '自述' : '大纲';
const entryText = entries => entries.map((entry, index) => `条目 ${index + 1}：\n${entry}`).join(NARRATIVE_MATERIAL_SEPARATOR);
export function narrativeMemoryTime(row) {
  return row.startTime && row.endTime ? `${row.startTime} — ${row.endTime}` : row.startTime || row.endTime || '';
}
export function narrativeMemoryText(row) {
  return `时间：${narrativeMemoryTime(row)}\n标题：${row.title}\n正文：\n${row.body}`;
}
function materialPart({field, name, value, kind = null}) {
  let body;
  if (field === 'card') body = value ? [['name', '姓名'], ['description', '角色描述'], ['personality', '性格'], ['scenario', '初始情境']].map(([key, label]) => `${label}：\n${value[key] ?? ''}`).join(NARRATIVE_MATERIAL_SEPARATOR) : '';
  else if (field === 'memory') body = value.map(narrativeMemoryText).join(NARRATIVE_MATERIAL_SEPARATOR);
  else if (field === 'original') body = value.map(row => `${row.speaker === '用户' ? '用户内容' : 'AI 正文'}：\n${row.text}`).join(NARRATIVE_MATERIAL_SEPARATOR);
  else if (field === 'previous') body = kind === 'self' ? value.map(row => `角色：${row.name}\n角色 ID：${row.id}\n${entryText(row.entries)}`).join(NARRATIVE_MATERIAL_SEPARATOR) : entryText(value);
  else body = value;
  return {field, name, kind, role: 'user', content: `${name}：\n${body}`, fixed: true, key: null};
}
export function narrativeMaterialParts(materials, kind = materials.previous?.some(row => typeof row === 'object') ? 'self' : 'outline') {
  return [
    {field: 'card', name: '角色设定', value: materials.background.initialCharacter},
    {field: 'memory', name: '记忆资料', value: materials.memory},
    {field: 'original', name: '剧情原文', value: materials.original},
    {field: 'supplement', name: '补充信息', value: materials.background.supplement, kind},
    {field: 'previous', name: kind === 'self' ? '已有角色自述' : '已有故事大纲', value: materials.previous, kind},
  ].map(materialPart);
}
// Shared story evidence is read once; supplements and prior outputs retain
// their task ownership even when their text happens to be identical.
export function narrativeMaterialGroups(tickets) {
  const groups = [];
  if (!tickets.length) return groups;
  const add = (field, name, value, kind = null) => groups.push({field, name, value, kind});
  const cards = new Map();
  for (const ticket of tickets) {
    const card = ticket.materials?.background?.initialCharacter;
    if (card) cards.set(JSON.stringify(card), card);
  }
  for (const card of cards.values()) add('card', '角色设定', card);
  for (const ticket of tickets) add('supplement', '补充信息', ticket.materials?.background?.supplement ?? '', ticket.kind);
  for (const ticket of tickets) add('previous', ticket.kind === 'self' ? '已有角色自述' : '已有故事大纲', ticket.materials?.previous ?? [], ticket.kind);
  for (const [field, name] of [['memory', '记忆资料'], ['original', '剧情原文']]) {
    const values = tickets.map(ticket => ticket.materials?.[field] ?? []);
    if (values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))) add(field, name, values[0]);
    else tickets.forEach((ticket, index) => add(field, name, values[index], ticket.kind));
  }
  return groups;
}
function narrativeOpening(combined = false) {
  return `${combined ? '你是一名小说创作助理，负责整理故事的发展与人物的变化。请根据提供的资料，分别完成以下两项任务。' : '请根据提供的资料，完成以下一项任务。'}\n${NARRATIVE_BOUNDARY}\n以下是需要处理的资料，是进行总结的依据：\n核心资料：`;
}
function narrativeTaskPart(ticket, index) {
  const name = `任务${index === 0 ? '一' : '二'}：${ticket.kind === 'outline' ? '故事大纲' : '角色自述'}`;
  const mapping = ticket.kind === 'self' ? `\n指定角色：\n${ticket.preferences.characters.map(({id, name}) => `姓名：${name}；角色 ID：${id}`).join('\n')}\n【角色名】使用对应姓名。` : '';
  return {name, role: 'system', content: `${index === 0 ? '阅读完核心资料后，请按顺序执行以下任务。\n' : ''}【${name}】${mapping}\n任务补充资料：`, fixed: true, key: null};
}
export function buildNarrativeRequest({ticket} = {}) {
  const kind = assertKind(ticket?.kind);
  if (!ticket.materials || !ticket.preferences || typeof ticket.preferences.prompt !== 'string') throw new Error('自述或大纲任务快照无效');
  const schema = narrativeSchema(kind);
  const materials = narrativeMaterialParts(ticket.materials, kind);
  const parts = [
    {name: '叙事任务资料边界', role: 'system', content: narrativeOpening(), fixed: true, key: null},
    ...materials.filter(part => !part.kind),
    narrativeTaskPart(ticket, 0),
    ...materials.filter(part => part.kind),
    {name: '具体任务', role: 'system', content: '你本阶段的具体任务：', fixed: true, key: null},
    {name: '本轮内容要求', role: 'system', content: ticket.preferences.prompt.trim() ? ticket.preferences.prompt : DEFAULT_NARRATIVE_PROMPTS[kind], fixed: false, key: 'prompt'},
    {name: '固定输出结构', role: 'system', content: `输出任务结果的格式要求：\n${NARRATIVE_PROTOCOL}${kind==='self'?`\n${NARRATIVE_SELF_PROTOCOL}`:''}\n${JSON.stringify(schema.value)}`, fixed: true, key: null},
  ];
  return {task: `narrative.${kind}`, title: kind === 'self' ? '角色自述' : '故事大纲', messages: parts.map(({role, content}) => ({role, content})), previewParts: parts, schema};
}
export function parseNarrativeResponse(value, {kind} = {}) {
  assertKind(kind);
  if (typeof value === 'string') {
    try { value = JSON.parse(value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu, '$1')); } catch { throw new Error('自述或大纲输出不是有效 JSON'); }
  }
  const entries = rows => Array.isArray(rows) && rows.every(text);
  if (kind === 'outline') {
    if (!exact(value, ['entries']) || !entries(value.entries)) throw new Error('故事大纲输出结构无效');
  } else {
    if (!exact(value, ['characters']) || !Array.isArray(value.characters) || value.characters.some(row => !exact(row, ['id', 'entries']) || !text(row.id) || !entries(row.entries)) || new Set(value.characters.map(row => row.id)).size !== value.characters.length) throw new Error('角色自述输出结构无效');
  }
  return clone(value);
}
export function validateNarrativeEntries(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || !previous.every(text) || !next.every(text)) throw new Error('自述或大纲条目无效');
  if (previous.length && !next.length) throw new Error('已有自述或大纲不能被空结果清空');
  const protectedLength = Math.max(0, previous.length - 2);
  if (next.length < protectedLength || previous.slice(0, protectedLength).some((row, index) => row !== next[index])) throw new Error('只能修改最后两条；更早内容必须逐字保留');
  const groups = rows => {
    const result = new Map();
    for (const row of rows) {
      const normalized = row.normalize('NFKC').replace(/\s+/gu, '').trim();
      if (!result.has(normalized)) result.set(normalized, {count: 0, texts: new Map()});
      const group = result.get(normalized);
      group.count++;
      group.texts.set(row, (group.texts.get(row) ?? 0) + 1);
    }
    return result;
  };
  // Historical duplicates are data, including their original spelling. Only
  // unchanged existing occurrences may coexist; editing/appending cannot
  // introduce another exact or normalization-equivalent copy.
  const previousGroups = groups(previous);
  for (const [normalized, group] of groups(next)) {
    if (group.count > 1 && [...group.texts].some(([row, count]) => count > (previousGroups.get(normalized)?.texts.get(row) ?? 0))) throw new Error('自述或大纲不能新增重复条目');
  }
  return clone(next);
}

// Each task keeps its approved prompt and prior output; common evidence is sent once.
export function buildCombinedNarrativeRequest(tickets) {
  if (!Array.isArray(tickets) || !tickets.length) throw new Error('没有启用的叙事功能');
  if (tickets.length === 1) return buildNarrativeRequest({ticket: tickets[0]});
  if (tickets.length !== 2 || new Set(tickets.map(ticket => ticket.kind)).size !== 2 || tickets.some(ticket => !['self', 'outline'].includes(ticket.kind) || JSON.stringify(ticket.source.requestedRange) !== JSON.stringify(tickets[0].source.requestedRange))) throw new Error('合并叙事必须使用相同批次范围');
  const schema = {name: 'narrative_combined', value: {type: 'object', additionalProperties: false, required: tickets.map(ticket => ticket.kind), properties: Object.fromEntries(tickets.map(ticket => [ticket.kind, narrativeSchema(ticket.kind).value]))}};
  const parts = [{name: '叙事任务身份与边界', role: 'system', content: narrativeOpening(true), fixed: true, key: null}];
  const groups = narrativeMaterialGroups(tickets);
  for (const group of groups.filter(group => !group.kind)) parts.push(materialPart(group));
  for (const [index, kind] of ['outline', 'self'].entries()) {
    const ticket = tickets.find(item => item.kind === kind);
    parts.push(narrativeTaskPart(ticket, index));
    for (const group of groups.filter(group => group.kind === kind)) parts.push(materialPart(group));
    parts.push({name: `${kindLabel(kind)}具体任务`, role: 'system', content: '你本阶段的具体任务：', fixed: true, key: null});
    parts.push({name: `${kindLabel(kind)}提示词`, role: 'system', content: ticket.preferences.prompt.trim() ? ticket.preferences.prompt : DEFAULT_NARRATIVE_PROMPTS[ticket.kind], fixed: false, key: `${ticket.kind}.prompt`});
  }
  parts.push({name: '固定合并输出结构', role: 'system', content: `输出任务结果的格式要求：\n${NARRATIVE_PROTOCOL}\n${NARRATIVE_SELF_PROTOCOL}\n分别返回 self 与 outline 顶层字段，各自遵守对应内容要求。\n${JSON.stringify(schema.value)}`, fixed: true, key: null});
  return {task: 'narrative.combined', title: '角色自述与故事大纲', messages: parts.map(({role, content}) => ({role, content})), previewParts: parts, schema};
}
export function parseCombinedNarrativeResponse(value, kinds) {
  if (kinds.length === 1) return {[kinds[0]]: parseNarrativeResponse(value, {kind: kinds[0]})};
  if (typeof value === 'string') {
    try { value = JSON.parse(value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu, '$1')); } catch { throw new Error('自述或大纲输出不是有效 JSON'); }
  }
  if (!exact(value, kinds)) throw new Error('合并叙事输出结构无效');
  return value;
}
