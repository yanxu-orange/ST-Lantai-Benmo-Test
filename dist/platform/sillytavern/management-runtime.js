import { createSillyTavernSettingsAdapter } from './settings-adapter.js';
import { createSillyTavernAiTransport, mainSnapshot } from './ai-provider.js';
import { createSettingsRepository } from '../../shared/settings/repository.js';
import { createBackgroundTaskManager } from '../../shared/runtime/background-tasks.js';
import { createAiProvider, AiProviderError } from '../../shared/ai/provider.js';
import { createMemoryManagementService } from '../../domain/memory/management-service.js';
import { createManagementController } from '../../app/management-controller.js';
import { sameTarget } from '../../domain/memory/repository.js';
import { createMainApiIdentity } from './main-api-identity.js';
import { createApiSettingsOperations } from './api-settings-operations.js';
import { createEventSummaryService } from '../../domain/summary/service.js';
import { createSummaryController } from '../../app/summary-controller.js';

const MAIN_EVENTS = ['MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED'];

// One owner survives mounted pages. All network and host exports are injectable.
export async function createManagementRuntime({ repository, getContext, document: doc,
  fetchImpl = globalThis.fetch, settingsOptions = {}, mainIdentityOptions = {}, jquery = globalThis.jQuery, signal, captureSummarySource } = {}) {
  const manager = createBackgroundTaskManager(), releases = [];
  let settings = null, controller = null, summaryService=null, summaryController=null, disposed = false, effective = null, epoch = 0, mainEpoch = 0, lastMain = null, jqueryCapable = false;
  const reported = new Map();
  const abort = () => {
    disposed = true; settings?.dispose();
    for (const release of releases.splice(0)) release();
    for (const task of manager.list()) manager.cancel(task.taskId);
    controller?.dispose();
    summaryController?.dispose();summaryService?.dispose();
  };
  if (signal?.aborted) throw new AiProviderError('unavailable');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    settings = createSettingsRepository(createSillyTavernSettingsAdapter({ getContext, fetchImpl, ...settingsOptions }));
    await settings.read();
  } catch { /* Memory editing remains available without settings capabilities. */ }
  if (disposed) throw new AiProviderError('unavailable');
  // Plugin credentials belong exclusively to settings. Never load native
  // Secrets or require its directory for editing or generating.
  const hostIdentity = await createMainApiIdentity({ getContext, ...mainIdentityOptions });
  if (disposed) throw new AiProviderError('unavailable');
  const ctx = getContext(), source = ctx?.eventSource;
  const mainCapable = !!ctx?.eventTypes?.MAIN_API_CHANGED
    && typeof source?.on === 'function' && typeof (source?.off ?? source?.removeListener) === 'function'
    && typeof doc?.addEventListener === 'function';
  function mainIdentity() {
    try {
      const current = getContext();
      if (!mainCapable || !jqueryCapable
        || typeof current?.generateRaw !== 'function' || typeof current.onlineStatus !== 'string' || !current.onlineStatus || current.onlineStatus === 'no_connection') throw new AiProviderError('unavailable');
      if (current.mainApi !== 'openai') {
        if (!ctx.eventTypes?.PRESET_CHANGED) throw new AiProviderError('unavailable');
        if (['textgenerationwebui', 'koboldhorde'].includes(current.mainApi) && !jqueryCapable) throw new AiProviderError('unavailable');
        try { return JSON.stringify(hostIdentity.snapshot()); } catch { throw new AiProviderError('unavailable'); }
      }
      if (!['CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'OAI_PRESET_CHANGED_AFTER'].every(name => ctx.eventTypes?.[name])) throw new AiProviderError('unavailable');
      if (typeof current.getChatCompletionModel !== 'function') throw new AiProviderError('unavailable');
      return mainSnapshot(current);
    } catch { throw new AiProviderError('unavailable'); }
  }
  function observeMain() {
    let identity; try { identity = mainIdentity(); } catch { identity = 'unavailable'; }
    if (lastMain !== identity) { lastMain = identity; mainEpoch++; reported.clear(); }
    try {
      const current = getContext();
      if (!reported.has('MAIN_API_CHANGED')) reported.set('MAIN_API_CHANGED', current?.mainApi);
      if (current?.mainApi === 'openai') {
        if (!reported.has('CHATCOMPLETION_SOURCE_CHANGED')) reported.set('CHATCOMPLETION_SOURCE_CHANGED', current.chatCompletionSettings?.chat_completion_source);
        if (!reported.has('CHATCOMPLETION_MODEL_CHANGED')) reported.set('CHATCOMPLETION_MODEL_CHANGED', current.getChatCompletionModel?.());
      }
    } catch { /* Missing identity stays unavailable; never expose host errors. */ }
  }
  if (mainCapable) {
    for (const name of MAIN_EVENTS) {
      if (!ctx.eventTypes[name]) continue;
      const type = ctx.eventTypes[name], listener = payload => {
        observeMain();
        // Chat-completion payloads describe OpenAI only. They cannot identify
        // a Novel/Kobold/TextGen/Horde configuration change.
        if (name !== 'MAIN_API_CHANGED' && name !== 'PRESET_CHANGED' && getContext()?.mainApi !== 'openai') return;
        // ST emits explicit scalar identities for these three events. Preserve
        // their B-A sequence even if an earlier async event listener delays us.
        let value; try { value = name === 'MAIN_API_CHANGED' ? payload?.apiId : payload; } catch { return; }
        if (['MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED'].includes(name)
          && typeof value === 'string' && reported.get(name) !== value) { reported.set(name, value); mainEpoch++; }
      };
      source.on(type, listener); releases.push(() => (source.removeListener ?? source.off).call(source, type, listener));
    }
    // These IDs are bound directly by ST openai.js. No Key control or Lantai
    // shadow input is read. Observe synchronously after the host target handler.
    const actions = new Set(['settings_preset', 'settings_preset_openai', 'settings_preset_textgenerationwebui', 'settings_preset_novel', 'api_button_textgenerationwebui', 'openai_proxy_preset', 'save_proxy', 'delete_proxy']);
    const seenActions = new WeakSet();
    const listener = event => {
      const target = event.target?.closest?.('[id]') ?? event.target, id = target?.id;
      if (target?.getRootNode?.() !== doc || !id) return;
      try { if (!hostIdentity.relevant(id)) return; } catch { return; }
      observeMain();
      if (actions.has(id) && ['change', 'click'].includes(event.type)) {
        const original = event.originalEvent ?? event;
        if (!seenActions.has(original)) { seenActions.add(original); mainEpoch++; }
      }
    };
    for (const type of ['input', 'change', 'click']) { doc.addEventListener(type, listener); releases.push(() => doc.removeEventListener(type, listener)); }
    // Select2 and ST's programmatic .trigger('change') use jQuery's delegated
    // bus. Its host handlers run first; duplicate native events compare equal.
    const delegated = typeof jquery === 'function' ? jquery(doc) : null;
    if (typeof delegated?.on === 'function' && typeof delegated?.off === 'function') {
      const events = `input.lantaiManagement change.lantaiManagement click.lantaiManagement`;
      delegated.on(events, listener); releases.push(() => delegated.off(events, listener));
      jqueryCapable = true;
    }
  }
  function getConfig() {
    if (disposed || !settings) throw new AiProviderError('configuration');
    const config = settings.getAiConfig();
    if (config.source === 'sillytavern') mainIdentity();
    return config;
  }
  function getGenerationSettings() {
    if (disposed || !settings) throw new AiProviderError('configuration');
    const value = settings.getGenerationSettings(), config = settings.getAiConfig();
    let identity = null;
    if (config.source === 'sillytavern') { mainIdentity(); observeMain(); identity = mainEpoch; }
    if (config.source === 'plugin') identity = config.credentialEpoch;
    const next = JSON.stringify([value.epoch, config.source, identity]);
    if (effective !== next) { effective = next; epoch++; }
    return { ...value, epoch };
  }
  function projectOriginal(target, ranges) {
    if (disposed || !Array.isArray(ranges) || !ranges.length || !sameTarget(target, repository.captureTarget())) throw new Error('原文来源不可用');
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) throw new Error('原文来源不可用');
    const result = [], floors = new Set();
    for (const range of ranges) {
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= chat.length) throw new Error('原文来源不可用');
      for (let floor = range.start; floor <= range.end; floor++) {
        if (floors.has(floor) || typeof chat[floor]?.mes !== 'string') throw new Error('原文来源不可用');
        floors.add(floor); result.push({ floor, text: chat[floor].mes });
      }
    }
    if (!sameTarget(target, repository.captureTarget()) || chat !== getContext()?.chat) throw new Error('原文来源已变化');
    return { messages: result };
  }
  function getOriginalSnapshot(target, ranges) {
    try { return projectOriginal(target, ranges); } catch { throw new Error('原文来源不可用或已变化'); }
  }
  const originalAvailable = (target, ranges) => { try { getOriginalSnapshot(target, ranges); return true; } catch { return false; } };
  const transportContext = () => {
    const current = getContext();
    return { mainApi: current?.mainApi, onlineStatus: current?.onlineStatus,
      generateRaw: current?.generateRaw, getRequestHeaders: current?.getRequestHeaders,
      getLantaiMainIdentity: mainIdentity };
  };
  const provider = createAiProvider({ getConfig, transport: createSillyTavernAiTransport({ getContext: transportContext, fetchImpl,
    resolveCredential: config => settings.resolveCredential(config) }) });
  const apiOperations = createApiSettingsOperations({ getContext: transportContext, fetchImpl,
    captureMain() { if (disposed) throw new AiProviderError('unavailable'); mainIdentity(); observeMain(); return mainEpoch; } });
  const service = createMemoryManagementService({ repository, manager, provider, getGenerationSettings, getOriginalSnapshot });
  controller = createManagementController({ service, repository, originalAvailable, getOriginalSnapshot,
    getSettingsEpoch: () => getGenerationSettings().epoch });
  if(typeof captureSummarySource==='function') {
    summaryService=createEventSummaryService({repository,manager,provider,getGenerationSettings,captureSource:captureSummarySource});
    summaryController=createSummaryController({repository,service:summaryService,captureSource:captureSummarySource});
    let completedReply=null,lastReplyFloor=(ctx?.chat?.length??0)-1;
    const on=(name,listener)=>{const type=ctx?.eventTypes?.[name];if(!type||typeof source?.on!=='function')return;source.on(type,listener);releases.push(()=>(source.off??source.removeListener)?.call(source,type,listener));};
    // MESSAGE_RECEIVED is emitted for a completed real chat reply. Quiet raw
    // tasks do not create one, and their nested lifecycle cannot erase it.
    on('MESSAGE_RECEIVED',(floor,type)=>{try{const chat=getContext()?.chat,message=chat?.[floor];if(type==='normal'&&Number.isSafeInteger(floor)&&floor>lastReplyFloor&&message&&!message.is_user&&!message.is_system){lastReplyFloor=floor;completedReply={target:repository.captureTarget(),floor,message};}}catch{/* no active chat */}});
    // STOPPED has no operation identity in ST. It cannot revoke a receipt
    // already emitted for a complete normal reply (it may belong to quiet).
    on('CHAT_CHANGED',()=>{completedReply=null;lastReplyFloor=(getContext()?.chat?.length??0)-1;});
    on('GENERATION_ENDED',()=>{const reply=completedReply;completedReply=null;try{if(reply&&sameTarget(reply.target,repository.captureTarget())&&getContext()?.chat?.[reply.floor]===reply.message)summaryController.wake();}catch{/* target closed */}});
  }
  return Object.freeze({ settings, manager, provider, apiOperations, service, controller, summaryService, summaryController, getGenerationSettings, getOriginalSnapshot, originalAvailable,
    dispose() { if (disposed) return; abort(); signal?.removeEventListener('abort', abort); } });
}
