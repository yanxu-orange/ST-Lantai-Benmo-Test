import { surfaceTheme } from './styles/theme.js';
import {BUILTIN_SUMMARY_CLEANING_SHORTCUTS} from '../domain/summary/cleaning.js';
import {recallRankingReason} from './recall-ranking-reasons.js';
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,action,extra='',secondary=false)=>`<button type="button" class="ui-button ui-button--${secondary?'secondary':'tertiary'}" data-recall-action="${action}" ${extra}>${label}</button>`;
const icon=(name,label,action)=>`<button type="button" class="ui-icon-button ui-button--tertiary" data-recall-action="${action}" aria-label="${label}"><img class="lt-icon" src="${new URL(`./icons/${name}.svg`,import.meta.url)}" alt=""></button>`;
const arrow='<svg class="lt-recall-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const numericFields=['recentFloorCount','maxCount','maxTokens','memoryDepth','anniversaryPoolLimit'];
const field=(label,key,value,type='text',extra='')=>`<label class="ui-field lt-stack"><span class="ui-field__label">${label}</span><input class="ui-input" type="${type}" data-recall-field="${key}" aria-label="${label}" value="${e(value)}" ${extra}></label>`;
const numberRow=(label,key,value,extra='')=>`<label class="ui-field lt-recall-number-row"><span class="ui-field__label">${label}</span><input class="ui-input" type="number" data-recall-field="${key}" aria-label="${label}" value="${e(value)}" ${extra}></label>`;
const switchControl=rule=>`<button type="button" class="ui-switch" role="switch" aria-checked="${rule.enabled}" aria-label="${rule.enabled?'停用':'启用'}${e(rule.name)}" data-recall-action="toggle-rule" data-id="${e(rule.id)}"><span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__knob"></span></span></button>`;
const actionName={exclude:'排除',extract:'提取',replace:'替换'};
function reason(item) {
  if(item.ranking)return recallRankingReason(item);
  const reasons=item.reasons.map(value=>value.code==='resident'?'常驻发送。':value.code==='alias-match'?`简称“${value.alias}”绑定“${value.term}”${value.qualified?'命中':'作为检索证据'}。`:value.term?`${value.sourceKind==='current'?'当前输入':'语境'}命中“${value.term}”。`:value.code==='joint-evidence'?'当前输入与语境形成共同资格。':value.code==='structured-relevance'?'依据结构相关证据选入。':'依据当前输入与语境形成召回资格。');
  if(item.excludedReason)reasons.push({'count-limit':'已达到本轮触发记忆上限。','token-limit':'已达到本轮正文 Token 上限。','insufficient-evidence':'本轮相关证据不足。'}[item.excludedReason]);
  return [...new Set(reasons),recallRankingReason(item)].filter(Boolean).join(' ');
}
export function mountRecallView({container,controller}={}) {
  const viewState=()=>controller.inspectView?.()??controller.inspect();
  let disposed=false,composing=false,editing=false,pending=false,saved=viewState().saved,timer=null,toast=false,dragging=null,renderedRoute=null,renderedSnapshot=null;
  function remember(){const main=container.querySelector('.lt-main');if(main&&renderedRoute)controller.setScroll(renderedRoute,main.scrollTop);for(const node of container.querySelectorAll('details[data-recall-open]'))controller.setOpen(node.dataset.recallOpen,node.open);}
  function updateTools(){
    for(const card of container.querySelectorAll('[data-recall-card]')){
      const body=card.querySelector('.lt-recall-memory-body'),toggle=card.querySelector('[data-recall-action="memory-body"]');
      if(body&&toggle)toggle.hidden=body.dataset.expanded!=='true'&&body.scrollHeight<=body.clientHeight+1;
    }
    const main=container.querySelector('.lt-main'),tools=container.querySelector('.lt-recall-scroll');if(main&&tools)tools.hidden=main.scrollHeight<=main.clientHeight+1;
  }
  const Resize=container.ownerDocument.defaultView?.ResizeObserver,observer=Resize?new Resize(updateTools):null;
  const detail=(id,title,body,s,extra='')=>`<details class="lt-recall-detail" data-recall-open="${e(id)}" ${(s.opened[id]??(id==='payload'))?'open':''}><summary>${title}${arrow}</summary><div class="lt-recall-detail-body" ${extra}>${body}</div></details>`;
  const textAction=(label,action,id,expanded,controls,hidden=false)=>`<button type="button" class="lt-recall-text-action" data-recall-action="${action}" data-id="${e(id)}" aria-expanded="${expanded}" aria-controls="${e(controls)}" ${hidden?'hidden':''}>${label}</button>`;
  function memories(items,s){return items.map(item=>{
    const expanded=s.opened[`body-${item.id}`]===true,explained=s.opened[`reason-${item.id}`]===true;
    const domKey=Array.from(item.id,c=>c.codePointAt(0).toString(16)).join('-');
    const bodyId=`lt-recall-body-${domKey}`,reasonId=`lt-recall-reason-${domKey}`;
    const type=({resident:'常驻',trigger:'触发',special:'时间'})[item.pool??item.ranking?.pool]??'触发';
    return `<article class="lt-recall-card" data-recall-card="${e(item.id)}"><header class="lt-recall-card-heading"><span class="lt-recall-item-title"><span>${e(item.event.title||'未命名记忆')}</span><time>${e(item.event.startTime||item.event.endTime)}</time></span><span class="lt-recall-pool-label">${item.excludedReason?'未选':type}</span></header><p id="${e(bodyId)}" class="lt-recall-memory-body" data-expanded="${expanded}">${e(item.event.body)}</p><div class="lt-recall-card-actions">${textAction(expanded?'收起全文':'展开全文','memory-body',item.id,expanded,bodyId,!expanded)}${textAction(explained?'收起命中原因':'查看命中原因','memory-reason',item.id,explained,reasonId)}</div><p id="${e(reasonId)}" class="lt-status lt-recall-memory-reason" ${explained?'':'hidden'}>${e(reason(item))}</p></article>`;
  }).join('');}
  function resultSections(p,s){
    const resident=p.selected.filter(item=>item.pool==='resident'),trigger=p.selected.filter(item=>item.pool==='trigger'),special=p.selected.filter(item=>item.pool==='special'),unselected=s.more?p.unselected:p.unselected.slice(0,2);
    return `${p.time?`<p class="lt-status">${p.time.current?`故事日期：${e(p.time.current.raw)}`:'当前故事日期不可用；相对日期与历史同日不参与匹配'}</p>`:''}<section class="lt-recall-section"><div class="lt-recall-heading"><h2>匹配文本</h2>${button('文本清洗 ›','cleaning')}</div><article class="lt-recall-input"><strong>${s.tab==='actual'?'发送时输入':'测试输入（清洗后）'}</strong><p>${e(p.matching.input.cleaned)||'当前输入为空'}</p></article><div class="lt-recall-heading"><h3>补充语境</h3><span class="lt-status">${s.tab==='actual'?'发送时语境':'当前聊天语境'} · ${p.matching.history.length} 楼</span></div>${p.matching.history.map(item=>detail(`floor-${item.floor}`,`<span>第 ${item.floor} 楼 · 距输入 ${item.distanceFromCurrent} 楼</span><span class="lt-recall-preview">${e(item.cleaned)}</span>`,`<p>${e(item.cleaned)||'清洗后为空'}</p>`,s)).join('')}</section><section class="lt-recall-section lt-recall-results"><div class="lt-recall-heading"><h2>${s.tab==='actual'?'匹配结果':'预计召回'}</h2><span class="lt-recall-counts"><span class="lt-status">${p.selected.length} 入选</span>${(p.unselectedCount??p.unselected.length)>0?textAction(`${s.opened['unselected-list']?'收起':'查看'}未选（${p.unselectedCount??p.unselected.length}）`,'unselected-list','',s.opened['unselected-list']===true,'lt-recall-unselected'):'<span class="lt-status">0 未选</span>'}</span></div><div class="lt-recall-cards">${p.selected.length?memories([...resident,...trigger,...special],s):'<p class="lt-status">本轮没有入选记忆</p>'}</div>${(p.unselectedCount??p.unselected.length)>0?`<div id="lt-recall-unselected" class="lt-recall-cards lt-recall-unselected" ${s.opened['unselected-list']?'':'hidden'}>${memories(unselected,s)}${(p.unselectedCount??p.unselected.length)>2?button(s.more?'收起其余':`查看其余 ${(p.unselectedCount??p.unselected.length)-2} 条`,'more'):''}</div>`:''}${p.budget.maxTokens!==null?`<p class="lt-status">普通记忆正文 ${p.budget.totalTokens} Token${p.budget.estimated?'（估算）':''}</p>`:''}</section>`;
  }
  function recallGuide(s){return detail('recall-guide','<span>召回说明</span>',`
    <div class="lt-recall-guide-group"><p>1. 常驻记忆：固定注入</p></div>
    <div class="lt-recall-guide-group"><p>2. 触发记忆：根据关键词或明确提到的时间召回。</p>
    <div class="lt-recall-guide-children"><p>（1）“重逢”召回重逢记忆</p>
    <p>（2）“2025/1/1”召回2025/1/1的记忆</p></div></div>
    <div class="lt-recall-guide-group"><p>3. 时间记忆</p>
    <div class="lt-recall-guide-children"><p>（1）历史同日召回，“去年今日/前年今日/三十年前今日，发生了什么？”</p>
    <p>（2）纪念日召回，“打开提前提醒，设置为3天 → 还有3天/今天就是纪念日了，之前的纪念日发生了什么？”</p>
    <p class="lt-recall-guide-note">召回优先级：纪念日＞历史同日；同一优先级内相关性高的优先；相关性相同年份较近优先。</p></div></div>
  `,s);}
  function monitor(s){
    const tabs=`<nav class="lt-recall-segment" aria-label="召回用途">${['actual','preview'].map(tab=>button(tab==='actual'?'召回监控':'召回测试',tab,`aria-pressed="${s.tab===tab}"`)).join('')}</nav>`;
    if(s.tab==='actual'){
      const a=s.actual;
      if(a.status==='empty')return tabs+'<p class="lt-status">还没有正式召回记录</p>';
      if(a.status!=='injected')return tabs+`<p class="${a.status==='preparing'?'lt-status':'lt-error'}" ${a.status==='preparing'?'role="status"':'role="alert"'}>${e(a.message)}</p>`;
      return tabs+`<p class="lt-status">${({normal:'普通发送',regenerate:'重新生成',swipe:'Swipe',continue:'Continue'})[a.type]??e(a.type)}</p>`+resultSections(a.result,s)+`<section class="lt-recall-section"><h2>实际注入</h2>${detail('payload',`<span><strong>记忆上下文</strong><small>${a.result.selectedIds.length} 条记忆</small></span><span class="lt-status">已注入 · d${a.depth}</span>`,`<pre>${e(a.prompt||'本轮没有入选记忆。')}</pre>`,s)}</section>`;
    }
    const status={idle:'输入测试文字后，点击开始测试。',dirty:'输入已修改，请开始测试以查看新结果。',running:'正在测试召回…',stale:'测试结果已失效，请重新开始测试。',ready:''}[s.testStatus]??'';
    return tabs+recallGuide(s)+`<section class="lt-recall-section"><label class="ui-field lt-stack"><span class="ui-field__label">测试文字</span><textarea class="lt-textarea" rows="4" data-recall-field="testInput" aria-label="测试文字">${e(s.testInput)}</textarea></label><p class="lt-status">使用当前聊天最近 ${s.draft.recentFloorCount} 楼非空、非系统语境；测试文字不会写入聊天。</p>${button('开始测试','start-test',s.testStatus==='running'?'disabled':'',true)}<p class="lt-status" data-recall-test-status ${status?'':'hidden'}>${e(status)}</p></section><div data-recall-test-result ${s.preview?'':'hidden'}>${s.preview?resultSections(s.preview,s):''}</div>`;
  }
  function settings(s){const d=s.draft;return `<section class="lt-recall-section"><h2>匹配</h2><div class="lt-recall-surface">${numberRow('最近匹配楼层','recentFloorCount',d.recentFloorCount,'min="0" step="1"')}<h3>排除词</h3><div class="lt-entry"><input class="ui-input" data-recall-term placeholder="输入完整词" aria-label="新增排除词">${button('添加','add-term')}</div><div class="lt-recall-chips">${d.excludedTerms.map((term,index)=>`<span class="ui-tag">${e(term)}${button('×','remove-term',`data-index="${index}" aria-label="删除排除词 ${e(term)}"`)}</span>`).join('')}</div>${button('召回文本清洗 ›','cleaning')}</div></section><section class="lt-recall-section"><h2>触发召回</h2><div class="lt-recall-surface"><div class="lt-recall-grid">${field('触发记忆上限','maxCount',d.maxCount,'number','min="1" step="1"')}${field('Token 上限','maxTokens',d.maxTokens??'','number','min="1" step="1" placeholder="留空则无上限"')}</div><p class="lt-status">常驻记忆不计入上述条数或 Token 限制；Token 留空表示不限制，单条完整记忆不会被截断。</p></div></section><section class="lt-recall-section"><h2>时间记忆</h2><div class="lt-recall-surface">${numberRow('时间记忆上限','anniversaryPoolLimit',d.anniversaryPoolLimit??'','min="0" step="1" placeholder="留空则关闭"')}<div class="lt-recall-heading"><span>历史同日自动召回</span><button type="button" class="ui-switch" role="switch" aria-label="历史同日自动召回" aria-checked="${d.automaticSameDayEnabled}" data-recall-action="toggle-same-day"><span class="ui-switch__track"><span class="ui-switch__knob"></span></span></button></div><p class="lt-status">自动召回历史同日与纪念日的记忆。留空或0关闭，不影响时间区提醒；不占触发记忆的条数或 Token 上限。</p></div></section><section class="lt-recall-section"><h2>注入</h2><div class="lt-recall-surface">${numberRow('记忆注入深度','memoryDepth',d.memoryDepth,'min="0" max="10000" step="1"')}</div></section>`;}
  function cleaning(s){return `<div class="lt-recall-cleaning-toolbar"><h2>规则</h2>${button(s.quick?'收起快捷添加':'快捷添加','quick')}${button('新建规则','new-rule')}</div>${s.quick?BUILTIN_SUMMARY_CLEANING_SHORTCUTS.map((rule,index)=>`<div class="lt-recall-heading"><span>${e(rule.name)}</span>${button('添加','shortcut',`data-index="${index}"`)}</div>`).join(''):''}<div class="lt-stack">${s.draft.recallCleaning.rules.map(rule=>`<article class="lt-recall-surface" data-recall-rule="${e(rule.id)}"><div class="lt-recall-heading"><button type="button" class="ui-icon-button ui-button--tertiary" data-recall-drag="${e(rule.id)}" aria-label="拖动排序${e(rule.name)}">☷</button><strong>${e(rule.name)}</strong>${switchControl(rule)}</div><div class="lt-recall-heading">${button(actionName[rule.action]+(rule.enabled?'中':''),'cycle-rule',`data-id="${e(rule.id)}" ${rule.action==='replace'?'disabled':''}`)}${button('编辑','edit-rule',`data-id="${e(rule.id)}"`)}${button('删除','delete-rule',`data-id="${e(rule.id)}"`)}</div></article>`).join('')}</div>`;}
  function rule(s){const d=s.ruleDraft;return `<form class="lt-stack" data-recall-rule-form>${field('正则名字','name',d.name)}<label class="ui-field lt-stack"><span class="ui-field__label">动作</span><select class="ui-input" data-recall-field="action" aria-label="动作">${Object.entries(actionName).map(([value,name])=>`<option value="${value}" ${d.action===value?'selected':''}>${name}</option>`).join('')}</select></label><label class="ui-field lt-stack"><span class="ui-field__label">正则表达式</span><textarea class="lt-textarea" data-recall-field="pattern" aria-label="正则表达式" spellcheck="false">${e(d.pattern)}</textarea></label><div data-recall-extract ${d.action==='extract'?'':'hidden'}>${field('提取分组','captureGroup',d.captureGroup,'number','min="0" step="1"')}</div><div data-recall-replace ${d.action==='replace'?'':'hidden'}>${field('替换文字','replacement',d.replacement)}</div></form>`;}
  function patchStatus(s){
    const savedNotice=container.querySelector('.lt-saved');if(savedNotice)savedNotice.hidden=!toast;
    for(const control of container.querySelectorAll('input,textarea,select,[role=switch],main button:not([data-recall-action=read]),footer button[data-recall-action=save-rule]')){
      const action=control.dataset.recallAction;
      const factBrowse=action==='actual'||s.route==='monitor'&&s.tab==='actual'&&['more','memory-body','memory-reason','unselected-list'].includes(action);
      const fixedAction=action==='cycle-rule'&&s.draft?.recallCleaning.rules.find(rule=>rule.id===control.dataset.id)?.action==='replace';
      control.disabled=fixedAction||!factBrowse&&(s.status!=='ready'||action==='start-test'&&(s.testStatus==='running'||s.autoSaving)||action==='save-rule'&&s.autoSaving);
    }
  }
  function contentKey(s, {rules=false,numbers=false}={}) {
    const draft=s.draft&&{...s.draft};
    if(draft&&rules)draft.recallCleaning=null;
    if(draft&&numbers)for(const key of numericFields)delete draft[key];
    return JSON.stringify([s.route,draft,s.ruleDraft,s.quick,s.error]);
  }
  function patchLightChange(s) {
    const old=renderedSnapshot;
    if(!old||old.route!==s.route||old.status!=='ready'||s.status!=='ready'||s.route==='monitor')return false;
    if(contentKey(old)===contentKey(s)){patchStatus(s);return true;}
    if(s.route==='cleaning'&&contentKey(old,{rules:true})===contentKey(s,{rules:true})){
      const before=old.draft.recallCleaning.rules,rules=s.draft.recallCleaning.rules;
      const shape=list=>JSON.stringify(list.map(({enabled,action,...rest})=>rest));
      if(shape(before)!==shape(rules))return false;
      const rows=[...container.querySelectorAll('[data-recall-rule]')];if(rows.length!==rules.length)return false;
      for(let i=0;i<rules.length;i++){
        const item=rules[i],row=rows[i];if(row.dataset.recallRule!==item.id)return false;
        const toggle=row.querySelector('[data-recall-action=toggle-rule]');
        toggle.setAttribute('aria-checked',String(item.enabled));toggle.setAttribute('aria-label',`${item.enabled?'停用':'启用'}${item.name}`);
        const action=row.querySelector('[data-recall-action=cycle-rule]');action.textContent=actionName[item.action]+(item.enabled?'中':'');
      }
      patchStatus(s);return true;
    }
    if(s.route==='settings'&&contentKey(old,{numbers:true})===contentKey(s,{numbers:true})){
      for(const input of container.querySelectorAll('input[data-recall-field]'))if(numericFields.includes(input.dataset.recallField)){
        const value=s.draft[input.dataset.recallField];input.value=value===null||Number.isNaN(value)?'':String(value);
      }
      patchStatus(s);return true;
    }
    return false;
  }
  function render(snapshot=viewState()){if(disposed)return;const s=snapshot;if(s.status!=='ready'||s.dirty){toast=false;clearTimeout(timer);saved=s.saved;}else if(s.saved!==saved){saved=s.saved;toast=true;clearTimeout(timer);timer=setTimeout(()=>{toast=false;const node=container.querySelector('.lt-saved');if(node)node.hidden=true;},2000);}if(composing||editing){pending=true;patchStatus(s);const error=container.querySelector('[data-recall-error]');if(error){error.textContent=s.error;error.hidden=!s.error;}return;}if(patchLightChange(s)){renderedSnapshot=s;return;}remember();const active=container.getRootNode().activeElement,focus=active&&container.contains(active)?{field:active.dataset.recallField,action:active.dataset.recallAction,id:active.dataset.id}:null;
    container.innerHTML=`<section class="lantai lt-recall ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(container)}"><header class="lt-header ui-header ui-header--centered">${icon('back','返回','back')}<h1 class="ui-page-title">${s.route==='cleaning'?'召回文本清洗':s.route==='rule'?'编辑清洗规则':'召回'}</h1>${icon('close','关闭','close')}</header>${['monitor','settings'].includes(s.route)?`<nav class="lt-recall-domains" aria-label="召回页面">${button('监控','monitor',`aria-pressed="${s.route==='monitor'}"`)}${button('设置','settings',`aria-pressed="${s.route==='settings'}"`)}</nav>`:''}<p class="lt-saved" role="status" ${toast?'':'hidden'}>已保存</p><main class="lt-main lt-stack ui-main" tabindex="-1"><p class="lt-error" role="alert" data-recall-error ${s.error?'':'hidden'}>${e(s.error)}</p>${s.route==='monitor'&&s.tab==='actual'?monitor(s):!s.draft?(s.status==='loading'?'<p class="lt-status">正在读取召回设置…</p>':'<p class="lt-status">召回设置暂不可用。</p>'):s.route==='monitor'?monitor(s):s.route==='settings'?settings(s):s.route==='cleaning'?cleaning(s):rule(s)}${['failed','unconfirmed'].includes(s.status)?button('重新读取','read'):''}</main>${s.route==='rule'?`<footer class="lt-footer ui-action-footer"><div class="lt-editor-actions">${button('取消','back')}${button('保存','save-rule','',true)}</div></footer>`:''}<div class="lt-recall-scroll">${button('↑','top','aria-label="滚动到顶部"')}${button('↓','bottom','aria-label="滚动到底部"')}</div></section>`;
    renderedSnapshot=s;renderedRoute=s.route;const updated=controller.viewPosition?.()??viewState();for(const node of container.querySelectorAll('details[data-recall-open]'))node.open=updated.opened[node.dataset.recallOpen]??(node.dataset.recallOpen==='payload');const main=container.querySelector('.lt-main');main.scrollTop=updated.scroll[s.route]??0;observer?.disconnect();observer?.observe(main);updateTools();
    if(focus){const node=[...container.querySelectorAll('input,textarea,select,button')].find(node=>focus.field?node.dataset.recallField===focus.field:node.dataset.recallAction===focus.action&&node.dataset.id===focus.id);node?.focus({preventScroll:true});}
    patchStatus(s);
  }
  function click(event){const node=event.target.closest('[data-recall-action]');if(!node||node.disabled)return;const action=node.dataset.recallAction;if(action==='back')controller.back();else if(action==='close')controller.close();else if(action==='monitor'||action==='settings'||action==='cleaning')controller.route(action);else if(action==='preview'||action==='actual')controller.tab(action);else if(action==='start-test'){if(composing)return;editing=false;void controller.startTest();}else if(action==='read')void controller.read();else if(action==='toggle-same-day')void controller.toggleSameDay();else if(action==='add-term'){const input=container.querySelector('[data-recall-term]');controller.addTerm(input.value);}else if(action==='remove-term')controller.removeTerm(Number(node.dataset.index));else if(action==='memory-body'||action==='memory-reason'){
      const card=node.closest('[data-recall-card]'),isBody=action==='memory-body',opened=node.getAttribute('aria-expanded')!=='true';
      controller.setOpen(`${isBody?'body':'reason'}-${node.dataset.id}`,opened);node.setAttribute('aria-expanded',String(opened));
      node.textContent=isBody?(opened?'收起全文':'展开全文'):(opened?'收起命中原因':'查看命中原因');
      if(isBody)card.querySelector('.lt-recall-memory-body').dataset.expanded=String(opened);else card.querySelector('.lt-recall-memory-reason').hidden=!opened;
      updateTools();
    }else if(action==='unselected-list'){
      const opened=node.getAttribute('aria-expanded')!=='true';controller.setOpen('unselected-list',opened);node.setAttribute('aria-expanded',String(opened));
      node.textContent=node.textContent.replace(/^(查看|收起)/,opened?'收起':'查看');container.querySelector('#lt-recall-unselected').hidden=!opened;updateTools();
    }else if(action==='more')controller.more();else if(action==='quick')controller.quick();else if(action==='new-rule'||action==='edit-rule')controller.newRule(node.dataset.id);else if(action==='save-rule')void controller.ruleSave();else if(action==='shortcut')controller.shortcut(Number(node.dataset.index));else if(action.endsWith('-rule'))controller.changeRule(node.dataset.id,action.split('-')[0]);else if(action==='top'||action==='bottom'){const main=container.querySelector('.lt-main');main.scrollTop=action==='top'?0:main.scrollHeight;} }
  function input(event){const node=event.target,key=node.dataset.recallField;if(!key)return;editing=true;if(key==='testInput'){controller.editTestInput(node.value);const result=container.querySelector('[data-recall-test-result]');if(result)result.hidden=true;const status=container.querySelector('[data-recall-test-status]');if(status){status.hidden=false;status.textContent='输入已修改，请开始测试以查看新结果。';}const start=container.querySelector('[data-recall-action=start-test]');if(start)start.disabled=false;return;}const s=viewState(),value=node.type==='number'?(['maxTokens','anniversaryPoolLimit'].includes(key)&&node.value===''?null:node.value===''?NaN:Number(node.value)):node.value;if(s.route==='rule'){controller.editRule(key,value);if(key==='action'){container.querySelector('[data-recall-extract]').hidden=value!=='extract';container.querySelector('[data-recall-replace]').hidden=value!=='replace';}}else controller.edit(key,value);}
  function change(event){input(event);if(viewState().route==='settings'&&event.target.dataset.recallField&&event.target.dataset.recallField!=='testInput')void controller.save();}
  const blur=()=>{if(composing)return;editing=false;setTimeout(()=>{if(!disposed&&pending&&!editing&&!composing){pending=false;render();}},0);};
  const compositionStart=()=>{composing=true;},compositionEnd=event=>{composing=false;input(event);};
  const toggle=event=>{const node=event.target;if(node.matches('details[data-recall-open]'))controller.setOpen(node.dataset.recallOpen,node.open);updateTools();};
  const pointerdown=event=>{const handle=event.target.closest('[data-recall-drag]');if(handle){dragging=handle.dataset.recallDrag;event.preventDefault();}};
  const pointerup=event=>{if(!dragging)return;const id=dragging;dragging=null;const root=container.getRootNode(),node=(root.elementFromPoint?.(event.clientX,event.clientY)??event.target).closest('[data-recall-rule]');if(node)controller.moveRule(id,node.dataset.recallRule);};
  container.addEventListener('click',click);container.addEventListener('input',input);container.addEventListener('change',change);container.addEventListener('focusout',blur);container.addEventListener('compositionstart',compositionStart);container.addEventListener('compositionend',compositionEnd);container.addEventListener('toggle',toggle,true);container.addEventListener('pointerdown',pointerdown);container.ownerDocument.addEventListener('pointerup',pointerup);const unsubscribe=controller.subscribe(render);render();
  return {dispose(){remember();disposed=true;observer?.disconnect();clearTimeout(timer);unsubscribe();container.removeEventListener('click',click);container.removeEventListener('input',input);container.removeEventListener('change',change);container.removeEventListener('focusout',blur);container.removeEventListener('compositionstart',compositionStart);container.removeEventListener('compositionend',compositionEnd);container.removeEventListener('toggle',toggle,true);container.removeEventListener('pointerdown',pointerdown);container.ownerDocument.removeEventListener('pointerup',pointerup);}};
}
