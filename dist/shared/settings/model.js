import {DEFAULT_SCHEDULE_INSTRUCTIONS,assertScheduleTrackingConfig} from '../../domain/time/schedule-prompts.js';
import {assertTrackingPrompts, DEFAULT_TRACKING_PROMPTS, migrateTrackingPrompts} from '../../domain/tracking/prompts.js';
import {normalizeControls, assertControls, defaultControls} from '../../domain/controls/model.js';
import {assertWorkshop, emptyWorkshop} from '../../domain/workshop/model.js';
import {validateTimeReminders, defaultTimeReminders, reviseTimeRemindersDefaults} from './time-reminders.js';
import { createDefaultEventWords } from './default-event-words.js';
import { CUMULATIVE_PROMPT_KEYS } from './cumulative-prompts.js';
import { SUMMARY_PROMPT_KEYS, migrateSummaryPromptOverrides } from './summary-prompts.js';
import { createDefaultCleaningRules, normalizeCleaningRule } from '../../domain/summary/cleaning.js';

export const SETTINGS_KEY = 'lantai_benmo';
export const PROMPT_KEYS = SUMMARY_PROMPT_KEYS;
const messages = Object.freeze({
  TASK_PRESET_MISSING: '此任务选择的 API 方案不存在，请在任务 API 设置中重新选择。',
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
export const AI_TASK_GROUPS = Object.freeze(['event', 'cumulative', 'narrative', 'latest']);
export function defaultTaskRoutes() { return Object.fromEntries(AI_TASK_GROUPS.map(group => [group, { source: 'inherit', presetId: null, model: '' }])); }
export function assertTaskRoutes(value) {
  exact(value, AI_TASK_GROUPS);
  for (const route of Object.values(value)) {
    exact(route, ['source', 'presetId', 'model']);
    if (!['inherit', 'sillytavern', 'plugin'].includes(route.source) || !(route.presetId === null || text(route.presetId)) || !text(route.model, true)) invalid();
  }
  return value;
}
function ai(value) {
  exact(value, ['source', 'activePresetId', 'presets', ...(Object.hasOwn(value ?? {}, 'taskRoutes') ? ['taskRoutes'] : [])]);
  if (Object.hasOwn(value, 'taskRoutes')) assertTaskRoutes(value.taskRoutes);
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
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const trackingKeys = ['trackingItemsEnabled', 'trackingNpcsEnabled', 'trackingIdentityReferencesEnabled'];
  const legacy = Object.keys(value).filter(key => !trackingKeys.includes(key)).length === 2;
  value = { trackingItemsEnabled: false, trackingNpcsEnabled: false, trackingIdentityReferencesEnabled: true, ...value };
  exact(value, [...(legacy ? ['eventWords', 'promptOverrides'] : ['eventWords', 'promptOverrides', 'generationMode', 'customPrompts', 'summaryCleaning']), ...trackingKeys]);
  if (trackingKeys.some(key => typeof value[key] !== 'boolean')) invalid();
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
export function defaultRecallSettings() { return { recentFloorCount:6,maxCount:5,maxTokens:null,memoryDepth:9999,anniversaryPoolLimit:2,automaticSameDayEnabled:true,bodySupplementEnabled:false,bodySupplementMaxTokens:500,bodySupplementReminderEnabled:false,excludedTerms:[],recallCleaning:{rules:[]} }; }
export function assertRecallSettings(value) {
  try {
    value={anniversaryPoolLimit:2,automaticSameDayEnabled:true,bodySupplementEnabled:false,bodySupplementMaxTokens:500,bodySupplementReminderEnabled:false,...value};
    exact(value,['recentFloorCount','maxCount','maxTokens','memoryDepth','excludedTerms','recallCleaning','anniversaryPoolLimit','automaticSameDayEnabled','bodySupplementEnabled','bodySupplementMaxTokens','bodySupplementReminderEnabled']);
    if(typeof value.bodySupplementEnabled!=='boolean'||typeof value.bodySupplementReminderEnabled!=='boolean'||!Number.isSafeInteger(value.bodySupplementMaxTokens)||value.bodySupplementMaxTokens<0)invalid();
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
    eventGeneration: { trackingItemsEnabled: false, trackingNpcsEnabled: false, trackingIdentityReferencesEnabled: true, eventWords: createDefaultEventWords(), promptOverrides: {}, generationMode: 'quality', customPrompts: [], summaryCleaning: { rules: createDefaultCleaningRules() } } };
}
export function defaultCumulativeGeneration() {
  return { trackingItemsEnabled: false, trackingNpcsEnabled: false, trackingIdentityReferencesEnabled: true };
}
export function assertCumulativeGeneration(value) {
  try {
    const trackingKeys = Object.keys(defaultCumulativeGeneration());
    if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!['promptOverrides','injectionPosition',...trackingKeys].includes(key)))invalid();
    value = { ...defaultCumulativeGeneration(), ...value };
    if (trackingKeys.some(key => typeof value[key] !== 'boolean')) invalid();
    if(Object.hasOwn(value,'promptOverrides')) {
      const prompts=value.promptOverrides;
      if(!prompts||Object.getPrototypeOf(prompts)!==Object.prototype||Object.entries(prompts).some(([key,item])=>!CUMULATIVE_PROMPT_KEYS.includes(key)||typeof item!=='string'))invalid();
    }
    if(Object.hasOwn(value,'injectionPosition')&&(!Number.isSafeInteger(value.injectionPosition)||value.injectionPosition<0||value.injectionPosition>10000))invalid();
    return frozenSettingsCopy(value);
  }catch{throw new SettingsError();}
}
export function defaultScheduleTracking(){return {categories:['schedule','anniversary'],instructions:DEFAULT_SCHEDULE_INSTRUCTIONS};}
export function assertScheduleTracking(value){try{return frozenSettingsCopy(assertScheduleTrackingConfig(value));}catch{throw new SettingsError();}}
export function assertTimeReminders(value){try{return frozenSettingsCopy(validateTimeReminders(value));}catch{throw new SettingsError();}}
export function assertSettings(value) {
  try {
    const legacy = value?.schema === 1;
    const present = field => Object.hasOwn(value ?? {}, field);
    const optional = SETTINGS_DOMAIN_KEYS.filter(field => SETTINGS_DOMAINS[field].optional && present(field));
    for (const field of SETTINGS_DOMAIN_KEYS) {
      if (SETTINGS_DOMAINS[field].optional && present(field) !== Object.hasOwn(value?.domainRevisions ?? {}, field)) invalid();
    }
    const hasTracking = present('trackingPrompts'), hasControls = present('controls'), hasRecall = present('recall');
    const hasCumulative = present('cumulativeGeneration'), hasWorkshop = present('workshop'), hasTime = present('timeReminders');
    const required = SETTINGS_DOMAIN_KEYS.filter(field => !SETTINGS_DOMAINS[field].optional);
    exact(value, ['schema', 'revision', 'domainRevisions', ...required, ...(legacy ? [] : ['credentials']), ...optional]);
    if (![1, 2].includes(value.schema) || !Number.isSafeInteger(value.revision) || value.revision < 0) invalid();
    exact(value.domainRevisions, [...required, ...optional]);
    if (Object.values(value.domainRevisions).some(version => !Number.isSafeInteger(version) || version < 0)
      || SETTINGS_DOMAIN_KEYS.reduce((sum, field) => sum + (value.domainRevisions[field] ?? 0), 0) !== value.revision) invalid();
    ai(value.ai); const validatedGeneration = generation(value.eventGeneration);
    // This is a normalized read view, not a persistence operation. Match the
    // complete known old default; near-matches, edits and explicit blanks are
    // user content and must survive both loading and unrelated settings saves.
    const eventGeneration = { ...validatedGeneration, promptOverrides: migrateSummaryPromptOverrides(validatedGeneration.promptOverrides) };
    if(!hasRecall&&(value.domainRevisions.recall??0)!==0)invalid();
    const migrated = { ...value, schema: 2, credentials: legacy ? [] : value.credentials, eventGeneration,domainRevisions:{...value.domainRevisions,recall:value.domainRevisions.recall??0},recall:hasRecall?assertRecallSettings(value.recall):defaultRecallSettings() };
    if(present('scheduleTracking'))migrated.scheduleTracking=assertScheduleTracking(value.scheduleTracking);
    if(hasTracking)migrated.trackingPrompts=migrateTrackingPrompts(assertTrackingPrompts(value.trackingPrompts));
    if(hasControls)migrated.controls=normalizeControls(value.controls);
    if(hasWorkshop)migrated.workshop=assertWorkshop(value.workshop);
    if(hasTime)migrated.timeReminders=assertTimeReminders(reviseTimeRemindersDefaults(value.timeReminders));
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
// Domain assembly only. Stored migrations remain explicit: a
// read default, a no-op default and an absent fingerprint are different facts.
export const SETTINGS_DOMAINS = Object.freeze(Object.fromEntries(Object.entries({
  ai: { validate: assertAiSettings, credentials: true },
  eventGeneration: { validate: assertEventGeneration },
  recall: { validate: assertRecallSettings, optional: true },
  cumulativeGeneration: { validate: assertCumulativeGeneration, optional: true, fingerprintAbsent: true, readDefault: defaultCumulativeGeneration },
  timeReminders: { validate: assertTimeReminders, optional: true, fingerprintAbsent: true, readDefault: defaultTimeReminders, noOpDefault: defaultTimeReminders },
  workshop: { validate: assertWorkshop, optional: true, fingerprintAbsent: true, readDefault: emptyWorkshop, noOpDefault: emptyWorkshop },
  controls: { validate: assertControls, optional: true, fingerprintAbsent: true, readDefault: defaultControls, noOpDefault: defaultControls },
  scheduleTracking: { validate: assertScheduleTracking, optional: true, fingerprintAbsent: true, readDefault: defaultScheduleTracking, noOpDefault: defaultScheduleTracking },
  trackingPrompts: { validate: assertTrackingPrompts, optional: true, fingerprintAbsent: true, readDefault: () => DEFAULT_TRACKING_PROMPTS },
}).map(([field, definition]) => [field, Object.freeze(definition)])));
export const SETTINGS_DOMAIN_KEYS = Object.freeze(Object.keys(SETTINGS_DOMAINS));
export function settingsDomainValue(root, field, purpose = 'read') {
  const fallback = SETTINGS_DOMAINS[field][purpose === 'no-op' ? 'noOpDefault' : 'readDefault'];
  return root[field] ?? (fallback ? fallback() : root[field]);
}
export function settingsDomainFingerprint(root, field) {
  const definition = SETTINGS_DOMAINS[field];
  const revision = definition.fingerprintAbsent ? root.domainRevisions[field] ?? 0 : root.domainRevisions[field];
  const value = definition.fingerprintAbsent ? root[field] ?? null : root[field];
  return settingsFingerprint({ revision, value, ...(definition.credentials ? { credentials: root.credentials } : {}) });
}
export function assertCredential(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) invalid();
  return value;
}
export function publicSettings(root) {
  return frozenSettingsCopy({ ...root, credentials: root.credentials.map(({ presetId }) => ({ presetId })) });
}
export function aiConfig(root, epoch, taskGroup) {
  if (taskGroup !== undefined && !AI_TASK_GROUPS.includes(taskGroup)) throw new SettingsError();
  const route = taskGroup ? root.ai.taskRoutes?.[taskGroup] : null;
  const explicit = route && route.source !== 'inherit';
  const source = explicit ? route.source : root.ai.source;
  if (source === 'sillytavern') return Object.freeze({ source });
  const presetId = explicit ? route.presetId : root.ai.activePresetId;
  const preset = root.ai.presets.find(item => item.id === presetId);
  if (source === 'plugin' && explicit && !preset) throw new SettingsError('TASK_PRESET_MISSING');
  const model = explicit && route.model ? route.model : preset?.model;
  if (source !== 'plugin' || !preset?.endpoint || !model || !root.credentials.some(item => item.presetId === preset.id)) return Object.freeze({ source: null });
  return Object.freeze({ source: 'plugin', endpoint: preset.endpoint, model, credentialId: preset.id, credentialEpoch: epoch });
}
