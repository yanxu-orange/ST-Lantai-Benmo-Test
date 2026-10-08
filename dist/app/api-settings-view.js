import { THEMES, surfaceTheme } from './styles/theme.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, label, action) => `<button type="button" class="ui-icon-button ui-button--tertiary" data-api-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`, import.meta.url)}" alt=""></button>`;
const field = (label, key, value, placeholder = '') => `<label class="ui-field lt-stack"><span class="ui-field__label">${label}</span><input class="ui-input" data-api-field="${key}" aria-label="${label}" value="${escape(value)}" placeholder="${placeholder}" autocomplete="off"></label>`;

export function mountApiSettingsView(container, session, { appearance } = {}) {
  let disposed = false, composing = false, textEditing = false, rendering = false;
  function render() {
    if (disposed) return;
    rendering = true;
    try { renderContent(); } finally { rendering = false; }
  }
  function renderContent() {
    // A document exposes the shadow host as activeElement. Use this work
    // surface's actual root, then follow any nested open shadow focus.
    let focused = container.getRootNode().activeElement ?? container.ownerDocument.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const focusField = focused?.dataset?.apiField;
    const focusSource = focused?.name === 'api-source' ? focused.value : null;
    const focusPreset = focused?.hasAttribute?.('data-api-preset');
    const focusModels = focused?.hasAttribute?.('data-api-model-choice');
    const focusAction = focused?.dataset?.apiAction;
    const focusAppearance = focused?.hasAttribute?.('data-appearance-theme');
    const focusAppearanceRead = focused?.dataset?.appearanceAction === 'read';
    const selection = focusField && focused.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
    const scroll = container.querySelector('.lt-main')?.scrollTop ?? 0;
    const state = session.inspect(), draft = state.draft, locked = ['loading', 'saving', 'unconfirmed'].includes(state.status);
    const preset = draft?.presets.find(item => item.id === draft.activePresetId);
    const hasCredential = preset && state.credentialPresetIds.includes(preset.id);
    container.innerHTML = `<section class="lantai lt-api-settings ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ${appearance?'lt-header--root':'ui-header--centered'}">${appearance?`<div class="lt-root-top"><h1 class="ui-page-title">设置</h1>${icon('close','关闭兰台','close')}</div>`:icon('back','返回原页面','back')+'<h1 class="ui-page-title">API 设置</h1>'+icon('close','关闭 API 设置','close')}</header><main class="lt-main ui-main" tabindex="-1">${appearance ? appearanceGroup() + '<h2 class="lt-settings-section-title">API 设置</h2>' : ''}<p class="lt-status" data-api-loading role="status" ${state.status === 'loading' ? '' : 'hidden'}>正在读取 API 配置…</p><form class="lt-editor" novalidate><fieldset class="lt-modes" aria-label="AI 来源" ${locked || !draft ? 'disabled' : ''}><legend class="ui-field__label">AI 来源</legend>${[['sillytavern', '酒馆主 API'], ['plugin', '插件 API']].map(([value, label]) => `<label class="lt-mode"><input type="radio" name="api-source" value="${value}" ${draft?.source === value ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>${draft?.source === null ? '<p class="lt-status">请选择生成时使用的来源。</p>' : ''}${draft?.source === 'sillytavern' ? '<p class="lt-status">使用酒馆当前的 API 和模型配置。</p><button type="button" class="ui-button ui-button--secondary" data-api-action="test">测试当前配置</button>' : ''}${draft?.source === 'plugin' ? `<section class="lt-stack"><div class="lt-api-presets"><label class="ui-field lt-stack"><span class="ui-field__label">方案</span><select class="ui-input" data-api-preset aria-label="方案"><option value="">请选择方案</option>${draft.presets.map(item => `<option value="${escape(item.id)}" ${item.id === draft.activePresetId ? 'selected' : ''}>${escape(item.name || '未命名方案')}</option>`).join('')}</select></label><button type="button" class="ui-button ui-button--tertiary" data-api-action="add">添加方案</button>${preset ? '<button type="button" class="ui-button ui-button--tertiary" data-api-action="save-as">另存为</button><button type="button" class="ui-button ui-button--tertiary" data-api-action="delete">删除方案</button>' : ''}</div>${preset ? `${field('方案名称', 'name', preset.name)}${field('API 地址', 'endpoint', preset.endpoint, 'https://example.com/v1')}${field('模型', 'model', preset.model)}<label class="ui-field lt-stack"><span class="ui-field__label">密钥</span><input type="${state.keyVisible ? 'text' : 'password'}" class="ui-input" data-api-field="key" aria-label="密钥" value="" autocomplete="new-password" placeholder="${hasCredential ? '已保存，留空保持原密钥' : '输入 API 密钥'}"></label><button type="button" class="ui-button ui-button--tertiary" data-api-action="toggle-key" aria-label="${state.keyVisible ? '隐藏密钥' : '显示密钥'}">${state.keyVisible ? '隐藏密钥' : '显示密钥'}</button><div class="lt-entry"><button type="button" class="ui-button ui-button--secondary" data-api-action="fetch-models">获取模型</button><button type="button" class="ui-button ui-button--secondary" data-api-action="test">测试当前配置</button></div><div data-api-models></div><div data-api-delete ${state.deleteConfirm ? '' : 'hidden'} class="lt-delete-confirmation"><p>删除当前方案？保存后生效。</p><div class="lt-entry"><button type="button" class="ui-button ui-button--tertiary" data-api-action="cancel-delete">取消</button><button type="button" class="ui-button ui-button--secondary" data-api-action="confirm-delete">确认删除</button></div></div>` : ''}<p class="lt-status" data-api-incomplete ${preset && (!preset.endpoint || !preset.model || !hasCredential) ? '' : 'hidden'}>方案尚未配置完整，暂不能生成。</p></section>` : ''}${appearance?`<button type="button" class="ui-button ui-button--primary" data-api-action="save" ${locked || !draft ? 'disabled' : ''}>${state.status === 'saving' ? '保存中…' : '保存 API 设置'}</button>`:""}</form><p data-api-operation role="status" class="lt-status"></p><p data-api-message class="${state.error ? 'lt-error' : 'lt-status'}" role="${state.error ? 'alert' : 'status'}" ${state.message ? '' : 'hidden'}>${escape(state.message)}</p><button type="button" class="ui-button ui-button--secondary" data-api-action="read" ${state.error || state.status === 'unconfirmed' ? '' : 'hidden'}>重新读取已保存配置</button></main>${appearance?`<footer class="lt-footer"><nav class="ui-bottom-nav" aria-label="一级分区">${[['记忆','memory',''],['时间','time',''],['工坊','workshop',''],['设置','current','aria-current="page"']].map(([label,action,attrs])=>`<button type="button" class="ui-button ui-nav-item" data-api-action="${action}" ${attrs}>${label}</button>`).join('')}</nav></footer>`:`<footer class="lt-footer ui-action-footer"><button type="button" class="ui-button ui-button--primary" data-api-action="save" ${locked || !draft ? 'disabled' : ''}>${state.status === 'saving' ? '保存中…' : '保存'}</button></footer>`}</section>`;
    const password = container.querySelector('[data-api-field=key]');
    if (password) password.value = session.passwordDraft(preset.id);
    patchOperations(state);
    patchAppearance();
    for (const control of container.querySelectorAll('.lt-editor input,.lt-editor select,.lt-editor button')) control.disabled ||= locked;
    container.querySelector('.lt-main').scrollTop = scroll;
    const focusSelector = focusAppearance ? '[data-appearance-theme]' : focusAppearanceRead ? '[data-appearance-action=read]' : focusField ? `[data-api-field="${focusField}"]`
      : focusSource ? `input[name="api-source"][value="${focusSource}"]`
        : focusPreset ? '[data-api-preset]' : focusModels ? '[data-api-model-choice]' : focusAction ? `[data-api-action="${focusAction}"]` : null;
    if (focusSelector) {
      const next = container.querySelector(focusSelector);
      next?.focus({ preventScroll: true });
      if (selection && next?.tagName === 'INPUT') next.setSelectionRange(...selection);
    }
  }
  function appearanceGroup() {
    return `<section class="lt-appearance-settings lt-stack" aria-labelledby="lt-appearance-heading"><h2 id="lt-appearance-heading" class="lt-settings-section-title">外观</h2><label class="ui-field lt-stack"><span class="ui-field__label">界面皮肤</span><select class="ui-input" data-appearance-theme aria-label="界面皮肤">${THEMES.map(theme => `<option value="${theme.id}">${theme.label}</option>`).join('')}</select></label><p class="lt-status" data-appearance-message role="status" hidden></p><button type="button" class="ui-button ui-button--secondary" data-appearance-action="read" hidden>重新读取外观</button></section>`;
  }
  function appearanceBlocksApiSave() {
    return appearance && ['loading','saving','unconfirmed'].includes(appearance.inspect().status);
  }
  function patchAppearance() {
    if (!appearance || disposed) return;
    const state = appearance.inspect(), api = session.inspect();
    const select = container.querySelector('[data-appearance-theme]');
    if (select) { select.value = state.previewTheme ?? state.theme; select.disabled = state.status !== 'ready' || !['ready','saved'].includes(api.status); }
    const message = container.querySelector('[data-appearance-message]');
    if (message) {
      message.textContent = state.status === 'saving' ? '正在保存外观…' : state.message;
      message.hidden = !message.textContent; message.className = state.error ? 'lt-error' : 'lt-status';
      message.setAttribute('role', state.error ? 'alert' : 'status');
    }
    const read = container.querySelector('[data-appearance-action=read]');
    if (read) { read.hidden = !state.error; read.disabled = ['loading','saving'].includes(state.status) || api.status === 'saving'; }
    const save = container.querySelector('[data-api-action=save]');
    if (save) save.disabled = appearanceBlocksApiSave() || ['loading','saving','unconfirmed'].includes(api.status) || !api.draft;
  }
  function patchOperations(state) {
    const status = container.querySelector('[data-api-operation]');
    if (status) { status.textContent = state.operation.message; status.hidden = !state.operation.message; status.className = state.operation.error ? 'lt-error' : 'lt-status'; }
    for (const name of ['fetch-models', 'test']) {
      const button = container.querySelector(`[data-api-action=${name}]`);
      if (button) { button.disabled = ['fetching', 'testing'].includes(state.operation.status) || ['loading', 'saving', 'unconfirmed'].includes(state.status);
        button.textContent = name === 'fetch-models' ? state.operation.status === 'fetching' ? '获取中…' : '获取模型' : state.operation.status === 'testing' ? '测试中…' : '测试当前配置'; }
    }
    const slot = container.querySelector('[data-api-models]');
    const preset = state.draft?.presets.find(item => item.id === state.draft.activePresetId);
    if (slot) slot.innerHTML = state.models.length ? `<label class="ui-field lt-stack"><span class="ui-field__label">可用模型</span><select class="ui-input" data-api-model-choice aria-label="可用模型"><option value="">请选择模型</option>${state.models.map(id => `<option value="${escape(id)}" ${preset?.model === id ? 'selected' : ''}>${escape(id)}</option>`).join('')}</select></label>` : '';
  }
  function patchTextState(state) {
    // Text entry never replaces the active input. Updating its surrounding
    // status and option label preserves native caret, IME and Tab behavior.
    patchOperations(state);
    patchAppearance();
    const message = container.querySelector('[data-api-message]');
    if (message) {
      message.textContent = state.message; message.hidden = !state.message;
      message.className = state.error ? 'lt-error' : 'lt-status';
      message.setAttribute('role', state.error ? 'alert' : 'status');
    }
    const reload = container.querySelector('[data-api-action=read]');
    if (reload) reload.hidden = !state.error && state.status !== 'unconfirmed';
    const preset = state.draft?.presets.find(item => item.id === state.draft.activePresetId);
    const select = container.querySelector('[data-api-preset]');
    if (preset && select) {
      for (const option of select.options) if (option.value === preset.id) option.textContent = preset.name || '未命名方案';
    }
    const incomplete = container.querySelector('[data-api-incomplete]');
    if (incomplete) incomplete.hidden = !preset || !!(preset.endpoint && preset.model && state.credentialPresetIds.includes(preset.id));
  }
  function writeText(target) {
    if (rendering || composing || !target.dataset.apiField) return;
    const state = session.inspect(), preset = state.draft?.presets.find(item => item.id === state.draft.activePresetId);
    if (target.dataset.apiField === 'key' ? session.passwordDraft(preset?.id) === target.value : preset?.[target.dataset.apiField] === target.value) return;
    textEditing = true;
    try { session.setField(target.dataset.apiField, target.value); } finally { textEditing = false; }
  }
  function change(event) {
    if (rendering) return;
    const target = event.target;
    if (target.hasAttribute('data-appearance-theme')) {
      if (['ready','saved'].includes(session.inspect().status)) void appearance?.select(target.value);
      patchAppearance(); return;
    }
    if (target.tagName === 'INPUT' && target.dataset.apiField) { writeText(target); return; }
    if (target.hasAttribute('data-api-model-choice')) { session.setField('model', target.value); return; }
    if (target.name === 'api-source') session.setSource(target.value);
    else if (target.hasAttribute('data-api-preset')) session.selectPreset(target.value || null);
    else if (target.dataset.apiField) session.setField(target.dataset.apiField, target.value);
  }
  function input(event) { if (!event.isComposing && event.target.tagName === 'INPUT') writeText(event.target); }
  function startComposition() { composing = true; }
  function endComposition(event) { composing = false; input(event); }
  function click(event) {
    if (event.target.closest('[data-appearance-action=read]')) { if (session.inspect().status !== 'saving') void appearance?.read(); return; }
    const action = event.target.closest('[data-api-action]')?.dataset.apiAction;
    if (action === 'save') { if (!appearanceBlocksApiSave()) void session.save(); }
    else if (action === 'read') void session.read();
    else if (action === 'add') session.addPreset();
    else if (action === 'delete') session.requestDelete();
    else if (action === 'cancel-delete') session.cancelDelete();
    else if (action === 'confirm-delete') session.deletePreset();
    else if (action === 'save-as') session.saveAs();
    else if (action === 'fetch-models') void session.fetchModels();
    else if (action === 'test') void session.test();
    else if (action === 'toggle-key') session.toggleKey();
    else if (['back', 'close', 'memory', 'time', 'workshop'].includes(action)) session.exit(action);
  }
  function submit(event) { event.preventDefault(); }
  function key(event) { if (event.key === 'Escape' && !composing && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (session.inspect().deleteConfirm) session.cancelDelete(); else session.exit('back'); } }
  container.addEventListener('input', input); container.addEventListener('change', change); container.addEventListener('click', click);
  container.addEventListener('submit', submit); container.addEventListener('keydown', key);
  container.addEventListener('compositionstart', startComposition); container.addEventListener('compositionend', endComposition);
  const unsubscribe = session.subscribe(state => { if (textEditing || composing) patchTextState(state); else render(); });
  const unsubscribeAppearance = appearance?.subscribe(patchAppearance); render();
  return Object.freeze({ refresh: render, dispose() {
    disposed = true; unsubscribe(); unsubscribeAppearance?.();
    container.removeEventListener('input', input); container.removeEventListener('change', change); container.removeEventListener('click', click);
    container.removeEventListener('submit', submit); container.removeEventListener('keydown', key);
    container.removeEventListener('compositionstart', startComposition); container.removeEventListener('compositionend', endComposition);
  } });
}
