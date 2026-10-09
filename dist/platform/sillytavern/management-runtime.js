import {featureGate} from '../../domain/controls/gate.js';
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
import { createCumulativeSummaryService } from '../../domain/cumulative/service.js';
import { createAutomaticCumulativeRunner } from '../../domain/cumulative/auto-runner.js';
import { createCumulativeController } from '../../app/cumulative-controller.js';

const MAIN_EVENTS = ['MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED'];

// One owner survives mounted pages. All network and host exports are injectable.
export async function createManagementRuntime({ repository, getContext, document: doc,
  fetchImpl = globalThis.fetch, settingsOptions = {}, mainIdentityOptions = {}, jquery = globalThis.jQuery, signal, captureSummarySource,getControls } = {}) {
  const allowed=key=>!getControls||!!getControls()?.allowed(key);
  const manager = createBackgroundTaskManager(), releases = [];
  let settings = null, controller = null, summaryService=null, summaryController=null, disposed = false, effective = null, epoch = 0, mainEpoch = 0, lastMain = null, jqueryCapable = false;
  const reported = new Map();
  let cumulativeService=null,cumulativeRunner=null,cumulativeController=null,cumulativeAiEpoch=0,lastCumulativeAi=null;
  const abort = () => {
    disposed = true; settings?.dispose();
    for (const release of releases.splice(0)) release();
    for (const task of manager.list()) manager.cancel(task.taskId);
    controller?.dispose();
    summaryController?.dispose();summaryService?.dispose();
    cumulativeController?.dispose();cumulativeRunner?.dispose();cumulativeService?.dispose();
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
    const next = JSON.stringify([value.generationEpoch, settings.captureAi().epoch, config.source, identity]);
    if (effective !== next) { effective = next; epoch++; }
    return { ...value, epoch };
  }
  function getCumulativeGenerationSettings() {
    if(disposed||!settings)throw new AiProviderError('configuration');
    const cumulative=settings.captureCumulativeGeneration(),shared=settings.captureEventGeneration(),ai=settings.captureAi();
    const config=settings.getAiConfig();let identity=null;
    if(config.source==='sillytavern'){mainIdentity();observeMain();identity=JSON.stringify(['sillytavern',mainEpoch]);}
    else if(config.source==='plugin')identity=JSON.stringify(['plugin',ai.ai.activePresetId]);
    const ticket=JSON.stringify([ai.epoch,identity]);
    if(ticket!==lastCumulativeAi){lastCumulativeAi=ticket;cumulativeAiEpoch++;}
    return {generation:cumulative.generation,cumulativeEpoch:cumulative.epoch,summaryCleaning:shared.generation.summaryCleaning,cleaningEpoch:shared.epoch,aiIdentity:identity,aiEpoch:cumulativeAiEpoch};
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
  const eventGeneration=()=>{if(!allowed('event'))throw new Error('事件记忆已关闭');return getGenerationSettings();};
  const cumulativeGeneration=()=>{if(!allowed('cumulative'))throw new Error('古法总结已关闭');return getCumulativeGenerationSettings();};
  const service = createMemoryManagementService({ repository, manager, provider, getGenerationSettings:eventGeneration,control:featureGate(getControls,'event'), getOriginalSnapshot });
  controller = createManagementController({ service, repository, originalAvailable, getOriginalSnapshot,
    getSettingsEpoch: () => getGenerationSettings().epoch });
  if(typeof captureSummarySource==='function') {
    summaryService=createEventSummaryService({repository,manager,provider,getGenerationSettings:eventGeneration,control:featureGate(getControls,'event'),captureSource:captureSummarySource});
    summaryController=createSummaryController({repository,service:summaryService,control:featureGate(getControls,'event'),captureSource:captureSummarySource});
    cumulativeService=createCumulativeSummaryService({repository,manager,provider,getGenerationSettings:cumulativeGeneration,control:featureGate(getControls,'cumulative'),captureSource:captureSummarySource});
    cumulativeRunner=createAutomaticCumulativeRunner({repository,service:cumulativeService,captureSource:captureSummarySource});
    cumulativeController=createCumulativeController({repository,service:cumulativeService,runner:cumulativeRunner,control:featureGate(getControls,'cumulative'),captureSource:captureSummarySource});
    let replyRun=null,quietDepth=0,lastReplyFloor=(ctx?.chat?.length??0)-1;
    const replyGates=Object.fromEntries(['event','cumulative'].map(key=>[key,featureGate(getControls,key)]));
    const on=(name,listener)=>{const type=ctx?.eventTypes?.[name];if(!type||typeof source?.on!=='function')return;source.on(type,listener);releases.push(()=>(source.off??source.removeListener)?.call(source,type,listener));};
    const currentRun=run=>!disposed&&replyRun===run&&sameTarget(run.target,repository.captureTarget())&&getContext()?.chat===run.chat;
    const completedProcessor=(processor,floor)=>!processor||(processor.messageId===floor&&processor.isFinished===true&&processor.isStopped!==true&&!processor.abortController?.signal?.aborted&&!processor.toolCalls?.length);
    function flushReply(){
      const run=replyRun,reply=run?.reply;if(!reply||!run.ended||run.consumed)return;
      try{
        if(!currentRun(run)||reply.floor<=lastReplyFloor||run.chat[reply.floor]!==reply.message
          ||reply.message.is_user!==false||reply.message.is_system||!reply.message.mes?.trim()
          ||!completedProcessor(reply.processor,reply.floor)||!completedProcessor(run.endProcessor,reply.floor)
          ||reply.processor&&run.endProcessor&&reply.processor!==run.endProcessor
          ||reply.source!==run.endSource||reply.source!==JSON.stringify(captureSummarySource(run.target)))return;
        // Consume before either controller wakes: their asynchronous runners
        // retain their existing explicit-start, batch and commit policies.
        run.consumed=true;lastReplyFloor=reply.floor;
        if(reply.proofs.event!==undefined&&replyGates.event.matches(reply.proofs.event))summaryController.wake();
        if(reply.proofs.cumulative!==undefined&&replyGates.cumulative.matches(reply.proofs.cumulative))cumulativeController.wake();
      }catch{/* Unconfirmed or changed source cannot wake another target. */}
    }
    on('GENERATION_STARTED',(type,_options,dryRun)=>{
      if(dryRun)return;
      if(type==='quiet'){quietDepth++;return;}
      replyRun=null;quietDepth=0;
      if(type!=='normal'&&type!==undefined)return;
      try{replyRun={target:repository.captureTarget(),chat:getContext()?.chat,startFloor:(getContext()?.chat?.length??0)-1,reply:null,ended:false,consumed:false};}catch{/* No confirmed foreground target. */}
    });
    on('MESSAGE_RECEIVED',(floor,type)=>{
      const run=replyRun;if(!run||run.consumed||type!=='normal'&&type!==undefined||!Number.isSafeInteger(floor)||floor<=lastReplyFloor||floor<=run.startFloor)return;
      try{
        if(!currentRun(run))return;
        const message=run.chat?.[floor];if(message?.is_user!==false||message.is_system||!message.mes?.trim())return;
        if(!run.reply)run.reply={floor,message,processor:getContext()?.streamingProcessor??null,source:JSON.stringify(captureSummarySource(run.target)),proofs:Object.fromEntries(Object.entries(replyGates).filter(([,gate])=>gate.allowed()).map(([key,gate])=>[key,gate.capture()]))};
        flushReply();
      }catch{/* No settled reply source. */}
    });
    on('GENERATION_ENDED',()=>{
      // ENDED is the host's unlabelled UI completion signal. Quiet may finish
      // without emitting it while a foreground stream is still running. Do not
      // let an unmatched quiet start hide a proven successful normal reply.
      const run=replyRun,processor=getContext()?.streamingProcessor;
      const completeReceipt=run?.reply&&completedProcessor(run.reply.processor,run.reply.floor);
      const completeStream=run&&processor&&processor.messageId>run.startFloor&&completedProcessor(processor,processor.messageId);
      if(quietDepth&&!completeReceipt&&!completeStream){quietDepth--;return;}
      if(!run||run.consumed||run.ended)return;
      try{if(!currentRun(run))return;run.endProcessor=processor??null;run.endSource=JSON.stringify(captureSummarySource(run.target));run.ended=true;flushReply();}catch{/* Missing completion evidence. */}
    });
    on('GENERATION_STOPPED',()=>{const processor=replyRun?.reply?.processor??getContext()?.streamingProcessor;if(!quietDepth||processor?.isStopped||processor?.abortController?.signal?.aborted)replyRun=null;});
    for(const name of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED'])on(name,()=>{replyRun=null;});
    // Positions can be reused after deletion, but neither deletion nor loading
    // history is a completed reply and may wake a runner.
    for(const name of ['CHAT_CHANGED','CHAT_CREATED','MESSAGE_DELETED'])on(name,()=>{replyRun=null;quietDepth=0;lastReplyFloor=(getContext()?.chat?.length??0)-1;});
  }
  return Object.freeze({ settings, manager, provider, apiOperations, service, controller, summaryService, summaryController, cumulativeService,cumulativeRunner,cumulativeController,getCumulativeGenerationSettings,getGenerationSettings, getOriginalSnapshot, originalAvailable,
    dispose() { if (disposed) return; abort(); signal?.removeEventListener('abort', abort); } });
}
