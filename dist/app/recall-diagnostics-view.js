import {exportMemoryDiagnostics} from '../domain/memory/diagnostics.js';
import {downloadSettingsBackup as downloadJson} from './settings-backup-session.js';

const statuses = {
  unknown:'未知', preparing:'准备中', selected:'已入选，尚未确认发送', adopted:'已交给酒馆',
  none:'无入选', withdrawn:'发送前撤回', disabled:'关闭', cleared:'未注入',
  failed:'失败', unconfirmed:'未确认', cancelled:'已取消', stale:'来源已变化',
  running:'生成中', 'awaiting-user':'待审核', committing:'保存中', succeeded:'已保存',
  prepared:'已准备', dispatched:'已派发', returned:'已收到结果'
};
const stages = {
  fast:'生成记忆', qualitySummary:'生成记忆', enhancedSummary:'生成记忆',
  qualityIndexes:'生成关键词与简称', enhancedKeywords:'生成关键词', aliases:'生成简称', summary:'生成古法总结'
};
const types = {normal:'普通发送', regenerate:'重新生成', swipe:'切换回复', continue:'续写'};
const sourceStates = {
  current:'以下为酒馆当前原文，历史请求可能使用了不同的内容或清洗规则。',
  changed:'来源楼层或回复已变化，原文无法对照。',
  unavailable:'当前无法读取原文。',
  unknown:'没有可核实的原文归属。'
};
const labels = {
  'count-limit':'超过条数上限', 'token-limit':'超过 Token 上限', 'special-limit':'超过时间记忆上限',
  'insufficient-evidence':'相关证据不足', resident:'常驻', 'alias-match':'简称命中',
  'joint-evidence':'综合匹配', 'structured-relevance':'结构相关'
};
const textStatus = key => statuses[key] ?? '未知';
const pageSize = 12;

export function createRecallDiagnosticsView({diagnostics, document, render, escape: e, button, detail}) {
  if (!diagnostics) return null;
  const {store, target, materials, titles} = diagnostics;
  let start = '', end = '', activeRange = null, page = 0, selected = null, notice = '', confirmClear = false;
  function applyRange() {
    const valid = value => value === '' || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
    const low = start === '' ? 0 : Number(start);
    const high = end === '' ? Number.MAX_SAFE_INTEGER : Number(end);
    if (!valid(start) || !valid(end) || low > high) {
      notice = '请输入有效的楼层范围。';
      return null;
    }
    return {start:low, end:high};
  }
  function summaryContent(row) {
    const rows = row.stages.map(stage => `<p>${e(stages[stage.name]??'阶段未知')} · ${e(textStatus(stage.status))}</p>
      <p class="lt-meta">请求模型 ${e(stage.requestedModel??'未知')} · 返回模型 ${e(stage.reportedModel??'未知')} · 提示词 ${e(stage.promptVersion??'未知')}</p>
      ${stage.sentFloors.length ? `<p class="lt-meta">实际送入 ${e(stage.sentFloors.join('、'))} 楼</p>` : ''}`).join('');
    return `<p class="lt-meta">尝试 ${row.attempt??'？'}${row.continuation?' · 续接上次阶段':''}</p>` + rows
      + (row.previousVersionId ? `<p class="lt-meta">上版 ${e(row.previousVersionId)}</p>` : '')
      + (selected?.id===row.id ? comparison() : button('查看原文与成果','diagnostic-materials',`data-id="${e(row.id)}"`));
  }
  function sendContent(row) {
    const cumulative = row.cumulativeInjection;
    return `<p>${e(types[row.type]??'发送')} · ${e(textStatus(row.status))}</p>
      <p class="lt-meta">入选 ${row.selected.length} 条 · 交给酒馆 ${row.adopted.length} 条</p>
      <p class="lt-meta">古法注入 · ${e(textStatus(cumulative?.status))}${cumulative?.versionId ? ' · '+e(cumulative.versionId) : ''}</p>
      ${row.candidateCount > row.candidates.length ? `<p class="lt-meta">保留 ${row.candidates.length} / ${row.candidateCount} 条候选明细</p>` : ''}
      ${row.candidates.map(item=>`<p class="lt-meta"><span data-diagnostic-candidate="${e(item.id)}">${e(item.id)}</span> · ${e(item.excludedReason ? labels[item.excludedReason]??item.excludedReason : row.adopted.includes(item.id)?'已交给酒馆':row.selected.includes(item.id)?'入选':'未入选')}${item.rank ? ' · 排名 '+item.rank : ''}${item.channels.length ? ' · '+e(item.channels.join('、')) : ''}${item.reasons.length ? ' · '+e(item.reasons.map(reason=>labels[reason]??reason).join('、')) : ''}</p>`).join('')}`;
  }
  function comparison() {
    if (!selected) return '';
    let current;
    try { current = materials(selected); } catch { /* current host data unavailable */ }
    return `<section class="lt-recall-section"><div class="lt-recall-heading"><h2>原文与成果</h2>${button('关闭对照','diagnostic-close-materials')}</div>
      ${!current ? '<p class="lt-status">当前资料不可用。</p>' : `<p class="lt-status">${e(sourceStates[current.sourceStatus])}</p>
      ${current.source.map(item=>`<article class="lt-recall-surface"><p class="lt-meta">第 ${item.floor} 楼 · ${item.role==='user'?'用户':'角色'}</p><pre>${e(item.text)}</pre></article>`).join('')}
      ${current.results.map(item=>`<article class="lt-recall-surface"><p class="lt-meta">${e(item.title??'总结成果')} · ${e(({matching:'与生成时一致',changed:'当前成果已变化',deleted:'当前成果不可用'})[item.status])}</p>${item.body ? `<pre>${e(item.body)}</pre>` : ''}</article>`).join('')}`}</section>`;
  }
  return {
    markup(state) {
      const snapshot = store.inspect(target);
      const filtered = activeRange ? exportMemoryDiagnostics(snapshot,activeRange.start,activeRange.end) : snapshot;
      const rows = [...filtered.summaries, ...filtered.sends].sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
      page = Math.max(0,Math.min(page,Math.ceil(rows.length/pageSize)-1));
      return `<section class="lt-recall-section"><div class="lt-recall-heading"><h2>诊断记录</h2>
        <button type="button" class="ui-switch" role="switch" aria-checked="${snapshot.enabled}" aria-label="记录当前聊天的诊断" data-recall-action="diagnostic-enable"><span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__knob"></span></span></button></div>
        <p class="lt-meta">仅记录当前聊天的总结与发送过程，保存在此浏览器。</p>
        ${snapshot.error ? '<p class="lt-error" role="alert">浏览器存储不可用，诊断记录可能未保存。</p>' : ''}
        ${notice ? `<p class="lt-status" role="status">${e(notice)}</p>` : ''}
        <div class="lt-recall-surface lt-stack">
          <label class="ui-field lt-recall-number-row"><span class="ui-field__label">起始楼层</span><input class="ui-input" type="number" min="0" value="${e(start)}" data-diagnostic-field="start" data-recall-field="diagnostic-start"></label>
          <label class="ui-field lt-recall-number-row"><span class="ui-field__label">结束楼层</span><input class="ui-input" type="number" min="0" value="${e(end)}" data-diagnostic-field="end" data-recall-field="diagnostic-end"></label>
          <div class="lt-recall-heading">${button('查看楼段','diagnostic-filter')}${button('导出 JSON','diagnostic-export','',true)}</div>
        </div>
        ${rows.length ? `<p class="lt-meta">总结 ${filtered.summaries.length} 次 · 发送 ${filtered.sends.length} 次</p>` : '<p class="lt-status">这个范围内还没有记录。</p>'}
        ${rows.slice(page*pageSize,(page+1)*pageSize).map(row=>{
          const title = row.kind ? `${row.kind==='event'?'事件记忆':'古法总结'} · ${row.requestedRange?.start??'？'}–${row.requestedRange?.end??'？'} 楼` : `发送时楼层 · 第 ${row.floor??'？'} 楼`;
          return detail('diagnostic-'+row.id,`<strong>${e(title)}</strong><small>${e(textStatus(row.status))}</small>`,row.kind?summaryContent(row):sendContent(row),state);
        }).join('')}
        ${rows.length>pageSize ? `<div class="lt-recall-heading">${button('上一页','diagnostic-prev',page===0?'disabled':'')}<span class="lt-meta">${page+1} / ${Math.ceil(rows.length/pageSize)}</span>${button('下一页','diagnostic-next',(page+1)*pageSize>=rows.length?'disabled':'')}</div>` : ''}
        ${snapshot.sends.length||snapshot.summaries.length ? confirmClear ? `<p class="lt-status">清空当前聊天的所有诊断记录？</p><div class="lt-recall-heading">${button('取消','diagnostic-cancel-clear')}${button('确认清空','diagnostic-clear','',true)}</div>` : button('清空记录','diagnostic-ask-clear') : ''}
      </section>`;
    },
    input(node) {
      if (node.dataset.diagnosticField === 'start') start = node.value;
      if (node.dataset.diagnosticField === 'end') end = node.value;
    },
    opened(node) {
      if (!node.open || !node.dataset.recallOpen?.startsWith('diagnostic-')) return;
      const items = [...node.querySelectorAll('[data-diagnostic-candidate]')];
      if (!items.length) return;
      try {
        const found = titles(items.map(item=>item.dataset.diagnosticCandidate));
        for (const item of items) {
          const id = item.dataset.diagnosticCandidate;
          item.textContent = found.get(id) ?? ('当前记忆不可用 · '+id);
        }
      } catch { /* IDs are still useful when the current root is unavailable. */ }
    },
    action(action, id) {
      notice = '';
      if (action === 'diagnostic-enable') {
        if (!store.setEnabled(target,!store.inspect(target).enabled)) notice = '无法保存记录开关。';
      } else if (action === 'diagnostic-filter') {
        const range = applyRange();
        if (range) { activeRange=range; page=0; selected=null; }
      } else if (action === 'diagnostic-export') {
        const range = applyRange();
        if (range) {
          const snapshot = store.inspect(target);
          const latest = Math.max(range.start,...snapshot.summaries.map(row=>row.requestedRange?.end??0),...snapshot.sends.map(row=>row.floor??0));
          const output = exportMemoryDiagnostics(snapshot,range.start,end===''?latest:range.end);
          try { downloadJson(document,JSON.stringify(output,null,2),'兰台-诊断记录.json'); }
          catch { notice = '无法下载诊断记录。'; }
        }
      } else if (action === 'diagnostic-prev') page--;
      else if (action === 'diagnostic-next') page++;
      else if (action === 'diagnostic-materials') selected = store.inspect(target).summaries.find(row=>row.id===id)??null;
      else if (action === 'diagnostic-close-materials') selected = null;
      else if (action === 'diagnostic-ask-clear') confirmClear = true;
      else if (action === 'diagnostic-cancel-clear') confirmClear = false;
      else if (action === 'diagnostic-clear') {
        if (store.clear(target)) { confirmClear=false; selected=null; page=0; }
        else notice = '未能清空诊断记录。';
      }
      render();
    }
  };
}
