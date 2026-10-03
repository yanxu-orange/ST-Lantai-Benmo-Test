import { createSillyTavernMemoryAdapter } from './memory-adapter.js';
import { createRepository, sameTarget } from '../../domain/memory/repository.js';
import { mountMemoryApp } from '../../app/memory-app.js';
import { getSillyTavernContext } from './context.js';
import { createManagementRuntime } from './management-runtime.js';
import { createApiSettingsSession } from '../../app/api-settings-session.js';
import { mountApiSettingsView } from '../../app/api-settings-view.js';
import { createManagementNotifications } from './management-notifications.js';

// Only this platform module touches the host document. Shadow DOM prevents
// host skins from changing the approved UI and prevents our UI CSS leakage.
export function createMemoryHost({ document: doc = globalThis.document, getContext = getSillyTavernContext, fetch: request = globalThis.fetch,
  runtimeOptions = {}, MutationObserver: Observer = globalThis.MutationObserver } = {}) {
  let adapter, repository, app, panel, content, memoryContent, settingsContent, apiView, apiSession, returnFocus, returnEpoch, returnTarget,
    runtime, runtimePromise, notices, entry, unsubscribe, disposed = false, closing = false, ticket = 0, stylePromise;
  const entryId = 'lantai-benmo-open';
  const lifetime = new AbortController();
  function ensureAdapter() {
    if (adapter) return;
    adapter = createSillyTavernMemoryAdapter({ getContext, fetch: request });
    repository = createRepository(adapter);
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
    ticket++; apiView?.dispose(); apiView = null; const current = apiSession; apiSession = null; current?.exit('close');
    app?.dispose(); app = null; panel?.remove(); panel = null; content = memoryContent = settingsContent = null;
    entry?.focus(); closing = false;
  }
  async function ensureRuntime() {
    if (!runtimePromise) runtimePromise = createManagementRuntime({ repository, getContext, document: doc, fetchImpl: request, ...runtimeOptions, signal: lifetime.signal })
      .then(value => { if (disposed) { value.dispose(); return null; } runtime = value;
        notices=createManagementNotifications({document:doc,controller:runtime.controller,styles,openTask});
        return value; });
    return runtimePromise;
  }
  async function openTask(taskId){
    if(disposed||apiSession)return false;
    if(panel)return app?.showManagementTask(taskId)??false;
    if(!runtime?.controller.resume(taskId))return false;
    await open();return !!app?.isManagementTask(taskId);
  }
  function returnFromSettings(reason) {
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
    if (!panel) {
      panel = doc.createElement('lantai-benmo-host'); panel.id = 'lantai-benmo-panel';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '兰台本末');
      const shadow = panel.attachShadow({ mode: 'open' });
      let composing = false;
      shadow.addEventListener('compositionstart', () => { composing = true; });
      shadow.addEventListener('compositionend', () => { composing = false; });
      panel.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || composing || shadow.querySelector('[data-composing=true]')) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!settingsContent.hidden) returnFromSettings('back'); else close(); return; }
        if (event.key !== 'Tab') return;
        const items = [...shadow.querySelectorAll('button,a,input,textarea,select,summary,[tabindex]')]
          .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
        const first = items[0], last = items.at(-1), active = shadow.activeElement;
        if (event.shiftKey && (active === first || !items.includes(active))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !items.includes(active))) { event.preventDefault(); first?.focus(); }
      });
      content = doc.createElement('div'); content.id = 'lt-host-content';
      memoryContent = doc.createElement('div'); memoryContent.className = 'lt-host-page';
      settingsContent = doc.createElement('div'); settingsContent.className = 'lt-host-page'; settingsContent.hidden = true;
      content.append(memoryContent, settingsContent);
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
        getOriginalSnapshot: runtime?.getOriginalSnapshot, originalAvailable: runtime?.originalAvailable, openSettings });
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
    open, close, openSettings, openTask,
    dispose() {
      disposed = true; close(); notices?.dispose(); runtime?.dispose(); lifetime.abort(); unsubscribe?.(); adapter?.dispose(); observer.disconnect();
      if (readyEvent && source) (source.removeListener ?? source.off)?.call(source, readyEvent, ready);
      entry?.remove(); entry = null;
    },
  };
}
