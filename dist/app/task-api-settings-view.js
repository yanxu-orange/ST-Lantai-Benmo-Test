import {surfaceTheme} from './styles/theme.js';
import {TASK_API_GROUPS} from './task-api-settings-session.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name,label,action) => `<button type="button" class="ui-icon-button ui-button--tertiary" data-task-api-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
export function mountTaskApiSettingsView(container,session) {
  let disposed = false;
  function render() {
    if (disposed) return;
    const state = session.inspect(), locked = !state.draft || ['loading','saving','unconfirmed'].includes(state.status);
    let focused = container.getRootNode().activeElement ?? container.ownerDocument.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const focusKey = ['taskApiSource','taskApiModel','taskApiFetch','taskApiAction'].find(key => focused?.dataset?.[key]);
    const focusValue = focusKey ? focused.dataset[focusKey] : null;
    const scroll = container.querySelector('.lt-main')?.scrollTop ?? 0;
    const groups = state.draft ? TASK_API_GROUPS.map(([key,label]) => {
      const route = state.draft[key], preset = state.presets.find(item => item.id === route.presetId);
      const missing = route.source === 'plugin' && !preset;
      const selected = route.source === 'plugin' ? `preset:${route.presetId}` : route.source;
      const options = [['inherit','跟随默认'],['sillytavern','酒馆主 API'],...state.presets.map(item => [`preset:${item.id}`,item.name || '未命名方案'])];
      if (missing) options.push([selected,'已失效的方案（请重新选择）']);
      const models = [...new Set([preset?.model,route.model,...(state.models[key] ?? [])].filter(Boolean))];
      const operation = state.operations[key];
      return `<section class="lt-stack"><label class="ui-field lt-stack"><span class="ui-field__label">API方案-${label}</span><select class="ui-input" data-task-api-source="${key}" aria-label="API方案-${label}" ${locked ? 'disabled' : ''}>${options.map(([value,name]) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>${missing ? '<p class="lt-error" role="alert">所选方案已不存在，请重新选择。</p>' : ''}${route.source === 'plugin' && preset ? `<label class="ui-field lt-stack"><span class="ui-field__label">模型</span><select class="ui-input" data-task-api-model="${key}" aria-label="${label} 模型" ${locked ? 'disabled' : ''}><option value="" ${!route.model ? 'selected' : ''}>跟随方案${preset.model ? `（${esc(preset.model)}）` : ''}</option>${models.map(model => `<option value="${esc(model)}" ${route.model === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}</select></label><button type="button" class="ui-button ui-button--secondary" data-task-api-fetch="${key}" ${locked || operation?.status === 'loading' ? 'disabled' : ''}>${operation?.status === 'loading' ? '获取中…' : '获取模型'}</button><p data-task-api-operation="${key}" class="${operation?.status === 'error' ? 'lt-error' : 'lt-status'}" role="status" ${operation?.message ? '' : 'hidden'}>${esc(operation?.message)}</p>` : ''}</section>`;
    }).join('') : '';
    container.innerHTML = `<section class="lantai lt-api-settings ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ui-header--centered">${icon('back','返回设置','back')}<h1 class="ui-page-title">任务 API</h1>${icon('close','关闭任务 API 设置','close')}</header><main class="lt-main ui-main" tabindex="-1">${state.status === 'loading' ? '<p class="lt-status" role="status">正在读取 API 配置…</p>' : ''}<form class="lt-editor" novalidate>${groups}</form><p data-task-api-message class="${state.error ? 'lt-error' : 'lt-status'}" role="${state.error ? 'alert' : 'status'}" ${state.message ? '' : 'hidden'}>${esc(state.message)}</p><button type="button" class="ui-button ui-button--secondary" data-task-api-action="read" ${state.error ? '' : 'hidden'} ${state.status === 'saving' ? 'disabled' : ''}>重新读取已保存配置</button></main><footer class="lt-footer ui-action-footer"><button type="button" class="ui-button ui-button--primary" data-task-api-action="save" ${locked ? 'disabled' : ''}>${state.status === 'saving' ? '保存中…' : '保存'}</button></footer></section>`;
    container.querySelector('.lt-main').scrollTop = scroll;
    if (focusKey) for (const node of container.querySelectorAll('[data-task-api-source],[data-task-api-model],[data-task-api-fetch],[data-task-api-action]')) if (node.dataset[focusKey] === focusValue) { node.focus?.({preventScroll:true}); break; }
  }
  function change(event) {
    const target = event.target;
    if (target.disabled) return;
    if (target.dataset.taskApiSource) session.selectSource(target.dataset.taskApiSource,target.value);
    else if (target.dataset.taskApiModel) session.selectModel(target.dataset.taskApiModel,target.value);
  }
  function click(event) {
    const button = event.target.closest('[data-task-api-action],[data-task-api-fetch]');
    if (!button || button.disabled) return;
    if (button.dataset.taskApiFetch) { void session.fetchModels(button.dataset.taskApiFetch); return; }
    const action = button.dataset.taskApiAction;
    if (action === 'save') void session.save(); else if (action === 'read') void session.read(); else session.exit(action);
  }
  function key(event) { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); session.exit('back'); } }
  const submit = event => event.preventDefault();
  container.addEventListener('change',change); container.addEventListener('click',click); container.addEventListener('keydown',key); container.addEventListener('submit',submit);
  const off = session.subscribe(render); render();
  return Object.freeze({refresh:render,dispose() { disposed = true; off(); container.removeEventListener('change',change); container.removeEventListener('click',click); container.removeEventListener('keydown',key); container.removeEventListener('submit',submit); }});
}
