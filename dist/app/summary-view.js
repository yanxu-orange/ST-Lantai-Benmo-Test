import { splitWords } from '../domain/memory/model.js';
import { eventEditorSections } from './event-editor-sections.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon=(name,label,action)=>`<button type="button" class="ui-icon-button ui-button--tertiary" data-summary-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const button=(text,action,disabled=false)=>`<button type="button" class="ui-button ui-button--tertiary" data-summary-action="${action}" ${disabled?'disabled':''}>${text}</button>`;
const choice=(key,label,value)=>`<label class="ui-choice ui-choice--control-only"><input type="checkbox" data-summary-param="${key}" ${value?'checked':''}><span>${label}</span></label>`;
const number=(key,label,value)=>`<label class="ui-field"><span>${label}</span><input class="ui-input" type="number" min="0" step="1" inputmode="numeric" data-summary-param="${key}" value="${esc(value)}"></label>`;
const histories=new WeakMap();
const savedNotices=new WeakMap();
const previewDetails=new WeakMap();
function preview(state) {
  const value=state.preview;if(!state.previewOpen||!value)return '';
  const tabs=`<nav class="lt-summary-switches" aria-label="预览视图">${['source','prompt'].map(view=>`<button type="button" class="ui-button ui-button--tertiary ui-segment" data-summary-preview-view="${view}" aria-pressed="${state.previewView===view}">${view==='source'?'上下文预览':'提示词预览'}</button>`).join('')}</nav>`;
  const content=state.previewView==='source'?value.source.sentFloors.map(item=>`<details class="lt-summary-source"><summary><span>第 ${item.floor} 楼 · ${item.role==='user'?'用户':'AI'}</span></summary><p>${esc(item.text)}</p></details>`).join(''):value.stages.map(stage=>{
    const parts=stage.pending?'<p class="lt-meta">尚待生成</p>':stage.previewParts.map(part=>`<details class="lt-summary-prompt"><summary><span class="lt-summary-prompt-label"><span>${esc(part.name)}</span><small class="lt-meta">${part.role.toUpperCase()}</small></span></summary><pre>${esc(part.content)}</pre></details>`).join('');
    return value.stages.length===1?parts:`<details class="lt-summary-stage"><summary><span>${stage.title}</span></summary>${parts}</details>`;
  }).join('');
  return `<section class="lt-summary-preview">${tabs}${content}</section>`;
}
function history(state) {
  return `<details class="lt-summary-history" ${state.historyOpen?'open':''}><summary>总结记录与重新生成</summary>${(state.summary?.batches??[]).map(batch=>`<div class="lt-summary-history-row"><span>${batch.actualRange.start}—${batch.actualRange.end} 楼</span>${batch.eventIds?.length&&!batch.eventIds.some(id=>state.formalIds?.includes(id))?'<span class="lt-meta">记忆已删除</span>':''}<button type="button" class="ui-button ui-button--tertiary" data-summary-regenerate="${esc(batch.id)}">重新生成</button></div>`).join('')||'<p class="lt-meta">暂无总结记录</p>'}</details>`;
}
function review(state) {
  return (state.drafts??[]).map((event,index)=>{
    const field=(label,key)=>`<label class="ui-field"><span class="ui-field__label">${label}</span><input class="ui-input" data-summary-field="${key}" value="${esc(event[key])}"></label>`;
    const entry=(key,label)=>`<div class="lt-entry"><input class="ui-input" data-summary-entry="${key}" aria-label="添加${label}" placeholder="输入${label}"><button type="button" class="ui-button ui-button--tertiary" data-summary-add="${key}" hidden>添加</button></div>`;
    const tags=(label,key)=>`<div class="lt-stack"><h3 class="ui-field__label">${label}</h3><div class="lt-tags">${event[key].map((word,i)=>`<span class="ui-tag">${esc(word)}<button type="button" class="ui-icon-button ui-button--tertiary" data-summary-remove-word="${key}" data-word-index="${i}" aria-label="删除${esc(word)}"><img class="lt-icon" src="${new URL('./icons/close.svg',import.meta.url)}" alt=""></button></span>`).join('')}</div>${entry(key,label)}</div>`;
    const terms=event.detailWords.map((term,termIndex)=>`<div class="lt-term" data-summary-term="${termIndex}" data-open="${state.openTerms[index]===term.id}" data-aliases="${term.aliases.length>0}"><div class="lt-term-head"><button type="button" class="ui-button ui-button--tertiary" data-summary-open-term="${esc(term.id)}" aria-expanded="${state.openTerms[index]===term.id}">${esc(term.word)}</button>${icon('close',`删除${term.word}`,`term-remove:${index}:${termIndex}`)}</div>${state.openTerms[index]===term.id?`<div class="lt-term-fields"><label class="lt-term-field ui-field__label">细节词<input class="ui-input" data-summary-term-field="word" value="${esc(term.word)}"></label><label class="lt-term-field ui-field__label">简称<input class="ui-input" data-summary-term-field="aliases" value="${esc(term.aliases.join('，'))}"></label></div>`:''}</div>`).join('');
    const fields=eventEditorSections({modes:`<fieldset class="lt-modes" aria-label="召回方式"><legend class="ui-field__label">召回方式</legend>${[['resident','常驻'],['trigger','触发']].map(([value,label])=>`<label class="lt-mode"><input type="radio" name="summary-mode-${index}" data-summary-field="mode" value="${value}" ${event.mode===value?'checked':''}>${label}</label>`).join('')}</fieldset>`,title:field('标题','title'),body:`<textarea class="lt-textarea" data-summary-field="body" rows="7" aria-label="正文">${esc(event.body)}</textarea>`,times:`<div class="lt-range">${field('故事时间起点','startTime')}<span>—</span>${field('故事时间终点','endTime')}</div>`,sources:event.sources.map(range=>`<div class="lt-range"><label class="ui-field"><span class="ui-field__label">来源起点</span><input class="ui-input" readonly value="${range.start}"></label><span>—</span><label class="ui-field"><span class="ui-field__label">来源终点</span><input class="ui-input" readonly value="${range.end}"></label></div>`).join(''),participants:tags('人物','people')+tags('地点','places'),keywords:tags('事件词','eventWords')+`<h3 class="ui-field__label">细节词与简称<span class="lt-meta"> · ${event.detailWords.length}</span></h3><div class="lt-terms">${terms}</div>${entry('detailWords','细节词')}`});
    return `<section class="lt-summary-candidate lt-editor" data-summary-event="${index}"><header><h2>记忆 ${index+1}</h2><button type="button" class="ui-button ui-button--danger" data-summary-remove="${index}">移除</button></header>${fields}</section>`;
  }).join('');
}
export function mountSummaryView({container,controller,onBack=()=>{},onClose=()=>{},openSettings=()=>{}}={}) {
  let disposed=false,composing=false,pending=false,renderedScope=null,renderedPreviewScope=null,savedUntil=0,savedTimer=null,stopIntent=false;
  const historyStates=histories.get(controller)??new Map();histories.set(controller,historyStates);
  const seenSaved=savedNotices.get(controller)??new Set();savedNotices.set(controller,seenSaved);
  const previewStates=previewDetails.get(controller)??new Map();previewDetails.set(controller,previewStates);
  const $=selector=>container.querySelector(selector);
  function footer(state){
    const auto=state.automatic,isReview=state.route==='review',running=['starting','running','committing'].includes(state.task?.status)||auto.status==='running',awaiting=state.task?.status==='awaiting-user';
    const canStop=state.origin==='auto'&&['running','waiting','awaiting-user'].includes(auto.status);
    if(stopIntent&&canStop&&!auto.stopRequested)return `<div class="lt-editor-actions">${button('取消','cancel-stop')}<button type="button" class="ui-button ui-button--secondary" data-summary-action="confirm-stop">确认停止</button></div>`;
    stopIntent=false;
    const stop=canStop?button(auto.stopRequested?'已请求停止，等待本批完成':'本批次完成后停止总结','stop',auto.stopRequested):'';
    if(isReview)return `${state.task?.candidate?.incomplete?button('重试后续阶段','retry',state.busy):''}${stop}<button type="button" class="ui-button ui-button--primary" data-summary-action="confirm" ${state.busy||state.task?.outcome==='unconfirmed'?'disabled':''}>${state.busy?'保存中…':'统一保存'}</button>`;
    if(canStop)return stop;
    if(awaiting&&state.task?.snapshot.params.reviewBeforeCommit)return button('检查总结结果','review');
    return `<button type="button" class="ui-button ui-button--primary" data-summary-action="start" ${state.busy||running||state.parametersUnconfirmed?'disabled':''}>${running?'正在生成…':auto.status==='stopped'?'继续总结':auto.status==='failed'||state.task?.status==='failed'?'重试本批':state.origin==='auto'?'开始自动总结':'开始总结'}</button>`;
  }
  function renderFooter(focus){const node=$('.lt-footer');if(!node)return;node.innerHTML=footer(controller.inspect());if(focus)$(`[data-summary-action="${focus}"]`)?.focus({preventScroll:true});}
  function rememberPreview(){const details=[...container.querySelectorAll('.lt-summary-preview details')];if(renderedPreviewScope&&details.length)previewStates.set(renderedPreviewScope,details.map(detail=>detail.open));}
  function render() {
    if(disposed)return;if(composing){pending=true;return;}
    const state={...controller.inspect()},root=container.getRootNode(),active=root.activeElement,inside=container.contains(active),scroll=$('.lt-main')?.scrollTop??state.scroll;
    rememberPreview();
    const scope=JSON.stringify([state.target?.rootId,state.target?.epoch,state.origin]);
    if(scope===renderedScope&&$('.lt-summary-history'))historyStates.set(scope,$('.lt-summary-history').open);
    state.historyOpen=historyStates.get(scope)??false;renderedScope=scope;
    renderedPreviewScope=JSON.stringify([scope,state.previewView,state.preview?.source?.fingerprint,state.preview?.stages?.map(stage=>stage.stage)]);
    if(state.task?.status==='succeeded'&&state.task.snapshot.params.reviewBeforeCommit&&!seenSaved.has(state.task.taskId)){
      seenSaved.add(state.task.taskId);savedUntil=Date.now()+2000;clearTimeout(savedTimer);savedTimer=setTimeout(()=>{savedUntil=0;$('.lt-saved')?.setAttribute('hidden','');},2000);
    }
    const statusMessage=state.message==='已保存本批记忆'?'':state.message;
    const eventIndex=active?.closest('[data-summary-event]')?.dataset.summaryEvent,term=active?.closest('[data-summary-term]')?.dataset.summaryTerm,field=active?.dataset.summaryField,termField=active?.dataset.summaryTermField,param=active?.dataset.summaryParam,action=active?.dataset.summaryAction,entry=active?.dataset.summaryEntry,start=active?.selectionStart,end=active?.selectionEnd;
    const entries=Object.entries(state.entries??{}).map(([identity,value])=>{const [id,key]=identity.split(':');return {index:state.drafts?.findIndex(event=>event.id===id),key,value};});
    const details=[...container.querySelectorAll('[data-summary-event] details')].map(element=>({index:element.closest('[data-summary-event]').dataset.summaryEvent,label:element.querySelector(':scope>summary').textContent,open:element.open}));
    const isReview=state.route==='review',title=isReview?'检查总结结果':state.origin==='auto'?'自动总结':'手动总结',params=state.params??{},auto=state.automatic;
    const running=['starting','running','committing'].includes(state.task?.status)||auto.status==='running',awaiting=state.task?.status==='awaiting-user';
    const body=isReview?review(state):`<section class="lt-summary-section">${state.origin==='auto'?choice('enabled','启用自动总结',params.enabled):''}<h2>${state.origin==='auto'?'总结范围':'楼层范围'}</h2>${state.origin==='auto'?number('batchSize','每隔多少楼总结',params.batchSize)+number('recentFloors','最近多少楼不参与总结',params.recentFloors):`<div class="lt-summary-range">${number('startFloor','开始楼',params.startFloor)}${number('endFloor','结束楼',params.endFloor)}</div>`}</section><section class="lt-summary-section"><h2>生成选项</h2>${choice('includeUser','包含用户消息',params.includeUser)}${choice('reviewBeforeCommit','入库前检查',params.reviewBeforeCommit)}${choice('hideOriginal','成功入库后隐藏来源楼层',params.hideOriginal)}</section>${history(state)}<div class="lt-summary-connection" data-preview-open="${state.previewOpen}"><div class="lt-summary-access"><div data-selected="${state.previewOpen}"><span>发送内容</span>${button(state.previewOpen?'收起':'预览','preview',state.busy)}</div><div><span>总结进度</span><span>第${state.summary?.progress.lastProcessedFloor??'—'}楼</span></div><div><span>总结设置</span>${button('打开','settings',state.busy)}</div></div>${preview(state)}</div>`;
    const actionMarkup=footer(state);
    container.innerHTML=`<section class="lantai lt-summary-workspace"><header class="lt-header">${icon('back',isReview?'放弃本批审核':'返回事件记忆','back')}<h1 class="ui-page-title">${title}</h1>${icon('close','关闭兰台本末','close')}</header><main class="lt-main lt-summary-main" tabindex="-1"><p class="lt-error" role="alert" ${state.error?'':'hidden'}>${esc(state.error)}</p><p class="lt-status" role="status" ${statusMessage?'':'hidden'}>${esc(statusMessage)}</p>${body}${state.summary?.pending&&!state.taskId?button('放弃保留草稿','discard-pending',state.busy):''}${state.task?.outcome==='unconfirmed'||state.parametersUnconfirmed?button('重新读取','read'):''}</main><p class="lt-saved lt-status" role="status" ${savedUntil>Date.now()?'':'hidden'}>本批总结已保存</p><footer class="lt-footer">${actionMarkup}</footer></section>`;
    $('.lt-main').scrollTop=scroll;
    for(const saved of entries){const input=$(`[data-summary-event="${saved.index}"] [data-summary-entry="${saved.key}"]`);if(input){input.value=saved.value;input.parentElement.querySelector('button').hidden=!saved.value.trim();}}
    for(const saved of details){const group=[...container.querySelectorAll(`[data-summary-event="${saved.index}"] details`)].find(element=>element.querySelector(':scope>summary').textContent===saved.label);if(group)group.open=saved.open;}
    const previewOpened=previewStates.get(renderedPreviewScope);if(previewOpened)[...container.querySelectorAll('.lt-summary-preview details')].forEach((detail,index)=>detail.open=previewOpened[index]===true);
    if(running||state.busy)for(const input of container.querySelectorAll('[data-summary-param]'))input.disabled=true;
    const prefix=eventIndex!==undefined?`[data-summary-event="${eventIndex}"] `:'';
    const restored=field?$(`${prefix}[data-summary-field="${field}"]${field==='mode'?`[value="${active.value}"]`:''}`):termField?$(`${prefix}[data-summary-term="${term}"] [data-summary-term-field="${termField}"]`):param?$(`[data-summary-param="${param}"]`):entry?$(`${prefix}[data-summary-entry="${entry}"]`):action?$(`[data-summary-action="${action}"]`):active?.matches('.lt-summary-history>summary')?$('.lt-summary-history>summary'):null;
    if(inside){(restored&&!restored.disabled?restored:$('.lt-main'))?.focus({preventScroll:true});if(restored&&typeof start==='number')restored.setSelectionRange?.(start,end);}
  }
  function input(event) {
    const target=event.target,key=target.dataset.summaryParam;
    if(key){controller.changeParams(params=>params[key]=target.type==='checkbox'?target.checked:Number(target.value));return;}
    const entry=target.dataset.summaryEntry;if(entry){controller.setEntry(target.closest('[data-summary-event]').dataset.summaryEvent,entry,target.value);const add=target.parentElement.querySelector('button');add.hidden=!target.value.trim();return;}
    const index=Number(target.closest('[data-summary-event]')?.dataset.summaryEvent),field=target.dataset.summaryField,termField=target.dataset.summaryTermField;
    if(field)controller.changeDrafts(items=>items[index][field]=['people','places','eventWords'].includes(field)?splitWords(target.value):target.value);
    if(termField){const termIndex=Number(target.closest('[data-summary-term]').dataset.summaryTerm);controller.changeDrafts(items=>items[index].detailWords[termIndex][termField]=termField==='aliases'?splitWords(target.value):target.value);}
  }
  async function click(event) {
    const target=event.target.closest('button');if(!target||target.disabled)return;
    if(target.dataset.summaryRegenerate){await controller.regenerate(target.dataset.summaryRegenerate);return;}
    if(target.dataset.summaryRemove!==undefined){controller.changeDrafts(items=>items.splice(Number(target.dataset.summaryRemove),1));render();return;}
    const eventIndex=Number(target.closest('[data-summary-event]')?.dataset.summaryEvent);
    if(target.dataset.summaryOpenTerm){controller.openTerm(eventIndex,target.dataset.summaryOpenTerm);return;}
    if(target.dataset.summaryRemoveWord){controller.changeDrafts(items=>items[eventIndex][target.dataset.summaryRemoveWord].splice(Number(target.dataset.wordIndex),1));render();return;}
    if(target.dataset.summaryAdd){const key=target.dataset.summaryAdd,input=target.parentElement.querySelector('input');if(input.dataset.composing==='true'||composing)return;const values=splitWords(input.value);controller.changeDrafts(items=>{const event=items[eventIndex];if(key==='detailWords'){for(const word of values)if(!event.detailWords.some(term=>term.word===word))event.detailWords.push({id:crypto.randomUUID(),word,aliases:[]});}else event[key]=[...new Set([...event[key],...values])];});controller.setEntry(eventIndex,key,'');render();return;}
    if(target.dataset.summaryPreviewView){controller.previewView(target.dataset.summaryPreviewView);return;}
    const action=target.dataset.summaryAction;if(!action)return;
    if(action==='stop'){stopIntent=true;renderFooter('cancel-stop');return;}
    if(action==='cancel-stop'){stopIntent=false;renderFooter('stop');return;}
    if(action==='confirm-stop'){stopIntent=false;controller.stop();renderFooter();return;}
    if(action.startsWith('term-')){const [kind,index,termIndex]=action.split(':');controller.changeDrafts(items=>kind==='term-add'?items[Number(index)].detailWords.push({id:crypto.randomUUID(),word:'',aliases:[]}):items[Number(index)].detailWords.splice(Number(termIndex),1));render();return;}
    if(action==='back'){if(await controller.back())onBack();}
    if(action==='close')onClose();if(action==='settings')openSettings();if(action==='start')await controller.start();if(action==='retry')await controller.retry();if(action==='discard-pending')await controller.discardPending();if(action==='confirm')await controller.confirm();if(action==='read')await controller.read();
    if(action==='preview'){if(controller.inspect().preview)controller.togglePreview();else await controller.preview();}
    if(action==='review')controller.showTask(controller.inspect().taskId);
  }
  const startComposition=()=>{composing=true;},endComposition=()=>{composing=false;if(pending){pending=false;render();}};
  const keydown=event=>{if(event.key==='Enter'&&event.target.dataset.summaryEntry&&!composing&&!event.isComposing){event.preventDefault();event.target.parentElement.querySelector('button')?.click();}};
  container.addEventListener('keydown',keydown);
  container.addEventListener('input',input);container.addEventListener('change',input);container.addEventListener('click',click);container.addEventListener('compositionstart',startComposition);container.addEventListener('compositionend',endComposition);
  const release=controller.subscribe(render);controller.setVisible(true);render();
  return {dispose(){rememberPreview();clearTimeout(savedTimer);if(renderedScope&&$('.lt-summary-history'))historyStates.set(renderedScope,$('.lt-summary-history').open);disposed=true;controller.setScroll($('.lt-main')?.scrollTop??0);controller.setVisible(false);release();container.removeEventListener('keydown',keydown);container.removeEventListener('input',input);container.removeEventListener('change',input);container.removeEventListener('click',click);container.removeEventListener('compositionstart',startComposition);container.removeEventListener('compositionend',endComposition);}};
}
