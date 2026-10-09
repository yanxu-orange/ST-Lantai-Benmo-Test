import {normalizeControls} from '../../domain/controls/model.js';
import {assertWorkshop} from '../../domain/workshop/model.js';
import {validateTimeReminders} from './time-reminders.js';
import { createDefaultEventWords } from './default-event-words.js';
import { SUMMARY_PROMPT_KEYS } from './summary-prompts.js';
import { createDefaultCleaningRules, normalizeCleaningRule } from '../../domain/summary/cleaning.js';

export const SETTINGS_KEY = 'lantai_benmo';
export const PROMPT_KEYS = SUMMARY_PROMPT_KEYS;
const messages = Object.freeze({
  INVALID_SETTINGS: '兰台设置格式无效，请检查设置内容。',
  SETTINGS_CONFLICT: '设置已发生变化，请重新读取后保存。',
  SETTINGS_COMMIT_UNCONFIRMED: '设置保存结果尚未确认，可能已经保存；请恢复连接后重新读取，不要重复提交。',
  SETTINGS_UNAVAILABLE: '当前宿主无法安全读取或确认设置。',
});
export class SettingsError extends Error {
  constructor(code = 'INVALID_SETTINGS') {
    const safe = Object.hasOwn(messages, code) ? code : 'INVALID_SETTINGS';
    super(messages[safe]); this.name = 'SettingsError'; this.code = safe;
  }
}
const invalid = () => { throw new SettingsError(); };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
const text = (value, empty = false) => typeof value === 'string' && value.trim() === value && (empty || !!value);
function ai(value) {
  exact(value, ['source', 'activePresetId', 'presets']);
  if (![null, 'sillytavern', 'plugin'].includes(value.source) || !Array.isArray(value.presets)
    || !(value.activePresetId === null || text(value.activePresetId))) invalid();
  const ids = new Set(), names = new Set();
  for (const preset of value.presets) {
    exact(preset, ['id', 'name', 'endpoint', 'model', 'secretId']);
    if (!text(preset.id) || !text(preset.name) || ids.has(preset.id) || names.has(preset.name)
      || !text(preset.endpoint, true) || !text(preset.model, true) || !text(preset.secretId, true)) invalid();
    ids.add(preset.id); names.add(preset.name);
    if (preset.secretId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(preset.secretId)) invalid();
    if (preset.endpoint) {
      let url;
      try { url = new URL(preset.endpoint); } catch { invalid(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
    }
  }
  if (value.activePresetId !== null && !ids.has(value.activePresetId)) invalid();
  return value;
}
function generation(value) {
  const legacy = value && Object.keys(value).length === 2;
  exact(value, legacy ? ['eventWords', 'promptOverrides'] : ['eventWords', 'promptOverrides', 'generationMode', 'customPrompts', 'summaryCleaning']);
  if (!Array.isArray(value.eventWords)) invalid();
  const ids = new Set(), names = new Set();
  for (const word of value.eventWords) {
    exact(word, ['id', 'name', 'definition', 'enabled']);
    if (!text(word.id) || !text(word.name) || typeof word.definition !== 'string' || typeof word.enabled !== 'boolean'
      || ids.has(word.id) || names.has(word.name)) invalid();
    ids.add(word.id); names.add(word.name);
  }
  const overrides = value.promptOverrides;
  if (!overrides || Object.getPrototypeOf(overrides) !== Object.prototype
    || Object.entries(overrides).some(([key, value]) => !PROMPT_KEYS.includes(key) || typeof value !== 'string')) invalid();
  if (legacy) return { ...value, generationMode: 'quality', customPrompts: [], summaryCleaning: { rules: createDefaultCleaningRules() } };
  if (!['fast', 'quality', 'enhanced'].includes(value.generationMode) || !Array.isArray(value.customPrompts)) invalid();
  const customIds = new Set();
  for (const prompt of value.customPrompts) {
    exact(prompt, ['id', 'name', 'content', 'position']);
    if (!text(prompt.id) || !text(prompt.name) || typeof prompt.content !== 'string' || !prompt.content.trim()
      || !['before', 'after'].includes(prompt.position) || customIds.has(prompt.id)) invalid();
    customIds.add(prompt.id);
  }
  exact(value.summaryCleaning, ['rules']);
  if (!Array.isArray(value.summaryCleaning.rules)) invalid();
  const ruleIds = new Set();
  for (const rule of value.summaryCleaning.rules) {
    exact(rule, ['id', 'name', 'enabled', 'action', 'pattern', 'captureGroup', 'replacement']);
    normalizeCleaningRule(rule);
    if (!text(rule.id) || !text(rule.name) || ruleIds.has(rule.id)) invalid();
    ruleIds.add(rule.id);
  }
  return value;
}
export function frozenSettingsCopy(value) {
  try {
    const copy = structuredClone(value);
    const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
    freeze(copy); return copy;
  } catch { throw new SettingsError(); }
}
export function settingsFingerprint(value) {
  if (value === undefined) return 'absent';
  const ordered = item => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(value));
}
export const equalSettings = (a, b) => settingsFingerprint(a) === settingsFingerprint(b);
export function defaultRecallSettings() { return { recentFloorCount:6,maxCount:5,maxTokens:null,memoryDepth:9999,anniversaryPoolLimit:2,automaticSameDayEnabled:true,excludedTerms:[],recallCleaning:{rules:[]} }; }
export function assertRecallSettings(value) {
  try {
    value={anniversaryPoolLimit:2,automaticSameDayEnabled:true,...value};
    exact(value,['recentFloorCount','maxCount','maxTokens','memoryDepth','excludedTerms','recallCleaning','anniversaryPoolLimit','automaticSameDayEnabled']);
    if(typeof value.automaticSameDayEnabled!=='boolean'||!(value.anniversaryPoolLimit===null||Number.isSafeInteger(value.anniversaryPoolLimit)&&value.anniversaryPoolLimit>=0))invalid();
    if(!Number.isSafeInteger(value.recentFloorCount)||value.recentFloorCount<0||!Number.isSafeInteger(value.maxCount)||value.maxCount<1
      ||!(value.maxTokens===null||Number.isSafeInteger(value.maxTokens)&&value.maxTokens>0)||!Number.isSafeInteger(value.memoryDepth)||value.memoryDepth<0||value.memoryDepth>10000)invalid();
    if(!Array.isArray(value.excludedTerms)||value.excludedTerms.some(term=>!text(term))||new Set(value.excludedTerms).size!==value.excludedTerms.length)invalid();
    exact(value.recallCleaning,['rules']);if(!Array.isArray(value.recallCleaning.rules))invalid();
    const ids=new Set();for(const rule of value.recallCleaning.rules){exact(rule,['id','name','enabled','action','pattern','captureGroup','replacement']);normalizeCleaningRule(rule);if(!text(rule.id)||!text(rule.name)||ids.has(rule.id))invalid();ids.add(rule.id);}
    return frozenSettingsCopy(value);
  }catch{throw new SettingsError();}
}
export function emptySettings() {
  return { schema: 2, revision: 0, domainRevisions: { ai: 0, eventGeneration: 0,recall:0 },recall:defaultRecallSettings(), credentials: [], ai: { source: null, activePresetId: null, presets: [] },
    eventGeneration: { eventWords: createDefaultEventWords(), promptOverrides: {}, generationMode: 'quality', customPrompts: [], summaryCleaning: { rules: createDefaultCleaningRules() } } };
}
export function assertCumulativeGeneration(value) {
  try {
    if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!['promptOverrides','injectionPosition'].includes(key)))invalid();
    if(Object.hasOwn(value,'promptOverrides')) {
      const prompts=value.promptOverrides;
      if(!prompts||Object.getPrototypeOf(prompts)!==Object.prototype||Object.entries(prompts).some(([key,item])=>!['identity','rules','outputFormat'].includes(key)||typeof item!=='string'))invalid();
    }
    if(Object.hasOwn(value,'injectionPosition')&&(!Number.isSafeInteger(value.injectionPosition)||value.injectionPosition<0||value.injectionPosition>10000))invalid();
    return frozenSettingsCopy(value);
  }catch{throw new SettingsError();}
}
export function assertTimeReminders(value){try{return frozenSettingsCopy(validateTimeReminders(value));}catch{throw new SettingsError();}}
export function assertSettings(value) {
  try {
    const legacy = value?.schema === 1;
    const hasControls=Object.hasOwn(value??{},'controls'),hasControlsRevision=Object.hasOwn(value?.domainRevisions??{},'controls');
    if(hasControls!==hasControlsRevision)invalid();
    const hasRecall=Object.hasOwn(value??{},'recall'),hasRecallRevision=Object.hasOwn(value?.domainRevisions??{},'recall');
    const hasCumulative=Object.hasOwn(value??{},'cumulativeGeneration'),hasCumulativeRevision=Object.hasOwn(value?.domainRevisions??{},'cumulativeGeneration');
    const hasWorkshop=Object.hasOwn(value??{},'workshop'),hasWorkshopRevision=Object.hasOwn(value?.domainRevisions??{},'workshop');
    if(hasWorkshop!==hasWorkshopRevision)invalid();
    const hasTime=Object.hasOwn(value??{},'timeReminders'),hasTimeRevision=Object.hasOwn(value?.domainRevisions??{},'timeReminders');
    if(hasTime!==hasTimeRevision)invalid();
    if(hasCumulative!==hasCumulativeRevision)invalid();
    if(hasRecall!==hasRecallRevision)invalid();
    exact(value, ['schema', 'revision', 'domainRevisions', 'ai', 'eventGeneration', ...(legacy ? [] : ['credentials']),...(hasRecall?['recall']:[]),...(hasCumulative?['cumulativeGeneration']:[]),...(hasTime?['timeReminders']:[]),...(hasWorkshop?['workshop']:[]),...(hasControls?['controls']:[])]);
    if (![1, 2].includes(value.schema) || !Number.isSafeInteger(value.revision) || value.revision < 0) invalid();
    exact(value.domainRevisions, ['ai', 'eventGeneration',...(hasRecallRevision?['recall']:[]),...(hasCumulativeRevision?['cumulativeGeneration']:[]),...(hasTimeRevision?['timeReminders']:[]),...(hasWorkshopRevision?['workshop']:[]),...(hasControlsRevision?['controls']:[])]);
    if (Object.values(value.domainRevisions).some(version => !Number.isSafeInteger(version) || version < 0)
      || value.domainRevisions.ai + value.domainRevisions.eventGeneration +(value.domainRevisions.recall??0)+(value.domainRevisions.cumulativeGeneration??0)+(value.domainRevisions.timeReminders??0)+(value.domainRevisions.workshop??0)+(value.domainRevisions.controls??0)!== value.revision) invalid();
    ai(value.ai); const eventGeneration = generation(value.eventGeneration);
    if(!hasRecall&&(value.domainRevisions.recall??0)!==0)invalid();
    const migrated = { ...value, schema: 2, credentials: legacy ? [] : value.credentials, eventGeneration,domainRevisions:{...value.domainRevisions,recall:value.domainRevisions.recall??0},recall:hasRecall?assertRecallSettings(value.recall):defaultRecallSettings() };
    if(hasControls)migrated.controls=normalizeControls(value.controls);
    if(hasWorkshop)migrated.workshop=assertWorkshop(value.workshop);
    if(hasTime)migrated.timeReminders=assertTimeReminders(value.timeReminders);
    if(hasCumulative)migrated.cumulativeGeneration=assertCumulativeGeneration(value.cumulativeGeneration);
    if (!Array.isArray(migrated.credentials)) invalid();
    const ids = new Set();
    for (const credential of migrated.credentials) {
      exact(credential, ['presetId', 'value']);
      if (!migrated.ai.presets.some(preset => preset.id === credential.presetId) || ids.has(credential.presetId)) invalid();
      assertCredential(credential.value); ids.add(credential.presetId);
    }
    return frozenSettingsCopy(migrated);
  } catch { throw new SettingsError(); }
}
export function assertAiSettings(value) { try { return frozenSettingsCopy(ai(value)); } catch { throw new SettingsError(); } }
export function assertEventGeneration(value) { try { return frozenSettingsCopy(generation(value)); } catch { throw new SettingsError(); } }
export function assertCredential(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) invalid();
  return value;
}
export function publicSettings(root) {
  return frozenSettingsCopy({ ...root, credentials: root.credentials.map(({ presetId }) => ({ presetId })) });
}
export function aiConfig(root, epoch) {
  if (root.ai.source === 'sillytavern') return Object.freeze({ source: 'sillytavern' });
  const preset = root.ai.presets.find(item => item.id === root.ai.activePresetId);
  if (root.ai.source !== 'plugin' || !preset?.endpoint || !preset.model || !root.credentials.some(item => item.presetId === preset.id)) return Object.freeze({ source: null });
  return Object.freeze({ source: 'plugin', endpoint: preset.endpoint, model: preset.model, credentialId: preset.id, credentialEpoch: epoch });
}
