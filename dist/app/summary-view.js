import {summaryPreviewSource,summaryPreviewPrompt,summaryPreviewStage,summaryPreviewTabs,summaryPreviewPanel} from './shared-ui/summary-preview.js';
import { surfaceTheme } from './styles/theme.js';
import { splitWords } from '../domain/memory/model.js';
import { eventEditorSections } from './event-editor-sections.js';
import {setLocationAliases,renameLocation,removeLocation} from '../domain/memory/location-aliases.js';
import {locationEditorRows,syncLocationEditor,updateLocationEditorRow,setLocationEditorError,focusLocationEditorError} from './location-alias-editor.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon=(name,label,action)=>`<button type="button" class="ui-icon-button ui-button--tertiary" data-summary-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const button=(text,action,disabled=false)=>`<button type="button" class="ui-button ui-button--tertiary" data-summary-action="${action}" ${disabled?'disabled':''}>${text}</button>`;
const choice=(key,label,value,graphic=false)=>`<label class="ui-choice ui-choice--control-only${graphic?' ui-hit-owner':''}"><input ${graphic?'class="ui-input" ':''}type="checkbox" data-summary-param="${key}" ${value?'checked':''}><span>${label}</span>${graphic?'<span class="ui-hit-area" aria-hidden="true"></span>':''}</label>`;
const optionChoices=(origin,params)=>{
  const graphic=origin==='manual';
  const content=choice('includeUser','包含用户消息',params.includeUser,graphic)+choice('reviewBeforeCommit','入库前检查',params.reviewBeforeCommit,graphic)+choice('hideOriginal','成功入库后隐藏来源楼层',params.hideOriginal,graphic);
  return graphic?`<div class="lt-summary-choices ui-choice-group" data-ui-interaction-profile="compact-group-candidate">${content}</div>`:content;
};
const number=(key,label,value)=>`<label class="ui-field"><span>${label}</span><input class="ui-input" type="number" min="0" step="1" inputmode="numeric" data-summary-param="${key}" value="${esc(value)}"></label>`;
const histories=new WeakMap();
const savedNotices=new WeakMap();
const previewDetails=new WeakMap();
const locationEditors=new WeakMap();
const progressText=summary=>summary?.progress?.lastProcessedFloor==null?'尚未总结':`第${summary.progress.lastProcessedFloor}楼`;
function preview(state) {
  const value=state.preview;if(!state.previewOpen||!value)return '';
  const tabs=summaryPreviewTabs([['source','上下文预览'],['prompt','提示词预览']],state.previewView,id=>`data-summary-preview-view="${id}"`);
  const content=state.previewView==='source'?value.source.sentFloors.map(item=>summaryPreviewSource(`第 ${item.floor} 楼 · ${item.role==='user'?'用户':'AI'}`,item.text)).join(''):value.stages.map(stage=>{
    const parts=stage.pending?'<p class="lt-meta">尚待生成</p>':stage.previewParts.map(part=>summaryPreviewPrompt(part)).join('');
    return value.stages.length===1?parts:summaryPreviewStage(stage.title,parts);
  }).join('');
  return summaryPreviewPanel(tabs,content);
}
function history(state) {
  return `<details class="lt-summary-history ui-disclosure" ${state.historyOpen?'open':''}><summary>总结记录与重新生成</summary>${(state.summary?.batches??[]).map(batch=>`<div class="lt-summary-history-row ui-disclosure-body"><span>${batch.actualRange.start}—${batch.actualRange.end} 楼</span>${batch.eventIds?.length&&!batch.eventIds.some(id=>state.formalIds?.includes(id))?'<span class="lt-meta">记忆已删除</span>':''}<button type="button" class="ui-button ui-button--tertiary" data-summary-regenerate="${esc(batch.id)}">重新生成</button></div>`).join('')||'<p class="lt-meta ui-disclosure-body">暂无总结记录</p>'}</details>`;
}
const reviewTags=(event,key)=>event[key].map((word,i)=>`<span class="ui-tag">${esc(word)}<button type="button" class="ui-icon-button ui-button--tertiary" data-summary-remove-word="${key}" data-word-index="${i}" aria-label="删除${esc(word)}"><img class="lt-icon" src="${new URL('./icons/close.svg',import.meta.url)}" alt=""></button></span>`).join('');
const reviewTermFields=term=>`<div class="lt-term-fields"><label class="lt-term-field ui-field__label">细节词<input class="ui-input" data-summary-term-field="word" value="${esc(term.word)}"></label><label class="lt-term-field ui-field__label">简称<input class="ui-input" data-summary-term-field="aliases" value="${esc(term.aliases.join('，'))}"></label></div>`;
const reviewTerm=(term,index,termIndex,open)=>`<div class="lt-term" data-summary-term="${termIndex}" data-open="${open}" data-aliases="${term.aliases.length>0}"><div class="lt-term-head"><button type="button" class="ui-button ui-button--tertiary" data-summary-open-term="${esc(term.id)}" aria-expanded="${open}">${esc(term.word)}</button>${icon('close',`删除${term.word}`,`term-remove:${index}:${termIndex}`)}</div>${open?reviewTermFields(term):''}</div>`;
function review(state,openLocations) {
  return (state.drafts??[]).map((event,index)=>{
    const field=(label,key)=>`<label class="ui-field"><span class="ui-field__label">${label}</span><input class="ui-input" data-summary-field="${key}" value="${esc(event[key])}"></label>`;
    const entry=(key,label)=>`<div class="lt-entry"><input class="ui-input" data-summary-entry="${key}" aria-label="添加${label}" placeholder="输入${label}"><button type="button" class="ui-button ui-button--tertiary" data-summary-add="${key}" hidden>添加</button></div>`;
    const tags=(label,key)=>`<div class="lt-stack"><h3 class="ui-field__label">${label}</h3><div class="lt-tags">${reviewTags(event,key)}</div>${entry(key,label)}</div>`;
    const locations=`<div class="lt-stack"><h3 class="ui-field__label">地点</h3><div class="lt-terms" data-location-list>${locationEditorRows(event,openLocations.get(event.id))}</div>${entry('places','地点')}</div>`;
    const terms=event.detailWords.map((term,termIndex)=>reviewTerm(term,index,termIndex,state.openTerms[index]===term.id)).join('');
    const fields=eventEditorSections({modes:`<fieldset class="lt-modes" aria-label="召回方式"><legend class="ui-field__label">召回方式</legend>${[['resident','常驻'],['trigger','触发']].map(([value,label])=>`<label class="lt-mode"><input type="radio" name="summary-mode-${index}" data-summary-field="mode" value="${value}" ${event.mode===value?'checked':''}>${label}</label>`).join('')}</fieldset>`,title:field('标题','title'),body:`<textarea class="lt-textarea" data-summary-field="body" rows="7" aria-label="正文">${esc(event.body)}</textarea>`,times:`<div class="lt-range">${field('故事时间起点','startTime')}<span>—</span>${field('故事时间终点','endTime')}</div>`,sources:event.sources.map(range=>`<div class="lt-range"><label class="ui-field"><span class="ui-field__label">来源起点</span><input class="ui-input" readonly value="${range.start}"></label><span>—</span><label class="ui-field"><span class="ui-field__label">来源终点</span><input class="ui-input" readonly value="${range.end}"></label></div>`).join(''),participants:tags('人物','people')+locations,keywords:tags('事件词','eventWords')+`<h3 class="ui-field__label">细节词与简称<span class="lt-meta"> · ${event.detailWords.length}</span></h3><div class="lt-terms" data-summary-terms>${terms}</div>${entry('detailWords','细节词')}`});
    return `<section class="lt-summary-candidate lt-editor" data-summary-event="${index}"><header><h2>记忆 ${index+1}</h2><button type="button" class="ui-button ui-button--danger" data-summary-remove="${index}">移除</button></header>${fields}</section>`;
  }).join('');
}
export function mountSummaryView({container,controller,onBack=()=>{},onClose=()=>{},openSettings=()=>{}}={}) {
  let disposed=false,composing=false,pending=false,renderedScope=null,renderedPreviewScope=null,renderedRoute=null,renderedDrafts=null,renderedOpenTerms='',savedUntil=0,savedTimer=null,stopIntent=false;
  const historyStates=histories.get(controller)??new Map();histories.set(controller,historyStates);
  const seenSaved=savedNotices.get(controller)??new Set();savedNotices.set(controller,seenSaved);
  const previewStates=previewDetails.get(controller)??new Map();previewDetails.set(controller,previewStates);
  const openLocations=locationEditors.get(controller)??new Map();locationEditors.set(controller,openLocations);
  const $=selector=>container.querySelector(selector);
  function footer(state){
    const auto=state.automatic,isReview=state.route==='review',running=['starting','running','committing','narrative-running','narrative-failed'].includes(state.task?.status)||auto.status==='running',awaiting=state.task?.status==='awaiting-user';
    const canStop=state.origin==='auto'&&['running','waiting','awaiting-user'].includes(auto.status);
    if(stopIntent&&canStop&&!auto.stopRequested)return `<div class="lt-editor-actions">${button('取消','cancel-stop')}<button type="button" class="ui-button ui-button--secondary" data-summary-action="confirm-stop">确认停止</button></div>`;
    stopIntent=false;
    const stop=canStop?button(auto.stopRequested?'已请求停止，等待本批完成':'本批次完成后停止总结','stop',auto.stopRequested):'';
    if(state.task?.status==='narrative-failed')return `${button('重试自述与大纲','retryNarrative',state.busy)}${button('跳过本批并继续','skipNarrative',state.busy)}`;
    if(isReview)return `${state.task?.candidate?.incomplete?button('重试后续阶段','retry',state.busy):''}${stop}<button type="button" class="ui-button ui-button--primary" data-summary-action="confirm" ${state.busy||state.task?.outcome==='unconfirmed'?'disabled':''}>${state.busy?'保存中…':'统一保存'}</button>`;
    if(canStop)return stop;
    if(awaiting&&state.task?.snapshot.params.reviewBeforeCommit)return button('检查总结结果','review');
    return `<button type="button" class="ui-button ui-button--primary" data-summary-action="start" ${state.busy||running||state.parametersUnconfirmed?'disabled':''}>${running?(state.task?.status==='narrative-running'?'正在生成自述与大纲…':'正在生成…'):auto.status==='stopped'?'继续总结':auto.status==='failed'||state.task?.status==='failed'?'重试本批':state.origin==='auto'?'开始自动总结':'开始总结'}</button>`;
  }
  function renderFooter(focus){const node=$('.lt-footer');if(!node)return;node.innerHTML=footer(controller.inspect());if(focus)$(`[data-summary-action="${focus}"]`)?.focus({preventScroll:true});}
  function updateReviewChrome(state){
    const error=$('.lt-main>.lt-error'),status=$('.lt-main>.lt-status');
    if(error){error.textContent=state.error??'';error.hidden=!state.error;}
    if(status){status.textContent=state.message==='已保存本批记忆'?'':state.message??'';status.hidden=!status.textContent;}
    const read=$('.lt-main>[data-summary-action="read"]'),needsRead=state.task?.outcome==='unconfirmed'||state.parametersUnconfirmed||state.parameterReadRequired;
    if(needsRead&&!read)$('.lt-main')?.insertAdjacentHTML('beforeend',button('重新读取','read'));
    if(!needsRead)read?.remove();
    syncReviewBusy(state);
    renderFooter();
  }
  function syncReviewBusy(state){for(const node of container.querySelectorAll('[data-summary-event] input,[data-summary-event] textarea,[data-summary-event] button'))node.disabled=state.busy;}
  const reviewSection=index=>$(`[data-summary-event="${index}"]`);
  function editInPlace(anchor,update){
    const main=$('.lt-main'),before=anchor?.getBoundingClientRect?.().top;
    update();
    if(main&&anchor?.isConnected&&Number.isFinite(before)){
      const after=anchor.getBoundingClientRect().top;
      if(Number.isFinite(after))main.scrollTop+=after-before;
    }
    const error=$('.lt-main>.lt-error');if(error){error.textContent='';error.hidden=true;}
  }
  function updateReviewTags(index,key){
    const section=reviewSection(index),input=section?.querySelector(`[data-summary-entry="${key}"]`),tags=input?.closest('.lt-stack')?.querySelector('.lt-tags');
    if(tags)tags.innerHTML=reviewTags(controller.inspect().drafts[index],key);
  }
  function updateTermCount(section){const terms=section?.querySelector('[data-summary-terms]'),count=terms?.previousElementSibling?.querySelector('.lt-meta');if(count)count.textContent=` · ${controller.inspect().drafts[Number(section.dataset.summaryEvent)].detailWords.length}`;}
  function toggleReviewTerm(index,id,anchor){
    if(composing)return;
    const section=reviewSection(index),before=anchor?.getBoundingClientRect?.().top;
    controller.openTerm(index,id,{notify:false});
    const state=controller.inspect(),open=state.openTerms[index];
    renderedOpenTerms=JSON.stringify(state.openTerms);
    for(const node of section.querySelectorAll('[data-summary-terms] [data-summary-term]')){
      const term=state.drafts[index].detailWords[Number(node.dataset.summaryTerm)],expanded=term?.id===open,fields=node.querySelector('.lt-term-fields');
      if(expanded&&!fields)node.insertAdjacentHTML('beforeend',reviewTermFields(term));
      if(!expanded)fields?.remove();
      node.dataset.open=String(expanded);node.querySelector('[data-summary-open-term]')?.setAttribute('aria-expanded',String(expanded));
    }
    const main=$('.lt-main');if(main&&anchor?.isConnected&&Number.isFinite(before))main.scrollTop+=anchor.getBoundingClientRect().top-before;
    anchor?.focus({preventScroll:true});
  }
  function addReviewEntry(index,key,input){
    if(controller.inspect().busy||input.dataset.composing==='true'||composing)return;
    const values=splitWords(input.value);if(!values.length)return;
    const section=reviewSection(index),beforeCount=controller.inspect().drafts[index].detailWords.length;
    controller.changeDrafts(items=>{const event=items[index];if(key==='detailWords'){for(const word of values)if(!event.detailWords.some(term=>term.word===word))event.detailWords.push({id:crypto.randomUUID(),word,aliases:[]});}else event[key]=[...new Set([...event[key],...values])];});
    controller.setEntry(index,key,'');
    editInPlace(input,()=>{
      input.value='';input.parentElement.querySelector('button').hidden=true;
      if(key==='detailWords'){
       const terms=section.querySelector('[data-summary-terms]'),draft=controller.inspect().drafts[index];
        for(let i=beforeCount;i<draft.detailWords.length;i++)terms.insertAdjacentHTML('beforeend',reviewTerm(draft.detailWords[i],index,i,false));
        updateTermCount(section);
      }else if(key==='places'){const draft=controller.inspect().drafts[index];syncLocationEditor(section.querySelector('[data-location-list]'),draft,openLocations.get(draft.id));}else updateReviewTags(index,key);
    });
    input.focus({preventScroll:true});
  }
  function editReviewLocation(index,target,remove=false){
    if(controller.inspect().busy||composing||!remove&&focusLocationEditorError(reviewSection(index)))return;
    const draft=controller.inspect().drafts[index],list=reviewSection(index).querySelector('[data-location-list]'),locationIndex=Number(target.closest('[data-location-row]').dataset.locationRow);
    let open=openLocations.get(draft.id);
    if(remove){controller.changeDrafts(items=>removeLocation(items[index],locationIndex));if(open===locationIndex)open=null;else if(open>locationIndex)open--;}
    else open=open===locationIndex?null:locationIndex;
    openLocations.set(draft.id,open);
    editInPlace(remove?list:target,()=>{if(remove)target.closest('[data-location-row]').remove();syncLocationEditor(list,draft,open);});
    (remove?list.querySelector('[data-location-toggle]')??reviewSection(index).querySelector('[data-summary-entry="places"]'):target)?.focus({preventScroll:true});
  }
  function removeReviewTerm(index,termIndex,node){
    if(controller.inspect().busy||composing)return;
    const section=reviewSection(index),terms=section.querySelector('[data-summary-terms]'),draft=controller.inspect().drafts[index],id=draft.detailWords[termIndex]?.id;
    if(id===controller.inspect().openTerms[index]){controller.openTerm(index,id,{notify:false});renderedOpenTerms=JSON.stringify(controller.inspect().openTerms);}
    controller.changeDrafts(items=>items[index].detailWords.splice(termIndex,1));
    editInPlace(terms,()=>{
      node.remove();
      for(const [i,term] of [...terms.querySelectorAll('[data-summary-term]')].entries()){
        term.dataset.summaryTerm=String(i);
        term.querySelector('[data-summary-action^="term-remove:"]')?.setAttribute('data-summary-action',`term-remove:${index}:${i}`);
      }
      updateTermCount(section);
    });
    terms.querySelector('[data-summary-open-term]')?.focus({preventScroll:true});
  }
  function removeReviewEvent(index,section){
    if(controller.inspect().busy||composing)return;
    const anchor=section.nextElementSibling??section.previousElementSibling??$('.lt-main');
    const removedId=controller.inspect().drafts[index]?.id;
    const removed=controller.removeDraft?.(index);
    if(removed===false)return;
    openLocations.delete(removedId);
    if(removed===undefined)controller.changeDrafts(items=>items.splice(index,1));
    renderedOpenTerms=JSON.stringify(controller.inspect().openTerms);
    editInPlace(anchor,()=>{
      section.remove();
      for(const [i,event] of [...container.querySelectorAll('[data-summary-event]')].entries()){
        event.dataset.summaryEvent=String(i);event.querySelector('header h2').textContent=`记忆 ${i+1}`;
        event.querySelector('[data-summary-remove]')?.setAttribute('data-summary-remove',String(i));
        for(const radio of event.querySelectorAll('[data-summary-field="mode"]'))radio.name=`summary-mode-${i}`;
        for(const [termIndex,term] of [...event.querySelectorAll('[data-summary-term]')].entries())term.querySelector('[data-summary-action^="term-remove:"]')?.setAttribute('data-summary-action',`term-remove:${i}:${termIndex}`);
      }
    });
  }
  function rememberPreview(){const details=[...container.querySelectorAll('.lt-summary-preview details')];if(renderedPreviewScope&&details.length)previewStates.set(renderedPreviewScope,details.map(detail=>detail.open));}
  function render() {
    if(disposed)return;if(composing){pending=true;return;}
    const current=controller.inspect();
    if(current.route==='review'&&renderedRoute==='review'&&current.drafts===renderedDrafts&&JSON.stringify(current.openTerms)===renderedOpenTerms&&$('.lt-summary-candidate')){updateReviewChrome(current);return;}
    const state={...current},root=container.getRootNode(),active=root.activeElement,inside=container.contains(active),scroll=$('.lt-main')?.scrollTop??state.scroll;
    rememberPreview();
    const scope=JSON.stringify([state.target?.rootId,state.target?.epoch,state.origin]);
    if(scope===renderedScope&&$('.lt-summary-history'))historyStates.set(scope,$('.lt-summary-history').open);
    state.historyOpen=historyStates.get(scope)??false;renderedScope=scope;
    renderedPreviewScope=JSON.stringify([scope,state.previewView,state.preview?.source?.fingerprint,state.preview?.stages?.map(stage=>stage.stage)]);
    if(state.task?.status==='succeeded'&&state.task.snapshot.params.reviewBeforeCommit&&!seenSaved.has(state.task.taskId)){
      seenSaved.add(state.task.taskId);savedUntil=Date.now()+2000;clearTimeout(savedTimer);savedTimer=setTimeout(()=>{savedUntil=0;$('.lt-saved')?.setAttribute('hidden','');},2000);
    }
    const statusMessage=state.message==='已保存本批记忆'?'':state.message;
    const eventIndex=active?.closest('[data-summary-event]')?.dataset.summaryEvent,term=active?.closest('[data-summary-term]')?.dataset.summaryTerm,field=active?.dataset.summaryField,termField=active?.dataset.summaryTermField,location=active?.closest('[data-location-row]')?.dataset.locationRow,locationField=active?.dataset.locationField,locationToggle=active?.dataset.locationToggle,param=active?.dataset.summaryParam,action=active?.dataset.summaryAction,entry=active?.dataset.summaryEntry,add=active?.dataset.summaryAdd,openTerm=active?.dataset.summaryOpenTerm,removeWord=active?.dataset.summaryRemoveWord,start=active?.selectionStart,end=active?.selectionEnd;
    const entries=Object.entries(state.entries??{}).map(([identity,value])=>{const [id,key]=identity.split(':');return {index:state.drafts?.findIndex(event=>event.id===id),key,value};});
    const details=[...container.querySelectorAll('[data-summary-event] details')].map(element=>({index:element.closest('[data-summary-event]').dataset.summaryEvent,label:element.querySelector(':scope>summary').textContent,open:element.open}));
    const isReview=state.route==='review',title=isReview?'检查总结结果':state.origin==='auto'?'自动总结':'手动总结',params=state.params??{},auto=state.automatic;
    const running=['starting','running','committing','narrative-running','narrative-failed'].includes(state.task?.status)||auto.status==='running',awaiting=state.task?.status==='awaiting-user';
    const body=isReview?review(state,openLocations):`<section class="lt-summary-section ui-section"><h2>${state.origin==='auto'?'总结范围':'楼层范围'}</h2>${state.origin==='auto'?(['paper-letter','purple-glow'].includes(surfaceTheme(container))?`<div class="lt-summary-auto-range">${number('batchSize','每隔多少楼总结',params.batchSize)}${number('recentFloors','最近多少楼不参与总结',params.recentFloors)}</div>`:number('batchSize','每隔多少楼总结',params.batchSize)+number('recentFloors','最近多少楼不参与总结',params.recentFloors)):`<div class="lt-summary-range ui-field-grid">${number('startFloor','开始楼',params.startFloor)}${number('endFloor','结束楼',params.endFloor)}</div>`}</section><section class="lt-summary-section ui-section"><h2>生成选项</h2>${optionChoices(state.origin,params)}</section>${history(state)}<div class="lt-summary-connection" data-preview-open="${state.previewOpen}"><div class="lt-summary-access ui-status-grid"><div class="ui-status-cell" data-selected="${state.previewOpen}"><span>发送内容</span>${button(state.previewOpen?'收起':'预览','preview',state.busy)}</div><div class="ui-status-cell"><span>总结进度</span><span class="ui-progress-text">${progressText(state.summary)}</span></div><div class="ui-status-cell"><span>总结设置</span>${button('打开','settings',state.busy)}</div></div>${preview(state)}</div>`;
    const actionMarkup=footer(state);
    container.innerHTML=`<section class="lantai lt-summary-workspace ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ui-header--centered">${icon('back',isReview?'放弃本批审核':'返回事件记忆','back')}<h1 class="ui-page-title">${title}</h1>${icon('close','关闭兰台本末','close')}</header><main class="lt-main lt-summary-main ui-main ui-main--summary" tabindex="-1"><p class="lt-error" role="alert" ${state.error?'':'hidden'}>${esc(state.error)}</p><p class="lt-status" role="status" ${statusMessage?'':'hidden'}>${esc(statusMessage)}</p>${body}${state.summary?.pending&&!state.taskId?button('放弃保留草稿','discard-pending',state.busy):''}${state.task?.outcome==='unconfirmed'||state.parametersUnconfirmed||state.parameterReadRequired?button('重新读取','read'):''}</main><p class="lt-saved lt-status" role="status" ${savedUntil>Date.now()?'':'hidden'}>本批总结已保存</p><footer class="lt-footer ui-action-footer">${actionMarkup}</footer></section>`;
    renderedRoute=state.route;renderedDrafts=state.drafts;renderedOpenTerms=JSON.stringify(state.openTerms);
    if(isReview)syncReviewBusy(state);
    $('.lt-main').scrollTop=scroll;
    for(const saved of entries){const input=$(`[data-summary-event="${saved.index}"] [data-summary-entry="${saved.key}"]`);if(input){input.value=saved.value;input.parentElement.querySelector('button').hidden=!saved.value.trim();}}
    for(const saved of details){const group=[...container.querySelectorAll(`[data-summary-event="${saved.index}"] details`)].find(element=>element.querySelector(':scope>summary').textContent===saved.label);if(group)group.open=saved.open;}
    const previewOpened=previewStates.get(renderedPreviewScope);if(previewOpened)[...container.querySelectorAll('.lt-summary-preview details')].forEach((detail,index)=>detail.open=previewOpened[index]===true);
    if(running||awaiting||state.busy)for(const input of container.querySelectorAll('[data-summary-param],[data-summary-regenerate]'))input.disabled=true;
    const prefix=eventIndex!==undefined?`[data-summary-event="${eventIndex}"] `:'';
    const restored=field?$(`${prefix}[data-summary-field="${field}"]${field==='mode'?`[value="${active.value}"]`:''}`):termField?$(`${prefix}[data-summary-term="${term}"] [data-summary-term-field="${termField}"]`):locationField?$(`${prefix}[data-location-row="${location}"] [data-location-field="${locationField}"]`):locationToggle!==undefined?$(`${prefix}[data-location-toggle="${locationToggle}"]`):param?$(`[data-summary-param="${param}"]`):entry?$(`${prefix}[data-summary-entry="${entry}"]`):add?$(`${prefix}[data-summary-add="${add}"]`):openTerm?$(`${prefix}[data-summary-open-term="${openTerm}"]`):removeWord?$(`${prefix}[data-summary-remove-word="${removeWord}"]`):action?$(`[data-summary-action="${action}"]`):active?.matches('.lt-summary-history>summary')?$('.lt-summary-history>summary'):null;
    if(inside){(restored&&!restored.disabled?restored:$('.lt-main'))?.focus({preventScroll:true});if(restored&&typeof start==='number')restored.setSelectionRange?.(start,end);}
  }
  function input(event) {
    if(composing||event.isComposing)return;
    const target=event.target,key=target.dataset.summaryParam;
    if(key){controller.changeParams(params=>params[key]=target.type==='checkbox'?target.checked:(target.value===''?NaN:Number(target.value)),{defer:event.type==='input'&&target.type!=='checkbox'});return;}
    const entry=target.dataset.summaryEntry;if(entry){controller.setEntry(target.closest('[data-summary-event]').dataset.summaryEvent,entry,target.value);const add=target.parentElement.querySelector('button');add.hidden=!target.value.trim();return;}
    const index=Number(target.closest('[data-summary-event]')?.dataset.summaryEvent),field=target.dataset.summaryField,termField=target.dataset.summaryTermField;
    if(target.dataset.locationField){
      const node=target.closest('[data-location-row]'),locationIndex=Number(node.dataset.locationRow);
      try{controller.changeDrafts(items=>{const draft=items[index];if(target.dataset.locationField==='name')renameLocation(draft,locationIndex,target.value);else setLocationAliases(draft,draft.places[locationIndex],splitWords(target.value));});setLocationEditorError(target);updateLocationEditorRow(node,controller.inspect().drafts[index],locationIndex);}
      catch(error){setLocationEditorError(target,error.message);}
      return;
    }
    if(field)controller.changeDrafts(items=>items[index][field]=['people','places','eventWords'].includes(field)?splitWords(target.value):target.value);
    if(termField){const termIndex=Number(target.closest('[data-summary-term]').dataset.summaryTerm);controller.changeDrafts(items=>items[index].detailWords[termIndex][termField]=termField==='aliases'?splitWords(target.value):target.value);}
  }
  async function click(event) {
    const target=event.target.closest('button');if(!target||target.disabled)return;
    if(target.dataset.summaryRegenerate){await controller.regenerate(target.dataset.summaryRegenerate);return;}
    if(target.dataset.summaryRemove!==undefined){removeReviewEvent(Number(target.dataset.summaryRemove),target.closest('[data-summary-event]'));return;}
    const eventIndex=Number(target.closest('[data-summary-event]')?.dataset.summaryEvent);
    if(target.hasAttribute('data-location-toggle')){editReviewLocation(eventIndex,target);return;}
    if(target.hasAttribute('data-location-remove')){editReviewLocation(eventIndex,target,true);return;}
    if(target.dataset.summaryOpenTerm){toggleReviewTerm(eventIndex,target.dataset.summaryOpenTerm,target);return;}
    if(target.dataset.summaryRemoveWord){const key=target.dataset.summaryRemoveWord,entry=reviewSection(eventIndex)?.querySelector(`[data-summary-entry="${key}"]`);controller.changeDrafts(items=>items[eventIndex][key].splice(Number(target.dataset.wordIndex),1));editInPlace(entry,()=>updateReviewTags(eventIndex,key));return;}
    if(target.dataset.summaryAdd){addReviewEntry(eventIndex,target.dataset.summaryAdd,target.parentElement.querySelector('input'));return;}
    if(target.dataset.summaryPreviewView){controller.previewView(target.dataset.summaryPreviewView);return;}
    const action=target.dataset.summaryAction;if(!action)return;
    if(action==='stop'){stopIntent=true;renderFooter('cancel-stop');return;}
    if(action==='cancel-stop'){stopIntent=false;renderFooter('stop');return;}
    if(action==='confirm-stop'){stopIntent=false;controller.stop();renderFooter();return;}
    if(action.startsWith('term-')){const [kind,index,termIndex]=action.split(':');if(kind==='term-remove')removeReviewTerm(Number(index),Number(termIndex),target.closest('[data-summary-term]'));return;}
    if(action==='back'){if(await controller.back())onBack();}
    if(action==='close')onClose();if(action==='settings')openSettings();if(action==='start')await controller.start();if(action==='retry')await controller.retry();if(action==='retryNarrative')await controller.retryNarrative();if(action==='skipNarrative')await controller.skipNarrative();if(action==='discard-pending')await controller.discardPending();if(action==='confirm'){if(composing||focusLocationEditorError(container))return;await controller.confirm();}if(action==='read')await controller.read();
    if(action==='preview'){if(controller.inspect().preview)controller.togglePreview();else await controller.preview();}
    if(action==='review')controller.showTask(controller.inspect().taskId);
  }
  const startComposition=()=>{composing=true;},endComposition=event=>{composing=false;input({target:event.target,type:'input',isComposing:false});if(pending){pending=false;render();}};
  const keydown=event=>{if(event.key==='Enter'&&event.target.dataset.summaryEntry&&!composing&&!event.isComposing){event.preventDefault();event.target.parentElement.querySelector('button')?.click();}};
  const blur=event=>{if(event.target.dataset.summaryParam&&!composing)void controller.flushParams?.();};
  container.addEventListener('blur',blur,true);
  container.addEventListener('keydown',keydown);
  container.addEventListener('input',input);container.addEventListener('change',input);container.addEventListener('click',click);container.addEventListener('compositionstart',startComposition);container.addEventListener('compositionend',endComposition);
  const release=controller.subscribe(render);controller.setVisible(true);render();
  return {dispose(){rememberPreview();clearTimeout(savedTimer);if(renderedScope&&$('.lt-summary-history'))historyStates.set(renderedScope,$('.lt-summary-history').open);disposed=true;controller.setScroll($('.lt-main')?.scrollTop??0);controller.setVisible(false);release();container.removeEventListener('blur',blur,true);container.removeEventListener('keydown',keydown);container.removeEventListener('input',input);container.removeEventListener('change',input);container.removeEventListener('click',click);container.removeEventListener('compositionstart',startComposition);container.removeEventListener('compositionend',endComposition);}};
}
