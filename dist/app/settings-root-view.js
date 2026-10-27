import {replacePageMarkup} from './stable-surface.js';
import {mountScheduleSettingsView} from './schedule-settings-view.js';
import {THEMES,surfaceTheme} from './styles/theme.js';
import {FEATURE_GROUPS,FEATURE_LABELS} from '../domain/controls/model.js';
import {mainNavigation,rootTitle} from './navigation.js';
import {APP_VERSION} from './version.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(name,label,action)=>`<button type="button" class="ui-icon-button ui-button--tertiary" data-settings-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const brand=`<svg class="lt-brand-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 6a4 4 0 1 1 8 0c0 2-2 3-2 5v1h3a4 4 0 0 1 4 4v3H3v-3a4 4 0 0 1 4-4h3v-1c0-2-2-3-2-5Zm-5 15h18v2H3Z"/></svg>`;
export function mountSettingsRootView(container,{controls,appearance,settings,onSchedule,availability=()=>controls.inspect().policy,onApi,onTaskApi,onNavigate,onClose,onGenerationDiagnostic,heightPreference=null,interfaceDiagnostic=null,focusAction=null}={}){
 const lifetime=new AbortController();let route='root',disposed=false,renderedBook=false,pendingThemeFocus=false,scheduleView=null;
 const row=(label,key,scope='control')=>`<div class="lt-settings-row"><span>${label}</span><button type="button" class="ui-switch" role="switch" aria-label="${label}" data-${scope}="${key}" aria-checked="false"><span class="ui-switch__track"><span class="ui-switch__knob"></span></span></button></div>`;
 const entry=(label,action)=>`<button type="button" class="lt-settings-entry" data-settings-action="${action}"><span>${label}</span><span aria-hidden="true">›</span></button>`;
 function rootContent(){
  const book=['paper-letter','purple-glow'].includes(surfaceTheme(container));
  const toggles=row('启用兰台','enabled')+row('在当前聊天中使用','chat');
  const services=entry('功能管理','features')+entry('连接方案','api')+entry('任务 API','task-api');
  const appearanceFields=`<label class="ui-field"><span class="ui-field__label">界面皮肤</span><select class="ui-input" data-settings-theme>${THEMES.map(theme=>`<option value="${theme.id}">${theme.label}</option>`).join('')}</select></label><p class="lt-status" data-appearance-status hidden></p><button type="button" class="ui-button ui-button--secondary" data-settings-action="appearance-read" hidden>重新读取外观</button>`;
  const identity=`<div class="lt-settings-brand"><div>${brand}<span>兰台本末</span><span class="lt-meta">v${esc(APP_VERSION)}</span></div><p class="lt-meta">剧情记忆与故事时间</p></div>`;
  const diagnostics=onGenerationDiagnostic?'<button type="button" class="ui-button ui-button--secondary" data-settings-action="generation-diagnostic">导出生成诊断</button><p class="lt-meta">诊断记录刷新后清空。</p><p class="lt-status" data-generation-diagnostic-status role="status"></p>':'';
  const interfaceTools=interfaceDiagnostic?'<button type="button" class="ui-button ui-button--secondary" data-settings-action="interface-record">记录界面诊断（最多30秒）</button><button type="button" class="ui-button ui-button--secondary" data-settings-action="interface-export" hidden>导出界面诊断</button><p class="lt-meta">仅记录界面状态，不采集文字内容；刷新清空。</p><p class="lt-status" data-interface-diagnostic-status role="status"></p>':'';
  const heightTools=heightPreference?`<div class="ui-field"><label class="ui-field__label" for="lt-panel-height">面板高度调整（缩减 px）</label><div class="lt-entry"><button type="button" class="ui-button ui-button--secondary" data-settings-action="height-less" aria-label="减少缩减量">−</button><input id="lt-panel-height" class="ui-input" data-panel-height type="number" min="0" step="1" inputmode="numeric" value="${heightPreference.inspect().reduction}"><button type="button" class="ui-button ui-button--secondary" data-settings-action="height-more" aria-label="增加缩减量">＋</button></div><button type="button" class="ui-button ui-button--tertiary" data-settings-action="height-default">恢复默认</button><p class="lt-status" data-height-status role="status" hidden></p></div>`:'';
  const group=(name,role,number,content)=>`<section class="lt-settings-group lt-settings-section" data-settings-section="${role}" data-settings-material="${role}"><h2 data-section-number="${number}">${name}</h2>${content}</section>`;
  return group('插件设置','plugin','01',toggles)+group('功能服务','services','02',services)+group('外观设计','appearance','03',appearanceFields+heightTools)+group('关于兰台','about','04',(book?identity.replace('<p class="lt-meta">剧情记忆与故事时间</p>',''):identity)+diagnostics+interfaceTools);
 }
 function patchHeight(overwrite=false){
  if(!heightPreference)return;const state=heightPreference.inspect(),field=container.querySelector('[data-panel-height]'),status=container.querySelector('[data-height-status]');
  if(overwrite&&field)field.value=String(state.reduction);
  if(status){status.textContent=state.message;status.hidden=!state.message;}
 }
 function render(focus=null,focusMain=true){
  if(disposed)return;scheduleView?.dispose();scheduleView=null;const state=controls.inspect();
  renderedBook=['paper-letter','purple-glow'].includes(surfaceTheme(container));
  replacePageMarkup(container,`<section class="lantai lt-settings ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ${route==='root'?'lt-header--root':'ui-header--centered'}">${route==='root'?`<div class="lt-root-top">${rootTitle('settings')}${icon('close','关闭兰台','close')}</div>`:`${icon('back','返回设置','back')}<h1 class="ui-page-title">功能管理</h1>${icon('close','关闭兰台','close')}`}</header><main class="lt-main ui-main lt-settings-main" tabindex="-1">${route==='root'?rootContent():`${FEATURE_GROUPS.map(([label,keys])=>`<section class="lt-settings-group"><h2>${label}</h2>${keys.map(key=>row(FEATURE_LABELS[key],key)+(key==='schedule'&&settings?entry('日程追踪设置','schedule'):'')).join('')}</section>`).join('')}`}<p class="lt-error" role="alert" data-controls-error hidden></p><button type="button" class="ui-button ui-button--secondary" data-settings-action="retry" hidden>重新读取设置</button></main><footer class="lt-footer">${mainNavigation({policy:availability(),current:'settings',attribute:'data-settings-action'})}</footer></section>`);
  patch();patchHeight();
  if(focusMain)(focus?container.querySelector(`[data-settings-action="${focus}"]`):container.querySelector('.lt-main'))?.focus?.({preventScroll:true});
 }
 function patch(){
  if(disposed||route==='schedule')return;const state=controls.inspect();
  for(const button of container.querySelectorAll('[data-control]')){
   const key=button.dataset.control,value=key==='enabled'?state.controls.enabled:key==='chat'?state.chat.enabled:state.controls.features[key];
   button.setAttribute('aria-checked',String(value));button.disabled=state.status!=='ready'||['loading','saving','unconfirmed'].includes(appearance.inspect().status);
   if(state.busy===key)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  }
  const error=container.querySelector('[data-controls-error]');if(error){error.textContent=state.error??'';error.hidden=!state.error;}
  const retry=container.querySelector('[data-settings-action=retry]');if(retry)retry.hidden=!state.error;
  const a=appearance.inspect(),select=container.querySelector('[data-settings-theme]');
  if(select){select.value=a.previewTheme??a.theme;select.disabled=a.status!=='ready'||!!state.busy||state.status==='loading';}
  if(pendingThemeFocus&&route==='root'&&select&&!select.disabled){pendingThemeFocus=false;select.focus?.({preventScroll:true});}
  else if(['error','unconfirmed'].includes(a.status))pendingThemeFocus=false;
  const message=container.querySelector('[data-appearance-status]');if(message){message.textContent=a.error?a.message:'';message.hidden=!message.textContent;}
  const appearanceRead=container.querySelector('[data-settings-action=appearance-read]');if(appearanceRead)appearanceRead.hidden=!a.error;
  const nav=container.querySelector('.lt-footer');if(nav)nav.innerHTML=mainNavigation({policy:availability(),current:'settings',attribute:'data-settings-action'});
  patchInterfaceDiagnostic();
 }
 function patchInterfaceDiagnostic(){
  if(disposed||route!=='root'||!interfaceDiagnostic)return;
  try{
   const state=interfaceDiagnostic.inspect(),record=container.querySelector('[data-settings-action=interface-record]'),exportButton=container.querySelector('[data-settings-action=interface-export]'),status=container.querySelector('[data-interface-diagnostic-status]');
   const recording=state.status==='recording';
   if(record){record.disabled=recording;record.textContent=recording?'正在记录界面诊断':state.hasData?'重新记录界面诊断（最多30秒）':'记录界面诊断（最多30秒）';}
   if(exportButton){exportButton.hidden=!recording&&!state.hasData;exportButton.textContent=recording?'停止并导出界面诊断':'导出界面诊断';}
   const reasons={timeout:'已到30秒，记录已停止。','panel-close':'界面已关闭，记录已停止。','chat-change':'聊天状态已变化，记录已停止。','document-hidden':'页面进入后台，记录已停止。','frame-cap':'达到记录上限，已停止。','event-cap':'达到记录上限，已停止。','byte-cap':'达到记录上限，已停止。','cost-limit':'采样开销持续偏高，已停止。',failed:'记录未完成，已停止。'};
   if(status)status.textContent=recording?(state.mode==='attributes-only'?'记录中，已减少采样；最多30秒后停止。':'记录中，最多30秒后自动停止。'):state.hasData?(reasons[state.reason]??'已停止，可导出。'):'';
  }catch{}
 }
 container.addEventListener('click',e=>{
  const toggle=e.target.closest('[data-control]');if(toggle&&!toggle.disabled){void controls.toggle(toggle.dataset.control);return;}
  const button=e.target.closest('[data-settings-action]');if(!button||button.disabled)return;
  pendingThemeFocus=false;
  const action=button.dataset.settingsAction;
  if(['height-less','height-more','height-default'].includes(action)){
   const current=heightPreference?.inspect().reduction??0;
   heightPreference?.set(action==='height-default'?0:Math.max(0,current+(action==='height-more'?1:-1)));patchHeight(true);return;
  }
  if(action==='interface-record'||action==='interface-export'){
   let ok=false;try{if(action==='interface-record')ok=interfaceDiagnostic?.start()===true;else{interfaceDiagnostic?.stop();ok=interfaceDiagnostic?.download()===true;}}catch{}
   patchInterfaceDiagnostic();if(!ok){const status=container.querySelector('[data-interface-diagnostic-status]');if(status)status.textContent=action==='interface-record'?'无法开始记录，请重试。':'导出未成功，请重试。';}return;
  }
  if(action==='generation-diagnostic'){let ok=false;try{ok=onGenerationDiagnostic?.()===true;}catch{}const status=container.querySelector('[data-generation-diagnostic-status]');if(status)status.textContent=ok?'已发起下载，请查看浏览器下载记录。':'导出未成功，请重试。';return;}
  if(action==='schedule'&&settings){route='schedule';scheduleView=mountScheduleSettingsView(container,{settings,controls,onSchedule,onClose,onBack:()=>{route='features';render();}});return;}
  if(action==='features'){route='features';render('back');}else if(action==='back'){route='root';render('features');}
  else if(action==='api')onApi?.();else if(action==='task-api')onTaskApi?.();else if(action==='close')onClose?.();
  else if(action==='appearance-read')void appearance.read();else if(action==='retry')void controls.refresh();else if(action!=='settings')onNavigate?.(action);
 },{signal:lifetime.signal});
 container.addEventListener('input',e=>{
  if(!e.target.matches?.('[data-panel-height]')||e.target.value.trim()==='')return;
  const value=Number(e.target.value);if(Number.isSafeInteger(value)&&value>=0){heightPreference?.set(value);patchHeight();}
 },{signal:lifetime.signal});
 container.addEventListener('change',e=>{
  if(e.target.matches?.('[data-panel-height]')){heightPreference?.set(e.target.value.trim()===''?NaN:Number(e.target.value));patchHeight();return;}
  if(!e.target.matches?.('[data-settings-theme]')||e.target.disabled)return;
  // Capture intent before saving disables/blurs the native select. A preview
  // can replace its DOM while disabled; restore only after readiness returns.
  pendingThemeFocus=true;
  void Promise.resolve(appearance.select(e.target.value)).then(()=>{if(!disposed)patch();});
 },{signal:lifetime.signal});
 // Replacing a focused native select can automatically focus its main ancestor.
 // That focusin is not user abandonment; an explicit pointer/Tab still cancels.
 container.addEventListener('focusin',e=>{if(!e.target.matches?.('[data-settings-theme],.lt-settings-main'))pendingThemeFocus=false;},{signal:lifetime.signal});
 container.addEventListener('pointerdown',e=>{if(!e.target.matches?.('[data-settings-theme]'))pendingThemeFocus=false;},{signal:lifetime.signal});
 container.addEventListener('keydown',e=>{if(e.key==='Tab')pendingThemeFocus=false;},{signal:lifetime.signal});
 const off=controls.subscribe(patch),offAppearance=appearance.subscribe(()=>{
  const book=['paper-letter','purple-glow'].includes(surfaceTheme(container));
  if(route!=='root'||book===renderedBook){patch();return;}
  const scroll=container.querySelector('.lt-main')?.scrollTop;
  render(null,!pendingThemeFocus);
  if(scroll!=null)container.querySelector('.lt-main').scrollTop=scroll;
 });let offInterface=()=>{};try{offInterface=interfaceDiagnostic?.subscribe(patchInterfaceDiagnostic)??offInterface;}catch{}render(focusAction);
 return {refresh:render,refreshAvailability:patch,back(){if(route==='schedule')return scheduleView?.back()??false;if(route==='features'){route='root';render('features');return true;}return false;},dispose(){disposed=true;scheduleView?.dispose();pendingThemeFocus=false;lifetime.abort();off();offAppearance();offInterface();}};
}
