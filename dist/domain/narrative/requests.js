import {assertKind, exact, text, clone} from './core.js';
import {DEFAULT_NARRATIVE_PROMPTS, LEGACY_NARRATIVE_PROMPTS, NARRATIVE_IDENTITIES, NARRATIVE_REQUIREMENTS} from './prompts.js';
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
  return [narrativeMemoryTime(row) ? `时间：${narrativeMemoryTime(row)}` : '', text(row.title) ? `标题：${row.title}` : '', text(row.body) ? `正文：\n${row.body}` : ''].filter(Boolean).join('\n');
}
function nonemptyMaterial(group) {
  const {field, value, kind} = group;
  if (field === 'card') return value && Object.values(value).some(item => typeof item === 'string' && item.trim());
  if (field === 'supplement') return typeof value === 'string' && value.trim();
  if (field === 'previous' && kind === 'self') return value.some(row => row.entries?.some(text));
  return Array.isArray(value) && value.length > 0;
}
function materialPart({field, name, value, kind = null}, perspective = null) {
  let body;
  if (field === 'card') body = value ? [['name', '姓名'], ['description', '角色描述'], ['personality', '性格'], ['scenario', '初始情境']].filter(([key]) => text(value[key])).map(([key, label]) => `${label}：\n${value[key]}`).join(NARRATIVE_MATERIAL_SEPARATOR) : '';
  else if (field === 'memory') body = value.map(narrativeMemoryText).join(NARRATIVE_MATERIAL_SEPARATOR);
  else if (field === 'original') body = value.map(row => row.text).join(NARRATIVE_MATERIAL_SEPARATOR);
  else if (field === 'previous') body = kind === 'self' ? value.filter(row => row.entries?.some(text)).map(row => `${value.length > 1 ? `${row.name}：\n` : ''}${entryText(row.entries)}`).join(NARRATIVE_MATERIAL_SEPARATOR) : entryText(value);
  else body = value;
  const heading = field === 'card' ? (perspective === 'self' ? '这是你的具体身份' : '这是故事中的人物设定')
    : ['memory', 'original'].includes(field) ? (perspective === 'self' ? '这是你的人生经历' : '这是已经发生的故事')
    : field === 'supplement' ? (kind === 'self' ? '这是一些特殊信息' : '这是一些补充信息')
    : kind === 'self' ? '这是你过去的看法和自述' : '这是此前整理的故事大纲';
  return {field, name, kind, role: 'user', content: `${heading}：\n${body}`, fixed: true, key: null};
}
export function narrativeMaterialParts(materials, kind = materials.previous?.some(row => typeof row === 'object') ? 'self' : 'outline') {
  return [
    {field: 'card', name: '角色设定', value: materials.background.initialCharacter},
    {field: 'memory', name: '记忆资料', value: materials.memory},
    {field: 'original', name: '剧情原文', value: materials.original},
    {field: 'supplement', name: '补充信息', value: materials.background.supplement, kind},
    {field: 'previous', name: kind === 'self' ? '已有角色自述' : '已有故事大纲', value: materials.previous, kind},
  ].filter(nonemptyMaterial).map(group => materialPart(group, kind));
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
  return groups.filter(nonemptyMaterial);
}
function characterNames(ticket) { return ticket.preferences.characters.map(row => row.name).join('、'); }
function substituteName(content, ticket) {
  if (ticket.kind !== 'self') return content;
  return content.replaceAll('【角色名】', characterNames(ticket)).replaceAll('［角色名称］', characterNames(ticket));
}
function promptContent(ticket) {
  const saved = ticket.preferences.prompt;
  const builtIn = !saved.trim() || saved === DEFAULT_NARRATIVE_PROMPTS[ticket.kind] || saved === LEGACY_NARRATIVE_PROMPTS[ticket.kind];
  return {builtIn, content: substituteName(builtIn ? NARRATIVE_REQUIREMENTS[ticket.kind] : saved, ticket)};
}
const systemPart = (name, content, key = null) => ({name, role: 'system', content, fixed: key === null, key});
function identity(ticket, combined = false) {
  if (!promptContent(ticket).builtIn) return combined ? '' : '请阅读下面的资料，并按照后面的具体要求完成任务。';
  if (!combined) return substituteName(NARRATIVE_IDENTITIES[ticket.kind], ticket);
  if (ticket.kind === 'outline') return '你是一名连载小说的故事编辑，擅长梳理主线、重要支线和关键转折。请结合刚才读到的故事与下面的信息，更新故事大纲，让读者能够理解故事如何发展到当前。';
  const names = characterNames(ticket);
  const hasCard = nonemptyMaterial({field: 'card', value: ticket.materials.background.initialCharacter});
  return `现在，请进入${names}的身份。你是${names}，是这个世界的主角。${hasCard ? '刚才的人物设定中包含你的身份，' : ''}故事中记录了你的经历。请结合这些经历和下面的信息，为此刻的自己更新一份简短自述。`;
}
function outputPart(tickets, schema, combined = false) {
  const self = tickets.find(ticket => ticket.kind === 'self');
  const mapping = self ? `\n${self.preferences.characters.map(row => `${row.name}的 id 填写“${row.id}”。`).join('\n')}` : '';
  const subject = combined ? '结果' : self ? '自述' : '大纲';
  const introduction = combined ? '两项工作完成后，请以小说创作助理的身份，按以下格式统一提交两项结果。\n\n' : '';
  const rules = `返回完整更新结果的 JSON，不加 Markdown 或解释。每条${combined ? '大纲或自述' : subject}为一个字符串，按剧情顺序排列。\n\n只能修改${combined ? '每组' : ''}已有${subject}的最后两条及追加，更早条目必须逐字保留。没有重要变化时逐字返回已有${subject}；尚无${subject}且没有重要变化时，${combined ? '对应的 ' : ''}entries 返回空数组。不得新增重复条目。${self ? '后来的认识不能改写早期自述。' : ''}`;
  const fields = combined ? '返回对象只包含 outline 和 self 两个字段。outline 包含 entries，填写完整大纲条目数组；self 包含 characters，数组中每个角色包含 id 和 entries，填写完整自述条目数组。'
    : self ? `返回对象只包含 characters 数组。数组中返回${characterNames(self)}的结果，包含 id 和 entries 两个字段，entries 填写完整自述条目数组。`
    : '返回对象只包含 entries 字段，填写完整大纲条目数组。';
  return systemPart('固定输出结构', `STEP 3 输出${combined ? '结果' : self ? '自述' : '大纲'}\n\n${introduction}${rules}\n\n${fields}${mapping}`);
}
export function buildNarrativeRequest({ticket} = {}) {
  const kind = assertKind(ticket?.kind);
  if (!ticket.materials || !ticket.preferences || typeof ticket.preferences.prompt !== 'string') throw new Error('自述或大纲任务快照无效');
  const schema = narrativeSchema(kind), prompt = promptContent(ticket);
  const parts = [
    systemPart('身份与任务', `${identity(ticket)}\n\nSTEP 1 ${kind === 'self' ? '了解你是谁' : '了解故事'}`),
    ...narrativeMaterialParts(ticket.materials, kind),
    systemPart('工作步骤', `STEP 2 ${kind === 'self' ? '分析此刻的自我' : '梳理故事的发展'}`),
    systemPart('本轮内容要求', prompt.content, 'prompt'),
    outputPart([ticket], schema),
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
  const self = tickets.find(ticket => ticket.kind === 'self');
  const parts = [systemPart('身份与任务', `你是一名小说创作助理，擅长通过沉浸式代入不同身份，完成相应的工作。接下来，请先了解下面的人物与故事，再依次完成两项任务：以故事编辑的身份更新故事大纲；以${characterNames(self)}的身份，为此刻的自己更新自述。\n\nSTEP 1 以助理的身份做前期工作，了解人物与故事`)];
  const groups = narrativeMaterialGroups(tickets);
  for (const group of groups.filter(group => !group.kind)) parts.push(materialPart(group));
  parts.push(systemPart('工作步骤', 'STEP 2 启用最擅长的沉浸式代入法，开始工作'));
  for (const [index, kind] of ['outline', 'self'].entries()) {
    const ticket = tickets.find(item => item.kind === kind);
    parts.push(systemPart(`任务${index === 0 ? '一' : '二'}：${kind === 'outline' ? '故事大纲' : '角色自述'}`, `任务${index === 0 ? '一' : '二'}：更新${kind === 'outline' ? '故事大纲' : '角色自述'}\n\n${identity(ticket, true)}`.trimEnd()));
    for (const group of groups.filter(group => group.kind === kind)) parts.push(materialPart(group, kind));
    parts.push(systemPart(`${kindLabel(kind)}提示词`, promptContent(ticket).content, `${kind}.prompt`));
  }
  parts.push(outputPart(tickets, schema, true));
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
