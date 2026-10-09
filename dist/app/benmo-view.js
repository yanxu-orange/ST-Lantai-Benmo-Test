import {mainNavigation} from './navigation.js';
import {surfaceTheme} from './styles/theme.js';

const TABS = {records: '兰台记录', self: '角色自述', outline: '故事大纲'};
const KINDS = {summary: '最新摘要', item: '物品追踪', npc: '角色追踪'};
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
export async function mountBenmoView({container: app, controller, availability = () => ({}), onNavigate = () => {}, onClose = () => {}, initialState = {}} = {}) {
  initialState ??= {};
  const lifetime = new AbortController();
  let value = await controller.load();
  let disposed = false, suspended = false, acting = false, composing = false;
  let error = '', dialog = null, draft = null, baseline = null, original = null, invalidated = false, renderedPolicy = '';
  let returnRoute = 'list', epoch = 0, toastTimer, redirectTimer;
  const generating = new Map();
  const state = {
    tab: Object.hasOwn(TABS, initialState.tab) ? initialState.tab : 'records',
    kind: Object.hasOwn(KINDS, initialState.kind) ? initialState.kind : 'summary',
    route: initialState.route === 'detail' ? 'detail' : 'list',
    selected: typeof initialState.selected === 'string' ? initialState.selected : null,
    selections: {item: null, npc: null, ...initialState.selections},
    scrolls: {...initialState.scrolls},
    expanded: new Set(Array.isArray(initialState.expanded) ? initialState.expanded : []),
    summaryFilter: initialState.summaryFilter === 'missing' ? 'missing' : 'all',
  };
  const externalPolicy = () => typeof availability === 'function' ? availability() ?? {} : availability ?? {};
  function policy() {
    const supplied = externalPolicy(), saved = value.policy ?? {};
    const result = {...saved, ...supplied};
    for (const key of ['enabled', 'benmo', ...Object.keys(KINDS)]) {
      if (saved[key] === false || supplied[key] === false) result[key] = false;
    }
    if (result.summary === undefined) result.summary = false;
    if (result.item === undefined) result.item = false;
    if (result.npc === undefined) result.npc = false;
    if (result.enabled === false || result.benmo === false) result.summary = result.item = result.npc = false;
    result.benmo = Object.keys(KINDS).some(key => result[key] === true);
    return result;
  }
  const enabledKinds = () => Object.keys(KINDS).filter(key => policy()[key]);
  const records = (kind = state.kind) => {
    const rows = value.tracking?.records ?? [];
    return Array.isArray(rows) ? rows.filter(row => row.kind === kind) : rows[kind] ?? [];
  };
  const summaryRecords = () => [...(value.summary?.records ?? [])].sort((a, b) => b.floor - a.floor);
  const selectedRecord = () => records().find(row => row.id === state.selected);
  const context = () => ['benmo', state.tab, state.kind, state.route, ['detail', 'edit'].includes(state.route) ? state.selected ?? 'new' : '', state.kind === 'summary' && state.route === 'list' ? state.summaryFilter : ''].join(':');
  const blocked = () => invalidated || externalPolicy().transient === true || value.writeBlocked === true || !policy()[state.kind];
  const button = (label, action, attrs = '', tone = 'tertiary') => `<button type="button" class="ui-button ui-button--${tone}" data-action="${action}" ${blocked() && ['save', 'delete-record', 'new', 'generate'].includes(action) ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const textEntry = (label, action, attrs = '') => button(label, action, attrs).replace('ui-button ui-button--tertiary', 'benmo-text-entry');
  const icon = (label, action, file) => `<button type="button" class="ui-icon-button ui-button--tertiary" aria-label="${esc(label)}" data-action="${action}"><img class="lt-icon" data-icon="${file}" src="${new URL(`./icons/${file}.svg`, import.meta.url)}" alt=""></button>`;
  const selectButton = (id, label, current, action) => button(label, action, `data-id="${esc(id)}" ${id === current ? 'aria-current="page"' : ''}`).replace('ui-button ui-button--tertiary', action === 'kind' ? 'benmo-category' : 'ui-button lt-type');

  function readDraft() {
    const form = app.querySelector('form');
    if (!form || !draft) return;
    const customInputs = new Map();
    for (const field of draft.customFields ?? []) for (const key of ['name', 'requirement', 'value']) customInputs.set(`record-field-${field.id}-${key}`, [field, key]);
    for (const [key, raw] of new FormData(form)) {
      const text = String(raw), custom = customInputs.get(key);
      if (custom) custom[0][custom[1]] = text;
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
    return {tab: state.tab, kind: state.kind, route: draft ? returnRoute : state.route, selected: state.selected, selections: {...state.selections}, scrolls: {...state.scrolls}, expanded: [...state.expanded], summaryFilter: state.summaryFilter};
  }
  function normalize() {
    const enabled = enabledKinds();
    if (!enabled.length) return false;
    if (!enabled.includes(state.kind)) {
      state.kind = enabled[0]; state.tab = 'records'; state.route = 'list';
      state.selected = state.selections[state.kind] ?? null; draft = baseline = original = null; dialog = null; epoch++;
    }
    if (state.route === 'detail' && !selectedRecord()) { state.route = 'list'; state.selected = null; }
    return true;
  }
  function redirectToSettings() {
    if (redirectTimer || disposed || suspended) return;
    redirectTimer = setTimeout(() => {
      redirectTimer = null;
      if (!disposed && !suspended && !externalPolicy().transient && !enabledKinds().length) onNavigate('settings', snapshotNavigation());
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
  const summarySource = floor => [...(value.summary?.missing ?? []), ...runningRows(), ...summaryRecords()].find(row => Number(row.floor) === floor);
  function reconcileGenerating() {
    for (const [floor, token] of generating) {
      const row = summarySource(floor), running = runningRows().some(job => Number(job.floor) === floor && job.replyId === token.replyId);
      if (!row || row.replyId !== token.replyId || (token.observed && !running)) generating.delete(floor);
      else if (running) token.observed = true;
    }
  }
  const missingRows = () => (value.summary?.missing ?? []).filter(row => !runningRows().some(job => Number(job.floor) === Number(row.floor)));
  function pendingStrip() {
    const count = missingRows().length, running = runningRows().length;
    if (!count && !running) return '';
    return `<section class="pending-strip" aria-label="摘要任务状态"><p class="meta" role="status">${count ? `待补 ${count} 楼` : ''}${running ? `${count ? '<span class="pending-separator" aria-hidden="true"> · </span>' : ''}生成中 ${running} 楼` : ''}</p>${textEntry(state.summaryFilter === 'missing' ? '全部摘要' : '查看', 'filter-summary', `data-id="${state.summaryFilter === 'missing' ? 'all' : 'missing'}" aria-label="${state.summaryFilter === 'missing' ? '返回全部摘要' : '查看待补与生成中的楼层'}"`)}</section>`;
  }
  function pendingRows() {
    const missing = missingRows(), running = runningRows();
    return `<div class="section"><p class="meta">仅统计当前版本的可见、已完成 AI 楼层；不自动补齐历史。</p>${running.map(row => `<article class="record"><div class="row"><div class="pending-row-title"><strong>第 ${esc(row.floor)} 楼</strong><span class="meta" role="status">生成中</span></div></div></article>`).join('')}${missing.map(row => `<article class="record"><div class="row"><strong>第 ${esc(row.floor)} 楼</strong>${button('补生成', 'generate', `data-id="${esc(row.floor)}" ${generating.has(Number(row.floor)) ? 'disabled aria-busy="true"' : ''}`, 'secondary')}</div><p class="meta">${esc(row.error || '当前版本尚无摘要。')}</p></article>`).join('')}${!missing.length && !running.length ? `<p class="meta">暂无待处理楼层。</p>${button('返回全部摘要', 'filter-summary', 'data-id="all"')}` : ''}</div>`;
  }
  function summaryView() {
    const shown = summaryRecords();
    return `<div class="summary-toolbar"><div class="summary-toolbar-main"><span class="meta">当前聊天 · ${shown.length} 条摘要</span>${textEntry('摘要设置', 'settings-summary')}</div>${pendingStrip()}</div>${state.summaryFilter === 'missing' ? pendingRows() : `<div class="section">${shown.map(row => `<article class="card"><div class="row"><span class="meta">第 ${esc(row.floor)} 楼${row.edited ? ' · 已修改' : ''}</span><div class="actions compact-actions">${button('编辑', 'edit-summary', `data-id="${esc(row.id)}"`)}${button('重试', 'generate', `data-id="${esc(row.floor)}" ${runningRows().some(job => Number(job.floor) === Number(row.floor)) ? 'disabled' : ''}`)}</div></div><p class="reading ${state.expanded.has(row.id) ? '' : 'summary-collapsed'}">${esc(row.body)}</p>${row.error ? `<p class="lt-error" role="alert">${esc(row.error)}</p>` : ''}${button(state.expanded.has(row.id) ? '收起' : '展开全文', 'expand', `data-id="${esc(row.id)}" aria-expanded="${state.expanded.has(row.id)}"`)}</article>`).join('')}${shown.length ? '' : '<p class="meta">暂无最新摘要。</p>'}</div>`}`;
  }
  const formActions = () => `<div class="form-actions">${button('取消', 'cancel')}${button(acting ? '保存中…' : '保存', 'save', acting ? 'disabled aria-busy="true"' : '', 'primary')}</div>`;
  function summarySettings() {
    return `<form id="benmo-edit-form" class="section"><section class="card"><label class="ui-field"><span>最近多少楼使用原文</span><input class="ui-input" type="number" name="recentFloors" aria-label="最近多少楼使用原文" min="1" step="1" required value="${esc(draft.recentFloors)}" inputmode="numeric"></label><p class="meta">启用压缩前，请关闭预设中按 X 楼删除正文或只保留摘要的正则，以免重复处理。</p></section><section class="card"><label class="ui-field"><span>最新摘要提示词</span><textarea class="lt-textarea" name="prompt" rows="7" required>${esc(draft.prompt)}</textarea></label><div class="actions">${button('恢复默认提示词', 'default-prompt')}</div></section>${formActions()}</form>`;
  }
  function trackingList() {
    const rows = records();
    return `<div class="row"><span class="meta">当前聊天 · ${rows.length} 条记录${state.kind === 'npc' ? ' · NPC' : ''}</span>${button('＋ 新建', 'new', '', 'secondary')}</div><div class="section">${rows.map(row => `<article class="record ${state.selected === row.id ? 'selected' : ''}"><button type="button" class="record-open" data-action="detail" data-id="${esc(row.id)}" aria-label="查看${esc(row.name)}"><strong>${esc(row.name)}</strong><span class="meta"><span class="tag">${row.pinned ? '常驻' : '触发'}</span> · 查看 ›</span></button><p>${esc(state.kind === 'item' ? row.introduction : [row.identity, row.appearance].filter(Boolean).join(' · '))}</p><p class="meta">${state.kind === 'item' ? esc(`位置：${row.location ?? ''} · 所属者：${row.owner ?? ''}`) : `最后出场：第 ${esc(row.lastAppearanceTurn ?? '—')} 个 AI 回合 · 缺席 ${esc(row.absentTurns ?? '—')} 回合`}</p><div class="keywords">${aliases(row.aliases).map(alias => `<span class="tag">${esc(alias)}</span>`).join('')}</div></article>`).join('')}${rows.length ? '' : `<p class="meta">暂无${state.kind === 'item' ? '物品' : '角色'}记录。</p>`}</div>`;
  }
  function detail() {
    const row = selectedRecord();
    if (!row) return '';
    return `<section class="card"><div class="row"><h2>${esc(row.name)}</h2><span class="tag">${row.pinned ? '常驻' : '触发'}</span></div><dl>${FIELDS[state.kind].slice(1).map(([key, label]) => `<div><dt>${label}</dt><dd>${esc((key === 'aliases' ? aliases(row.aliases).join('，') : row[key]) || '未记录')}</dd></div>`).join('')}${state.kind === 'npc' ? `<div><dt>最后实际出场／缺席</dt><dd>第 ${esc(row.lastAppearanceTurn ?? '—')} 个 AI 回合／${esc(row.absentTurns ?? '—')} 回合</dd></div>` : ''}${(row.customFields ?? []).filter(field => String(field.value ?? '').trim()).map(field => `<div><dt>${esc(field.name)}</dt><dd>${esc(field.value)}</dd></div>`).join('')}</dl></section><div class="detail-actions">${button('删除', 'delete-record')}${button('编辑', 'edit', '', 'primary')}</div>`;
  }
  function recordCustomFields() {
    return `<section class="section"><h2>自定义字段</h2><p class="meta">仅属于这条${state.kind === 'item' ? '物品' : '角色'}记录。</p>${draft.customFields.map(field => `<section class="custom-field-row" data-field-id="${esc(field.id)}"><div class="custom-field-heading"><label class="ui-field"><span>字段名</span><input class="ui-input" name="${esc(`record-field-${field.id}-name`)}" value="${esc(field.name)}" maxlength="80" required placeholder="如：${state.kind === 'item' ? '耐久' : '擅长技能'}"></label>${button('移除', 'remove-field', `data-id="${esc(field.id)}" aria-label="移除此字段"`)}</div><label class="ui-field"><span>追踪要求</span><textarea class="lt-textarea" name="${esc(`record-field-${field.id}-requirement`)}" rows="2" maxlength="1000" required placeholder="说明需要记录什么、何时更新">${esc(field.requirement)}</textarea></label><label class="ui-field"><span>当前内容</span><textarea class="lt-textarea" name="${esc(`record-field-${field.id}-value`)}" rows="2" maxlength="2000">${esc(field.value)}</textarea></label></section>`).join('')}${button('＋ 添加字段', 'add-field', '', 'secondary')}</section>`;
  }
  function editor() {
    if (state.kind === 'summary') return `<form id="benmo-edit-form" class="section"><p class="summary-origin">来源：第 ${esc(draft.floor)} 楼 · 当前选中版本</p><label class="ui-field"><span>摘要正文</span><textarea class="lt-textarea" name="body" rows="10" required>${esc(draft.body)}</textarea></label>${formActions()}</form>`;
    return `<form id="benmo-edit-form" class="section"><div class="two-cols">${FIELDS[state.kind].map(([key, label]) => `<label class="ui-field"><span>${label}</span>${MULTILINE.has(key) ? `<textarea class="lt-textarea" name="${key}" rows="2" maxlength="600">${esc(draft[key])}</textarea>` : `<input class="ui-input" name="${key}" value="${esc(draft[key])}" ${key === 'name' ? 'required maxlength="160"' : 'maxlength="2000"'}>`}</label>`).join('')}</div><fieldset class="lt-modes" aria-label="召回方式"><legend class="ui-field__label">召回方式</legend>${[['resident', '常驻'], ['trigger', '触发']].map(([mode, label]) => `<label class="lt-mode"><input type="radio" name="mode" value="${mode}" ${draft.pinned === (mode === 'resident') ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>${state.kind === 'npc' ? '<p class="meta">最后实际出场与缺席回合由剧情记录，此处不手动填写。</p>' : ''}${recordCustomFields()}${formActions()}</form>`;
  }
  function content() {
    if (state.route === 'summary-settings') return summarySettings();
    if (state.route === 'edit') return editor();
    if (state.route === 'detail') return detail();
    if (state.tab !== 'records') return `<section class="section future"><div class="row"><h2>${TABS[state.tab]}</h2><span class="meta">功能待设计</span></div><p class="reading">${state.tab === 'self' ? '从角色自己的视角，回望经历与变化。' : '梳理故事的来龙去脉，留住重要转折。'}</p><p class="meta">内容与操作尚未确定。</p></section>`;
    return `<nav class="subtabs" aria-label="兰台记录功能">${enabledKinds().map(id => selectButton(id, KINDS[id], state.kind, 'kind')).join('')}</nav>${state.kind === 'summary' ? summaryView() : trackingList()}`;
  }
  function pageTitle() {
    if (state.route === 'summary-settings') return '最新摘要设置';
    if (state.route === 'detail') return state.kind === 'item' ? '物品详情' : '角色详情';
    if (state.route === 'edit') return state.kind === 'summary' ? '编辑最新摘要' : `${returnRoute === 'list' && !original ? '新建' : '编辑'}${state.kind === 'item' ? '物品' : '角色'}`;
    return '本末';
  }
  function render() {
    if (disposed || suspended) return;
    if (externalPolicy().transient) { syncWriteControls(); return; }
    renderedPolicy = JSON.stringify(policy());
    if (!normalize()) { app.innerHTML = ''; redirectToSettings(); return; }
    const focused = app.getRootNode().activeElement;
    const focusName = focused?.name, focusValue = focused?.value, focusData = focused?.dataset ? JSON.stringify({...focused.dataset}) : null;
    const subpage = state.route !== 'list';
    app.innerHTML = `<section class="lantai workshop benmo ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(app)}">${subpage ? `<header class="lt-header ui-header subpage-header">${icon(draft && returnRoute === 'detail' ? '返回记录详情' : `返回${KINDS[state.kind]}`, 'back', 'back')}<h1 class="ui-page-title">${pageTitle()}</h1>${icon('关闭兰台', 'close', 'close')}</header>` : `<header class="lt-header lt-header--root ui-header"><div class="lt-root-top"><h1 class="ui-page-title">本末</h1>${icon('关闭兰台', 'close', 'close')}</div><nav class="ui-tablist" aria-label="本末分区">${Object.entries(TABS).map(([id, label]) => selectButton(id, label, state.tab, 'tab')).join('')}</nav></header>`}<main class="lt-main ui-main" tabindex="-1">${error || value.error ? `<p class="lt-error" role="alert">${esc(error || value.error)}</p>${button('重新读取', 'reload')}` : ''}${content()}</main><footer class="lt-footer">${mainNavigation({policy: policy(), current: 'benmo', actions: {memory: 'area', time: 'area', workshop: 'area', benmo: 'area', settings: 'area'}, attributes: Object.fromEntries(['memory', 'time', 'workshop', 'benmo', 'settings'].map(area => [area, `data-id="${area}"`]))})}</footer>${dialog ? `<div class="wk-dialog" role="dialog" aria-modal="true" aria-label="确认操作"><div class="wk-dialog-box"><p>${esc(dialog.pending ? '正在处理，请稍候…' : dialog.text)}</p><div class="wk-dialog-actions">${button('取消', 'cancel-dialog', dialog.pending ? 'disabled' : '')}${button(dialog.pending ? '处理中…' : '确认', 'confirm-dialog', dialog.pending ? 'disabled aria-busy="true"' : '', 'primary')}</div></div></div>` : ''}</section>`;
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
  function confirm(text, action) { remember(); dialog = {text, action, pending: false}; render(); }
  function leave(action) { if (dirty()) confirm('放弃未保存的修改？', action); else action(); }
  function clearDraft() { draft = baseline = original = null; }
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
    draft = route === 'summary-settings' ? {recentFloors: String(value.summary?.preferences?.recentFloors ?? 6), prompt: value.summary?.preferences?.prompt ?? controller.defaultPrompt ?? ''}
      : state.kind === 'summary' ? {id: record.id, floor: record.floor, body: record.body ?? ''} : makeDraft(record);
    baseline = clone(draft); state.route = route; error = ''; state.scrolls[context()] = 0; render();
  }
  const apply = next => { value = next ?? controller.snapshot?.() ?? value; error = ''; };
  async function save() {
    if (!draft || blocked() || composing || !app.querySelector('form')?.reportValidity()) return;
    readDraft(); const submitted = clone(draft), operationEpoch = epoch, route = state.route, kind = state.kind;
    let payload = submitted;
    if (route === 'summary-settings') {
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
    const next = route === 'summary-settings' ? await controller.saveSummaryPreferences(payload)
      : kind === 'summary' ? await controller.saveSummary(submitted.id, submitted.body, {original})
        : await controller.saveRecord(kind, payload, {original});
    if (disposed) return;
    apply(next);
    if (epoch !== operationEpoch || suspended || !draft) return;
    remember(); const newer = clone(draft);
    if (!same(newer, submitted)) {
      const saved = route === 'summary-settings' ? null : kind !== 'summary' ? records(kind).find(row => row.id === submitted.id) : summaryRecords().find(row => row.id === submitted.id);
      const savedDraft = saved ? (kind === 'summary' ? {id: saved.id, floor: saved.floor, body: saved.body} : makeDraft(saved, kind)) : route === 'summary-settings' ? {...payload, recentFloors: String(payload.recentFloors)} : clone(submitted);
      baseline = clone(savedDraft); draft = {...savedDraft, ...Object.fromEntries(Object.entries(newer).filter(([key, text]) => !same(text, submitted[key])))};
      if (saved) original = clone(saved);
      acting = false; render(); toast('已保存提交内容；新修改尚未保存');
    } else {
      if (kind !== 'summary') { state.selected = submitted.id; state.selections[kind] = submitted.id; }
      state.route = returnRoute; clearDraft(); acting = false; render(); toast('已保存');
    }
  }
  async function generate(floor) {
    if (blocked() || generating.has(floor) || !Number.isSafeInteger(floor) || !policy().summary || runningRows().some(row => Number(row.floor) === floor)) return;
    const exists = [...summaryRecords(), ...missingRows()].some(row => Number(row.floor) === floor);
    if (!exists) return;
    const operationEpoch = epoch, token = {replyId: summarySource(floor)?.replyId, observed: false}; generating.set(floor, token); remember(); render();
    try { const next = await controller.generateSummary(floor); if (!disposed && generating.get(floor) === token) apply(next); }
    catch (failure) { if (!disposed && generating.get(floor) === token && epoch === operationEpoch) error = failure.message || '摘要生成未完成，请重试'; }
    finally { if (generating.get(floor) === token) generating.delete(floor); if (!disposed && !suspended && epoch === operationEpoch) { remember(); render(); } }
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
    if (composing && ['save', 'add-field', 'remove-field', 'default-prompt'].includes(action)) return;
    let ownsAction = false;
    const actionEpoch = epoch;
    try {
      if (action === 'cancel-dialog') { if (!dialog?.pending) { dialog = null; render(); } return; }
      if (action === 'confirm-dialog') {
        if (!dialog || dialog.pending) return;
        const pending = dialog; pending.pending = true; acting = ownsAction = true; render();
        await pending.action(); if (disposed) return; if (dialog === pending) dialog = null; render(); return;
      }
      if (action === 'back' || action === 'cancel') { if (action === 'cancel') leave(goBack); else back(); return; }
      if (action === 'close') { leave(() => { epoch++; clearDraft(); dialog = null; onClose(); }); return; }
      if (action === 'area') { leave(() => navigate(id)); return; }
      if (action === 'reload') { acting = ownsAction = true; remember(); const token = epoch; const next = await controller.load({refresh: true}); if (!disposed && token === epoch) { apply(next); invalidated = false; render(); } return; }
      if (action === 'tab' && Object.hasOwn(TABS, id)) { leave(() => { remember(); epoch++; state.tab = id; state.route = 'list'; clearDraft(); render(); }); return; }
      if (action === 'kind' && enabledKinds().includes(id)) { leave(() => { remember(); epoch++; state.kind = id; state.route = 'list'; state.selected = state.selections[id] ?? null; clearDraft(); render(); }); return; }
      if (action === 'settings-summary' && state.kind === 'summary') { startEdit(null, 'list', 'summary-settings'); return; }
      if (action === 'default-prompt' && state.route === 'summary-settings') { remember(); draft.prompt = controller.defaultPrompt ?? ''; render(); return; }
      if (action === 'expand') { remember(); state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); render(); return; }
      if (action === 'filter-summary' && ['all', 'missing'].includes(id)) { remember(); state.summaryFilter = id; render(); return; }
      if (action === 'generate' && state.kind === 'summary') { await generate(Number(id)); return; }
      if (action === 'detail') {
        if (!records().some(row => row.id === id)) return;
        remember(); epoch++; state.selected = id; state.selections[state.kind] = id; state.route = 'detail'; state.scrolls[context()] = 0; render(); return;
      }
      if (action === 'edit' && state.route === 'detail') { const row = selectedRecord(); if (row) startEdit(row, 'detail'); return; }
      if (action === 'edit-summary') { const row = summaryRecords().find(record => record.id === id); if (row) startEdit(row, 'list'); return; }
      if (action === 'new' && FIELDS[state.kind] && !blocked()) { remember(); state.selected = null; startEdit(null, 'list'); return; }
      if (action === 'add-field' && draft?.customFields) { remember(); draft.customFields.push({id: crypto.randomUUID(), name: '', requirement: '', value: ''}); render(); return; }
      if (action === 'remove-field' && draft?.customFields) {
        remember(); const field = draft.customFields.find(row => row.id === id); if (!field) return;
        const remove = () => { draft.customFields = draft.customFields.filter(row => row.id !== id); dialog = null; render(); };
        if (field.value.trim()) confirm(`移除这条记录的“${field.name}”字段及当前内容？保存后生效，取消编辑则保留。`, remove); else remove(); return;
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
      const controls = [...app.querySelectorAll('.wk-dialog button')].filter(node => !node.disabled);
      if (!controls.length) return;
      event.preventDefault(); const index = controls.indexOf(app.getRootNode().activeElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    }
  }, {signal: lifetime.signal});
  const unsubscribe = controller.subscribe?.(next => {
    if (disposed) return;
    value = next;
    reconcileGenerating();
    // A background receipt must never rebuild an active input or its baseline.
    if (!draft && !acting && !dialog && !suspended) { remember(); render(); }
    else for (const node of app.querySelectorAll('[data-action="save"],[data-action="delete-record"]')) node.disabled = blocked() || acting;
  });
  render();
  return {
    back() { if (!dialog && !acting) back(); },
    blocking() { return acting || dirty() || !!dialog; },
    snapshotNavigation,
    refreshAvailability() { if (JSON.stringify(policy()) !== renderedPolicy || externalPolicy().transient) { remember(); render(); } },
    invalidate(message) { remember(); epoch++; invalidated = true; error = message; value = {...value, writeBlocked: true}; render(); },
    suspend() { remember(); suspended = true; epoch++; app.inert = true; },
    resume() { suspended = false; app.inert = false; render(); },
    dispose() { disposed = true; epoch++; unsubscribe?.(); lifetime.abort(); clearTimeout(toastTimer); clearTimeout(redirectTimer); app.innerHTML = ''; },
  };
}
