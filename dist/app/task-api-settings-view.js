import {surfaceTheme} from './styles/theme.js';
import {TASK_API_GROUPS} from './task-api-settings-session.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name,label,action) => `<button type="button" class="ui-icon-button ui-button--tertiary" data-task-api-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const modelOptions = (state,key,route,preset) => [...new Set([route?.model||(route?.modelSource!=='task'?preset?.model:'')||'',...(state.models[key]??[])].filter(Boolean))].map(model=>`<option value="${esc(model)}"></option>`).join('');
export function mountTaskApiSettingsView(container,session) {
  let disposed = false,editing=false,composing=false;
  function render() {
    if (disposed) return;
    const state = session.inspect(), locked = !state.draft || ['loading','saving','unconfirmed'].includes(state.status);
    let focused = container.getRootNode().activeElement ?? container.ownerDocument.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const focusKey = ['taskApiSource','taskApiModel','taskApiFetch','taskApiAction'].find(key => focused?.dataset?.[key]);
    const focusValue = focusKey ? focused.dataset[focusKey] : null;
    const selection=focused?.tagName==='INPUT'?[focused.selectionStart,focused.selectionEnd]:null;
    const scroll = container.querySelector('.lt-main')?.scrollTop ?? 0;
    const groups = state.draft ? TASK_API_GROUPS.map(([key,label]) => {
      const unresolved=state.draft[key]===null,route = state.draft[key]??{source:'unresolved',presetId:null,model:''}, expected=['embedding','rerank'].includes(key)?key:'text',presets=state.presets,preset = presets.find(item => item.id === route.presetId);
      const missing = route.source === 'plugin' && !preset;
      const selected = route.source === 'plugin' ? `preset:${route.presetId}` : route.source;
      const options = [...(unresolved?[['unresolved','请选择统一的总结来源']]:[]),['none','未配置'],...(expected==='text'?[['sillytavern','酒馆主 API']]:[]),...presets.map(item => [`preset:${item.id}`,item.name || '未命名方案'])];
      if (missing) options.push([selected,'已失效的方案（请重新选择）']);
      const effectiveModel=route.model||(route.modelSource!=='task'?preset?.model:'')||'',operation=state.operations[key];
      return `<section class="ui-surface lt-settings-group" data-task-api-group="${key}"><h2>${label}</h2><label class="ui-field lt-settings-row"><span class="ui-field__label">方案</span><select class="ui-input" data-task-api-source="${key}" aria-label="API方案-${label}" ${locked?'disabled':''}>${options.map(([value,name])=>`<option value="${esc(value)}" ${selected===value?'selected':''} ${value==='unresolved'?'disabled':''}>${esc(name)}</option>`).join('')}</select></label>${unresolved?'<p class="lt-error" role="alert">旧事件总结与古法总结的来源或模型选择不同；保存前请明确统一选择，原配置仍保留。</p>':''}${missing?'<p class="lt-error" role="alert">所选方案已不存在，请重新选择。</p>':''}${route.source==='plugin'&&preset?`<label class="ui-field lt-settings-row"><span class="ui-field__label">模型</span><input class="ui-input" data-task-api-model="${key}" list="lt-task-models-${key}" aria-label="${label} 模型" value="${esc(effectiveModel)}" placeholder="输入或选择模型" autocomplete="off" spellcheck="false" ${locked?'disabled':''}><datalist id="lt-task-models-${key}">${modelOptions(state,key,route,preset)}</datalist></label><button type="button" class="ui-button ui-button--secondary" data-task-api-fetch="${key}" ${locked||operation?.status==='loading'?'disabled':''}>${operation?.status==='loading'?'获取中…':'获取模型'}</button><p data-task-api-operation="${key}" class="${operation?.status==='error'?'lt-error':'lt-status'}" role="status" ${operation?.message?'':'hidden'}>${esc(operation?.message)}</p>`:''}</section>`;
    }).join('') : '';
    container.innerHTML = `<section class="lantai lt-api-settings lt-task-api-settings ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ui-header--centered">${icon('back','返回设置','back')}<h1 class="ui-page-title">任务 API</h1>${icon('close','关闭任务 API 设置','close')}</header><main class="lt-main ui-main" tabindex="-1">${state.status === 'loading' ? '<p class="lt-status" role="status">正在读取 API 配置…</p>' : ''}<form class="lt-stack" novalidate>${groups}</form><p data-task-api-message class="${state.error ? 'lt-error' : 'lt-status'}" role="${state.error ? 'alert' : 'status'}" ${state.message ? '' : 'hidden'}>${esc(state.message)}</p><button type="button" class="ui-button ui-button--secondary" data-task-api-action="read" ${state.error ? '' : 'hidden'} ${state.status === 'saving' ? 'disabled' : ''}>重新读取已保存配置</button></main><footer class="lt-footer ui-action-footer"><button type="button" class="ui-button ui-button--primary" data-task-api-action="save" ${locked ? 'disabled' : ''}>${state.status === 'saving' ? '保存中…' : '保存'}</button></footer></section>`;
    container.querySelector('.lt-main').scrollTop = scroll;
    if (focusKey) for (const node of container.querySelectorAll('[data-task-api-source],[data-task-api-model],[data-task-api-fetch],[data-task-api-action]')) if (node.dataset[focusKey] === focusValue) { node.focus?.({preventScroll:true});if(selection&&node.tagName==='INPUT')node.setSelectionRange?.(...selection); break; }
  }
  function change(event) {
    const target = event.target;
    if (target.disabled) return;
    if (target.dataset.taskApiSource) session.selectSource(target.dataset.taskApiSource,target.value);
    else if (target.dataset.taskApiModel) input(event);
  }
  // Async receipts still update surrounding feedback during native text/IME
  // entry. Never replace the active input merely to finish a model request.
  function patchFeedback(state) {
    if(disposed)return;
    const locked=!state.draft||['loading','saving','unconfirmed'].includes(state.status);
    for(const [key] of TASK_API_GROUPS){
      const operation=state.operations[key],route=state.draft?.[key],preset=state.presets.find(item=>item.id===route?.presetId);
      const fetch=container.querySelector(`[data-task-api-fetch="${key}"]`);
      if(fetch){fetch.disabled=locked||operation?.status==='loading';fetch.textContent=operation?.status==='loading'?'获取中…':'获取模型';}
      const message=container.querySelector(`[data-task-api-operation="${key}"]`);
      if(message){message.textContent=operation?.message??'';message.hidden=!operation?.message;message.className=operation?.status==='error'?'lt-error':'lt-status';}
      const models=container.querySelector(`#lt-task-models-${key}`);
      if(models){const markup=modelOptions(state,key,route,preset);if(models.innerHTML!==markup)models.innerHTML=markup;}
      for(const kind of ['source','model']){const field=container.querySelector(`[data-task-api-${kind}="${key}"]`);if(field)field.disabled=locked;}
    }
    const message=container.querySelector('[data-task-api-message]');
    if(message){message.textContent=state.message;message.hidden=!state.message;message.className=state.error?'lt-error':'lt-status';message.setAttribute('role',state.error?'alert':'status');}
    const save=container.querySelector('[data-task-api-action="save"]');if(save){save.disabled=locked;save.textContent=state.status==='saving'?'保存中…':'保存';}
    const read=container.querySelector('[data-task-api-action="read"]');if(read){read.hidden=!state.error;read.disabled=state.status==='saving';}
  }
  function input(event){const target=event.target;if(composing||event.isComposing||target.disabled||!target.dataset.taskApiModel)return;const route=session.inspect().draft?.[target.dataset.taskApiModel];if(route?.modelSource==='task'&&route.model===target.value)return;editing=true;try{session.selectModel(target.dataset.taskApiModel,target.value);}finally{editing=false;}}
  function startComposition(){composing=true;}function endComposition(event){composing=false;input(event);}
  function click(event) {
    const button = event.target.closest('[data-task-api-action],[data-task-api-fetch]');
    if (!button || button.disabled) return;
    if (button.dataset.taskApiFetch) { void session.fetchModels(button.dataset.taskApiFetch); return; }
    const action = button.dataset.taskApiAction;
    if (action === 'save') void session.save(); else if (action === 'read') void session.read(); else session.exit(action);
  }
  function key(event) { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); session.exit('back'); } }
    const submit = event => event.preventDefault();
  container.addEventListener('input',input);container.addEventListener('compositionstart',startComposition);container.addEventListener('compositionend',endComposition);container.addEventListener('change',change); container.addEventListener('click',click); container.addEventListener('keydown',key); container.addEventListener('submit',submit);
  const off = session.subscribe(state=>{if(editing||composing)patchFeedback(state);else render();}); render();
  return Object.freeze({refresh:render,dispose() { disposed = true; off();container.removeEventListener('input',input);container.removeEventListener('compositionstart',startComposition);container.removeEventListener('compositionend',endComposition); container.removeEventListener('change',change); container.removeEventListener('click',click); container.removeEventListener('keydown',key); container.removeEventListener('submit',submit); }});
}
