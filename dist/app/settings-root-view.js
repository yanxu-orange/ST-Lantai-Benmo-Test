import {THEMES,surfaceTheme} from './styles/theme.js';
import {FEATURES,FEATURE_LABELS} from '../domain/controls/model.js';
import {mainNavigation} from './navigation.js';
import {APP_VERSION} from './version.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(name,label,action)=>`<button type="button" class="ui-icon-button ui-button--tertiary" data-settings-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const brand=`<svg class="lt-brand-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 6a4 4 0 1 1 8 0c0 2-2 3-2 5v1h3a4 4 0 0 1 4 4v3H3v-3a4 4 0 0 1 4-4h3v-1c0-2-2-3-2-5Zm-5 15h18v2H3Z"/></svg>`;
export function mountSettingsRootView(container,{controls,appearance,onApi,onNavigate,onClose,focusAction=null}={}){
 const lifetime=new AbortController();let route='root',disposed=false;
 const row=(label,key)=>`<div class="lt-settings-row"><span>${label}</span><button type="button" class="ui-switch" role="switch" aria-label="${label}" data-control="${key}" aria-checked="false"><span class="ui-switch__track"><span class="ui-switch__knob"></span></span></button></div>`;
 const entry=(label,action)=>`<button type="button" class="lt-settings-entry" data-settings-action="${action}"><span>${label}</span><span aria-hidden="true">›</span></button>`;
 function render(focus=null){
  if(disposed)return;const state=controls.inspect();
  container.innerHTML=`<section class="lantai lt-settings ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ${route==='root'?'lt-header--root':'ui-header--centered'}">${route==='root'?`<div class="lt-root-top"><h1 class="ui-page-title">设置</h1>${icon('close','关闭兰台','close')}</div>`:`${icon('back','返回设置','back')}<h1 class="ui-page-title">功能管理</h1>${icon('close','关闭兰台','close')}`}</header><main class="lt-main ui-main lt-settings-main" tabindex="-1">${route==='root'?`<section class="lt-settings-group"><h2>插件</h2>${row('启用兰台','enabled')}${row('在当前聊天中使用','chat')}${entry('功能管理','features')}${entry('API 设置','api')}</section><section class="lt-settings-group"><h2>外观</h2><label class="ui-field"><span class="ui-field__label">界面皮肤</span><select class="ui-input" data-settings-theme>${THEMES.map(theme=>`<option value="${theme.id}">${theme.label}</option>`).join('')}</select></label><p class="lt-status" data-appearance-status hidden></p><button type="button" class="ui-button ui-button--secondary" data-settings-action="appearance-read" hidden>重新读取外观</button></section><div class="lt-settings-brand"><div>${brand}<span>兰台本末</span><span class="lt-meta">v${esc(APP_VERSION)}</span></div><p class="lt-meta">剧情记忆与故事时间</p></div>`:`<section class="lt-settings-group">${FEATURES.map(key=>row(FEATURE_LABELS[key],key)).join('')}</section>`}<p class="lt-error" role="alert" data-controls-error hidden></p><button type="button" class="ui-button ui-button--secondary" data-settings-action="retry" hidden>重新读取设置</button></main>${route==='root'?`<footer class="lt-footer">${mainNavigation({policy:state.policy,current:'settings',attribute:'data-settings-action'})}</footer>`:''}</section>`;
  patch();
  (focus?container.querySelector(`[data-settings-action="${focus}"]`):container.querySelector('.lt-main'))?.focus?.({preventScroll:true});
 }
 function patch(){
  if(disposed)return;const state=controls.inspect();
  for(const button of container.querySelectorAll('[data-control]')){
   const key=button.dataset.control,value=key==='enabled'?state.controls.enabled:key==='chat'?state.chat.enabled:state.controls.features[key];
   button.setAttribute('aria-checked',String(value));button.disabled=state.status!=='ready'||['loading','saving','unconfirmed'].includes(appearance.inspect().status);
   if(state.busy===key)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  }
  const error=container.querySelector('[data-controls-error]');if(error){error.textContent=state.error??'';error.hidden=!state.error;}
  const retry=container.querySelector('[data-settings-action=retry]');if(retry)retry.hidden=!state.error;
  const a=appearance.inspect(),select=container.querySelector('[data-settings-theme]');
  if(select){select.value=a.previewTheme??a.theme;select.disabled=a.status!=='ready'||!!state.busy||state.status==='loading';}
  const message=container.querySelector('[data-appearance-status]');if(message){message.textContent=a.error?a.message:'';message.hidden=!message.textContent;}
  const appearanceRead=container.querySelector('[data-settings-action=appearance-read]');if(appearanceRead)appearanceRead.hidden=!a.error;
  const nav=container.querySelector('.lt-footer');if(nav)nav.innerHTML=mainNavigation({policy:state.policy,current:'settings',attribute:'data-settings-action'});
 }
 container.addEventListener('click',e=>{
  const toggle=e.target.closest('[data-control]');if(toggle&&!toggle.disabled){void controls.toggle(toggle.dataset.control);return;}
  const button=e.target.closest('[data-settings-action]');if(!button||button.disabled)return;
  const action=button.dataset.settingsAction;
  if(action==='features'){route='features';render('back');}else if(action==='back'){route='root';render('features');}
  else if(action==='api')onApi?.();else if(action==='close')onClose?.();
  else if(action==='appearance-read')void appearance.read();else if(action==='retry')void controls.refresh();else if(action!=='settings')onNavigate?.(action);
 },{signal:lifetime.signal});
 container.addEventListener('change',e=>{if(e.target.matches?.('[data-settings-theme]'))void appearance.select(e.target.value);},{signal:lifetime.signal});
 const off=controls.subscribe(patch),offAppearance=appearance.subscribe(patch);render(focusAction);
 return {refresh:render,back(){if(route==='features'){route='root';render('features');return true;}return false;},dispose(){disposed=true;lifetime.abort();off();offAppearance();}};
}
