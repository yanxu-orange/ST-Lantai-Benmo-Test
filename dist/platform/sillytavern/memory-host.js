import { createSillyTavernMemoryAdapter } from './memory-adapter.js';
import { createRepository, sameTarget } from '../../domain/memory/repository.js';
import { mountMemoryApp } from '../../app/memory-app.js';
import { getSillyTavernContext } from './context.js';
import { createManagementRuntime } from './management-runtime.js';
import { createApiSettingsSession } from '../../app/api-settings-session.js';
import { mountApiSettingsView } from '../../app/api-settings-view.js';
import { createManagementNotifications } from './management-notifications.js';
import { mountSummaryView } from '../../app/summary-view.js';
import { createSummarySettingsController } from '../../app/summary-settings-controller.js';
import { mountSummarySettingsView } from '../../app/summary-settings-view.js';
import { summaryReadonlyContent } from '../../domain/summary/requests.js';
import {createSummaryNotifications} from './summary-notifications.js';
import {createSummaryHistoryHook} from './summary-history.js';
import {createRecallRuntime} from './recall-runtime.js';
import {createRecallController} from '../../app/recall-controller.js';
import {mountRecallView} from '../../app/recall-view.js';

// Only this platform module touches the host document. Shadow DOM prevents
// host skins from changing the approved UI and prevents our UI CSS leakage.
export function createMemoryHost({ document: doc = globalThis.document, getContext = getSillyTavernContext, fetch: request = globalThis.fetch,
  runtimeOptions = {}, MutationObserver: Observer = globalThis.MutationObserver } = {}) {
  let adapter, repository, app, panel, content, memoryContent, settingsContent, apiView, apiSession, returnFocus, returnEpoch, returnTarget,
    runtime, runtimePromise, notices, entry, unsubscribe, disposed = false, closing = false, replacingPage = false, ticket = 0, stylePromise,
    summaryContent,summaryView,summarySettingsView,summarySettingsController,summarySettingsTarget,summarySettingsFromMemory=false,summaryNotices,summaryHistory,summaryReturnFocus,memoryEditFocus,
    recallRuntime,recallController,recallView,recallTarget,pageRequest=0,recallEntryRequest=0;
  const entryId = 'lantai-benmo-open';
  const lifetime = new AbortController();
  function ensureAdapter() {
    if (adapter) return;
    adapter = createSillyTavernMemoryAdapter({ getContext, fetch: request });
    repository = createRepository(adapter);
    // The proof is this round's guarded IN_CHAT system-slot write receipt.
    // ST remains responsible for its subsequent preset/budget assembly.
    summaryHistory=createSummaryHistoryHook({repository,captureSource:target=>adapter.captureSummarySource(target),getContext,getReplacementProof:()=>recallRuntime?.getReplacementProof()});
    unsubscribe = adapter.subscribe(kind => {
      if (!panel) return;
      if (kind === 'reload' && app) {
        const current = app;
        void adapter.prepare().then(() => { if (app === current) return current.rebind(); }).catch(error => { if (app === current) errorView(error); });
      } else { runtime?.controller.refresh(); void open(); }
    });
  }
  function close() {
    if (closing) return;
    closing = true;
    ticket++;pageRequest++; apiView?.dispose(); apiView = null; const current = apiSession; apiSession = null; current?.exit('close');
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;
    recallView?.dispose();recallView=null;recallController?.suspend();
    app?.dispose(); app = null; panel?.remove(); panel = null; content = memoryContent = settingsContent = summaryContent = null;
    entry?.focus(); closing = false;
  }
  async function ensureRuntime() {
    if (!runtimePromise) runtimePromise = createManagementRuntime({ repository, getContext, document: doc, fetchImpl: request, ...runtimeOptions, signal: lifetime.signal,captureSummarySource:target=>adapter.captureSummarySource(target) })
      .then(value => { if (disposed) { value.dispose(); return null; } runtime = value;
        notices=createManagementNotifications({document:doc,controller:runtime.controller,styles,openTask});
        summaryNotices=createSummaryNotifications({document:doc,service:runtime.summaryService,styles,openTask:openSummaryTask});
        recallRuntime=createRecallRuntime({repository,settings:runtime.settings,getContext,captureSource:target=>adapter.captureSummarySource(target)});
        return value; });
    return runtimePromise;
  }
  async function openTask(taskId){
    if(disposed||apiSession)return false;
    if(panel)return app?.showManagementTask(taskId)??false;
    if(!runtime?.controller.resume(taskId))return false;
    await open();return !!app?.isManagementTask(taskId);
  }
  async function openSummaryTask(taskId) {
    if(disposed||apiSession||summarySettingsView)return false;
    if(panel&&summaryContent.hidden){const active=panel.shadowRoot.activeElement;if(app?.session.state.route==='editor'||active?.matches('input,textarea,select')||panel.shadowRoot.querySelector('[data-composing=true]'))return false;}
    const task=runtime?.summaryService.inspect(taskId);if(!task||!sameTarget(task.target,repository.captureTarget()))return false;
    if(!panel)await open();
    if(!panel||!runtime.summaryController.showTask(taskId))return false;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;summaryView?.dispose();
    summaryView=mountSummaryView({container:summaryContent,controller:runtime.summaryController,onBack:()=>void returnFromSummary(),onClose:close,openSettings:()=>void openSummarySettings(false)});return true;
  }
  async function returnFromSummary() {
    pageRequest++;
    recallView?.dispose();recallView=null;recallController?.suspend();
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;
    if(!panel)return;summaryContent.replaceChildren();summaryContent.hidden=true;memoryContent.hidden=false;memoryContent.inert=false;
    await app?.rebind();if(!panel)return;
    if(app?.session.state.route==='editor'&&app.session.state.draft?.id&&!app.session.state.root.events.some(event=>event.id===app.session.state.draft.id))await app.refresh();
    const previous=summaryReturnFocus;
    (previous?.isConnected&&memoryContent.contains(previous)&&!previous.closest('[hidden],[inert]')?previous:memoryContent.querySelector('[data-action=summary-manual]')??memoryContent.querySelector('.lt-main'))?.focus({preventScroll:true});
  }
  async function showSummary(origin='manual',batchId=null) {
    if(!runtime?.summaryController||!panel||apiSession)return false;
    if(summaryContent.hidden)summaryReturnFocus=batchId&&memoryEditFocus?.isConnected&&memoryContent.contains(memoryEditFocus)?memoryEditFocus:panel.shadowRoot.activeElement;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    const ready=await runtime.summaryController.open(origin);
    if(!ready||!panel||serial!==ticket||request!==pageRequest||!sameTarget(target,repository.captureTarget()))return false;
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    recallView?.dispose();recallView=null;recallController?.suspend();
    summarySettingsView?.dispose();summarySettingsView=null;summaryView?.dispose();
    summaryView=mountSummaryView({container:summaryContent,controller:runtime.summaryController,onBack:()=>void returnFromSummary(),onClose:close,openSettings:()=>void openSummarySettings(false)});
    if(batchId)await runtime.summaryController.regenerate(batchId);
    (summaryContent.querySelector('.lt-main'))?.focus({preventScroll:true});return true;
  }
  async function openSummarySettings(fromMemory=true) {
    if(!runtime?.settings||!panel||apiSession)return;
    if(summaryContent.hidden)summaryReturnFocus=panel.shadowRoot.activeElement;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    let initial=false;
    if(!summarySettingsController||!sameTarget(target,summarySettingsTarget)) {
      summarySettingsController?.dispose();summarySettingsTarget=target;
      const current=()=>sameTarget(target,repository.captureTarget());
      const read=async()=>{const capture=await repository.captureSummary(target);return capture.summary.excludedFloors;};
      const change=async(floor,remove)=>{const capture=await repository.captureSummary(target),records=structuredClone(capture.summary.excludedFloors);if(remove){const index=records.findIndex(item=>item.floor===Number(floor));if(index>=0)records.splice(index,1);}else{const message=adapter.captureSummarySource(target).messages.find(item=>item.floor===Number(floor));if(!message)throw new Error('楼层不存在');if(!records.some(item=>item.floor===message.floor))records.push({floor:message.floor,identity:message.identity});}await repository.setSummaryExcludedFloors(target,records,{expectedSummaryRevision:capture.summary.revision,isCurrent:current});};
      summarySettingsController=createSummarySettingsController({settings:runtime.settings,exclusions:{read,add:floor=>change(floor,false),remove:floor=>change(floor,true)},isCurrent:current,onBack:()=>{if(summarySettingsFromMemory)void returnFromSummary();else void showSummary(runtime.summaryController.inspect().origin);},onClose:close});
      initial=true;
    }
    if(!panel||serial!==ticket||!sameTarget(target,repository.captureTarget()))return;
    summarySettingsFromMemory=fromMemory;summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();
    recallView?.dispose();recallView=null;recallController?.suspend();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    summarySettingsView=mountSummarySettingsView(summaryContent,summarySettingsController,{readonlyContent:summaryReadonlyContent});
    const controller=summarySettingsController;
    if(initial||!controller.inspect().draft)afterPageFrame(()=>{
      if(panel&&serial===ticket&&request===pageRequest&&summarySettingsController===controller&&sameTarget(target,repository.captureTarget()))void controller.init();
    });
  }
  // Paint the existing locked loading surface before starting reads/computation.
  function afterPageFrame(work){const frame=doc.defaultView?.requestAnimationFrame;if(frame)frame.call(doc.defaultView,()=>setTimeout(work,0));else setTimeout(work,0);}
  async function openRecall() {
    if(!panel||apiSession||!recallRuntime)return false;
    const target=repository.captureTarget(),serial=ticket,request=++pageRequest;
    let initial=false;
    if(summaryContent.hidden)summaryReturnFocus=panel.shadowRoot.activeElement;
    if(!recallController||!sameTarget(target,recallTarget)) {
      recallController?.dispose();recallTarget=target;
      recallController=createRecallController({repository,settings:runtime.settings,runtime:recallRuntime,onBack:()=>void returnFromSummary(),onClose:close});
      initial=true;
    }
    if(!panel||serial!==ticket||!sameTarget(target,repository.captureTarget()))return false;
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;recallView?.dispose();
    memoryContent.hidden=true;memoryContent.inert=true;summaryContent.hidden=false;
    recallController.resume();
      recallController.route('monitor');recallController.tab('actual');
    recallView=mountRecallView({container:summaryContent,controller:recallController});
    const controller=recallController,state=controller.viewPosition();
    if(initial||!state.hasDraft)afterPageFrame(()=>{
      if(panel&&serial===ticket&&request===pageRequest&&recallController===controller&&sameTarget(target,repository.captureTarget()))void controller.read();
    });return true;
  }
  function returnFromSettings(reason) {
    if(replacingPage)return;
    apiView?.dispose(); apiView = null; apiSession = null;
    if (reason === 'close') { close(); return; }
    settingsContent.replaceChildren(); settingsContent.hidden = true; memoryContent.hidden = false; memoryContent.inert = false;
    const previous = returnFocus;
    const identity = previous && ['id', 'data-action', 'data-management-field', 'data-management-entry', 'name']
      .filter(key => previous.hasAttribute(key)).map(key => [key, previous.getAttribute(key)]);
    if (generationEpoch() !== returnEpoch) runtime.controller.refresh();
    const visible = node => node?.isConnected && memoryContent.contains(node)
      && !node.disabled && !node.closest('[hidden],[inert]') && node.getClientRects().length;
    const samePage = sameTarget(returnTarget, repository.captureTarget());
    let focus = samePage && visible(previous) ? previous : null;
    if (!focus && samePage && identity?.length) focus = [...memoryContent.querySelectorAll('button,a,input,textarea,select,summary,[tabindex]')]
      .find(node => node.tagName === previous.tagName && identity.every(([key, value]) => node.getAttribute(key) === value) && visible(node));
    if (!focus) focus = [...memoryContent.querySelectorAll('[data-action=back],button,a,input,textarea,select,summary,[tabindex]')]
      .find(node => node.tabIndex >= 0 && visible(node));
    if (focus) focus.focus({ preventScroll: true });
    else { memoryContent.tabIndex = -1; memoryContent.focus({ preventScroll: true }); }
    returnFocus = returnTarget = null;
  }
  function generationEpoch() { try { return runtime.getGenerationSettings().epoch; } catch { return null; } }
  function openSettings() {
    if (apiSession || !panel || !runtime) return;
    returnFocus = panel.shadowRoot.activeElement;
    returnTarget = repository.captureTarget();
    returnEpoch = generationEpoch();
    memoryContent.hidden = true; memoryContent.inert = true; settingsContent.hidden = false;
    if (!runtime.settings) {
      settingsContent.textContent = '当前酒馆设置或密钥引用能力不可用。';
      const back = doc.createElement('button'); back.type = 'button'; back.textContent = '返回原页面';
      back.addEventListener('click', () => returnFromSettings('back')); settingsContent.append(back); back.focus(); return;
    }
    apiSession = createApiSettingsSession({ repository: runtime.settings, operations: runtime.apiOperations, onExit: returnFromSettings });
    apiView = mountApiSettingsView(settingsContent, apiSession); void apiSession.read();
  }
  async function styles() {
    if (!stylePromise) stylePromise = Promise.all([
      new URL('../../vendor/plugin-ui-system/web.css', import.meta.url),
      new URL('../../app/lantai-theme.css', import.meta.url),
      new URL('../../app/tag-palette.css', import.meta.url),
      new URL('../../app/memory.css', import.meta.url),
      new URL('../../app/api-settings.css', import.meta.url),
      new URL('../../app/summary-view.css', import.meta.url),
      new URL('../../app/summary-settings.css', import.meta.url),
      new URL('../../app/recall-view.css', import.meta.url),
      new URL('./memory-host.css', import.meta.url),
    ].map(async url => {
      const response = await request(url);
      if (!response.ok) throw new Error('兰台界面样式未能加载，请关闭后重试');
      return response.text();
    })).then(parts => parts.map(css => css.replace(/:root\b/g, ':host')).join('\n')).catch(error => { stylePromise = null; throw error; });
    return stylePromise;
  }
  function errorView(error) {
    memoryContent.replaceChildren();
    const surface = doc.createElement('section'); surface.className = 'lantai';
    const main = doc.createElement('main'); main.className = 'lt-main lt-stack';
    const message = doc.createElement('p'); message.className = 'lt-error'; message.setAttribute('role', 'alert'); message.textContent = '记忆读取失败，请恢复连接后重试。';
    const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'ui-button ui-button--secondary'; retry.textContent = '重试'; retry.addEventListener('click', () => void open());
    const exit = doc.createElement('button'); exit.type = 'button'; exit.className = 'ui-button ui-button--tertiary'; exit.textContent = '返回聊天'; exit.addEventListener('click', close);
    main.append(message, retry, exit); surface.append(main); memoryContent.append(surface); retry.focus();
  }
  async function open() {
    if (disposed) return;
    const currentTicket = ++ticket;
    app?.dispose(); app = null;
    summaryView?.dispose();summaryView=null;summarySettingsView?.dispose();summarySettingsView=null;
    recallView?.dispose();recallView=null;recallController?.suspend();
    if(panel){summaryContent.replaceChildren();summaryContent.hidden=true;memoryContent.hidden=false;memoryContent.inert=false;apiView?.dispose();apiView=null;const previous=apiSession;apiSession=null;replacingPage=true;try{previous?.exit('back');}finally{replacingPage=false;}settingsContent.replaceChildren();settingsContent.hidden=true;}
    if (!panel) {
      panel = doc.createElement('lantai-benmo-host'); panel.id = 'lantai-benmo-panel';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '兰台本末');
      const shadow = panel.attachShadow({ mode: 'open' });
      let composing = false;
      shadow.addEventListener('compositionstart', () => { composing = true; });
      shadow.addEventListener('compositionend', () => { composing = false; });
      panel.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || composing || shadow.querySelector('[data-composing=true]')) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!settingsContent.hidden) returnFromSettings('back'); else if(!summaryContent.hidden){if(recallView)recallController.back();else if(summarySettingsView)summarySettingsController.back();else void runtime.summaryController.back().then(back=>{if(back)void returnFromSummary();});}else close(); return; }
        if (event.key !== 'Tab') return;
        const items = [...shadow.querySelectorAll('button,a,input,textarea,select,summary,[tabindex]')]
          .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
        const first = items[0], last = items.at(-1), active = shadow.activeElement;
        if (event.shiftKey && (active === first || !items.includes(active))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !items.includes(active))) { event.preventDefault(); first?.focus(); }
      });
      content = doc.createElement('div'); content.id = 'lt-host-content';
      memoryContent = doc.createElement('div'); memoryContent.className = 'lt-host-page';
      memoryContent.addEventListener('focusin',event=>{if(event.target.matches('input,textarea,select'))memoryEditFocus=event.target;});
      settingsContent = doc.createElement('div'); settingsContent.className = 'lt-host-page'; settingsContent.hidden = true;
      summaryContent=doc.createElement('div');summaryContent.className='lt-host-page';summaryContent.hidden=true;
      content.append(memoryContent, settingsContent,summaryContent);
      shadow.append(content); doc.body.append(panel);
    }
    memoryContent.textContent = '正在读取记忆…';
    try {
      const css = await styles();
      if (disposed || currentTicket !== ticket || !panel) return;
      if (!panel.shadowRoot.querySelector('style')) { const style = doc.createElement('style'); style.textContent = css; panel.shadowRoot.prepend(style); }
      ensureAdapter();
      await adapter.prepare();
      if (disposed || currentTicket !== ticket || !panel) return;
      await ensureRuntime();
      if (disposed || currentTicket !== ticket || !panel) return;
      app = mountMemoryApp(memoryContent, repository, { history: null, window: null, onClose: close,
        managementService: runtime?.service, managementController: runtime?.controller,
        getSettingsEpoch: () => runtime.getGenerationSettings().epoch,
        getOriginalSnapshot: runtime?.getOriginalSnapshot, originalAvailable: runtime?.originalAvailable, openSettings,
        openSummary:origin=>void showSummary(origin),openSummarySettings:()=>void openSummarySettings(true),openRecall:()=>void openRecall(),regenerateBatch:id=>void showSummary('manual',id) });
      await app.ready;
    } catch (error) { if (!disposed && currentTicket === ticket && panel) errorView(error); }
  }
  function installEntry() {
    if (disposed) return;
    // Subscribe before the first page open: host renames must be observed
    // even when the user has not opened Lantai after a browser reload.
    try { ensureAdapter(); } catch { /* APP_READY/open will retry capability detection. */ }
    if (repository) void ensureRuntime().catch(() => {});
    if (entry) return;
    const menu = doc.querySelector('#extensionsMenu');
    if (!menu) return;
    entry = doc.createElement('button'); entry.id = entryId; entry.type = 'button'; entry.className = 'list-group-item flex-container flexGap5';
    const label = doc.createElement('span'); label.textContent = '兰台本末';
    entry.append(label); entry.addEventListener('click', () => void open()); menu.append(entry);
  }
  const context = getContext(), source = context?.eventSource, readyEvent = context?.eventTypes?.APP_READY;
  const ready = () => installEntry();
  if (source?.on && readyEvent) source.on(readyEvent, ready);
  installEntry();
  // Host startup may add the Extensions menu after loading the module.
  const observer = new Observer(installEntry);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return {
    open, close, openSettings, openTask,openSummary:showSummary,openSummarySettings,openSummaryTask,openRecall,
    async interceptPrompt(...args){
      if(disposed)return;
      const request=++recallEntryRequest;let entryTarget;
      try{
        ensureAdapter();try{entryTarget=repository.captureTarget();}catch{/* Cold entry has no confirmed target yet. */}
        const target=await adapter.prepare();
        if(disposed)return;await ensureRuntime();
        if(disposed||!sameTarget(target,repository.captureTarget()))return;
        await recallRuntime?.intercept(...args);await summaryHistory.intercept(...args);
      }catch{if(!disposed&&request===recallEntryRequest)recallRuntime?.preparationFailed(entryTarget,args[0],args[3]);/* Keep the host prompt copy on unavailable authority. */}
    },
    recallStatus:()=>recallRuntime?.inspect()??{status:'empty'},
    promptHistoryStatus:()=>summaryHistory?.inspect()??{status:'retained',reason:'not-initialized',removed:0},
    dispose() {
      disposed = true; close(); notices?.dispose();summaryNotices?.dispose();summarySettingsController?.dispose();summaryHistory?.dispose();recallController?.dispose();recallRuntime?.dispose(); runtime?.dispose(); lifetime.abort(); unsubscribe?.(); adapter?.dispose(); observer.disconnect();
      if (readyEvent && source) (source.removeListener ?? source.off)?.call(source, readyEvent, ready);
      entry?.remove(); entry = null;
    },
  };
}
