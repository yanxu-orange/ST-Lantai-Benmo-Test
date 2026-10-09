import {surfaceTheme} from './styles/theme.js';

const FIELDS={
  item:[['name','名称'],['introduction','精简介绍',true],['location','位置'],['custodian','保管者'],['owner','所属者'],['transferFrom','赠送／转移方'],['transferTo','接收方'],['transferReason','简短原因',true]],
  npc:[['name','姓名'],['appearance','辨识外表',true],['identity','身份'],['relationToUser','与 user 的关系'],['relationToChar','与 char 的关系']],
};
const TITLES={item:'物品追踪',npc:'NPC 追踪'};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const aliases=value=>[...new Set(String(value??'').split(/[,，\n]/).map(part=>part.trim()).filter(Boolean))];

// This is a child page of the workshop, never a main-navigation destination.
export async function mountTrackingView({container:app,controller,kind,onBack,onClose}={}) {
  if(!FIELDS[kind])throw new Error('追踪页面类型无效');
  const lifetime=new AbortController(),scrolls={list:0,editor:0};
  let value=await controller.load(),route='list',draft=null,baseline=null,original=null,dialog=null;
  let disposed=false,acting=false,error='',toastTimer,toggleVersion=0,pendingToggles=0;
  const initialDraft=record=>({id:record?.id??crypto.randomUUID(),...Object.fromEntries(FIELDS[kind].map(([key])=>[key,record?.[key]??''])),aliases:(record?.aliases??[]).join('，'),pinned:record?.pinned===true});
  const apply=next=>{value=next;error='';};
  const button=(text,action,attributes='',tone='tertiary')=>`<button type="button" class="ui-button ui-button--${tone}" data-action="${action}" ${value.writeBlocked&&['save','delete-record','new'].includes(action)?'disabled':''} ${attributes}>${text}</button>`;
  const icon=(label,action,file)=>`<button type="button" class="ui-icon-button ui-button--tertiary" aria-label="${esc(label)}" data-action="${action}"><img class="lt-icon" data-icon="${file}" src="${new URL(`./icons/${file}.svg`,import.meta.url)}" alt=""></button>`;
  const switchControl=(label,action,checked,disabled=false)=>`<button type="button" class="ui-switch" role="switch" aria-label="${esc(label)}" aria-checked="${checked===true}" data-action="${action}" ${disabled?'disabled':''}><span class="ui-switch__track"><span class="ui-switch__knob"></span></span></button>`;
  function remember(){const main=app.querySelector('.lt-main');if(main)scrolls[route]=main.scrollTop;}
  function readDraft(){
    const form=app.querySelector('form');if(!form||!draft)return;
    for(const [key,text]of new FormData(form))if(key==='aliases'||FIELDS[kind].some(([name])=>name===key))draft[key]=String(text);
  }
  function dirty(){readDraft();return !!draft&&!same(draft,baseline);}
  function toast(text){
    if(disposed)return;clearTimeout(toastTimer);app.querySelector('.wk-toast')?.remove();
    const element=app.ownerDocument.createElement('p');element.className='wk-toast';element.setAttribute('role','status');element.textContent=text;
    app.querySelector('.workshop')?.append(element);toastTimer=setTimeout(()=>element.remove(),1800);
  }
  function appearance(record){
    return [Number.isSafeInteger(record.lastAppearanceTurn)&&record.lastAppearanceTurn>0?`最后实际出场：第 ${record.lastAppearanceTurn} 个 AI 回合`:'',Number.isSafeInteger(record.absentTurns)&&record.absentTurns>=0?`缺席 ${record.absentTurns} 个 AI 回合`:''].filter(Boolean).join(' · ');
  }
  function list(){
    const records=value.records??[];
    return `<div class="wk-toolbar"><span>当前聊天 · ${TITLES[kind]}</span>${switchControl(`启用${TITLES[kind]}`,'toggle-enabled',value.enabled,value.writeBlocked)}</div><div class="wk-toolbar"><span class="lt-meta">${records.length} 条记录</span>${button('＋ 新建','new','','secondary')}</div>${records.length?`<div class="lt-stack">${records.map(record=>`<section class="lt-section wk-results"><div class="wk-result-meta"><h2 class="wk-result-title">${esc(record.name)}</h2><div>${record.pinned?'<span class="lt-meta">常驻</span>':''}${button('编辑','edit',`data-id="${esc(record.id)}"`)}</div></div>${FIELDS[kind].slice(1).filter(([key])=>record[key]).map(([key,label])=>`<p class="wk-result"><span class="lt-meta">${label}：</span>${esc(record[key])}</p>`).join('')}${record.aliases?.length?`<p class="wk-result"><span class="lt-meta">${kind==='npc'?'称呼／别名':'名称／简称'}：</span>${esc(record.aliases.join('、'))}</p>`:''}${kind==='npc'&&appearance(record)?`<p class="lt-meta">${esc(appearance(record))}</p>`:''}</section>`).join('')}</div>`:`<p class="wk-empty">暂无${kind==='item'?'物品':'NPC'}记录</p>`}`;
  }
  function editor(){
    const record=value.records?.find(row=>row.id===draft.id);
    return `<form id="tracking-form" class="wk-form"><section class="wk-form-section">${FIELDS[kind].map(([key,label,multiline])=>`<label class="ui-field"><span class="ui-field__label">${label}</span>${multiline?`<textarea class="lt-textarea" rows="2" name="${key}" maxlength="600">${esc(draft[key])}</textarea>`:`<input class="ui-input" type="text" name="${key}" value="${esc(draft[key])}" maxlength="${key==='name'?160:600}" ${key==='name'?'required':''}>`}</label>`).join('')}<label class="ui-field"><span class="ui-field__label">${kind==='npc'?'称呼／别名':'名称／简称'}</span><input class="ui-input" type="text" name="aliases" value="${esc(draft.aliases)}" maxlength="2000" placeholder="用逗号分隔"></label><div class="wk-toolbar"><span>常驻</span>${switchControl('常驻','toggle-pinned',draft.pinned)}</div>${kind==='npc'?`<div class="ui-field"><span class="ui-field__label">最后实际出场 AI 回合</span><output class="lt-meta" data-tracking-readonly="lastAppearanceTurn">${esc(record?.lastAppearanceTurn??'')}</output></div><div class="ui-field"><span class="ui-field__label">缺席 AI 回合</span><output class="lt-meta" data-tracking-readonly="absentTurns">${esc(record?.absentTurns??'')}</output></div>`:''}</section></form>`;
  }
  function render(){
    if(disposed)return;
    const focused=app.getRootNode().activeElement,focusKey=focused?.dataset?JSON.stringify({...focused.dataset}):null;
    const title=route==='list'?TITLES[kind]:(value.records?.some(row=>row.id===draft.id)?'编辑':'新建')+(kind==='item'?'物品':'NPC');
    app.innerHTML=`<section class="lantai workshop ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(app)}"><header class="lt-header ui-header ui-header--centered">${icon(route==='list'?'返回工坊':'返回追踪','back','back')}<h1 class="ui-page-title">${title}</h1>${icon('关闭兰台','close','close')}</header><main class="lt-main ui-main" tabindex="-1">${error||value.error?`<p class="lt-error" role="alert">${esc(error||value.error)}</p>${button('重新读取','reload')}`:''}${route==='list'?list():editor()}</main><footer class="lt-footer">${route==='editor'?`<div class="wk-editor-footer">${value.records?.some(row=>row.id===draft.id)?button('删除','delete-record','','danger'):''}${button('保存','save','','primary')}</div>`:''}</footer>${dialog?`<div class="wk-dialog" role="dialog" aria-modal="true" aria-label="确认操作"><div class="wk-dialog-box"><p>${esc(dialog.pending?'正在处理，请稍候…':dialog.text)}</p><div class="wk-dialog-actions">${button('取消','cancel-dialog',dialog.pending?'disabled':'')}${button(dialog.pending?'处理中…':'确认','confirm-dialog',dialog.pending?'disabled aria-busy="true"':'','primary')}</div></div></div>`:''}</section>`;
    if(dialog){for(const node of app.querySelectorAll('.lt-header,.lt-main,.lt-footer'))node.inert=true;app.querySelector('[data-action="cancel-dialog"]')?.focus({preventScroll:true});}
    else {
      const main=app.querySelector('.lt-main');if(main)main.scrollTop=scrolls[route]??0;
      if(focused&&focusKey){const next=[...app.querySelectorAll('[data-action]')].find(node=>JSON.stringify({...node.dataset})===focusKey);(next??main)?.focus?.({preventScroll:true});}
    }
  }
  function goList(){remember();route='list';draft=null;baseline=null;original=null;dialog=null;render();}
  function confirm(text,action){remember();readDraft();dialog={text,action,pending:false};render();}
  function leave(action){if(dirty())confirm('放弃未保存的修改？',action);else action();}
  function back(){leave(()=>route==='list'?onBack?.():goList());}
  function syncSwitch(control){
    for(const node of [...app.querySelectorAll('[data-action="toggle-enabled"]'),...(control?[control]:[])]){
      node.setAttribute('aria-checked',String(value.enabled));
      if(pendingToggles)node.setAttribute('aria-busy','true');else node.removeAttribute('aria-busy');
    }
  }
  async function changeEnabled(control){
    if(acting||dialog||value.writeBlocked)return;
    const version=++toggleVersion,enabled=!value.enabled;value={...value,enabled};pendingToggles++;syncSwitch(control);
    try{
      const next=await controller.savePreferences({enabled});if(disposed||version!==toggleVersion)return;
      apply(next);
    }catch(failure){if(disposed)return;error=failure.message||'保存未确认，请重新读取';value={...value,writeBlocked:true};remember();readDraft();render();}
    finally{pendingToggles--;if(!disposed)syncSwitch(control);}
  }
  async function save(){
    const form=app.querySelector('form');if(!form?.reportValidity())return;
    readDraft();const submitted=structuredClone(draft),payload={...submitted,aliases:aliases(submitted.aliases)};
    payload.name=payload.name.trim();if(!payload.name)throw new Error('请填写名称');
    const next=await controller.saveRecord(payload,{original});if(disposed)return;
    if(route!=='editor'||draft?.id!==submitted.id){apply(next);render();return;}
    readDraft();const newer=structuredClone(draft),changed=!same(newer,submitted);apply(next);
    if(changed){
      const saved=next.records?.find(row=>row.id===submitted.id);
      original=saved?structuredClone(saved):original;
      baseline=saved?initialDraft(saved):submitted;
      draft={...baseline,...Object.fromEntries(Object.entries(newer).filter(([key,text])=>!same(text,submitted[key])))};
      remember();render();toast('已保存提交内容；新修改尚未保存');
    }else {goList();toast('已保存');}
  }
  app.addEventListener('submit',event=>event.preventDefault(),{signal:lifetime.signal});
  app.addEventListener('click',async event=>{
    const control=event.target.closest('[data-action]');if(!control||control.disabled||disposed)return;
    const action=control.dataset.action;
    if(dialog&&!['cancel-dialog','confirm-dialog'].includes(action))return;
    if(action==='toggle-enabled')return changeEnabled(control);
    if(acting&&!['back','close','cancel-dialog','confirm-dialog'].includes(action))return;
    let ownsAction=false;
    try{
      if(action==='cancel-dialog'){if(!dialog?.pending){dialog=null;render();}return;}
      if(action==='confirm-dialog'){
        if(!dialog||dialog.pending)return;const pending=dialog;acting=ownsAction=true;pending.pending=true;render();
        await pending.action();if(disposed)return;if(dialog===pending)dialog=null;render();return;
      }
      if(action==='reload'){acting=ownsAction=true;remember();readDraft();apply(await controller.load({refresh:true}));if(!disposed)render();return;}
      if(action==='new'||action==='edit'){
        if(action==='new'&&value.writeBlocked)return;
        const record=action==='edit'?value.records?.find(row=>row.id===control.dataset.id):null;
        if(action==='edit'&&!record)throw new Error('追踪记录已变化，请重新读取');
        remember();original=record?structuredClone(record):null;draft=initialDraft(record);baseline=structuredClone(draft);scrolls.editor=0;route='editor';render();return;
      }
      if(action==='toggle-pinned'){readDraft();draft.pinned=!draft.pinned;control.setAttribute('aria-checked',String(draft.pinned));return;}
      if(action==='delete-record'){
        if(value.writeBlocked)return;const id=draft.id;
        confirm(`删除这条${kind==='item'?'物品':'NPC'}记录？`,async()=>{const next=await controller.deleteRecord(id);if(disposed)return;apply(next);goList();toast('已删除');});return;
      }
      if(action==='save'){if(value.writeBlocked)return;acting=ownsAction=true;await save();return;}
      if(action==='back')back();
      if(action==='close')leave(()=>onClose?.());
    }catch(failure){
      if(!disposed){remember();readDraft();dialog=null;error=failure.message||'操作未完成，请重试';value={...value,writeBlocked:controller.snapshot?.().writeBlocked??true};render();}
    }finally{if(ownsAction)acting=false;}
  },{signal:lifetime.signal});
  app.addEventListener('keydown',event=>{
    if(!dialog)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!dialog.pending){dialog=null;render();}return;}
    if(event.key==='Tab'){
      const buttons=[...app.querySelectorAll('.wk-dialog button')].filter(node=>!node.disabled);if(!buttons.length)return;
      event.preventDefault();const index=buttons.indexOf(app.getRootNode().activeElement);buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length].focus();
    }
  },{signal:lifetime.signal});
  const unsubscribe=controller.subscribe?.(next=>{
    if(disposed)return;
    // Background refreshes update the list, never replace an active draft or
    // the original used to compute its edited-field patch.
    value={...next,enabled:pendingToggles?value.enabled:next.enabled};
    if(route==='list'&&!acting&&!pendingToggles&&!dialog){remember();render();}
    else if(route==='editor'){
      const record=value.records?.find(row=>row.id===draft.id);
      for(const key of ['lastAppearanceTurn','absentTurns']){const node=app.querySelector(`[data-tracking-readonly="${key}"]`);if(node)node.textContent=String(record?.[key]??'');}
      for(const node of app.querySelectorAll('[data-action="save"],[data-action="delete-record"]'))node.disabled=value.writeBlocked;
    }
  });
  render();
  return {
    back(){if(dialog||acting)return;back();},
    blocking(){return acting||pendingToggles>0||dirty()||!!dialog;},
    invalidate(message){remember();readDraft();error=message;value={...value,writeBlocked:true};render();},
    suspend(){readDraft();app.inert=true;},
    resume(){app.inert=false;render();},
    dispose(){disposed=true;unsubscribe?.();lifetime.abort();clearTimeout(toastTimer);app.innerHTML='';},
  };
}
