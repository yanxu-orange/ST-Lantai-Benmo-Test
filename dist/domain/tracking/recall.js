import { assertRecallSettings, defaultRecallSettings } from '../../shared/settings/model.js';
import { applySummaryCleaningRules } from '../summary/cleaning.js';
import { buildRecallQueryFragments, collectMemoryStructuredWitnesses } from '../recall/structured-witness.js';
import { assertTrackingRecord, npcAbsenceTurns } from './model.js';
import { assertTrackingPreferences } from './data.js';
const LABELS = { introduction: '介绍', location: '位置', custodian: '保管者', owner: '所属者', transferFrom: '转出方', transferTo: '转入方', transferReason: '原因', appearance: '外表', identity: '身份', relationToUser: '与 user 关系', relationToChar: '与 char 关系' };
export function trackingRecordText(record, aiTurn = 0) {
  assertTrackingRecord(record);
  const fields = Object.entries(LABELS).filter(([key]) => record[key]).map(([key, label]) => `${label}：${record[key]}`);
  fields.push(...(record.customFields ?? []).filter(field => field.value.trim()).map(field => `${field.name}：${field.value}`));
  if (record.aliases.length) fields.unshift(`别名：${record.aliases.join('、')}`);
  if (record.kind === 'npc' && record.lastAppearanceTurn !== null) fields.push(`最后实际出场：第 ${record.lastAppearanceTurn} 个 AI 回合`, `缺席：${npcAbsenceTurns(record, aiTurn)} 个 AI 回合`);
  return `【${record.kind === 'npc' ? 'NPC' : '物品'}｜${record.name}】${fields.length ? `\n${fields.join('；')}` : ''}`;
}
export async function buildTrackingRecall({ records = [], input = '', recentHistory = [], aiTurn = 0,
  preferences = { itemsEnabled: true, npcsEnabled: true }, settings = defaultRecallSettings(), countTokens = null } = {}) {
  settings = assertRecallSettings(settings); preferences = assertTrackingPreferences(preferences);
  if (!Array.isArray(records) || typeof input !== 'string' || !Array.isArray(recentHistory) || !Number.isSafeInteger(aiTurn) || aiTurn < 0 || countTokens !== null && typeof countTokens !== 'function') throw new Error('追踪召回输入无效');
  const ids = new Set();
  for (const record of records) { assertTrackingRecord(record); if (ids.has(record.id)) throw new Error('追踪召回身份重复'); ids.add(record.id); }
  const clean = text => applySummaryCleaningRules(text, settings.recallCleaning.rules).text;
  const fragments = buildRecallQueryFragments({ currentInput: clean(input), recentHistory: recentHistory.slice(0, settings.recentFloorCount).map(row => ({ rawPosition: row.floor, distanceFromCurrent: row.distanceFromCurrent, originalText: row.text, cleanedText: clean(row.text) })) });
  const excluded = new Set(settings.excludedTerms), candidates = [], unselected = [];
  for (const record of records) {
    if (!preferences[record.kind === 'item' ? 'itemsEnabled' : 'npcsEnabled']) continue;
    // Literal fields reuse recall's full-name boundaries, without fuzzy identity
    // fragments: Ann is not Joanna, and an alias never fuses stored entities.
    const evidence = collectMemoryStructuredWitnesses({ id: record.id, title: excluded.has(record.name) ? '' : record.name,
      people: record.aliases.filter(alias => !excluded.has(alias)) }, fragments);
    const witnesses = evidence.parentFacts.flatMap(row => row.witnesses);
    if (!record.pinned && !witnesses.length) { unselected.push({ id: record.id, excludedReason: 'no-name-match' }); continue; }
    candidates.push({ id: record.id, record: structuredClone(record), text: trackingRecordText(record, aiTurn), pinned: record.pinned,
      distance: witnesses.length ? Math.min(...witnesses.map(row => row.distanceFromCurrent)) : Infinity,
      reasons: [...(record.pinned ? [{ code: 'pinned' }] : []), ...witnesses.map(row => ({ code: row.field === 'title' ? 'name-match' : 'alias-match', term: row.storedValue, sourceKind: row.sourceKind, distanceFromCurrent: row.distanceFromCurrent }))], tokens: null, estimated: false });
  }
  candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.distance - b.distance);
  const selected = []; let matchedCount = 0, totalTokens = 0, estimated = false, stopped = false;
  for (const candidate of candidates) {
    if (!candidate.pinned && matchedCount >= settings.maxCount) { unselected.push({ id: candidate.id, excludedReason: 'count-limit' }); continue; }
    if (!candidate.pinned && stopped) { unselected.push({ id: candidate.id, excludedReason: 'token-limit' }); continue; }
    if (!candidate.pinned && settings.maxTokens !== null) {
      try {
        const measured = countTokens ? await countTokens(candidate.text) : { tokens: Math.ceil(candidate.text.length / 2), estimated: true };
        const tokens = typeof measured === 'number' ? measured : measured?.tokens;
        if (!Number.isFinite(tokens) || tokens < 0) throw new Error();
        candidate.tokens = tokens; candidate.estimated = typeof measured === 'object' && measured.estimated === true;
        totalTokens += tokens; estimated ||= candidate.estimated; stopped = totalTokens >= settings.maxTokens;
      } catch { throw new Error('追踪召回 Token 计数失败'); }
    }
    if (!candidate.pinned) matchedCount++;
    selected.push(candidate);
  }
  const prompt = selected.length ? ['<lantai_entity_memory>', '以下为与近期对话有关或人工常驻的物品与 NPC 资料。未知信息没有填写；缺席不表示离场、消失或死亡。请作为连续性参考，不要机械复述。', ...selected.map(row => row.text), '</lantai_entity_memory>'].join('\n\n') : '';
  return { selected, selectedIds: selected.map(row => row.id), unselected, prompt,
    budget: { maxCount: settings.maxCount, maxTokens: settings.maxTokens, totalTokens: settings.maxTokens === null ? null : totalTokens, estimated, soft: true, scope: 'matched-records' } };
}
