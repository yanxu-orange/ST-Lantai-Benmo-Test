import { sameTarget } from '../domain/memory/repository.js';
import { filterMemories } from '../domain/memory/query.js';
import { buildTimeline } from '../domain/memory/timeline.js';
import { detailWordError } from '../domain/memory/model.js';
import { createMemorySession, splitWords } from './memory-session.js';
import { createManagementController } from './management-controller.js';
import { managementView,managementParticipantTags } from './management-view.js';
import { eventEditorSections } from './event-editor-sections.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name,label,action,disabled=false) => `<button type="button" class="ui-icon-button${['back','close','cancel-delete'].includes(action)?' ui-button--tertiary':''}" data-action="${action}" aria-label="${label}" ${disabled?'title="首片尚未实现"':''}><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const button = (label,action,disabled=false) => `<button type="button" class="ui-button ui-button--tertiary" data-action="${action}" ${disabled?'title="首片尚未实现"':''}>${label}</button>`;
export function mountMemoryApp(container, repository, { history: browserHistory = globalThis.history, window: browserWindow = globalThis.window, onClose = () => {}, managementService=null, managementController=null, originalAvailable=()=>false, getSettingsEpoch=null, getOriginalSnapshot=null, openSettings=()=>{},openSummary=()=>{},openSummarySettings=()=>{},regenerateBatch=()=>{} } = {}) {
  const session = createMemorySession(repository), state = session.state;
  const management=managementController??createManagementController({service:managementService,repository,originalAvailable,getSettingsEpoch,getOriginalSnapshot});
  let managementVisible=false,refreshingManagement=false,enteringManagement=false;
  let openTerm = null, rootView = 'list', rootScroll = { list: 0, timeline: 0 }, disposed = false, routeTicket=0, noticeTicket=0, savedTimer=null;
  let multi=false, selected=new Set(), confirmation=null;
  let queryScope=null, query='', filterMode='all', filterWords='all', searchOpen=false, filterOpen=false;
  const $ = selector => container.querySelector(selector);
  function resetSelection() { multi=false;selected.clear(); }
  function clearOperations() { if(confirmation)restoreConfirmation(confirmation);confirmation=null;$('#lt-operation-menu')?.remove(); }
  function pruneSelection() { const visible=new Set(visibleMemories().map(event=>event.id));for(const id of selected)if(!visible.has(id))selected.delete(id); }
  function resetQuery() { clearOperations();resetSelection(); query='';filterMode='all';filterWords='all';searchOpen=false;filterOpen=false; }
  function bindQueryScope() {
    try { const target=repository.captureTarget(), scope=JSON.stringify([target.chatId,target.rootId]);if(queryScope!==scope){resetQuery();rootScroll={list:0,timeline:0};queryScope=scope;} } catch { resetQuery();queryScope=null; }
  }
  const hasQuery=()=>!!query.trim();
  const hasFilters=()=>filterMode!=='all'||filterWords!=='all';
  const visibleMemories=()=>filterMemories(state.root?.events??[],{query,mode:filterMode,words:filterWords});
  function queryIcon(name,label,open,active) { return icon(name,label,name).replace('aria-label=',`aria-pressed="${open||active}" aria-expanded="${open}" aria-controls="lt-${name}-panel" aria-label=`); }
  function filterGroup(label,key,options,value) {
    return `<fieldset class="lt-filter-group"><legend class="ui-field__label">${label}</legend><div class="lt-filter-options">${options.map(([option,text])=>`<label class="ui-button ui-button--tertiary"><input type="radio" name="lt-${key}" data-filter="${key}" value="${option}" ${value===option?'checked':''}><span>${text}</span></label>`).join('')}</div></fieldset>`;
  }
  function queryPanels() {
    return `<div class="lt-entry" id="lt-search-panel" ${searchOpen?'':'hidden'}><input class="ui-input" type="search" data-query aria-label="搜索记忆" placeholder="搜索标题与正文" value="${escape(query)}">${button('收起','search')}</div><div class="lt-section" id="lt-filter-panel" ${filterOpen?'':'hidden'}>${filterGroup('召回方式','filterMode',[['all','全部'],['resident','常驻'],['trigger','触发']],filterMode)}${filterGroup('关键词','filterWords',[['all','全部'],['event','缺事件词'],['detail','缺细节词'],['none','无新词']],filterWords)}</div><p class="lt-meta" id="lt-query-state" role="status" ${hasQuery()||hasFilters()?'':'hidden'}>${visibleMemories().length} 条</p>`;
  }
  function collection() {
    const events=visibleMemories();
    return events.length?(rootView==='timeline'?timeline(events):events.map(card).join('')):`<p class="lt-meta">${state.root?.events.length?'没有符合条件的记忆':'尚无事件记忆'}</p>`;
  }
  function updateCollection() {
    if(confirmation||state.route!=='list'||!$('#lt-memory-list'))return;
    if(multi){pruneSelection();$('#lt-memory-list').innerHTML=collection();updateSelection();return;}
    const queryField=$('[data-query]');if(!queryField){render({focus:false});return;}if(queryField.value!==query)queryField.value=query;
    for(const field of container.querySelectorAll('[data-filter]'))field.checked=field.value===(field.dataset.filter==='filterMode'?filterMode:filterWords);
    $('#lt-memory-list').innerHTML=collection();
    $('#lt-query-state').hidden=!(hasQuery()||hasFilters());$('#lt-query-state').textContent=`${visibleMemories().length} 条`;
    for(const [name,open,active] of [['search',searchOpen,hasQuery()],['filter',filterOpen,hasFilters()]]) {
      $(`#lt-${name}-panel`).hidden=!open;
      const control=$(`.lt-list-icons [data-action=${name}]`);control.setAttribute('aria-pressed',String(open||active));control.setAttribute('aria-expanded',String(open));
    }
  }
  function clearSaved() {
    if(savedTimer!==null)clearTimeout(savedTimer);
    savedTimer=null;
    const notice=$('#lt-saved');if(notice){notice.textContent='';notice.hidden=true;}
  }
  function showSaved(message='已保存') {
    clearSaved();const notice=$('#lt-saved');if(!notice)return;
    notice.hidden=false;notice.textContent=message;
    savedTimer=setTimeout(clearSaved,2000);
  }
  function input(label,field,value,index='') { const id=`lt-${field}-${index}`; return `<label class="ui-field" for="${id}"><span class="ui-field__label">${label}</span><input class="ui-input" id="${id}" data-field="${field}" ${index!==''?`data-index="${index}"`:''} value="${escape(value)}" ${field.startsWith('source')?'inputmode="numeric"':''}></label>`; }
  function text(label,field,value,rows) { if(field==='body')return `<textarea class="lt-textarea" id="lt-body" data-field="body" rows="${rows}" required aria-label="正文">${escape(value)}</textarea>`; return `<div class="ui-field"><label class="ui-field__label" for="lt-${field}">${label}</label><input type="text" class="ui-input" id="lt-${field}" data-field="${field}" value="${escape(value)}"></div>`; }
  function tagSection(label,key) {
    return `<div class="lt-stack"><h3 class="ui-field__label">${label}</h3><div class="lt-tags" data-tags="${key}">${tags(key)}</div><div class="lt-entry"><input class="ui-input" data-entry="${key}" aria-label="添加${label}" placeholder="输入${label}"><button type="button" class="ui-button ui-button--tertiary" data-add="${key}" hidden>添加</button></div></div>`;
  }
  function tags(key) { return state.draft[key].map((word,index)=>`<span class="ui-tag">${escape(word)}<button type="button" class="ui-icon-button ui-button--tertiary" data-remove="${key}" data-index="${index}" aria-label="删除${escape(word)}"><img class="lt-icon" src="${new URL('./icons/close.svg',import.meta.url)}" alt=""></button></span>`).join(''); }
  function terms() {
    const ordered=[...state.draft.detailWords], active=ordered.findIndex(term=>term.id===openTerm);
    if(active%2===1)[ordered[active-1],ordered[active]]=[ordered[active],ordered[active-1]];
    return ordered.map(term=>`<div class="lt-term" data-open="${openTerm===term.id}" data-aliases="${term.aliases.length>0}"><div class="lt-term-head"><button type="button" class="ui-button ui-button--tertiary" data-term="${escape(term.id)}" aria-expanded="${openTerm===term.id}">${escape(term.word)}</button><button type="button" class="ui-icon-button ui-button--tertiary" data-delete-term="${escape(term.id)}" aria-label="删除${escape(term.word)}"><img class="lt-icon" src="${new URL('./icons/close.svg',import.meta.url)}" alt=""></button></div>${openTerm===term.id?`<div class="lt-term-fields"><label class="lt-term-field ui-field__label">细节词<input class="ui-input" data-term-word="${escape(term.id)}" value="${escape(term.word)}"></label><label class="lt-term-field ui-field__label">简称<input class="ui-input" data-term-alias="${escape(term.id)}" value="${escape(term.aliases.join('，'))}"></label><p class="lt-error" id="lt-alias-error" role="alert" hidden></p></div>`:''}</div>`).join('');
  }
  function fieldSection(label,html) { return `<details open class="lt-section"><summary>${label}</summary><div class="lt-stack">${html}</div></details>`; }
  function editor() {
    const draft=state.draft;
    return `<form class="lt-editor" id="lt-editor" novalidate>${eventEditorSections({modes:`<fieldset class="lt-modes" aria-label="召回方式"><legend class="ui-field__label">召回方式</legend>${[['resident','常驻'],['trigger','触发']].map(([value,label])=>`<label class="lt-mode"><input type="radio" name="mode" value="${value}" ${draft.mode===value?'checked':''}>${label}</label>`).join('')}</fieldset>`,title:text('标题','title',draft.title,2),body:text('正文','body',draft.body,7),times:`<div class="lt-range">${input('故事时间起点','startTime',draft.startTime)}<span>—</span>${input('故事时间终点','endTime',draft.endTime)}</div>`,sources:`<div id="lt-sources">${sourceRows()}</div>${button('增加区间','add-source')}`,participants:tagSection('人物','people')+tagSection('地点','places'),keywords:tagSection('事件词','eventWords')+`<h3 class="ui-field__label" id="lt-term-count">细节词与简称<span class="lt-meta"> · ${draft.detailWords.length}</span></h3><div class="lt-terms" id="lt-terms">${terms()}</div><div class="lt-entry"><input class="ui-input" data-entry="detailWords" aria-label="添加细节词" placeholder="输入细节词"><button class="ui-button ui-button--tertiary" type="button" data-add="detailWords" hidden>添加</button></div>`})}</form>`;
  }
  function sourceRows() { return (state.draft.sources.length?state.draft.sources:[{start:'',end:''}]).map((range,index)=>`<div class="lt-range ${state.draft.sources.length>1?'lt-source-range':''}">${input(`来源起点${index+1}`,'sourceStart',range.start,index)}<span>—</span>${input(`来源终点${index+1}`,'sourceEnd',range.end,index)}${state.draft.sources.length>1?`<button type="button" class="ui-icon-button ui-button--tertiary" data-action="remove-source" data-index="${index}" aria-label="删除区间${index+1}"><img class="lt-icon" src="${new URL('./icons/close.svg',import.meta.url)}" alt=""></button>`:''}</div>`).join(''); }
  function card(event) { const normal=`<button type="button" class="ui-row ui-row--interactive lt-row" data-edit="${escape(event.id)}" aria-label="编辑记忆：${escape(event.title||'无标题')}"><span class="lt-tags lt-event-meta"><span class="ui-tag">${event.mode==='resident'?'常驻':'触发'}</span><span class="lt-meta">${escape(event.sources.map(range=>`${range.start}—${range.end}楼`).join('、'))}</span></span><span class="lt-meta">${escape([event.startTime,event.endTime].filter(Boolean).join('—'))}</span>${event.title?`<span class="ui-row__title lt-title">${escape(event.title)}</span>`:''}<span class="ui-reading lt-copy">${escape(event.body)}</span><span class="lt-tags">${event.eventWords.map(word=>`<span class="ui-tag lt-tag--event">${escape(word)}</span>`).join('')}${event.detailWords.map(term=>`<span class="ui-tag lt-tag--detail">${escape(term.word)}</span>`).join('')}</span></button>`;if(!multi)return normal;const body=normal.slice(normal.indexOf('>')+1,-9);return `<label class="ui-row lt-row lt-selection-row" data-selected="${selected.has(event.id)}"><input type="checkbox" data-select="${escape(event.id)}" aria-label="选择记忆：${escape(event.title||'无标题')}" ${selected.has(event.id)?'checked':''} ${state.pending?'disabled':''}><span class="lt-selection-content">${body}</span></label>`; }
  function timeline(events) {
    return buildTimeline(events).map(year=>`<section class="lt-timeline-year"><h2 class="ui-section-title">${year.kind==='unlocated'?'时间未知':year.year===null?'未知':`${year.year}年`}</h2><div class="lt-timeline-track">${year.dates.map(date=>`<section class="lt-timeline-date">${date.label?`<h3 class="lt-meta">${escape(date.label)}</h3>`:''}<div class="lt-timeline-cards">${date.events.map(event=>`<div class="lt-timeline-entry">${card(event)}</div>`).join('')}</div></section>`).join('')}</div></section>`).join('');
  }
  function selectionList() { pruneSelection();return `<div class="lt-selection-heading"><strong id="lt-selection-count">已选 ${selected.size} 条</strong>${button('全选','select-all')}${button('清空','clear-selection')}${button('退出','exit-selection')}</div><p class="lt-meta" ${hasQuery()||hasFilters()?'':'hidden'}>${visibleMemories().length} 条</p><section id="lt-memory-list" class="lt-stack" aria-label="选择事件记忆">${collection()}</section>`; }
  function bulkFooter() { return `<div class="lt-bulk-actions">${[['bulk-resident','设常驻'],['bulk-trigger','设触发'],['bulk-merge','合并'],['bulk-menu','其他']].map(([action,label])=>`<button type="button" class="ui-button ui-button--tertiary" data-action="${action}" ${action==='bulk-menu'?'aria-expanded="false" aria-controls="lt-operation-menu"':''} ${action!=='bulk-menu'&&action.startsWith('bulk-')&&(state.pending||selected.size<(action==='bulk-merge'?2:1))?'disabled':''}>${label}</button>`).join('')}</div>`; }
  function updateSelection() { if(!multi||!$('#lt-selection-count'))return;$('#lt-selection-count').textContent=`已选 ${selected.size} 条`;for(const field of container.querySelectorAll('[data-select]')){field.checked=selected.has(field.dataset.select);field.disabled=state.pending||!!confirmation;field.closest('.lt-row').dataset.selected=String(field.checked);}for(const control of container.querySelectorAll('[data-action=bulk-resident],[data-action=bulk-trigger]'))control.disabled=state.pending||!!confirmation||!selected.size;const merge=$('[data-action=bulk-merge]');if(merge)merge.disabled=state.pending||!!confirmation||selected.size<2||[...selected].some(id=>state.root.events.find(event=>event.id===id)?.mergedFrom);for(const control of container.querySelectorAll('.lt-selection-heading button,[data-action=bulk-menu]'))control.disabled=state.pending||!!confirmation; }
  function list() {
    return `<nav class="lt-work-actions" aria-label="事件记忆操作">${button('手动总结','summary-manual')}${button('自动总结','summary-auto')}${button('总结设置','summary-settings')}${button('召回','unavailable',true)}</nav><div class="lt-controls"><div class="lt-view-switch" role="group" aria-label="记忆展示方式">${['list','timeline'].map(view=>`<button type="button" class="ui-button ui-button--tertiary" data-action="${view}" aria-pressed="${rootView===view}">${view==='list'?'列表':'时间线'}</button>`).join('')}</div><div class="lt-list-icons">${icon('add','新建记忆','new')}${queryIcon('search','搜索记忆',searchOpen,hasQuery())}${queryIcon('filter','筛选记忆',filterOpen,hasFilters())}${icon('multi','多选记忆','multi')}</div></div>${queryPanels()}<section id="lt-memory-list" class="lt-stack${rootView==='timeline'?' lt-timeline':''}" aria-label="事件记忆${rootView==='timeline'?'时间线':'列表'}">${collection()}</section>`;
  }
  function operationButton(action,label) { return `<button type="button" class="ui-button ui-button--tertiary" data-action="${action}" aria-expanded="false" aria-controls="lt-operation-menu" ${state.pending?'disabled':''}>${label}</button>`; }
  function toggleMenu(bulk=false) {
    const control=$(`[data-action=${bulk?'bulk-menu':'editor-menu'}]`),existing=$('#lt-operation-menu');
    if(existing){existing.remove();control.setAttribute('aria-expanded','false');return;}
    const deletable=bulk?selected.size>0:state.root?.events.some(event=>event.id===state.draft?.id);
    const menu=document.createElement('div');menu.id='lt-operation-menu';menu.className='lt-operation-menu';menu.setAttribute('aria-label',bulk?'多选操作':'记忆操作');
    if(deletable)menu.innerHTML=button('重建关键词与检索简称',bulk?'rebuild-selected':'rebuild-event')+(!bulk&&state.draft?.batch?button('重新生成所属批次','regenerate-batch'):'')+(!bulk&&state.draft?.mergedFrom?button('撤销合并','undo-merge'):'')+`<button type="button" class="ui-button ui-button--danger" data-action="${bulk?'delete-selected':'delete-event'}">${bulk?'删除所选':'删除这条记忆'}</button>`;
    $('.lt-footer').prepend(menu);control.setAttribute('aria-expanded','true');menu.querySelector('button')?.focus();
  }
  function restoreConfirmation(previous) {
    previous.node.remove();
    for(const [control,disabled] of previous.controls)if(control.isConnected)control.disabled=disabled;
    for(const [summary,tabindex] of previous.summaries)if(summary.isConnected){if(tabindex===null)summary.removeAttribute('tabindex');else summary.setAttribute('tabindex',tabindex);}
    for(const [element,hidden] of previous.footerChildren)if(element.isConnected)element.hidden=hidden;
  }
  function startDelete(bulk,undo=false) {
    if(state.pending||confirmation)return;
    const ids=bulk?[...selected]:[state.draft?.id];
    if(!ids.length||ids.some(id=>!state.root?.events.some(event=>event.id===id)))return;
    const target=repository.captureTarget();if(!sameTarget(target,state.target))throw new Error('聊天目标已变化，请返回列表重新进入');
    const focus=container.getRootNode().activeElement??document.activeElement;
    $('#lt-operation-menu')?.remove();for(const control of container.querySelectorAll('[aria-controls=lt-operation-menu]'))control.setAttribute('aria-expanded','false');
    const main=$('.lt-main'),footer=$('.lt-footer'),scroll=main.scrollTop;
    const controls=[...main.querySelectorAll('input,textarea,select,button'),...footer.querySelectorAll('input,textarea,select,button')].map(control=>[control,control.disabled]);
    const summaries=[...main.querySelectorAll('summary')].map(summary=>[summary,summary.getAttribute('tabindex')]);
    const footerChildren=[...footer.children].map(element=>[element,element.hidden]);
    const node=document.createElement('section'),name=state.root.events.find(event=>event.id===ids[0])?.title||'无标题';
    node.className='lt-delete-confirmation';node.setAttribute('role','group');node.setAttribute('aria-labelledby','lt-delete-question');
    node.innerHTML=`<p id="lt-delete-question">${undo?`恢复合并前的 ${state.draft.mergedFrom.length} 条记忆，并移除当前记忆？`:bulk?`删除选中的 ${ids.length} 条记忆？`:`删除「${escape(name)}」？`}</p><p class="lt-error" role="alert" id="lt-delete-error" hidden></p><div class="lt-editor-actions">${button('取消','cancel-delete')}<button type="button" class="ui-button ${undo?'ui-button--secondary':'ui-button--danger'}" data-action="confirm-delete">${undo?'撤销合并':'删除'}</button></div>`;
    confirmation={ids:Object.freeze(ids),target:structuredClone(target),bulk,undo,node,controls,summaries,footerChildren,focus,scroll};
    clearSaved();noticeTicket++;state.error='';$('#lt-error').hidden=true;
    for(const [control] of controls)control.disabled=true;for(const [summary] of summaries)summary.tabIndex=-1;for(const [element] of footerChildren)element.hidden=true;
    footer.append(node);main.scrollTop=scroll;$('[data-action=cancel-delete]')?.focus({preventScroll:true});
  }
  function cancelDelete() {
    if(!confirmation||state.pending)return;
    const previous=confirmation;if(previous.undo){if(!previous.unconfirmed)management.cancel();management.back();}restoreConfirmation(previous);confirmation=null;state.error='';$('.lt-main').scrollTop=previous.scroll;
    updateError();updatePendingControls();(previous.focus?.isConnected?previous.focus:$(`[data-action=${previous.bulk?'bulk-menu':'editor-menu'}]`))?.focus({preventScroll:true});
  }
  function updateDelete() {for(const control of container.querySelectorAll('[data-action=confirm-delete],[data-action=cancel-delete]'))control.disabled=state.pending||control.dataset.action==='confirm-delete'&&!!(confirmation?.unconfirmed||confirmation?.finished);const back=$('[data-action=back]');if(back)back.disabled=!!confirmation&&state.pending;}
  function updatePendingControls() {
    updateDelete();if(confirmation)return;if($('#lt-selection-count'))updateSelection();
    const save=$('[data-action=save]');if(save){save.disabled=state.pending;save.textContent=state.pending?'保存中…':'保存';}
    const menu=$('[data-action=editor-menu]');if(menu)menu.disabled=state.pending;
  }
  function managementContext() {
    return {rootView,rootScroll:{...rootScroll},multi,selected:[...selected],query,filterMode,filterWords,searchOpen,filterOpen,route:state.route,id:state.draft?.id??null,target:structuredClone(state.target),scroll:$('.lt-main')?.scrollTop??0,openTerm};
  }
  async function enterManagement(kind,ids) {
    if(state.pending||enteringManagement||container.querySelector('[data-composing=true]'))return;
    enteringManagement=true;try{
    if(state.route==='editor'){
      flush();const formal=state.root?.events.find(event=>event.id===state.draft?.id),draft=structuredClone(state.draft);
      draft.sources=draft.sources.filter(range=>!(range.start===''&&range.end===''));
      if(!formal||JSON.stringify(formal)!==JSON.stringify(draft)){state.error='请先保存当前编辑，再发起记忆管理。';updateError();return;}
    }
    const context=managementContext();if(!sameTarget(context.target,repository.captureTarget()))throw new Error('聊天目标已变化，请返回列表重新进入');clearOperations();await management.open(kind,ids,context);
    if(disposed||!sameTarget(context.target,state.target)||!sameTarget(context.target,repository.captureTarget())||!sameTarget(context.target,management.inspect()?.target))return;
    managementVisible=kind!=='undo';
    if(kind==='undo'){await management.start();await management.settled();if(!disposed){const task=management.inspect();if(task?.status==='awaiting-user')startDelete(false,true);else if(task?.outcome==='unconfirmed'){startDelete(false,true);confirmation.unconfirmed=true;state.error='保存结果待确认，可能已经写入。请重新读取实际结果。';updateError();$('[data-action=confirm-delete]').disabled=true;confirmation.node.insertAdjacentHTML('beforeend',button('重新读取','recover-undo'));}else{state.error=task?.error||'撤销来源已变化，请重新读取。';updateError();}}}
    else {render();if(kind==='keywords')await management.start();}
    }finally{enteringManagement=false;}
  }
  function renderManagement(focus=false) {
    const task=management.inspect();if(!task){managementVisible=false;render({focus});return;}
    const scroll=$('.lt-main')?.scrollTop??task.scroll??0,view=managementView(task);
    const active=container.getRootNode().activeElement??document.activeElement,field=active?.dataset?.managementField,entry=active?.dataset?.managementEntry,activeAction=active?.dataset?.action,wasInside=container.contains(active),selectionStart=active?.selectionStart,selectionEnd=active?.selectionEnd;
    const pending=[...container.querySelectorAll('[data-management-entry]')].map(element=>[element.dataset.managementEntry,element.value]);
    const groups=[...container.querySelectorAll('[data-management-group]')].map(element=>[element.dataset.managementGroup,element.open]);
    container.innerHTML=`<section class="lantai"><header class="lt-header">${icon('back','返回原工作面','mgmt-back')}<h1 class="ui-page-title">${view.title}</h1>${icon('close','关闭兰台本末','close')}</header><main class="lt-main" tabindex="-1">${view.content}</main><footer class="lt-footer">${view.actions}</footer></section>`;
    $('.lt-main').scrollTop=focus?task.scroll??0:scroll;
    for(const [key,open]of groups){const group=$(`[data-management-group="${key}"]`);if(group)group.open=open;}
    for(const [key,value]of pending){const element=$(`[data-management-entry="${key}"]`);if(element){element.value=value;$(`[data-management-add="${key}"]`).hidden=!value.trim();}}
    const restored=active?.dataset?.indexField?$(`[data-term-id="${active.dataset.termId}"][data-index-field="${active.dataset.indexField}"]`):active?.dataset?.indexEntry?$(`[data-index-result="${active.closest('[data-index-result]').dataset.indexResult}"] [data-index-entry="${active.dataset.indexEntry}"]`):field?$(`[data-management-field="${field}"]`):entry?$(`[data-management-entry="${entry}"]`):null;
    if(!focus&&restored){restored.focus({preventScroll:true});restored.setSelectionRange?.(selectionStart,selectionEnd);}
    else if(!focus&&wasInside){const control=activeAction?$(`[data-action="${activeAction}"]`):null;(control&&!control.disabled?control:$('.lt-main'))?.focus({preventScroll:true});}
    if(focus)($('.lt-main [data-management-field=title]')??$('.lt-main'))?.focus({preventScroll:true});
  }
  async function returnManagement({reload=false,message=''}={}) {
    const task=management.inspect();if(!message&&task?.status!=='committing'&&task?.outcome!=='unconfirmed')management.cancel();
    const context=management.back();managementVisible=false;
    if(reload){await session.load();if(disposed||state.route==='closed')return;}
    if(context&&sameTarget(context.target,state.target)){
      rootView=context.rootView;rootScroll=context.rootScroll;multi=context.multi;selected=new Set(context.selected);query=context.query;filterMode=context.filterMode;filterWords=context.filterWords;searchOpen=context.searchOpen;filterOpen=context.filterOpen;openTerm=context.openTerm;
      const formal=state.root?.events.find(event=>event.id===context.id&&!event.supersededBy);
      if(context.route==='editor'&&formal)session.edit(formal.id);else session.leave();
    }else session.leave();
    pruneSelection();browserHistory?.replaceState({view:rootView,lantai:state.draft?.id??'list'},'',state.route==='editor'?'#editor':'#memory');render({focus:false});
    if(context&&$('.lt-main'))$('.lt-main').scrollTop=context.route==='editor'?context.scroll:rootScroll[rootView];
    if(message)showSaved(message);($('.lt-main [data-action=editor-menu]')??$('.lt-main'))?.focus({preventScroll:true});
  }
  async function acceptManagementSuccess() {
    if(refreshingManagement||disposed||!managementVisible)return;refreshingManagement=true;
    try{await session.load();if(disposed||!managementVisible||state.route==='closed')return;if(state.error){renderManagement();return;}await returnManagement({message:'已完成'});}finally{refreshingManagement=false;}
  }
  const unsubscribeManagement=management.subscribe(()=>{
    if(disposed||!managementVisible||state.route==='closed')return;
    const task=management.inspect();if(task?.status==='succeeded')void acceptManagementSuccess();else renderManagement();
  });
  function addManagementWords(key) {
    const field=$(`[data-management-entry="${key}"]`);if(!field||field.dataset.composing==='true')return;
    const words=splitWords(field.value);if(!words.length)return;
    management.change(fields=>fields[key]=[...new Set([...fields[key],...words])]);field.value='';$(`[data-management-add="${key}"]`).hidden=true;$(`[data-management-tags="${key}"]`).innerHTML=managementParticipantTags(key,management.inspect().fields[key]);
  }
  function addIndexWords(field){
    if(!field||field.dataset.composing==='true')return;
    const index=Number(field.closest('[data-index-result]').dataset.indexResult),key=field.dataset.indexEntry,values=splitWords(field.value);if(!values.length)return;
    management.changeIndexes(items=>{const item=items[index];if(key==='event')item.eventWords=[...new Set([...item.eventWords,...values])];else for(const word of values)if(!item.detailWords.some(term=>term.word===word))item.detailWords.push({id:crypto.randomUUID(),word,aliases:[],aliasesText:''});item[`${key}Entry`]='';});
    renderManagement();
  }
  function render({ focus=true }={}) {
    if(disposed) return;
    if(managementVisible&&state.route!=='closed'){renderManagement(focus);return;}
    clearSaved();noticeTicket++;
    const editing=state.route==='editor', closed=state.route==='closed';const selecting=multi&&!editing;
    container.innerHTML=closed?'<button type="button" class="ui-button ui-button--secondary" data-action="open">打开兰台本末</button>':`<section class="lantai" aria-label="兰台本末"><header class="lt-header${selecting?' lt-header--selection':editing?'':' lt-header--root'}">${editing?icon('back',rootView==='timeline'?'返回时间线':'返回列表','back')+'<h1 class="ui-page-title">编辑记忆</h1>'+icon('close','关闭兰台本末','close'):selecting?'<h1 class="ui-page-title">选择事件记忆</h1>'+icon('close','关闭兰台本末','close'):`<div class="lt-root-top"><h1 class="ui-page-title">记忆</h1>${icon('close','关闭兰台本末','close')}</div><nav aria-label="记忆类型">${button('最新摘要','unavailable',true).replace('ui-button--tertiary','lt-type')}${button('古法总结','unavailable',true).replace('ui-button--tertiary','lt-type')}<button type="button" class="ui-button lt-type" aria-current="page">事件记忆</button></nav>`}</header><main class="lt-main${editing?'':' lt-main--root'}" tabindex="-1"><p class="lt-error" role="alert" id="lt-error" ${state.error?'':'hidden'}>${escape(state.error)}</p>${editing?editor():state.root?(selecting?selectionList():list()):'<p class="lt-meta">正在读取记忆</p>'}</main><p class="lt-saved lt-status" role="status" id="lt-saved" hidden></p><footer class="lt-footer"><p class="lt-status" role="status" id="lt-status"></p>${editing?`<div class="lt-editor-actions"><button type="button" class="ui-button ui-button--primary" data-action="save" ${state.pending?'disabled':''}>${state.pending?'保存中…':'保存'}</button>${operationButton('editor-menu','操作')}</div>`:selecting?bulkFooter():`<nav aria-label="一级分区"><a class="ui-nav-item" href="#memory" aria-current="page">记忆</a>${['时间','模块','设置'].map(label=>`<button type="button" class="ui-nav-item" data-action="${label==='设置'?'settings':'unavailable'}" ${label==='设置'?'':'title="首片尚未实现"'}>${label}</button>`).join('')}</nav>`}</footer></section>`;
    if(selecting)updateSelection();
    if(!editing&&!closed&&$('.lt-main')) $('.lt-main').scrollTop=rootScroll[rootView];
    if(focus) (editing?$('#lt-title'):closed?$('[data-action=open]'):$('.lt-main'))?.focus();
  }
  function renderTerms() { $('#lt-terms').innerHTML=terms();$('#lt-term-count').innerHTML=`细节词与简称<span class="lt-meta"> · ${state.draft.detailWords.length}</span>`; }
  function updateError() {
    if(confirmation){const box=$('#lt-delete-error');if(box){box.textContent=state.error;box.hidden=!state.error;}return;}
    for(const field of container.querySelectorAll('[aria-invalid]')){field.removeAttribute('aria-invalid');field.removeAttribute('aria-describedby');}
    const timeFailure=state.error.includes('故事时间');
    const termFailure=state.error.includes('简称')||state.error.includes('细节词');
    const term=termFailure?state.draft?.detailWords.find(term=>detailWordError(term,state.draft.detailWords)):null;
    if(term && openTerm!==term.id){openTerm=term.id;renderTerms();}
    const localFailure=!!term;
    const invalid=timeFailure?[...container.querySelectorAll('[data-field=startTime],[data-field=endTime]')]:state.error.includes('正文')?[...container.querySelectorAll('#lt-body')]:localFailure?[...container.querySelectorAll(state.error.includes('细节词重复')||state.error.includes('细节词不能为空')?'[data-term-word]':'[data-term-alias]')]:state.error.includes('来源楼层')?[...container.querySelectorAll('[data-field^=source]')]:[];
    for(const field of invalid){field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby',localFailure?'lt-alias-error':'lt-error');}
    const local=$('#lt-alias-error');if(local){local.textContent=localFailure?state.error:'';local.hidden=!localFailure;}
    const box=$('#lt-error');if(box){box.textContent=localFailure?'':state.error;box.hidden=localFailure||!state.error;}
    if(state.error){const group=timeFailure?$('[data-field=startTime]')?.closest('details'):localFailure?$('#lt-terms')?.closest('details'):state.error.includes('正文')?$('#lt-body')?.closest('details'):state.error.includes('来源楼层')?$('#lt-sources')?.closest('details'):null;if(group)group.open=true;if(timeFailure)$('[data-field=startTime]')?.focus();}
  }
  function addWords(key) {
    const field=$(`[data-entry="${key}"]`); if(!field||field.dataset.composing==='true') return;
    const words=splitWords(field.value); if(!words.length)return;clearSaved();noticeTicket++;
    session.change(draft=>{ if(key==='detailWords'){ for(const word of words) if(!draft.detailWords.some(term=>term.word===word))draft.detailWords.push({id:crypto.randomUUID(),word,aliases:[]}); }else draft[key]=[...new Set([...draft[key],...words])]; });
    field.value=''; $(`[data-add="${key}"]`).hidden=true;
    if(key==='detailWords')renderTerms();else $(`[data-tags="${key}"]`).innerHTML=tags(key);
  }
  function flush() { for(const field of container.querySelectorAll('[data-entry]'))addWords(field.dataset.entry); }
  async function route(id,push=false) {
    clearOperations();resetSelection();
    const ticket=++routeTicket;
    bindQueryScope();
    const loading=session.load();render({focus:false});await loading; if(ticket!==routeTicket||disposed)return;
    if(id&&state.root?.events.some(event=>event.id===id))session.edit(id);
    else if(id==='new'&&state.root)session.edit();
    if(push)browserHistory?.pushState({view:rootView,lantai:state.draft?.id??'list'},'',state.route==='editor'?'#editor':'#memory');
    render();
  }
  const click=async event=>{
    if(confirmation&&event.target.closest('.lt-main')){event.preventDefault();return;}
    const target=event.target.closest('button,a');if(!target||target.disabled)return;
    if(target.matches('a'))event.preventDefault();
    try {
      if(target.dataset.indexTerm){management.openTerm(management.inspect().openIndexTerm===target.dataset.indexTerm?null:target.dataset.indexTerm);renderManagement();return;}
      if(target.dataset.indexAdd){addIndexWords(target.closest('[data-index-result]').querySelector(`[data-index-entry="${target.dataset.indexAdd}"]`));return;}
      if(target.hasAttribute('data-index-remove-event')||target.dataset.indexDelete){const index=Number(target.closest('[data-index-result]').dataset.indexResult);management.changeIndexes(items=>{if(target.dataset.indexDelete)items[index].detailWords=items[index].detailWords.filter(term=>term.id!==target.dataset.indexDelete);else items[index].eventWords.splice(Number(target.dataset.indexRemoveEvent),1);});renderManagement();return;}
      if(target.dataset.managementAdd){addManagementWords(target.dataset.managementAdd);return;}
      if(target.dataset.managementRemove){management.change(fields=>fields[target.dataset.managementRemove].splice(Number(target.dataset.index),1));renderManagement();return;}
      if(target.dataset.action?.startsWith('mgmt-')){
        const action=target.dataset.action.slice(5);
        if(action==='back'){management.setScroll($('.lt-main').scrollTop);await returnManagement();}
        else if(action==='start'||action==='original'||action==='memories')await management.start(action==='start'?undefined:action);
        else if(action==='review'){if(container.querySelector('[data-composing=true]'))return;for(const field of container.querySelectorAll('[data-management-entry]'))addManagementWords(field.dataset.managementEntry);management.review();}
        else if(action==='confirm'){if(container.querySelector('[data-composing=true]'))return;for(const field of [...container.querySelectorAll('[data-index-entry]')])addIndexWords(field);await management.confirm();const invalid=$('[data-invalid=true]');if(invalid){invalid.scrollIntoView({block:'nearest'});(invalid.querySelector('input')??invalid).focus({preventScroll:true});}}
        else if(action==='cancel')management.cancel();
        else if(action==='retry')management.retry();
        else if(action==='recover'){const taskId=management.inspect()?.taskId,root=await management.recover();if(root&&managementVisible&&management.inspect()?.taskId===taskId&&!disposed){state.root=root;await returnManagement({message:'已读取实际结果'});}}
        else if(action==='settings'){openSettings();return;}
        if(managementVisible)renderManagement();return;
      }
      if(target.dataset.remove||target.dataset.deleteTerm||['remove-source','add-source'].includes(target.dataset.action)){clearSaved();noticeTicket++;}
      if(target.dataset.edit){rootScroll[rootView]=$('.lt-main').scrollTop;session.edit(target.dataset.edit);browserHistory?.pushState({view:rootView,lantai:target.dataset.edit},'','#editor');render();return;}
      if(target.dataset.add){addWords(target.dataset.add);return;}
      if(target.dataset.remove){session.change(draft=>draft[target.dataset.remove].splice(Number(target.dataset.index),1));$(`[data-tags="${target.dataset.remove}"]`).innerHTML=tags(target.dataset.remove);return;}
      if(target.dataset.term){openTerm=openTerm===target.dataset.term?null:target.dataset.term;renderTerms();return;}
      if(target.dataset.deleteTerm){session.change(draft=>draft.detailWords=draft.detailWords.filter(term=>term.id!==target.dataset.deleteTerm));renderTerms();return;}
      switch(target.dataset.action){
        case 'editor-menu':if(!state.pending)toggleMenu();break;
        case 'bulk-menu':if(!state.pending)toggleMenu(true);break;
        case 'settings':openSettings();break;
        case 'rebuild-event':await enterManagement('keywords',[state.draft.id]);break;
        case 'rebuild-selected':await enterManagement('keywords',[...selected]);break;
        case 'bulk-merge':await enterManagement('merge',[...selected]);break;
        case 'undo-merge':await enterManagement('undo',[state.draft.id]);break;
        case 'regenerate-batch':clearOperations();regenerateBatch(state.draft?.batch?.id);break;
        case 'summary-manual':openSummary('manual');break;
        case 'summary-auto':openSummary('auto');break;
        case 'summary-settings':openSummarySettings();break;
        case 'delete-event':startDelete(false);break;
        case 'delete-selected':startDelete(true);break;
        case 'cancel-delete':cancelDelete();break;
        case 'confirm-delete':{
          if(!confirmation||state.pending)break;
          if(confirmation.undo){
            const frozen=confirmation;state.pending=true;updateDelete();
            try{const result=await management.confirm();if(disposed||confirmation!==frozen)break;
              if(result?.status==='succeeded'){const previousView={route:state.route,draft:state.draft,root:state.root,target:state.target};await session.load();if(disposed||confirmation!==frozen)break;if(state.error){Object.assign(state,previousView);frozen.finished=true;state.error='撤销已提交，读取结果失败，请重新读取实际结果。';updateError();frozen.node.insertAdjacentHTML('beforeend',button('重新读取','recover-undo'));}else{confirmation=null;management.back();render({focus:false});showSaved('已撤销合并');}}
              else {state.error=result?.outcome==='unconfirmed'?'保存结果待确认，可能已经写入。请重新读取实际结果。':'撤销未完成，请检查来源后重试。';updateError();if(result?.outcome==='unconfirmed'){frozen.unconfirmed=true;frozen.node.insertAdjacentHTML('beforeend',button('重新读取','recover-undo'));}}
            }finally{state.pending=false;if(!disposed){updateDelete();if(confirmation?.unconfirmed)$('[data-action=confirm-delete]').disabled=true;}}break;
          }
          const frozen=confirmation,work=session.removeMany(frozen.ids,frozen.target);updateDelete();
          try {const result=await work;if(result.applied&&!disposed&&confirmation===frozen){confirmation=null;if(frozen.bulk){for(const id of frozen.ids)selected.delete(id);pruneSelection();}else session.leave();browserHistory?.replaceState({view:rootView,lantai:'list'},'','#memory');render({focus:false});showSaved('已删除');$('.lt-main')?.focus({preventScroll:true});}}
          catch {if(!disposed&&confirmation===frozen)updateError();}
          finally {if(!disposed)updatePendingControls();}break;
        }
        case 'recover-undo':{const frozen=confirmation,root=await management.recover();if(root&&!disposed&&confirmation===frozen){state.root=root;session.leave();confirmation=null;management.back();render();showSaved('已读取实际结果');}else{state.error='保存结果仍待确认，请恢复连接后重新读取。';updateError();}break;}

        case 'multi':rootScroll[rootView]=$('.lt-main').scrollTop;rootView='list';multi=true;selected.clear();searchOpen=false;filterOpen=false;browserHistory?.replaceState({view:rootView,lantai:'list'},'','#memory');render();break;
        case 'select-all':if(state.pending)break;selected=new Set(visibleMemories().map(event=>event.id));updateSelection();break;
        case 'clear-selection':if(state.pending)break;selected.clear();updateSelection();break;
        case 'exit-selection':if(state.pending)break;resetSelection();render();break;
        case 'bulk-resident':case 'bulk-trigger':{
          if(state.pending||!selected.size)break;rootScroll[rootView]=$('.lt-main').scrollTop;clearSaved();const notice=noticeTicket;const work=session.setModeMany([...selected],target.dataset.action==='bulk-resident'?'resident':'trigger');updateSelection();
          try{const result=await work;if(result.applied&&!disposed&&multi&&notice===noticeTicket){pruneSelection();render({focus:false});if(result.changed)showSaved();}}catch{if(!disposed)updateError();}finally{if(!disposed)updateSelection();}break;
        }
        case 'list': case 'timeline': rootScroll[rootView]=$('.lt-main').scrollTop;rootView=target.dataset.action;browserHistory?.replaceState({view:rootView,lantai:'list'},'','#memory');render();break;
        case 'search': searchOpen=!searchOpen;if(searchOpen){filterOpen=false;filterMode='all';filterWords='all';}updateCollection();(searchOpen?$('[data-query]'):$('.lt-list-icons [data-action=search]'))?.focus();break;
        case 'filter': filterOpen=!filterOpen;if(filterOpen){searchOpen=false;query='';}updateCollection();break;
        case 'new': rootScroll[rootView]=$('.lt-main').scrollTop;session.edit();openTerm=null;browserHistory?.pushState({view:rootView,lantai:'new'},'','#editor');render();break;
        case 'back': if(confirmation){cancelDelete();break;}session.leave();browserHistory?.pushState({view:rootView,lantai:'list'},'','#memory');await route(null);break;
        case 'close': if(managementVisible)management.setScroll($('.lt-main')?.scrollTop??0);managementVisible=false;resetQuery();session.close();browserHistory?.replaceState({view:rootView,lantai:'closed'},'','#closed');render();onClose();break;
        case 'open': await route(null);browserHistory?.replaceState({view:rootView,lantai:'list'},'','#memory');break;
        case 'remove-source':session.change(draft=>draft.sources.splice(Number(target.dataset.index),1));$('#lt-sources').innerHTML=sourceRows();updateError();break;
        case 'add-source':session.change(draft=>{if(!draft.sources.length)draft.sources.push({start:'',end:''});draft.sources.push({start:'',end:''});});$('#lt-sources').innerHTML=sourceRows();break;
        case 'save': {
          if([...container.querySelectorAll('[data-composing=true]')].length)return;
          clearSaved();flush();const saveNoticeTicket=noticeTicket;const saving=session.save();target.disabled=true;target.textContent='保存中…';
          try{const result=await saving;if(state.route==='list')render({focus:false});if(state.route==='editor'&&target.isConnected){if(result.draftApplied&&saveNoticeTicket===noticeTicket)showSaved();else $('#lt-status').textContent='有未保存修改';browserHistory?.replaceState({view:rootView,lantai:state.draft.id},'','#editor');}}catch{updateError();if(state.route==='editor'&&!state.error.includes('故事时间'))$(state.error.includes('简称')||state.error.includes('细节词')?'#lt-alias-error':'#lt-error')?.scrollIntoView({block:'nearest'});}
          finally{if(target.isConnected){target.disabled=false;target.textContent='保存';}}break;
        }
      }
    }catch(error){state.error=error.message;updateError();}
  };
  const inputEvent=event=>{
    if(confirmation)return;
    clearSaved();noticeTicket++;
    const field=event.target;
    if(managementVisible){
      if(field.dataset.indexField||field.dataset.indexEntry){const index=Number(field.closest('[data-index-result]').dataset.indexResult);management.changeIndexes(items=>{if(field.dataset.indexEntry)items[index][`${field.dataset.indexEntry}Entry`]=field.value;else{const term=items[index].detailWords.find(term=>term.id===field.dataset.termId);term[field.dataset.indexField]=field.value;}});if(field.dataset.indexEntry)field.parentElement.querySelector('button').hidden=!field.value.trim();return;}
      if(field.dataset.managementField)management.change(fields=>fields[field.dataset.managementField]=field.value);
      if(field.dataset.managementEntry)$(`[data-management-add="${field.dataset.managementEntry}"]`).hidden=!field.value.trim();
      return;
    }
    if(field.dataset.select){if(!multi||state.pending)return;field.checked?selected.add(field.dataset.select):selected.delete(field.dataset.select);updateSelection();return;}
    if(field.hasAttribute('data-query')){const changed=query!==field.value;query=field.value;if(changed&&!event.isComposing&&field.dataset.composing!=='true')updateCollection();return;}
    if(field.dataset.filter){if(!field.checked)return;if(field.dataset.filter==='filterMode')filterMode=field.value;else filterWords=field.value;updateCollection();return;}
    if(field.dataset.entry){$(`[data-add="${field.dataset.entry}"]`).hidden=!field.value.trim();return;}
    session.change(draft=>{
      if(field.name==='mode')draft.mode=field.value;
      else if(field.dataset.field?.startsWith('source')){const value=field.value.trim();if(!draft.sources[Number(field.dataset.index)])draft.sources[Number(field.dataset.index)]={start:'',end:''};draft.sources[Number(field.dataset.index)][field.dataset.field==='sourceStart'?'start':'end']=value===''?'':Number(value);}
      else if(field.dataset.field)draft[field.dataset.field]=field.value;
      else if(field.dataset.termWord){draft.detailWords.find(term=>term.id===field.dataset.termWord).word=field.value;}
      else if(field.dataset.termAlias){draft.detailWords.find(term=>term.id===field.dataset.termAlias).aliases=String(field.value).split(/[,，]/u).map(alias=>alias.trim()).filter(Boolean);}
    });if(field.dataset.termWord){const head=container.querySelector(`[data-term="${field.dataset.termWord}"]`);if(head)head.textContent=field.value;}updateError();if($('#lt-status'))$('#lt-status').textContent='';
  };
  const keydown=event=>{if(event.key==='Escape'){if(event.isComposing||event.target.dataset.composing==='true')return;if(managementVisible){event.preventDefault();event.stopPropagation();management.setScroll($('.lt-main')?.scrollTop??0);void returnManagement();return;}if(confirmation){event.preventDefault();event.stopPropagation();cancelDelete();return;}if($('#lt-operation-menu')){event.preventDefault();event.stopPropagation();const control=$('[aria-controls=lt-operation-menu][aria-expanded=true]');$('#lt-operation-menu').remove();control?.setAttribute('aria-expanded','false');control?.focus();return;}resetQuery();session.close();browserHistory?.replaceState({view:rootView,lantai:'closed'},'','#closed');render();onClose();}else if(event.key==='Enter'&&event.target.dataset.indexEntry&&!event.isComposing&&event.target.dataset.composing!=='true'){event.preventDefault();addIndexWords(event.target);}else if(event.key==='Enter'&&event.target.dataset.managementEntry&&!event.isComposing&&event.target.dataset.composing!=='true'){event.preventDefault();addManagementWords(event.target.dataset.managementEntry);}else if(event.key==='Enter'&&event.target.dataset.entry&&!event.isComposing&&event.target.dataset.composing!=='true'){event.preventDefault();addWords(event.target.dataset.entry);}};
  const blur=event=>{if(event.target.dataset.managementEntry&&event.relatedTarget?.closest('[data-management-add],[data-action=mgmt-review]')==null)addManagementWords(event.target.dataset.managementEntry);if(event.target.dataset.entry)addWords(event.target.dataset.entry);};
  const compositionStart=event=>{event.target.dataset.composing='true';};
  const compositionEnd=event=>{delete event.target.dataset.composing;if(event.target.hasAttribute('data-query')){query=event.target.value;updateCollection();}};
  const pop=event=>{if(managementVisible){management.setScroll($('.lt-main')?.scrollTop??0);void returnManagement();return;}if(state.route==='list'&&$('.lt-main'))rootScroll[rootView]=$('.lt-main').scrollTop;if(['list','timeline'].includes(event.state?.view))rootView=event.state.view;if(event.state?.lantai==='closed'){resetQuery();session.close();render();}else route(event.state?.lantai==='list'?null:event.state?.lantai);};
  container.addEventListener('click',click);container.addEventListener('input',inputEvent);container.addEventListener('change',inputEvent);container.addEventListener('keydown',keydown);container.addEventListener('focusout',blur);container.addEventListener('compositionstart',compositionStart);container.addEventListener('compositionend',compositionEnd);browserWindow?.addEventListener('popstate',pop);
  const submit=event=>event.preventDefault();container.addEventListener('submit',submit);
  browserHistory?.replaceState({view:rootView,lantai:'list'},'','#memory');
  const ready=route(null).then(()=>{if(!disposed&&management.resumeCurrent()){managementVisible=true;renderManagement(true);}});
  return { session,ready,management, isManagementTask(taskId){return managementVisible&&management.inspect()?.taskId===taskId;}, showManagementTask(taskId){if(disposed||state.pending||confirmation||container.querySelector('[data-composing=true]')||state.route==='editor')return false;const active=container.getRootNode().activeElement;if(active?.matches('input,textarea,select'))return false;if(managementVisible)return management.inspect()?.taskId===taskId;if(!management.resume(taskId))return false;managementVisible=true;renderManagement(true);return true;}, async rebind(){clearSaved();noticeTicket++;const previous=state.target;bindQueryScope();await session.rebind();if(!disposed){if(managementVisible){renderManagement();return;}if(confirmation&&!sameTarget(previous,state.target)){clearOperations();render();}else{updateError();updateCollection();}}}, async refresh(){managementVisible=false;management.back();openTerm=null;rootScroll={list:0,timeline:0};await route(null);browserHistory?.replaceState({view:rootView,lantai:'list'},'','#memory');}, dispose(){if(managementVisible)management.setScroll($('.lt-main')?.scrollTop??0);unsubscribeManagement();clearOperations();session.close();clearSaved();noticeTicket++;disposed=true;container.removeEventListener('submit',submit);container.replaceChildren();container.removeEventListener('click',click);container.removeEventListener('input',inputEvent);container.removeEventListener('change',inputEvent);container.removeEventListener('keydown',keydown);container.removeEventListener('focusout',blur);container.removeEventListener('compositionstart',compositionStart);container.removeEventListener('compositionend',compositionEnd);browserWindow?.removeEventListener('popstate',pop);} };
}

