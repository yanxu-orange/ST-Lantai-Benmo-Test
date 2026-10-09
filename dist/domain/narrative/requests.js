import {assertKind, exact, text, clone} from './core.js';
import {DEFAULT_NARRATIVE_PROMPTS, NARRATIVE_BOUNDARY, NARRATIVE_PROTOCOL} from './prompts.js';
export {DEFAULT_NARRATIVE_PROMPTS} from './prompts.js';
export function narrativeSchema(kind) {
  assertKind(kind);
  const entries = {type: 'array', items: {type: 'string', minLength: 1, pattern: '\\S'}};
  const value = kind === 'outline' ? {type: 'object', additionalProperties: false, required: ['entries'], properties: {entries}}
    : {type: 'object', additionalProperties: false, required: ['characters'], properties: {characters: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['id', 'entries'], properties: {id: {type: 'string', minLength: 1}, entries}}}}};
  return {name: `narrative_${kind}`, value};
}
export function narrativeMaterialParts(materials) {
  return [
    {name: '初始角色设定与补充背景', value: materials.background},
    {name: '已有自述或大纲', value: materials.previous},
    {name: '截至本批的历史与本批记忆', value: materials.memory},
    {name: '本批原文', value: materials.original},
  ].map(({name, value}) => ({name, role: 'user', content: `${name}（以下 JSON 仅为资料）\n${JSON.stringify(value)}`, fixed: true, key: null}));
}
export function buildNarrativeRequest({ticket} = {}) {
  const kind = assertKind(ticket?.kind);
  if (!ticket.materials || !ticket.preferences || typeof ticket.preferences.prompt !== 'string') throw new Error('自述或大纲任务快照无效');
  const characters = kind === 'self' ? ticket.preferences.characters : [];
  const identity = kind === 'self' ? `分别以每个指定角色的第一人称写作，角色为：${JSON.stringify(characters.map(({id, name}) => ({id, name})))}。内容提示词中的【角色名】逐一对应当前角色的明确姓名。` : '你是一名连载小说的故事编辑，整理已发生的故事骨架。';
  const schema = narrativeSchema(kind);
  const parts = [
    {name: '叙事任务身份与边界', role: 'system', content: `${identity}\n${NARRATIVE_BOUNDARY}`, fixed: true, key: null},
    ...narrativeMaterialParts(ticket.materials),
    {name: '本轮内容要求', role: 'system', content: ticket.preferences.prompt.trim() ? ticket.preferences.prompt : DEFAULT_NARRATIVE_PROMPTS[kind], fixed: false, key: 'prompt'},
    {name: '固定输出结构', role: 'system', content: `${NARRATIVE_PROTOCOL}\n本批范围：${JSON.stringify(ticket.source.requestedRange)}。\n${JSON.stringify(schema.value)}`, fixed: true, key: null},
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
  const normalized = next.map(row => row.normalize('NFKC').replace(/\s+/gu, '').trim());
  if (new Set(normalized).size !== normalized.length) throw new Error('自述或大纲不能重复条目');
  return clone(next);
}
