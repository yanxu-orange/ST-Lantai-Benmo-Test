import {surfaceTheme} from './styles/theme.js';
import {TASK_API_GROUPS} from './task-api-settings-session.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name,label,action) => `<button type="button" class="ui-icon-button ui-button--tertiary" data-task-api-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
export function mountTaskApiSettingsView(container,session) {
  let disposed = false, textEditing = false, composing = false;
  function render() {
    if (disposed) return;
    const state = session.inspect(), locked = !state.draft || ['loading','saving','unconfirmed'].includes(state.status);
    let focused = container.getRootNode().activeElement ?? container.ownerDocument.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const focusKey = ['taskApiSource','taskApiModel','taskApiModelInput','taskApiFetch','taskApiAction'].find(key => focused?.dataset?.[key]);
    const focusValue = focusKey ? focused.dataset[focusKey] : null;
    const selection = focusKey === 'taskApiModelInput' ? [focused.selectionStart,focused.selectionEnd] : null;
    const scroll = container.querySelector('.lt-main')?.scrollTop ?? 0;
    const groups = state.draft ? TASK_API_GROUPS.map(([key,label]) => {
      const route = state.draft[key], preset = state.presets.find(item => item.id === route.presetId);
      const missing = route.source === 'plugin' && !preset;
      const selected = route.source === 'plugin' ? `preset:${route.presetId}` : route.source;
      const options = [['inherit','跟随默认'],['sillytavern','酒馆主 API'],...state.presets.map(item => [`preset:${item.id}`,item.name || '未命名方案'])];
      if (missing) options.push([selected,'已失效的方案（请重新选择）']);
      const models = [...new Set([preset?.model,route.model,...(state.models[key] ?? [])].filter(Boolean))];
      const operation = state.operations[key];
      return `<section class="lt-stack"><h2 class="lt-settings-section-title">${label}</h2><label class="ui-field lt-stack"><span class="ui-field__label">API 来源</span><select class="ui-input" data-task-api-source="${key}" aria-label="${label} API 来源" ${locked ? 'disabled' : ''}>${options.map(([value,name]) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>${missing ? '<p class="lt-error" role="alert">所选方案已不存在，请重新选择。</p>' : ''}${route.source === 'plugin' && preset ? `<label class="ui-field lt-stack"><span class="ui-field__label">模型（留空跟随方案）</span><input class="ui-input" data-task-api-model-input="${key}" aria-label="${label} 模型" value="${esc(route.model)}" placeholder="跟随方案${preset.model ? `（${esc(preset.model)}）` : ''}" autocomplete="off" ${locked ? 'disabled' : ''}></label><label class="ui-field lt-stack"><span class="ui-field__label">可用模型</span><select class="ui-input" data-task-api-model="${key}" aria-label="${label} 模型" ${locked ? 'disabled' : ''}><option value="" ${!route.model ? 'selected' : ''}>跟随方案${preset.model ? `（${esc(preset.model)}）` : ''}</option>${models.map(model => `<option value="${esc(model)}" ${route.model === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}</select></label><button type="button" class="ui-button ui-button--secondary" data-task-api-fetch="${key}" ${locked || operation?.status === 'loading' ? 'disabled' : ''}>${operation?.status === 'loading' ? '获取中…' : '获取模型'}</button><p data-task-api-operation="${key}" class="${operation?.status === 'error' ? 'lt-error' : 'lt-status'}" role="status" ${operation?.message ? '' : 'hidden'}>${esc(operation?.message)}</p>` : ''}</section>`;
    }).join('') : '';
    container.innerHTML = `<section class="lantai lt-api-settings ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ui-header--centered">${icon('back','返回设置','back')}<h1 class="ui-page-title">任务 API</h1>${icon('close','关闭任务 API 设置','close')}</header><main class="lt-main ui-main" tabindex="-1"><p class="lt-status">各项任务默认沿用 API 设置，也可单独选择方案和模型。</p>${state.status === 'loading' ? '<p class="lt-status" role="status">正在读取 API 配置…</p>' : ''}<form class="lt-editor" novalidate>${groups}</form><p data-task-api-message class="${state.error ? 'lt-error' : 'lt-status'}" role="${state.error ? 'alert' : 'status'}" ${state.message ? '' : 'hidden'}>${esc(state.message)}</p><button type="button" class="ui-button ui-button--secondary" data-task-api-action="read" ${state.error ? '' : 'hidden'} ${state.status === 'saving' ? 'disabled' : ''}>重新读取已保存配置</button></main><footer class="lt-footer ui-action-footer"><button type="button" class="ui-button ui-button--primary" data-task-api-action="save" ${locked ? 'disabled' : ''}>${state.status === 'saving' ? '保存中…' : '保存'}</button></footer></section>`;
    container.querySelector('.lt-main').scrollTop = scroll;
    if (focusKey) for (const node of container.querySelectorAll('[data-task-api-source],[data-task-api-model],[data-task-api-model-input],[data-task-api-fetch],[data-task-api-action]')) if (node.dataset[focusKey] === focusValue) { node.focus?.({preventScroll:true}); if (selection) node.setSelectionRange?.(...selection); break; }
  }
  function change(event) {
    const target = event.target;
    if (target.disabled) return;
    if (target.dataset.taskApiModelInput) { writeText(event); return; }
    if (target.dataset.taskApiSource) session.selectSource(target.dataset.taskApiSource,target.value);
    else if (target.dataset.taskApiModel) session.selectModel(target.dataset.taskApiModel,target.value);
  }
  function writeText(event) {
    const target = event.target;
    if (composing || event.isComposing || target.disabled || !target.dataset.taskApiModelInput) return;
    textEditing = true;
    try { session.selectModel(target.dataset.taskApiModelInput,target.value); } finally { textEditing = false; }
  }
  function compositionStart() { composing = true; }
  function compositionEnd(event) { composing = false; writeText(event); patchTextState(session.inspect()); }
  function click(event) {
    const button = event.target.closest('[data-task-api-action],[data-task-api-fetch]');
    if (!button || button.disabled) return;
    if (button.dataset.taskApiFetch) { void session.fetchModels(button.dataset.taskApiFetch); return; }
    const action = button.dataset.taskApiAction;
    if (action === 'save') void session.save(); else if (action === 'read') void session.read(); else session.exit(action);
  }
  function key(event) { if (event.key === 'Escape' && !composing && !event.isComposing) { event.preventDefault(); event.stopPropagation(); session.exit('back'); } }
  const submit = event => event.preventDefault();
  container.addEventListener('change',change); container.addEventListener('click',click); container.addEventListener('keydown',key); container.addEventListener('submit',submit);
  container.addEventListener('input',writeText); container.addEventListener('compositionstart',compositionStart); container.addEventListener('compositionend',compositionEnd);
  function patchTextState(state) {
    const message = container.querySelector('[data-task-api-message]');
    if (message) { message.textContent = state.message; message.hidden = !state.message; message.className = state.error ? 'lt-error' : 'lt-status'; message.setAttribute('role',state.error ? 'alert' : 'status'); }
    const locked = ['loading','saving','unconfirmed'].includes(state.status);
    for (const button of container.querySelectorAll('[data-task-api-fetch]')) {
      const operation = state.operations[button.dataset.taskApiFetch];
      button.disabled = locked || operation?.status === 'loading'; button.textContent = operation?.status === 'loading' ? '获取中…' : '获取模型';
    }
    for (const node of container.querySelectorAll('[data-task-api-operation]')) {
      const operation = state.operations[node.dataset.taskApiOperation];
      node.textContent = operation?.message ?? ''; node.hidden = !node.textContent; node.className = operation?.status === 'error' ? 'lt-error' : 'lt-status';
    }
    for (const select of container.querySelectorAll('[data-task-api-model]')) {
      const group = select.dataset.taskApiModel, route = state.draft[group], preset = state.presets.find(item => item.id === route.presetId);
      const models = [...new Set([preset?.model,route.model,...(state.models[group] ?? [])].filter(Boolean))];
      select.innerHTML = `<option value="" ${!route.model ? 'selected' : ''}>跟随方案${preset?.model ? `（${esc(preset.model)}）` : ''}</option>${models.map(model => `<option value="${esc(model)}" ${route.model === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}`;
    }
  }
  const off = session.subscribe(state => { if (!textEditing && !composing) render(); else patchTextState(state); }); render();
  return Object.freeze({refresh:render,dispose() { disposed = true; off(); container.removeEventListener('input',writeText); container.removeEventListener('compositionstart',compositionStart); container.removeEventListener('compositionend',compositionEnd); container.removeEventListener('change',change); container.removeEventListener('click',click); container.removeEventListener('keydown',key); container.removeEventListener('submit',submit); }});
}
