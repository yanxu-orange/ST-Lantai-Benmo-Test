import {emptyTime} from '../domain/time/data.js';
import {createCalendar} from '../domain/time/calendar.js';
import {initialHolidayItems} from '../domain/time/catalog-items.js';
import { blankEvent, emptyRoot } from '../domain/memory/model.js';
import { emptySettings, SETTINGS_KEY } from '../shared/settings/model.js';
import { APPEARANCE_KEY } from '../platform/sillytavern/appearance-adapter.js';
import { BASE_STYLE_ENTRIES, MEMPHIS_STYLE_ENTRIES, SNOW_ERMINE_STYLE_ENTRIES } from '../app/styles/style-entries.js';

// Disposable, memory-only preview. Never reads global SillyTavern, browser storage,
// cookies, real settings, or test fixtures. Refresh resets every edit and credential.
const clone = value => structuredClone(value);
const reply = value => ({ ok: true, json: async () => clone(value) });
const blocked = () => { throw new Error('预览已阻止未声明的请求'); };
export function mockAiOutput(request) {
  const messages = request.messages ?? request.prompt;
  if (!Array.isArray(messages)) return blocked();
  if (messages.some(item => item.content.includes('LANTAI_API_CONNECTION_OK'))) return { probe: 'LANTAI_API_CONNECTION_OK' };
  const task = messages.map(item => item.content).join('\n').match(/\[LANTAI_BACKGROUND_TASK:([\w.]+)\]/)?.[1];
  if (task === 'cumulative.summary') return { summary: '【虚构预览】林岚与白川在雪山驿站重逢，约定携青色船票前往旧码头。风雪渐止，两人整理旅途见闻，等待次日出发。' };
  const payloads = messages.flatMap(item => { try { return [JSON.parse(item.content)]; } catch { return []; } });
  const drafts = payloads.find(item => item.summaryDrafts)?.summaryDrafts ?? [];
  const words = payloads.find(item => item.availableEventWords)?.availableEventWords ?? [];
  const word = words[0]?.name;
  const memory = { title: '雪山驿站的约定（虚构）', storyTime: { start: '2026年6月1日下午', end: '' }, body: '【虚构预览】林岚取走青色船票，与白川约定次日同行。', people: ['林岚', '白川'], locations: ['雪山驿站'], classificationTags: [], specialDateCandidates: [] };
  const stage = task?.replace('event.summary.', '');
  const indexes = drafts.map(draft => ({ draftId: draft.draftId, eventKeywords: word ? [word] : [], detailKeywords: ['青色船票'], detailAliases: [{ parentDetail: '青色船票', aliases: ['船票'] }] }));
  if (task?.startsWith('event.summary.')) {
    if (stage === 'fast' || stage.endsWith('Summary')) return { memories: [stage === 'fast' ? { ...memory, eventKeywords: word ? [word] : [], detailKeywords: ['青色船票'], detailAliases: [{ parentDetail: '青色船票', aliases: ['船票'] }] } : memory] };
    if (stage === 'enhancedKeywords') return { indexes: indexes.map(({ detailAliases, ...item }) => item) };
    if (stage === 'aliases') return { indexes: drafts.map(draft => ({ draftId: draft.draftId, detailAliases: [{ parentDetail: draft.detailKeywords[0], aliases: ['船票'] }] })) };
    if (stage === 'qualityIndexes') return { indexes };
  }
  if (task === 'memory.merge') return { title: '雪山与旧码头（虚构合并）', body: '【虚构预览】林岚与白川整理旅途见闻，在雪山驿站约定同行，随后前往旧码头。', coherenceWarning: '' };
  if (task === 'memory.indexes') return { indexes };
  return blocked();
}

export function createPreviewFixture({ assetFetch, delay = 200, timeConfigured = true } = {}) {
  const listeners = new Map(), slots = new Map(), calls = [];
  const eventNames = ['APP_READY', 'CHAT_CHANGED', 'CHAT_RENAMED', 'SETTINGS_UPDATED', 'MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED'];
  const eventTypes = Object.fromEntries(eventNames.map(name => [name, name]));
  const emit = name => { for (const listener of [...(listeners.get(name) ?? [])]) listener(); };
  const settings = emptySettings(); settings.ai.source = 'sillytavern';
  let settingsDisk = { [SETTINGS_KEY]: settings };
  const disk = new Map(), chatDisk = new Map();
  for (const name of ['A', 'B']) {
    const root = { ...emptyRoot(`fiction-preview-${name}`), binding: { kind: 'character', owner: 'fiction-preview.png', name, integrity: null, lineageParent: null } };
    root.events = ['雪山驿站的重逢', '一张青色船票与很长的同行约定标题，用于检查换行和完整时间', '风雪后的归途'].map((title, index) => ({
      ...blankEvent(`preview-${name}-${index}`), title: `${title}（虚构${name}）`,
      body: '【虚构预览数据】林岚与白川在雪山驿站整理旅途见闻，约定次日前往旧码头。\n这里的记忆和人物仅用于界面验收。'.repeat(index + 1),
      startTime: `2026年6月${index + 1}日下午`, endTime: index === 1 ? '2026年6月3日清晨' : '', sources: [{ start: index * 2, end: index * 2 + 1 }], people: ['林岚', '白川'], places: ['雪山驿站'], eventWords: ['约定'], detailWords: [{ id: `ticket-${index}`, word: '青色船票', aliases: ['船票'] }],
    }));
    const calendar={id:`fiction-calendar-${name}`,type:'modern',name:'现代历法（虚构）',showTerms:true,showHolidays:true};
    const date={calendarId:calendar.id,year:2026,month:6,day:1};
    root.time={...emptyTime(),calendars:[calendar],activeCalendarId:calendar.id,currentDate:date,manualAnchor:{date,nextFloor:0,boundary:[],setAt:'2026-06-01T00:00:00.000Z'},items:[...initialHolidayItems(createCalendar(calendar)),
      {id:`fiction-trip-${name}`,kind:'schedule',title:'雪山湖畔三日同行（虚构）',calendarId:calendar.id,startDate:date,repeat:'once',durationDays:3,advanceDays:3,enabled:true,remind:true,show:true,description:'整理旅途见闻，约定前往湖边。全部为验收用虚构安排。',instruction:''},
      {id:`fiction-anniversary-${name}`,kind:'anniversary',title:'初次相遇的纪念日（虚构）',calendarId:calendar.id,startDate:{...date,day:4},repeat:'yearly',durationDays:1,advanceDays:null,enabled:true,remind:true,show:true,description:'一起回忆初识时的青色船票。',instruction:'',startYear:2024} ]};
    if (!timeConfigured) delete root.time;
    disk.set(name, { lantai_benmo_memory: root });
  }
  const ctx = {
    chatId: 'A', characterId: 0, groupId: null, characters: [{ avatar: 'fiction-preview.png', chat: 'A' }],
    chatMetadata: clone(disk.get('A')), extensionSettings: clone(settingsDisk),
    chat: Array.from({ length: 12 }, (_, floor) => ({ id: `fiction-${floor}`, mes: `【虚构聊天第${floor}楼】林岚与白川在雪山驿站讨论青色船票，约定次日前往旧码头。`, is_user: floor % 2 === 0, is_system: false, send_date: `fiction-date-${floor}` })),
    eventTypes, eventSource: { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeListener(name, fn) { listeners.get(name)?.delete(fn); } },
    getCurrentChatId: () => ctx.chatId, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    mainApi: 'openai', onlineStatus: 'fiction-only', chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'fiction-model', custom_url: 'https://preview.invalid/v1' }, getChatCompletionModel: () => 'fiction-model',
    saveMetadata: async () => { disk.set(ctx.chatId, clone(ctx.chatMetadata)); chatDisk.set(ctx.chatId,clone(ctx.chat)); },
    setExtensionPrompt: (name, ...values) => slots.set(name, clone(values)),
    generateRaw: async request => { calls.push('mock-generate'); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); return JSON.stringify(mockAiOutput(request)); },
  };
  for(const name of ['A','B'])chatDisk.set(name,clone(ctx.chat));
  const saveSettings = async () => { settingsDisk = clone(ctx.extensionSettings); emit('SETTINGS_UPDATED'); };
  const styles = new Map([...BASE_STYLE_ENTRIES, ...MEMPHIS_STYLE_ENTRIES, ...SNOW_ERMINE_STYLE_ENTRIES].map(({ url }) => {
    const resolved = new URL(url); resolved.pathname = resolved.pathname.replace('/src/vendor/', '/vendor/');
    return [url.href, resolved];
  }));
  async function request(url, options = {}) {
    // Only exact, known stylesheet URLs can reach the network. Never forward
    // business payloads, credentials, cookies, arbitrary URLs or host endpoints.
    if (url instanceof URL && styles.has(url.href)) {
      if (Object.keys(options).length || typeof assetFetch !== 'function') return blocked();
      return assetFetch(styles.get(url.href), { credentials: 'omit', redirect: 'error' });
    }
    if (typeof url !== 'string' || options.method !== 'POST') return blocked();
    if (!['/api/chats/get', '/api/settings/get', '/api/backends/chat-completions/status', '/api/backends/chat-completions/generate'].includes(url)) return blocked();
    const body = JSON.parse(options.body ?? '{}'); calls.push(url);
    if (url === '/api/chats/get') {
      if (!disk.has(body.file_name)) return blocked();
      return reply([{ chat_metadata: clone(disk.get(body.file_name)) },...clone(chatDisk.get(body.file_name)??[])]);
    }
    if (url === '/api/settings/get') return reply({ settings: JSON.stringify({ extension_settings: settingsDisk }) });
    if (url.endsWith('/status')) return reply({ data: [{ id: 'fiction-model' }, { id: 'fiction-model-2' }] });
    return reply({ choices: [{ message: { content: await ctx.generateRaw(body) } }] });
  }
  return {
    ctx, request, calls, slots,
    runtimeOptions: { workshopRegexOptions:{saveHost:saveSettings,loadEngine:async()=>({SCRIPT_TYPES:{GLOBAL:0},getScriptsByType:()=>ctx.extensionSettings.regex??[],saveScriptsByType:async value=>{ctx.extensionSettings.regex=clone(value);}})},settingsOptions: { saveHost: saveSettings }, mainIdentityOptions: { loadModule: async () => ({}) }, jquery: () => ({ on() {}, off() {} }) },
    appearanceOptions: { saveHost: saveSettings },
    switchChat(name) { if (!disk.has(name)) return blocked(); ctx.chatId = name; ctx.characters[0].chat = name; ctx.chatMetadata = clone(disk.get(name)); ctx.chat=clone(chatDisk.get(name)); emit('CHAT_CHANGED'); },
    snapshot: () => ({ settings: clone(settingsDisk), chats: clone([...disk]) }),
    appearanceKey: APPEARANCE_KEY,
  };
}
