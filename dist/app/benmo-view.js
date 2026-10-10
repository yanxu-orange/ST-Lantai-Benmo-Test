import {replaceSurfaceMarkup} from './stable-surface.js';
import {mainNavigation} from './navigation.js';
import {surfaceTheme} from './styles/theme.js';

const TABS = {records: '兰台记录', self: '角色自述', outline: '故事大纲'};
const KINDS = {summary: '最新摘要', item: '物品追踪', npc: '角色追踪'};
const NARRATIVES = ['self', 'outline'];
const FEATURES = [...Object.keys(KINDS), ...NARRATIVES];
const FIELDS = {
  item: [['name', '名称'], ['introduction', '精简介绍'], ['location', '位置'], ['custodian', '保管者'], ['owner', '所属者'], ['transferFrom', '赠送／转移方'], ['transferTo', '接收方'], ['transferReason', '简短原因'], ['aliases', '名称／简称（关键词）']],
  npc: [['name', '姓名'], ['appearance', '辨识外表'], ['identity', '身份'], ['relationToUser', '与 user 的关系'], ['relationToChar', '与 char 的关系'], ['aliases', '称呼／别名（关键词）']],
};
const MULTILINE = new Set(['introduction', 'appearance', 'transferReason', 'relationToUser', 'relationToChar']);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const clone = value => structuredClone(value);
const aliases = value => [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[,，\n]/)).map(part => String(part).trim()).filter(Boolean))];

/** The Benmo surface owns only navigation/drafts. The controller owns source
 * eligibility, runtime jobs, feature policy and acknowledged persistence. */
export async function mountBenmoView({container: app, controller, availability = () => ({}), onNavigate = () => {}, onClose = () => {}, isCurrent = () => true, initialState = {}} = {}) {
  initialState ??= {};
  const lifetime = new AbortController();
  let value = await (controller.ensure ? controller.ensure() : controller.load());
  if (!isCurrent()) return null;
  let disposed = false, suspended = false, acting = false, composing = false;
  let error = '', dialog = null, draft = null, baseline = null, original = null, narrativeRecovery = null, narrativeDraftTarget = null, invalidated = false, renderedPolicy = '';
  let returnRoute = 'list', epoch = 0, toastTimer, redirectTimer;
  let backfillJob = null, summaryVisibilityDisposer = null, observingSummaryVisibility = false;
  const generating = new Map(), narrativeJobs = new Map();
  const state = {
    tab: Object.hasOwn(TABS, initialState.tab) ? initialState.tab : 'records',
    kind: Object.hasOwn(KINDS, initialState.kind) ? initialState.kind : 'summary',
    route: initialState.route === 'detail' ? 'detail' : 'list',
    selected: typeof initialState.selected === 'string' ? initialState.selected : null,
    selections: {item: null, npc: null, ...initialState.selections},
    scrolls: {...initialState.scrolls},
    expanded: new Set(Array.isArray(initialState.expanded) ? initialState.expanded : []),
    summaryHistoryExpanded: initialState.summaryHistoryExpanded === true,
  };
  const externalPolicy = () => typeof availability === 'function' ? availability() ?? {} : availability ?? {};
  function policy() {
    const supplied = externalPolicy(), saved = value.policy ?? {};
    const result = {...saved, ...supplied};
    for (const key of ['enabled', 'benmo', ...FEATURES]) {
      if (saved[key] === false || supplied[key] === false) result[key] = false;
    }
    for (const key of FEATURES) if (result[key] === undefined || result.enabled === false || result.benmo === false) result[key] = false;
    result.benmo = FEATURES.some(key => result[key] === true);
    return result;
  }
  const enabledKinds = () => Object.keys(KINDS).filter(key => policy()[key]);
  const enabledTabs = () => Object.keys(TABS).filter(key => key === 'records' ? enabledKinds().length > 0 : policy()[key]);
  const activeKind = () => state.tab === 'records' ? state.kind : state.tab;
  const narrativeData = () => value.narrative?.narrative ?? {};
  const narrativePreferences = (kind = state.tab) => narrativeData().preferences?.[kind] ?? {};
  const narrativeResults = (kind = state.tab) => narrativeData()[kind] ?? [];
  const narrativeStatus = (kind = state.tab) => value.narrative?.[kind] ?? {};
  const narrativeEntry = (id, kind = state.tab) => (kind === 'self' ? narrativeResults(kind).flatMap(row => row.entries ?? []) : narrativeResults(kind)).find(row => row.id === id);
  const records = (kind = state.kind) => {
    const rows = value.tracking?.records ?? [];
    return Array.isArray(rows) ? rows.filter(row => row.kind === kind) : rows[kind] ?? [];
  };
  const byFloor = rows => [...rows].sort((a, b) => Number(a.floor) - Number(b.floor));
  const summaryRecords = () => byFloor(value.summary?.records ?? []);
  const selectedRecord = () => records().find(row => row.id === state.selected);
  const context = () => ['benmo', state.tab, state.kind, state.route, ['detail', 'edit', 'narrative-edit'].includes(state.route) ? state.selected ?? 'new' : ''].join(':');
  const blocked = () => !!narrativeRecovery || summaryDraftHidden() || invalidated || externalPolicy().transient === true || value.writeBlocked === true || !policy()[activeKind()];
  const button = (label, action, attrs = '', tone = 'tertiary') => `<button type="button" class="ui-button ui-button--${tone}" data-action="${action}" ${blocked() && ['save', 'delete-record', 'toggle-excluded', 'restore-excluded', 'new', 'generate', 'generate-narrative', 'manual-summary', 'start-backfill'].includes(action) ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const textEntry = (label, action, attrs = '') => button(label, action, attrs).replace('ui-button ui-button--tertiary', 'benmo-text-entry');
  const icon = (label, action, file, attrs = '') => `<button type="button" class="ui-icon-button ui-button--tertiary" aria-label="${esc(label)}" data-action="${action}" ${attrs}><img class="lt-icon" data-icon="${file}" src="${new URL(`./icons/${file}.svg`, import.meta.url)}" alt=""></button>`;
  const selectButton = (id, label, current, action) => action === 'kind'
    ? button(label, action, `data-id="${esc(id)}" aria-pressed="${id === current}"`)
    : button(label, action, `data-id="${esc(id)}" ${id === current ? 'aria-current="page"' : ''}`).replace('ui-button ui-button--tertiary', 'ui-button lt-type');

  function readDraft() {
    const form = app.querySelector('form');
    if (!form || !draft) return;
    const customInputs = new Map();
    if (state.route === 'narrative-settings') {
      for (const [key, raw] of new FormData(form)) {
        if (['background', 'budget', 'depth', 'prompt'].includes(key)) draft[key] = String(raw);
        else { const character = draft.characters?.find(row => key === `narrative-character-${row.id}`); if (character) character.name = String(raw); }
      }
      return;
    }
    if (state.route === 'narrative-edit') {
      for (const [key, raw] of new FormData(form)) if (key === 'text') draft.text = String(raw);
      return;
    }
    for (const field of draft.customFields ?? []) for (const key of ['name', 'requirement', 'value']) customInputs.set(`record-field-${field.id}-${key}`, [field, key]);
    for (const [key, raw] of new FormData(form)) {
      const text = String(raw), custom = customInputs.get(key);
      if (custom) custom[0][custom[1]] = text;
      else if (state.route === 'tracking-settings' && ['prompt', 'exclusionNames'].includes(key)) draft[key] = text;
      else if (state.route === 'summary-settings' && ['recentFloors', 'prompt'].includes(key)) draft[key] = text;
      else if (state.kind === 'summary' && key === 'body') draft.body = text;
      else if (state.kind !== 'summary' && key === 'mode') draft.pinned = text === 'resident';
      else if (state.kind !== 'summary' && FIELDS[state.kind].some(([name]) => name === key)) draft[key] = text;
    }
  }
  function remember() {
    const main = app.querySelector('.lt-main');
    if (main) state.scrolls[context()] = main.scrollTop;
    readDraft();
  }
  const dirty = () => { readDraft(); return !!draft && !same(draft, baseline); };
  function snapshotNavigation() {
    remember();
    return {tab: state.tab, kind: state.kind, route: draft ? returnRoute : state.route, selected: state.selected, selections: {...state.selections}, scrolls: {...state.scrolls}, expanded: [...state.expanded], summaryHistoryExpanded: state.summaryHistoryExpanded};
  }
  function normalize() {
    const tabs = enabledTabs(), kinds = enabledKinds();
    if (!tabs.length) return false;
    if (!tabs.includes(state.tab) || (state.tab === 'records' && !kinds.includes(state.kind))) {
      if (!tabs.includes(state.tab)) state.tab = tabs[0];
      if (state.tab === 'records') state.kind = kinds[0];
      state.route = 'list'; state.selected = state.selections[state.kind] ?? null;
      draft = baseline = original = null; narrativeRecovery = narrativeDraftTarget = null; dialog = null; epoch++;
    }
    if (state.tab === 'records' && state.route === 'detail' && !selectedRecord()) { state.route = 'list'; state.selected = null; }
    return true;
  }
  function redirectToSettings() {
    if (redirectTimer || disposed || suspended) return;
    redirectTimer = setTimeout(() => {
      redirectTimer = null;
      if (!disposed && !suspended && !externalPolicy().transient && !enabledTabs().length) onNavigate('settings', snapshotNavigation());
    }, 0);
  }
  function toast(text) {
    if (disposed || suspended) return;
    clearTimeout(toastTimer); app.querySelector('.wk-toast')?.remove();
    const element = app.ownerDocument.createElement('p'); element.className = 'wk-toast';
    element.setAttribute('role', 'status'); element.textContent = text;
    app.querySelector('.benmo')?.append(element); toastTimer = setTimeout(() => element.remove(), 2000);
  }
  // Counts/rows always come from the source-aware runtime. A local pending
  // promise is only a duplicate-click guard, never evidence of a valid job.
  const runningRows = () => value.summary?.running ?? [];
  const summaryCurrentRows = () => {
    if (Array.isArray(value.summary?.currentRows)) return byFloor(value.summary.currentRows);
    // Older controller fixtures expose the same current list in three parts.
    const rows = new Map();
    for (const row of [...(value.summary?.missing ?? []), ...runningRows(), ...summaryRecords()]) rows.set(Number(row.floor), row);
    return byFloor(rows.values());
  };
  const summaryHistoryRecords = () => byFloor(value.summary?.historyRecords ?? []).filter(row => row.id && row.body && !row.nativeHidden);
  const summarySource = floor => [...summaryCurrentRows(), ...summaryRecords()].find(row => Number(row.floor) === floor);
  function summaryDraftHidden() {
    return state.tab === 'records' && state.kind === 'summary' && state.route === 'edit' && !!draft && summarySource(Number(draft.floor))?.nativeHidden === true;
  }
  const summaryRunning = row => generating.has(Number(row.floor)) || ['queued', 'running'].includes(row.status) || runningRows().some(job => Number(job.floor) === Number(row.floor));
  function reconcileGenerating() {
    for (const [floor, token] of generating) {
      const row = summarySource(floor), running = runningRows().some(job => Number(job.floor) === floor && job.replyId === token.replyId);
      if (!row || row.replyId !== token.replyId || (token.observed && !running)) generating.delete(floor);
      else if (running) token.observed = true;
    }
  }
  const missingRows = () => {
    const current = new Map(summaryCurrentRows().map(row => [Number(row.floor), row]));
    return (value.summary?.missing ?? []).filter(row => {
      const shown = current.get(Number(row.floor));
      return shown && !shown.nativeHidden && !row.nativeHidden && !shown.id && !summaryRunning(shown);
    });
  };
  const backfillStatus = () => value.summary?.backfill ?? {};
  const backfillRunning = () => ['queued', 'running', 'stopping'].includes(backfillStatus().status) || !!backfillJob;
  function reconcileBackfill() {
    if (!backfillJob) return;
    const info = backfillStatus();
    if (['queued', 'running', 'stopping'].includes(info.status)) {
      if (backfillJob.id && backfillJob.id !== info.id) backfillJob = null;
      else { backfillJob.id = info.id;backfillJob.observed = true; }
    } else if (backfillJob.observed) backfillJob = null;
  }
  function backfillProgress() {
    const info = backfillStatus();
    if (!info.status || info.status === 'idle') return '';
    const labels = {queued:'排队中',running:'补缺中',stopping:'正在停止',stopped:'已停止',cancelled:'已停止',succeeded:'补缺完成',completed:'补缺完成',partial:'补缺结束，部分楼层未完成',failed:'补缺失败'};
    return `<p class="meta" role="status">${esc(labels[info.status] ?? '补缺已结束')} · 已补 ${esc(info.completed ?? 0)} / ${esc(info.total ?? 0)} 楼${info.skipped ? ` · 已有跳过 ${esc(info.skipped)} 楼` : ''}${info.failed ? ` · 失败 ${esc(info.failed)} 楼` : ''}</p>${info.error ? `<p class="lt-error" role="alert">${esc(info.error)}</p>` : ''}`;
  }
  function backfillControls() {
    const count = missingRows().length, running = backfillRunning();
    return `<section class="pending-strip" aria-label="摘要任务状态"><p class="meta" role="status">缺少${count}条</p><div class="actions compact-actions">${controller.startSummaryBackfill ? button('补齐缺失', 'start-backfill', running || !count ? 'disabled' : '', 'secondary') : ''}${running && controller.stopSummaryBackfill ? button('停止补缺', 'stop-backfill', backfillStatus().status === 'stopping' ? 'disabled' : '') : ''}</div></section>${backfillProgress()}`;
  }
  function summaryCurrentRow(row) {
    if (row.nativeHidden) return `<p class="meta">第${esc(row.floor)}楼 · 已隐藏</p>`;
    if (row.id && row.body) return summaryCard(row);
    const running = summaryRunning(row), disabled = running ? 'disabled aria-busy="true"' : '';
    return `<article class="card summary-card"><header class="summary-card-header"><span class="meta">第 ${esc(row.floor)} 楼</span><div class="summary-card-actions">${controller.manualSummary ? textEntry('手动补录', 'manual-summary', `data-id="${esc(row.floor)}" ${disabled}`) : ''}${textEntry('生成', 'generate', `data-id="${esc(row.floor)}" ${disabled}`)}</div></header>${running ? '<p class="meta" role="status">生成中</p>' : ''}${row.error ? `<p class="lt-error" role="alert">${esc(row.error)}</p>` : ''}</article>`;
  }
  function summaryCard(row) {
    const expanded = state.expanded.has(row.id), bodyId = `benmo-summary-body-${row.id}`;
    const running = summaryRunning(row);
    return `<article class="card summary-card"><header class="summary-card-header"><span class="meta">第 ${esc(row.floor)} 楼</span><div class="summary-card-actions">${icon('编辑摘要', 'edit-summary', 'edit', `data-id="${esc(row.id)}"`)}${icon('重新生成摘要', 'generate', 'refresh', `data-id="${esc(row.floor)}" ${running ? 'disabled aria-busy="true"' : blocked() ? 'disabled' : ''}`)}</div></header><p id="${esc(bodyId)}" class="reading ${expanded ? '' : 'summary-collapsed'}">${esc(row.body)}</p>${row.error ? `<p class="lt-error" role="alert">${esc(row.error)}</p>` : ''}${textEntry(expanded ? '收起' : '展开全文', 'expand', `data-id="${esc(row.id)}" aria-expanded="${expanded}" aria-controls="${esc(bodyId)}"`)}</article>`;
  }
  function summaryView() {
    const current = summaryCurrentRows(), history = summaryHistoryRecords(), count = current.filter(row => row.id && row.body && !row.nativeHidden).length;
    return `<div class="summary-toolbar"><div class="summary-toolbar-main"><span class="meta">当前聊天 · ${count} 条摘要</span>${textEntry('摘要设置', 'settings-summary')}</div>${backfillControls()}</div><div class="section" aria-label="当前摘要">${current.map(summaryCurrentRow).join('')}${current.length ? '' : '<p class="meta">暂无最新摘要。</p>'}</div><section class="section benmo-summary-history" aria-label="历史摘要">${springHeading('历史摘要')}<button type="button" class="record-open" data-action="toggle-summary-history" aria-expanded="${state.summaryHistoryExpanded}" aria-controls="benmo-summary-history"><strong>历史摘要</strong><span class="meta">${history.length} 条 · ${state.summaryHistoryExpanded ? '收起' : '展开'}</span></button><div id="benmo-summary-history" class="${state.summaryHistoryExpanded ? 'section' : ''}" ${state.summaryHistoryExpanded ? '' : 'hidden'}>${state.summaryHistoryExpanded ? history.map(summaryCard).join('') : ''}</div></section>`;
  }
  // Decorative headings are hidden in every other appearance. They contain no
  // controls or source data; the existing fields keep their accessible labels.
  const springHeading = label => `<div class="benmo-spring-heading" hidden aria-hidden="true">${esc(label)}</div>`;
  const formActions = () => `<div class="form-actions">${button('取消', 'cancel')}${button(acting ? '保存中…' : '保存', 'save', acting ? 'disabled aria-busy="true"' : '', 'primary')}</div>`;
  function summarySettings() {
    const automatic=value.summary?.automatic?.message;
    return `<p class="meta" role="status" data-latest-automatic-status ${automatic?'':'hidden'}>${automatic?`自动生成：${esc(automatic)}`:''}</p><form id="benmo-edit-form" class="section">${springHeading('摘要处理')}<section class="card"><label class="ui-field"><span>最近多少楼使用原文</span><input class="ui-input" type="number" name="recentFloors" aria-label="最近多少楼使用原文" min="1" step="1" required value="${esc(draft.recentFloors)}" inputmode="numeric"></label><p class="meta">启用压缩前，请关闭预设中按 X 楼删除正文或只保留摘要的正则，以免重复处理。</p></section>${springHeading('最新摘要提示词')}<section class="card"><label class="ui-field"><span>最新摘要提示词</span><textarea class="lt-textarea lt-prompt-editor" name="prompt" rows="7" required>${esc(draft.prompt)}</textarea></label><div class="actions">${button('恢复默认提示词', 'default-prompt')}</div></section>${formActions()}</form>`;
  }
  function trackingSettings() {
    const excluded = value.tracking?.exclusions?.[state.kind] ?? {ids:[]};
    const paused = (excluded.ids ?? []).map(id => {
      const row = records().find(row => row.id === id);
      const label = row?.name || excluded.labels?.[id]?.[0] || id;
      return `<div class="section"><p class="reading meta">${esc(label)}${row ? '' : ' · 当前记录已不在列表中'}</p><div class="actions">${button('恢复追踪', 'restore-excluded', `data-id="${esc(id)}" aria-label="恢复${esc(label)}的追踪"`)}</div></div>`;
    }).join('');
    return `<form id="benmo-edit-form" class="section">${springHeading(`${KINDS[state.kind]}要求`)}<section class="card"><label class="ui-field"><span>${KINDS[state.kind]}要求</span><textarea class="lt-textarea lt-prompt-editor" name="prompt" rows="10" maxlength="20000" required>${esc(draft.prompt)}</textarea></label><div class="actions">${button('恢复默认提示词', 'default-tracking-prompt')}</div></section>${springHeading('名称排除名单')}<section class="card"><label class="ui-field"><span>名称排除名单 · 仅当前聊天</span><textarea class="lt-textarea" name="exclusionNames" rows="5" aria-describedby="tracking-exclusion-help" placeholder="一行一个名称或别名">${esc(draft.exclusionNames)}</textarea></label><p class="meta" id="tracking-exclusion-help">每行一个名称或别名，完整匹配。</p><p class="meta">排除后停止自动追踪与召回，已有资料保留；恢复只影响后续，不回补历史。</p></section>${paused ? `<section class="card"><h2>已暂停的记录</h2><p class="meta">恢复立即生效；名称排除名单仍独立生效。</p>${paused}</section>` : ''}${formActions()}</form>`;
  }
  function trackingList() {
    const rows = records();
    return `<div class="row"><span class="meta">当前聊天 · ${rows.length} 条记录${state.kind === 'npc' ? ' · NPC' : ''}</span><div class="actions">${textEntry('追踪设置', 'settings-tracking')}${button('＋ 新建', 'new', '', 'secondary')}</div></div><div class="section">${rows.map(row => `<article class="record ${state.selected === row.id ? 'selected' : ''}" data-tracking-excluded="${row.excluded === true}"><button type="button" class="record-open" data-action="detail" data-id="${esc(row.id)}" aria-label="查看${esc(row.name)}"><strong>${esc(row.name)}</strong><span class="meta"><span class="tag">${row.excluded ? '已暂停追踪' : row.pinned ? '常驻' : '触发'}</span> · 查看 ›</span></button><p>${esc(state.kind === 'item' ? row.introduction : [row.identity, row.appearance].filter(Boolean).join(' · '))}</p><p class="meta">${state.kind === 'item' ? esc(`位置：${row.location ?? ''} · 所属者：${row.owner ?? ''}`) : `最后出场：第 ${esc(row.lastAppearanceTurn ?? '—')} 个 AI 回合 · 缺席 ${esc(row.absentTurns ?? '—')} 回合`}</p><div class="keywords">${aliases(row.aliases).map(alias => `<span class="tag">${esc(alias)}</span>`).join('')}</div></article>`).join('')}${rows.length ? '' : `<p class="meta">暂无${state.kind === 'item' ? '物品' : '角色'}记录。</p>`}</div>`;
  }
  const recordPaused = row => (value.tracking?.exclusions?.[state.kind]?.ids ?? []).includes(row.id);
  function detailField(label, value, {long = false, groupStart = false} = {}) {
    const text = String(value ?? ''), empty = !text.trim();
    return `<div class="detail-field${long && !empty ? ' detail-field--long' : ''}${groupStart ? ' detail-field--group-start' : ''}"><dt>${esc(label)}</dt><dd${empty ? ' class="detail-field-empty"' : ''}>${empty ? '—' : esc(text)}</dd></div>`;
  }
  function detail() {
    const row = selectedRecord();
    if (!row) return '';
    const fields = FIELDS[state.kind].slice(1).map(([key, label]) => detailField(label, key === 'aliases' ? aliases(row.aliases).join('，') : row[key], {long: MULTILINE.has(key), groupStart: key === 'transferFrom' || key === 'aliases'})).join('');
    const customFields = (row.customFields ?? []).filter(field => String(field.value ?? '').trim());
    return `<section class="card record-detail" data-tracking-excluded="${row.excluded === true}"><div class="row"><h2>${esc(row.name)}</h2><span class="tag">${row.excluded ? '已暂停追踪' : row.pinned ? '常驻' : '触发'}</span></div>${row.excluded ? `<p class="meta">自动追踪与召回已暂停，已有资料保留。恢复后只处理后续，不回补历史。${!recordPaused(row) ? '名称或别名命中排除，请检查名称排除名单及同名暂停记录。' : ''}</p>` : ''}<div class="actions">${button(recordPaused(row) ? '恢复此记录追踪' : '暂停此记录追踪', 'toggle-excluded')}${row.excluded ? textEntry('追踪设置', 'settings-tracking') : ''}</div><dl class="detail-fields">${fields}${state.kind === 'npc' ? detailField('最后实际出场／缺席', `第 ${row.lastAppearanceTurn ?? '—'} 个 AI 回合／${row.absentTurns ?? '—'} 回合`) : ''}${customFields.map((field, index) => detailField(field.name, field.value, {long: true, groupStart: index === 0})).join('')}</dl></section><div class="detail-actions">${button('删除', 'delete-record')}${button('编辑', 'edit', '', 'primary')}</div>`;
  }
  function recordCustomFields() {
    return `<section class="section benmo-custom-fields"><h2>自定义字段</h2><p class="meta">仅属于这条${state.kind === 'item' ? '物品' : '角色'}记录。</p>${draft.customFields.map(field => `<section class="custom-field-row" data-field-id="${esc(field.id)}"><div class="custom-field-heading"><label class="ui-field"><span>字段名</span><input class="ui-input" name="${esc(`record-field-${field.id}-name`)}" value="${esc(field.name)}" maxlength="80" required placeholder="如：${state.kind === 'item' ? '耐久' : '擅长技能'}"></label>${button('移除', 'remove-field', `data-id="${esc(field.id)}" aria-label="移除此字段"`)}</div><label class="ui-field"><span>追踪要求</span><textarea class="lt-textarea lt-prompt-editor" name="${esc(`record-field-${field.id}-requirement`)}" rows="2" maxlength="1000" required placeholder="说明需要记录什么、何时更新">${esc(field.requirement)}</textarea></label><label class="ui-field"><span>当前内容</span><textarea class="lt-textarea" name="${esc(`record-field-${field.id}-value`)}" rows="2" maxlength="2000">${esc(field.value)}</textarea></label></section>`).join('')}${button('＋ 添加字段', 'add-field', '', 'secondary')}</section>`;
  }
  function editor() {
    if (state.kind === 'summary') return `<form id="benmo-edit-form" class="section"><p class="summary-origin">来源：第 ${esc(draft.floor)} 楼 · 当前选中版本</p>${!draft.id ? '<p class="meta">可输入或粘贴纯文本。保存后用于该 AI 楼层的摘要展示与压缩，用户原文保留；不会调用 API。</p>' : ''}<label class="ui-field"><span>摘要正文</span><textarea class="lt-textarea" name="body" rows="10" required>${esc(draft.body)}</textarea></label>${formActions()}</form>`;
    return `<form id="benmo-edit-form" class="section">${springHeading('基本资料')}<div class="two-cols benmo-basic-fields">${FIELDS[state.kind].map(([key, label]) => `<label class="ui-field"><span>${label}</span>${MULTILINE.has(key) ? `<textarea class="lt-textarea" name="${key}" rows="2" maxlength="600">${esc(draft[key])}</textarea>` : `<input class="ui-input" name="${key}" value="${esc(draft[key])}" ${key === 'name' ? 'required maxlength="160"' : 'maxlength="2000"'}>`}</label>`).join('')}</div><fieldset class="lt-modes" aria-label="召回方式"><legend class="ui-field__label">召回方式</legend>${[['resident', '常驻'], ['trigger', '触发']].map(([mode, label]) => `<label class="lt-mode"><input type="radio" name="mode" value="${mode}" ${draft.pinned === (mode === 'resident') ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>${state.kind === 'npc' ? '<p class="meta">最后实际出场与缺席回合由剧情记录，此处不手动填写。</p>' : ''}${recordCustomFields()}${formActions()}</form>`;
  }
  const rangesText = ranges => (ranges ?? []).map(range => Number(range.start) === Number(range.end) ? `第 ${range.start} 楼` : `第 ${range.start}—${range.end} 楼`).join('、') || '未读取';
  function narrativeReport() {
    const info = narrativeStatus(), progress = narrativeData().progress?.[state.tab], report = info.materialReport ?? progress?.materialsReport;
    if (!report) return '<p class="meta">生成后显示实际读取范围与材料用量。</p>';
    return `<section class="card benmo-material-report" aria-label="本次读取范围"><h2>本次读取范围</h2><p class="meta">原文：${esc(rangesText(report.originalRanges))}</p><p class="meta">记忆：${esc(rangesText(report.memoryRanges))}</p><p class="meta">材料用量：${report.estimated ? '估算约 ' : '宿主 tokenizer 计数 '}${esc(report.tokens)} / ${esc(report.budget)} token${report.estimated ? '（估算值，不是精确 token 数）' : ''}</p>${Number.isSafeInteger(report.promptTokens) && Number.isSafeInteger(report.outputReserve) ? `<p class="meta">另留提示词 ${esc(report.promptTokens)} token、输出 ${esc(report.outputReserve)} token；不计入材料预算，尚未核验模型上下文上限。</p>` : ''}${report.unavailableMemoryCount > 0 ? `<p class="meta" role="status">已跳过 ${esc(report.unavailableMemoryCount)} 条来源范围无法确认的记忆。</p>` : ''}${report.trimmed ? `<p class="meta" role="status">预算裁剪：已略过 ${esc(report.omittedMemoryCount ?? 0)} 条较早记忆；本批必要材料、已有结果与开启的背景保留。</p>` : '<p class="meta">材料未因预算裁剪。</p>'}</section>`;
  }
  function narrativeView() {
    const kind = state.tab, preferences = narrativePreferences(), info = narrativeStatus(), result = narrativeResults();
    const running = info.status === 'running' || narrativeJobs.has(kind);
    const entryMarkup = entry => `<article class="record benmo-narrative-entry"><div class="row"><span class="meta">${esc(rangesText(entry.sources))}</span>${button('编辑', 'edit-narrative', `data-id="${esc(entry.id)}"`)}</div><p class="reading">${esc(entry.text)}</p></article>`;
    return `<div class="row"><span class="meta">当前聊天 · ${kind === 'self' ? `${result.length} 位角色` : `${result.length} 条大纲`}</span><div class="actions">${textEntry(`${TABS[kind]}设置`, 'settings-narrative')}${button(running ? '生成中…' : '生成／更新', 'generate-narrative', running || (kind === 'self' && !preferences.characters?.length) ? `disabled ${running ? 'aria-busy="true"' : ''}` : '', 'secondary')}${running ? button('停止生成', 'cancel-narrative') : ''}</div></div><p class="meta">沿用事件记忆的批次节奏；没有重要变化时不会新增条目。${kind === 'self' ? '指定角色分别生成，选择的自述每轮注入。' : '已启用的大纲每轮注入。'}</p>${kind === 'self' && !preferences.characters?.length ? '<p class="meta">请先在角色自述设置中添加指定角色。</p>' : ''}${info.error && info.error !== (error || value.error) ? `<p class="lt-error" role="alert">${esc(info.error)}</p>` : ''}${narrativeReport()}<div class="section">${kind === 'self' ? result.map(character => { const selected = preferences.characters?.find(row => row.id === character.id); return `<section class="section benmo-narrative-group"><div class="row"><h2>${esc(character.name)}</h2><span class="meta">${selected ? selected.inject ? '每轮注入' : '未选择注入' : '保留的历史自述'}</span></div>${(character.entries ?? []).map(entryMarkup).join('')}${character.entries?.length ? '' : '<p class="meta">暂无自述。</p>'}</section>`; }).join('') : result.map(entryMarkup).join('')}${result.length ? '' : `<p class="meta">暂无${TABS[kind]}。可手动生成，也可等待下一批剧情。</p>`}</div>`;
  }
  function narrativeSwitch(key, label, checked, action = 'toggle-narrative-setting') {
    return `<div class="row"><span class="ui-field__label">${esc(label)}</span><button type="button" class="ui-switch" role="switch" aria-label="${esc(label)}" aria-checked="${checked === true}" data-action="${action}" data-id="${esc(key)}"><span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__knob" aria-hidden="true"></span></span></button></div>`;
  }
  function narrativeSettings() {
    const self = state.tab === 'self';
    return `<form id="benmo-edit-form" class="section"><section class="card"><h2>读取材料</h2>${narrativeSwitch('readMemory', '读取记忆', draft.readMemory)}${narrativeSwitch('readOriginal', '读取本批原文', draft.readOriginal)}<p class="meta">记忆与原文至少选择一项。已有${TABS[state.tab]}单独传入；历史记忆只读到本批结束。</p>${self ? `${narrativeSwitch('readCard', '读取角色卡基础设定', draft.readCard)}<p class="meta">仅读取 description、personality、scenario，作为故事初始状态；不读取世界书、开场脚本或其他分支。</p>` : ''}<label class="ui-field"><span>补充背景</span><textarea class="lt-textarea" name="background" rows="5" placeholder="可粘贴本条路线或世界设定">${esc(draft.background)}</textarea></label><p class="meta">背景与角色卡可同时使用；作者秘密与未来安排不会自动成为角色已知事实。</p></section>${self ? `<section class="card"><h2>指定角色与注入</h2><p class="meta">所有指定角色都会生成自述；分别选择哪些角色的自述每轮注入。</p>${draft.characters.map(character => `<section class="section"><div class="custom-field-heading"><label class="ui-field"><span>角色姓名</span><input class="ui-input" name="${esc(`narrative-character-${character.id}`)}" value="${esc(character.name)}" maxlength="160" required></label>${button('移除', 'remove-narrative-character', `data-id="${esc(character.id)}" aria-label="移除此指定角色"`)}</div>${narrativeSwitch(character.id, `${character.name || '此角色'}的自述每轮注入`, character.inject, 'toggle-narrative-injection')}</section>`).join('')}${button('＋ 添加角色', 'add-narrative-character', '', 'secondary')}</section>` : ''}<section class="card"><div class="two-cols"><label class="ui-field"><span>材料预算（token）</span><input class="ui-input" name="budget" type="number" min="1" step="1" inputmode="numeric" required value="${esc(draft.budget)}"></label><label class="ui-field"><span>注入深度</span><input class="ui-input" name="depth" type="number" min="0" max="10000" step="1" inputmode="numeric" required value="${esc(draft.depth)}"></label></div><p class="meta">材料预算合计背景、已有结果、记忆与原文，提示词与输出另留空间。优先保留本批必要材料，再由近到远选择历史记忆；必要材料超限会报错，请调整预算或材料。</p><p class="meta">有宿主 tokenizer 时按其计数，否则明确显示估算。同一位置先注入故事大纲，再注入角色自述。</p></section><section class="card"><label class="ui-field"><span>${TABS[state.tab]}内容提示词</span><textarea class="lt-textarea lt-prompt-editor" name="prompt" rows="12" maxlength="20000" required>${esc(draft.prompt)}</textarea></label><p class="meta">可以修改内容要求；输出结构、历史前缀保护与来源校验由插件固定。</p><div class="actions">${button('恢复默认提示词', 'default-narrative-prompt')}</div></section>${formActions()}</form>`;
  }
  function narrativeEditor() {
    return `<form id="benmo-edit-form" class="section"><p class="summary-origin">来源：${esc(rangesText(draft.sources))}</p><label class="ui-field"><span>${TABS[state.tab]}正文</span><textarea class="lt-textarea" name="text" rows="10" required>${esc(draft.text)}</textarea></label><p class="meta">手动修改保存到当前聊天；自动生成仍只允许更新末两条或追加。</p>${formActions()}</form>`;
  }
  function narrativeSettingsDraft(preferences, kind = state.tab) {
    const next = {...preferences, readMemory: preferences.readMemory !== false, readOriginal: preferences.readOriginal !== false, background: preferences.background ?? '', budget: String(preferences.budget ?? 30000), depth: String(preferences.depth ?? 9999), prompt: preferences.prompt || controller.defaultNarrativePrompts?.[kind] || ''};
    if (kind === 'self') { next.readCard = preferences.readCard !== false; next.characters = clone(preferences.characters ?? []); }
    return next;
  }
  function startNarrativeSettings() {
    remember(); epoch++; returnRoute = 'list'; original = clone(narrativePreferences());
    draft = narrativeSettingsDraft(original); baseline = clone(draft); narrativeRecovery = null; narrativeDraftTarget = clone(value.target ?? null);
    state.route = 'narrative-settings'; error = ''; state.scrolls[context()] = 0; render();
  }
  // Reload refreshes source authority without losing unsaved changes. Rebase
  // only after comparing base/local/current, never turn a stale full result
  // array into an unconditional replacement for a background update.
  function recoverNarrativeDraft() {
    if (!draft || !['narrative-settings', 'narrative-edit'].includes(state.route)) return;
    if (narrativeDraftTarget && value.target && (narrativeDraftTarget.chatId !== value.target.chatId || narrativeDraftTarget.rootId !== value.target.rootId)) {
      narrativeRecovery = {type: 'target'};
      error = '聊天已切换，不能将原聊天草稿保存到新聊天。草稿仍保留在下方，请复制后返回列表重新打开。';
      return;
    }
    const local = clone(draft), base = clone(baseline), kind = state.tab, route = state.route, ticket = epoch;
    const latest = clone(route === 'narrative-settings' ? narrativePreferences(kind) : narrativeResults(kind));
    let currentDraft;
    if (route === 'narrative-settings') currentDraft = narrativeSettingsDraft(latest, kind);
    else {
      const find = rows => kind === 'self' ? rows.flatMap(character => character.entries.map(entry => ({owner: character.id, entry}))).find(row => row.entry.id === local.id) : rows.map(entry => ({owner: null, entry})).find(row => row.entry.id === local.id);
      const current = find(latest), before = find(original);
      if (!current || !before || current.owner !== before.owner) {
        narrativeRecovery = {type: 'missing'};
        error = '原条目已删除、合并或移到其他角色，无法直接覆盖。草稿仍保留在下方，请复制后返回列表，重新选择要编辑的条目。';
        return;
      }
      currentDraft = clone(current.entry);
    }
    const keys = route === 'narrative-edit' ? ['text'] : Object.keys(currentDraft);
    const changed = keys.filter(key => !same(local[key], base[key]));
    const conflicts = changed.filter(key => !same(currentDraft[key], base[key]) && !same(currentDraft[key], local[key]));
    const labels = {text:'正文',readMemory:'读取记忆',readOriginal:'读取本批原文',readCard:'读取角色卡',background:'补充背景',budget:'材料预算',depth:'注入深度',prompt:'内容提示词',characters:'指定角色与注入'};
    const describe = value => typeof value === 'boolean' ? value ? '开启' : '关闭' : Array.isArray(value) ? value.map(row => `${row.name}（${row.inject ? '注入' : '不注入'}）`).join('、') || '未指定角色' : String(value ?? '');
    const accept = chosenLocal => {
      if (disposed || suspended || epoch !== ticket || state.route !== route || !draft) return;
      const merged = clone(currentDraft);
      for (const key of changed) if (chosenLocal.has(key) || !conflicts.includes(key)) merged[key] = clone(local[key]);
      original = clone(latest); baseline = clone(currentDraft); draft = merged;
      narrativeRecovery = null; dialog = null; error = '';
    };
    if (!conflicts.length) { accept(new Set()); return; }
    narrativeRecovery = {type: 'conflict'};
    error = '最新内容与草稿修改了相同字段，草稿已保留。请重新读取并选择如何处理，再保存。';
    const chosenLocal = new Set(); let index = 0;
    const choose = useLocal => {
      if (useLocal) chosenLocal.add(conflicts[index]);
      if (++index === conflicts.length) accept(chosenLocal); else showConflict();
    };
    const showConflict = () => {
      const key = conflicts[index];
      dialog = {text: `第 ${index + 1}／${conflicts.length} 项冲突：${labels[key] ?? key}。请选择保留哪份修改；其他字段的新内容与草稿会保留。选择完后仍需点击保存。`, pending: false,
        details: [{label: labels[key] ?? key, latest: describe(currentDraft[key]), local: describe(local[key])}],
        confirmLabel: '采用草稿修改', cancelLabel: '保留后台新内容', action: () => choose(true), cancelAction: () => choose(false)};
    };
    showConflict();
  }
  function startNarrativeEdit(id) {
    const entry = narrativeEntry(id); if (!entry) return;
    remember(); epoch++; returnRoute = 'list'; original = clone(narrativeResults()); draft = clone(entry); baseline = clone(draft); narrativeRecovery = null; narrativeDraftTarget = clone(value.target ?? null);
    state.selected = id; state.route = 'narrative-edit'; error = ''; state.scrolls[context()] = 0; render();
  }
  async function saveNarrative() {
    readDraft(); const submitted = clone(draft), previous = clone(original), operationEpoch = epoch, route = state.route, kind = state.tab;
    let next;
    if (route === 'narrative-settings') {
      if (!submitted.readMemory && !submitted.readOriginal) throw new Error('读取记忆与读取原文至少选择一项');
      const budget = Number(submitted.budget), depth = Number(submitted.depth);
      if (!String(submitted.budget).trim() || !Number.isSafeInteger(budget) || budget < 1) throw new Error('请填写大于 0 的整数材料预算');
      if (!String(submitted.depth).trim() || !Number.isSafeInteger(depth) || depth < 0 || depth > 10000) throw new Error('请填写 0—10000 的整数注入深度');
      if (!submitted.prompt.trim() || submitted.prompt.length > 20000) throw new Error('请填写有效的内容提示词（最多 20000 字）');
      const payload = {...submitted, budget, depth};
      if (kind === 'self') {
        payload.characters = submitted.characters.map(row => ({...row, name: row.name.trim()}));
        if (payload.characters.some(row => !row.name) || new Set(payload.characters.map(row => row.name)).size !== payload.characters.length) throw new Error('请填写不重复的角色姓名');
      }
      next = await controller.saveNarrativePreferences(kind, payload, {original: previous});
    } else {
      if (!submitted.text.trim()) throw new Error('请填写正文');
      const replace = entries => entries.map(entry => entry.id === submitted.id ? {...entry, text: submitted.text} : entry);
      const entries = kind === 'self' ? previous.map(character => ({...character, entries: replace(character.entries)})) : replace(previous);
      next = await controller.saveNarrativeEntries(kind, entries, {original: previous});
    }
    if (disposed) return;
    apply(next);
    if (epoch !== operationEpoch || suspended || !draft) return;
    remember(); const newer = clone(draft);
    if (!same(newer, submitted)) {
      baseline = clone(submitted); draft = newer;
      original = clone(route === 'narrative-settings' ? narrativePreferences(kind) : narrativeResults(kind));
      acting = false; render(); toast('已保存提交内容；新修改尚未保存');
    } else { state.route = returnRoute; clearDraft(); acting = false; render(); toast('已保存'); }
  }
  async function generateNarrative() {
    const kind = state.tab;
    if (!NARRATIVES.includes(kind) || blocked() || narrativeJobs.has(kind) || narrativeStatus().status === 'running') return;
    const operationEpoch = epoch, token = {}; narrativeJobs.set(kind, token); remember(); render();
    try { const next = await controller.generateNarrative(kind); if (!disposed && narrativeJobs.get(kind) === token) apply(next); }
    catch (failure) { if (!disposed && !suspended && epoch === operationEpoch && narrativeJobs.get(kind) === token) error = failure.message || '生成未完成，请重试'; }
    finally { if (narrativeJobs.get(kind) === token) narrativeJobs.delete(kind); if (!disposed && !suspended && epoch === operationEpoch) { remember(); render(); } }
  }
  function content() {
    if (state.route === 'narrative-settings') return narrativeSettings();
    if (state.route === 'narrative-edit') return narrativeEditor();
    if (state.route === 'tracking-settings') return trackingSettings();
    if (state.route === 'summary-settings') return summarySettings();
    if (state.route === 'edit') return editor();
    if (state.route === 'detail') return detail();
    if (state.tab !== 'records') return narrativeView();
    return `<nav class="subtabs lt-view-switch ui-segment-group" role="group" aria-label="兰台记录功能">${enabledKinds().map(id => selectButton(id, KINDS[id], state.kind, 'kind')).join('')}</nav>${state.kind === 'summary' ? summaryView() : trackingList()}`;
  }
  function pageTitle() {
    if (state.route === 'narrative-settings') return `${TABS[state.tab]}设置`;
    if (state.route === 'narrative-edit') return `编辑${TABS[state.tab]}`;
    if (state.route === 'tracking-settings') return `${KINDS[state.kind]}设置`;
    if (state.route === 'summary-settings') return '最新摘要设置';
    if (state.route === 'detail') return state.kind === 'item' ? '物品详情' : '角色详情';
    if (state.route === 'edit') return state.kind === 'summary' ? draft?.id ? '编辑最新摘要' : '手动补录摘要' : `${returnRoute === 'list' && !original ? '新建' : '编辑'}${state.kind === 'item' ? '物品' : '角色'}`;
    return '本末';
  }
  let renderedMarkup = null;
  function render() {
    if (disposed || suspended) return;
    if (externalPolicy().transient) { syncWriteControls(); return; }
    renderedPolicy = JSON.stringify(policy());
    if (!normalize()) { stopSummaryVisibility(); app.innerHTML = ''; renderedMarkup = null; redirectToSettings(); return; }
    if (state.tab === 'records' && state.kind === 'summary') startSummaryVisibility(); else stopSummaryVisibility();
    const focused = app.getRootNode().activeElement;
    const focusName = focused?.name, focusValue = focused?.value, focusData = focused?.dataset ? JSON.stringify({...focused.dataset}) : null;
    const subpage = state.route !== 'list';
    const markup = `<section class="lantai workshop benmo ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(app)}" data-benmo-route="${state.route}" data-benmo-tab="${state.tab}" data-benmo-kind="${state.kind}">${subpage ? `<header class="lt-header ui-header subpage-header">${icon(draft && returnRoute === 'detail' ? '返回记录详情' : `返回${state.tab === 'records' ? KINDS[state.kind] : TABS[state.tab]}`, 'back', 'back')}<h1 class="ui-page-title">${pageTitle()}</h1>${icon('关闭兰台', 'close', 'close')}</header>` : `<header class="lt-header lt-header--root ui-header"><div class="lt-root-top"><h1 class="ui-page-title">本末</h1>${icon('关闭兰台', 'close', 'close')}</div><nav class="ui-tablist" aria-label="本末分区">${enabledTabs().map(id => selectButton(id, TABS[id], state.tab, 'tab')).join('')}</nav></header>`}<main class="lt-main ui-main" tabindex="-1">${error || value.error ? `<p class="lt-error" role="alert">${esc(error || value.error)}</p>${button('重新读取', 'reload')}` : ''}${content()}</main><footer class="lt-footer">${mainNavigation({policy: policy(), current: 'benmo', actions: {memory: 'area', time: 'area', workshop: 'area', benmo: 'area', settings: 'area'}, attributes: Object.fromEntries(['memory', 'time', 'workshop', 'benmo', 'settings'].map(area => [area, `data-id="${area}"`]))})}</footer>${dialog ? `<div class="wk-dialog" role="dialog" aria-modal="true" aria-label="确认操作"><div class="wk-dialog-box"><p>${esc(dialog.pending ? '正在处理，请稍候…' : dialog.text)}</p>${(dialog.details ?? []).map(item => `<section class="section"><label class="ui-field"><span>后台新内容</span><textarea class="lt-textarea" rows="3" readonly aria-label="后台${esc(item.label)}">${esc(item.latest)}</textarea></label><label class="ui-field"><span>你的草稿</span><textarea class="lt-textarea" rows="3" readonly aria-label="草稿${esc(item.label)}">${esc(item.local)}</textarea></label></section>`).join('')}<div class="wk-dialog-actions">${button(dialog.cancelLabel ?? '取消', 'cancel-dialog', dialog.pending ? 'disabled' : '')}${button(dialog.pending ? '处理中…' : dialog.confirmLabel ?? '确认', 'confirm-dialog', dialog.pending ? 'disabled aria-busy="true"' : '', 'primary')}</div></div></div>` : ''}</section>`;
  // Repeated runtime receipts must not replace an unchanged surface.
  if (markup !== renderedMarkup) { replaceSurfaceMarkup(app, markup, renderedMarkup); renderedMarkup = markup; }
    const main = app.querySelector('.lt-main');
    if (main) main.scrollTop = state.scrolls[context()] ?? 0;
    if (dialog) {
      for (const node of app.querySelectorAll('.lt-header,.lt-main,.lt-footer')) node.inert = true;
      app.querySelector('[data-action="cancel-dialog"]')?.focus({preventScroll: true});
    } else if (focused) {
      const next = [...app.querySelectorAll('[data-action],input,textarea')].find(node => focusName ? node.name === focusName && (node.type !== 'radio' || node.value === focusValue) : focusData && JSON.stringify({...node.dataset}) === focusData);
      next?.focus?.({preventScroll: true});
    }
  }
  function confirm(text, action, labels = {}) { remember(); dialog = {text, action, pending: false, ...labels}; render(); }
  function leave(action) { if (dirty()) confirm('放弃未保存的修改？', action, {cancelLabel: '继续编辑', confirmLabel: '放弃修改'}); else action(); }
  function clearDraft() { draft = baseline = original = null; narrativeRecovery = narrativeDraftTarget = null; }
  function goBack() {
    remember(); epoch++; dialog = null;
    if (draft) { state.route = returnRoute; if (returnRoute === 'list') state.selected = state.selections[state.kind] ?? null; clearDraft(); }
    else state.route = 'list';
    render();
  }
  function back() {
    leave(() => state.route === 'list' ? navigate(policy().memory ? 'memory' : 'settings') : goBack());
  }
  function navigate(area) {
    const available = policy();
    if (area === 'benmo' || !['memory', 'time', 'workshop', 'settings'].includes(area) || (area !== 'settings' && !available[area])) return;
    const snapshot = snapshotNavigation(); epoch++; state.route = snapshot.route; clearDraft(); dialog = null;
    onNavigate(area, snapshot);
  }
  function makeDraft(record, kind = state.kind) {
    return {id: record?.id ?? crypto.randomUUID(), ...Object.fromEntries(FIELDS[kind].map(([key]) => [key, key === 'aliases' ? aliases(record?.aliases).join('，') : record?.[key] ?? ''])), pinned: record?.pinned === true, customFields: (record?.customFields ?? []).map(field => ({id: field.id, name: field.name ?? '', requirement: field.requirement ?? '', value: field.value ?? ''}))};
  }
  function startEdit(record, destination, route = 'edit') {
    remember(); epoch++; returnRoute = destination; original = record ? clone(record) : null;
    draft = route === 'tracking-settings' ? {prompt: value.tracking?.prompts?.[state.kind] ?? controller.defaultTrackingPrompts?.[state.kind] ?? '', exclusionNames: (value.tracking?.exclusions?.[state.kind]?.names ?? []).join('\n')}
      : route === 'summary-settings' ? {recentFloors: String(value.summary?.preferences?.recentFloors ?? 6), prompt: value.summary?.preferences?.prompt ?? controller.defaultPrompt ?? ''}
      : state.kind === 'summary' ? {id: record.id, floor: record.floor, body: record.body ?? ''} : makeDraft(record);
    baseline = clone(draft); state.route = route; error = ''; state.scrolls[context()] = 0; render();
  }
  const apply = next => { value = next ?? controller.snapshot?.() ?? value; error = ''; };
  async function saveTrackingSettings(kind, submitted, operationEpoch) {
    const before = clone(baseline);
    let next = value;
    if (submitted.prompt !== before.prompt) {
      next = await controller.saveTrackingPrompt(kind, submitted.prompt, {original:before.prompt});
      // A successful first write must not be retried against a stale prompt
      // if saving the chat-local names subsequently fails.
      if (!disposed && epoch === operationEpoch && baseline) baseline.prompt = submitted.prompt;
    }
    if (submitted.exclusionNames !== before.exclusionNames) {
      next = await controller.saveExclusionNames(kind, submitted.exclusionNames.split(/\r?\n/).map(name => name.trim()).filter(Boolean), {original: before.exclusionNames.split('\n').filter(Boolean)});
      if (!disposed && epoch === operationEpoch && baseline) baseline.exclusionNames = (next.tracking?.exclusions?.[kind]?.names ?? []).join('\n');
    }
    return next;
  }
  async function save() {
    if (!draft || blocked() || composing || !app.querySelector('form')?.reportValidity()) return;
    if (['narrative-settings', 'narrative-edit'].includes(state.route)) return saveNarrative();
    readDraft(); const submitted = clone(draft), operationEpoch = epoch, route = state.route, kind = state.kind;
    let payload = submitted;
    if (route === 'tracking-settings') {
      if (!submitted.prompt.trim() || submitted.prompt.length > 20000) throw new Error('请填写有效的追踪要求（最多 20000 字）');
    } else if (route === 'summary-settings') {
      const count = Number(submitted.recentFloors);
      if (!Number.isSafeInteger(count) || count < 1 || !submitted.prompt.trim()) throw new Error('请填写有效楼数和提示词');
      payload = {...submitted, recentFloors: count};
    } else if (kind === 'summary') {
      if (!submitted.body.trim()) throw new Error('请填写摘要正文');
    } else {
      payload = {...submitted, name: submitted.name.trim(), aliases: aliases(submitted.aliases), customFields: submitted.customFields.map(field => ({...field, name: field.name.trim(), requirement: field.requirement.trim()}))};
      if (!payload.name) throw new Error('请填写名称');
      if (payload.customFields.some(field => !field.name || !field.requirement) || new Set(payload.customFields.map(field => field.name)).size !== payload.customFields.length) throw new Error('请填写字段名和追踪要求，字段名不要重复');
    }
    const next = route === 'tracking-settings' ? await saveTrackingSettings(kind, submitted, operationEpoch)
      : route === 'summary-settings' ? await controller.saveSummaryPreferences(payload)
      : kind === 'summary' ? submitted.id ? await controller.saveSummary(submitted.id, submitted.body, {original}) : await controller.manualSummary(submitted.floor, submitted.body, {original})
        : await controller.saveRecord(kind, payload, {original});
    if (disposed) return;
    apply(next);
    if (epoch !== operationEpoch || suspended || !draft) return;
    remember(); const newer = clone(draft);
    if (!same(newer, submitted)) {
      const saved = ['summary-settings','tracking-settings'].includes(route) ? null : kind !== 'summary' ? records(kind).find(row => row.id === submitted.id) : summaryRecords().find(row => submitted.id ? row.id === submitted.id : row.floor === submitted.floor && row.replyId === original?.replyId);
      const savedDraft = saved ? (kind === 'summary' ? {id: saved.id, floor: saved.floor, body: saved.body} : makeDraft(saved, kind)) : route === 'summary-settings' ? {...payload, recentFloors: String(payload.recentFloors)} : route === 'tracking-settings' ? {...submitted, exclusionNames: (value.tracking?.exclusions?.[kind]?.names ?? []).join('\n')} : clone(submitted);
      baseline = clone(savedDraft); draft = {...savedDraft, ...Object.fromEntries(Object.entries(newer).filter(([key, text]) => !same(text, submitted[key])))};
      if (saved) original = clone(saved);
      acting = false; render(); toast('已保存提交内容；新修改尚未保存');
    } else {
      if (kind !== 'summary' && route !== 'tracking-settings') { state.selected = submitted.id; state.selections[kind] = submitted.id; }
      state.route = returnRoute; clearDraft(); acting = false; render(); toast('已保存');
    }
  }
  async function generate(floor) {
    if (blocked() || generating.has(floor) || !Number.isSafeInteger(floor) || !policy().summary || runningRows().some(row => Number(row.floor) === floor)) return;
    const source = summarySource(floor);
    if (!source || source.nativeHidden || summaryRunning(source) || (!(source.id && source.body) && !missingRows().some(row => Number(row.floor) === floor))) return;
    const operationEpoch = epoch, token = {replyId: summarySource(floor)?.replyId, observed: false}; generating.set(floor, token); remember(); render();
    try { const next = await controller.generateSummary(floor); if (!disposed && generating.get(floor) === token) apply(next); }
    catch (failure) { if (!disposed && generating.get(floor) === token && epoch === operationEpoch) error = failure.message || '摘要生成未完成，请重试'; }
    finally { if (generating.get(floor) === token) generating.delete(floor); if (!disposed && !suspended && epoch === operationEpoch) { remember(); render(); } }
  }
  async function startBackfill() {
    if (blocked() || backfillRunning() || !missingRows().length || !controller.startSummaryBackfill) return;
    const token = {}, operationEpoch = epoch; backfillJob = token; error = ''; remember(); render();
    try { const next = await controller.startSummaryBackfill(); if (!disposed && backfillJob === token) apply(next); }
    catch (failure) { if (!disposed && !suspended && backfillJob === token && epoch === operationEpoch) error = failure.message || '补缺未完成，请重试'; }
    finally { if (backfillJob === token) backfillJob = null; if (!disposed && !suspended && epoch === operationEpoch) { remember(); render(); } }
  }
  async function stopBackfill() {
    if (!controller.stopSummaryBackfill) return;
    const operationEpoch = epoch;
    backfillJob = null;
    const next = await controller.stopSummaryBackfill();
    if (!disposed) { apply(next);if (!suspended && epoch === operationEpoch) { remember();render(); } }
  }
  app.addEventListener('submit', event => event.preventDefault(), {signal: lifetime.signal});
  app.addEventListener('compositionstart', () => { composing = true; }, {signal: lifetime.signal});
  app.addEventListener('compositionend', () => { composing = false; }, {signal: lifetime.signal});
  function syncWriteControls() {
    if (disposed || suspended) return;
    for (const node of app.querySelectorAll('[data-action="save"]')) {
      node.disabled = blocked() || acting;
      if (acting) node.setAttribute('aria-busy', 'true'); else node.removeAttribute('aria-busy');
      node.textContent = acting ? '保存中…' : '保存';
    }
  }
  app.addEventListener('click', async event => {
    const control = event.target.closest('[data-action]');
    if (!control || control.disabled || disposed || suspended) return;
    const action = control.dataset.action, id = control.dataset.id;
    if (dialog && !['cancel-dialog', 'confirm-dialog'].includes(action)) return;
    if (acting && !['back', 'cancel', 'close', 'area', 'cancel-dialog', 'confirm-dialog'].includes(action)) return;
    if (composing && ['save', 'restore-excluded', 'add-field', 'remove-field', 'default-prompt', 'default-tracking-prompt', 'default-narrative-prompt', 'add-narrative-character', 'remove-narrative-character', 'toggle-narrative-setting', 'toggle-narrative-injection'].includes(action)) return;
    let ownsAction = false;
    const actionEpoch = epoch;
    try {
      if (action === 'cancel-dialog') { if (dialog && !dialog.pending) { const pending = dialog; pending.cancelAction?.(); if (dialog === pending) dialog = null; render(); } return; }
      if (action === 'confirm-dialog') {
        if (!dialog || dialog.pending) return;
        const pending = dialog; pending.pending = true; acting = ownsAction = true; render();
        await pending.action(); if (disposed) return; if (dialog === pending) dialog = null; render(); return;
      }
      if (action === 'back' || action === 'cancel') { if (action === 'cancel') leave(goBack); else back(); return; }
      if (action === 'close') { leave(() => { epoch++; clearDraft(); dialog = null; suspended = true; app.inert = true; stopSummaryVisibility(); onClose(); }); return; }
      if (action === 'area') { leave(() => navigate(id)); return; }
      if (action === 'reload') { acting = ownsAction = true; remember(); const token = epoch; const next = await controller.load({refresh: true}); if (!disposed && token === epoch) { remember(); apply(next); invalidated = false; recoverNarrativeDraft(); render(); } return; }
      if (action === 'tab' && enabledTabs().includes(id)) { leave(() => { remember(); epoch++; state.tab = id; state.route = 'list'; clearDraft(); render(); }); return; }
      if (action === 'kind' && enabledKinds().includes(id)) { leave(() => { remember(); epoch++; state.kind = id; state.route = 'list'; state.selected = state.selections[id] ?? null; clearDraft(); render(); }); return; }
      if (action === 'settings-narrative' && NARRATIVES.includes(state.tab)) { startNarrativeSettings(); return; }
      if (action === 'edit-narrative' && NARRATIVES.includes(state.tab)) { startNarrativeEdit(id); return; }
      if (action === 'generate-narrative') { await generateNarrative(); return; }
      if (action === 'cancel-narrative' && NARRATIVES.includes(state.tab)) {
        const kind = state.tab, token = epoch; const next = await controller.cancelNarrative(kind); narrativeJobs.delete(kind);
        if (!disposed) { apply(next); if (!suspended && epoch === token) { remember(); render(); } } return;
      }
      if (action === 'default-narrative-prompt' && state.route === 'narrative-settings') { remember(); draft.prompt = controller.defaultNarrativePrompts?.[state.tab] ?? ''; render(); return; }
      if (action === 'toggle-narrative-setting' && state.route === 'narrative-settings' && ['readMemory', 'readOriginal', 'readCard'].includes(id)) { remember(); draft[id] = !draft[id]; render(); return; }
      if (action === 'toggle-narrative-injection' && state.route === 'narrative-settings') { remember(); const character = draft.characters?.find(row => row.id === id); if (character) { character.inject = !character.inject; render(); } return; }
      if (action === 'add-narrative-character' && state.route === 'narrative-settings' && state.tab === 'self') { remember(); draft.characters.push({id: crypto.randomUUID(), name: '', inject: true}); render(); return; }
      if (action === 'remove-narrative-character' && state.route === 'narrative-settings' && state.tab === 'self') { remember(); draft.characters = draft.characters.filter(row => row.id !== id); render(); return; }
      if (action === 'settings-tracking' && FIELDS[state.kind]) { startEdit(null, state.route === 'detail' ? 'detail' : 'list', 'tracking-settings'); return; }
      if (action === 'default-tracking-prompt' && state.route === 'tracking-settings') { remember(); draft.prompt = controller.defaultTrackingPrompts?.[state.kind] ?? ''; render(); return; }
      if (action === 'settings-summary' && state.kind === 'summary') { startEdit(null, 'list', 'summary-settings'); return; }
      if (action === 'default-prompt' && state.route === 'summary-settings') { remember(); draft.prompt = controller.defaultPrompt ?? ''; render(); return; }
      if (action === 'expand') { remember(); state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); render(); return; }
      if (action === 'toggle-summary-history' && state.kind === 'summary') { remember(); state.summaryHistoryExpanded = !state.summaryHistoryExpanded; render(); return; }
      if (action === 'manual-summary' && state.kind === 'summary' && !blocked()) { const row = missingRows().find(record => Number(record.floor) === Number(id));if (row && !generating.has(Number(id))) startEdit(row, 'list');return; }
      if (action === 'start-backfill' && state.kind === 'summary') { await startBackfill();return; }
      if (action === 'stop-backfill' && state.kind === 'summary') { await stopBackfill();return; }
      if (action === 'generate' && state.kind === 'summary') { await generate(Number(id)); return; }
      if (action === 'detail') {
        if (!records().some(row => row.id === id)) return;
        remember(); epoch++; state.selected = id; state.selections[state.kind] = id; state.route = 'detail'; state.scrolls[context()] = 0; render(); return;
      }
      if (action === 'edit' && state.route === 'detail') { const row = selectedRecord(); if (row) startEdit(row, 'detail'); return; }
      if (action === 'edit-summary') { const row = summaryRecords().find(record => record.id === id); if (row && !row.nativeHidden && !summaryCurrentRows().some(current => Number(current.floor) === Number(row.floor) && current.nativeHidden)) startEdit(row, 'list'); return; }
      if (action === 'new' && FIELDS[state.kind] && !blocked()) { remember(); state.selected = null; startEdit(null, 'list'); return; }
      if (action === 'add-field' && draft?.customFields) { remember(); draft.customFields.push({id: crypto.randomUUID(), name: '', requirement: '', value: ''}); render(); return; }
      if (action === 'remove-field' && draft?.customFields) {
        remember(); const field = draft.customFields.find(row => row.id === id); if (!field) return;
        const remove = () => { draft.customFields = draft.customFields.filter(row => row.id !== id); dialog = null; render(); };
        if (field.value.trim()) confirm(`移除这条记录的“${field.name}”字段及当前内容？保存后生效，取消编辑则保留。`, remove); else remove(); return;
      }
      if (action === 'restore-excluded' && state.route === 'tracking-settings' && !blocked()) {
        const kind = state.kind, token = epoch;
        if (!(value.tracking?.exclusions?.[kind]?.ids ?? []).includes(id)) return;
        remember(); acting = ownsAction = true;
        const next = await controller.setRecordExcluded(kind, id, false);
        if (disposed) return;
        if (epoch === token && !suspended) remember();
        apply(next);
        if (epoch !== token || suspended) return;
        render(); toast('已解除记录暂停；名称排除名单仍独立生效'); return;
      }
      if (action === 'toggle-excluded' && state.route === 'detail' && !blocked()) {
        const row = selectedRecord(), kind = state.kind, token = epoch; if (!row) return;
        const excluded = !recordPaused(row);
        acting = ownsAction = true;
        const next = await controller.setRecordExcluded(kind, row.id, excluded);
        if (disposed) return;
        apply(next);
        if (epoch !== token || suspended) return;
        render();
        toast(excluded ? '已暂停此记录追踪' : selectedRecord()?.excluded ? '已移除记录暂停；名称排除仍生效' : '已恢复追踪，不回补历史');
        return;
      }
      if (action === 'delete-record' && state.route === 'detail' && !blocked()) {
        const row = selectedRecord(), kind = state.kind, token = epoch; if (!row) return;
        confirm(`删除“${row.name}”这条${kind === 'item' ? '物品' : '角色'}记录？`, async () => {
          const next = await controller.deleteRecord(kind, row.id); if (disposed) return; apply(next);
          if (epoch !== token || suspended) return;
          state.selected = null; state.selections[kind] = null; state.route = 'list'; dialog = null; render(); toast('已删除');
        }); return;
      }
      if (action === 'save' && !blocked()) { acting = ownsAction = true; syncWriteControls(); await save(); }
    } catch (failure) {
      if (!disposed && !suspended && actionEpoch === epoch) { remember(); dialog = null; error = failure.message || '操作未完成，请重试'; value = {...value, writeBlocked: controller.snapshot?.().writeBlocked ?? value.writeBlocked}; acting = false; render(); }
    } finally { if (ownsAction) { acting = false; syncWriteControls(); } }
  }, {signal: lifetime.signal});
  app.addEventListener('keydown', event => {
    if (!dialog || composing || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!dialog.pending) { dialog = null; render(); } }
    if (event.key === 'Tab') {
      const controls = [...app.querySelectorAll('.wk-dialog button,.wk-dialog textarea')].filter(node => !node.disabled);
      if (!controls.length) return;
      event.preventDefault(); const index = controls.indexOf(app.getRootNode().activeElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    }
  }, {signal: lifetime.signal});
  const unsubscribe = controller.subscribe?.(next => {
    if (disposed) return;
    value = next;
    const automaticStatus=app.querySelector('[data-latest-automatic-status]');
    if(automaticStatus){const message=value.summary?.automatic?.message;automaticStatus.textContent=message?`自动生成：${message}`:'';automaticStatus.hidden=!message;}
    reconcileGenerating();
    reconcileBackfill();
    // A background receipt must never rebuild an active input or its baseline.
    if (!draft && !acting && !dialog && !suspended) { remember(); render(); }
    else for (const node of app.querySelectorAll('[data-action="save"],[data-action="delete-record"],[data-action="toggle-excluded"],[data-action="restore-excluded"]')) node.disabled = blocked() || acting;
  });
  function startSummaryVisibility() {
    if (disposed || suspended || observingSummaryVisibility || !controller.observeSummaryVisibility) return;
    observingSummaryVisibility = true;
    summaryVisibilityDisposer = controller.observeSummaryVisibility({document: app.ownerDocument});
  }
  function stopSummaryVisibility() {
    const dispose = summaryVisibilityDisposer;
    summaryVisibilityDisposer = null; observingSummaryVisibility = false;
    dispose?.();
  }
  render();
  return {
    back() { if (!dialog && !acting) back(); },
    blocking() { return acting || dirty() || !!dialog; },
    snapshotNavigation,
    refreshAvailability() { if (JSON.stringify(policy()) !== renderedPolicy || externalPolicy().transient) { remember(); render(); } },
    invalidate(message) { remember(); epoch++; invalidated = true; error = message; value = {...value, writeBlocked: true}; render(); },
    suspend() { if (disposed || suspended) return; remember(); suspended = true; epoch++; app.inert = true; stopSummaryVisibility(); },
    resume() { if (disposed) return; suspended = false; app.inert = false; render(); },
    dispose() { if (disposed) return; disposed = true; epoch++; stopSummaryVisibility(); unsubscribe?.(); lifetime.abort(); clearTimeout(toastTimer); clearTimeout(redirectTimer); app.innerHTML = ''; },
  };
}
