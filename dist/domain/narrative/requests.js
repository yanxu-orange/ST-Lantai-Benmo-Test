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

// Each enabled section keeps its own approved content prompt and materials.
export function buildCombinedNarrativeRequest(tickets) {
  if (!Array.isArray(tickets) || !tickets.length) throw new Error('没有启用的叙事功能');
  if (tickets.length === 1) return buildNarrativeRequest({ticket: tickets[0]});
  if (tickets.length !== 2 || new Set(tickets.map(ticket => ticket.kind)).size !== 2 || tickets.some(ticket => !['self', 'outline'].includes(ticket.kind) || JSON.stringify(ticket.source.requestedRange) !== JSON.stringify(tickets[0].source.requestedRange))) throw new Error('合并叙事必须使用相同批次范围');
  const schema = {name: 'narrative_combined', value: {type: 'object', additionalProperties: false, required: tickets.map(ticket => ticket.kind), properties: Object.fromEntries(tickets.map(ticket => [ticket.kind, narrativeSchema(ticket.kind).value]))}};
  const characters = tickets.find(ticket => ticket.kind === 'self').preferences.characters.map(({id, name}) => ({id, name}));
  const parts = [{name: '叙事任务身份与边界', role: 'system', content: `本批分别完成角色自述与故事大纲。self：分别以每个指定角色的第一人称写作，角色为：${JSON.stringify(characters)}。内容提示词中的【角色名】逐一对应当前角色的明确姓名。outline：以故事编辑的身份整理已发生的故事骨架。\n${NARRATIVE_BOUNDARY}`, fixed: true, key: null}];
  const materials = tickets.map(ticket => narrativeMaterialParts(ticket.materials));
  for (let index = 0; index < materials[0].length; index++) {
    if (materials.every(rows => rows[index].content === materials[0][index].content)) parts.push({...materials[0][index], name: `共同${materials[0][index].name}`});
    else for (let at = 0; at < tickets.length; at++) parts.push({...materials[at][index], name: `${tickets[at].kind} ${materials[at][index].name}`, content: `仅用于 ${tickets[at].kind}：${materials[at][index].content}`});
  }
  for (const ticket of tickets) {
    parts.push({name: `${ticket.kind} 内容要求`, role: 'system', content: `以下内容要求仅用于 ${ticket.kind} 字段。`, fixed: true, key: null});
    parts.push({name: `${ticket.kind} 提示词`, role: 'system', content: ticket.preferences.prompt.trim() ? ticket.preferences.prompt : DEFAULT_NARRATIVE_PROMPTS[ticket.kind], fixed: false, key: `${ticket.kind}.prompt`});
  }
  parts.push({name: '固定合并输出结构', role: 'system', content: `${NARRATIVE_PROTOCOL}\n本批范围：${JSON.stringify(tickets[0].source.requestedRange)}。\n分别返回 self 与 outline 顶层字段，各自遵守对应内容要求。\n${JSON.stringify(schema.value)}`, fixed: true, key: null});
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
