import {estimateNarrativeTokens} from '../domain/narrative/source.js';
import {narrativeSourceChoice} from '../domain/narrative/data.js';
import {narrativeMaterialGroups, narrativeMemoryTime} from '../domain/narrative/requests.js';
import {summaryPreviewSource,summaryPreviewPrompt,summaryPreviewStage,summaryPreviewTabs,summaryPreviewPanel} from './shared-ui/summary-preview.js';
import {changeGenerationDraft,createGenerationPreview} from './generation-preview.js';
import {replaceSurfaceMarkup} from './stable-surface.js';
import {mainNavigation,rootTitle} from './navigation.js';
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
export async function mountBenmoView({container: app, controller, availability = () => ({}), onNavigate = () => {}, onClose = () => {}, onOpenCleaning = null, isCurrent = () => true, prepare, initialState = {}, onMountCommit = () => {}, onRenderCommit = () => {}} = {}) {
  initialState ??= {};
  const lifetime = new AbortController();
  const revalidationActions = new Set(['save','delete-narrative','delete-record','toggle-excluded','restore-excluded','new','generate','generate-narrative','preview-narrative','save-narrative-budget','start-narrative','continue-narrative','retry-narrative','skip-narrative','pause-narrative','confirm-narrative-review','regenerate-narrative','manual-summary','start-backfill']);
  const revalidationControls = new Map();
  let value = {}, loading = true, loadFailed = false, initializing = true, revalidating = false;
  let disposed = false, suspended = false, acting = false, composing = false;
  let error = '', dialog = null, draft = null, baseline = null, original = null, narrativeRecovery = null, narrativeDraftTarget = null, invalidated = false, renderedPolicy = '';
  let narrativeRange = null, narrativePlanning = false, narrativeKinds = null;
  const previewState={preview:null,previewOpen:false,previewView:'memory',previewBusy:false};
  const generationPreview=createGenerationPreview(previewState);
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
  let renderPolicy = null;
  const readExternalPolicy = () => typeof availability === 'function' ? availability() ?? {} : availability ?? {};
  const externalPolicy = () => renderPolicy?.external ?? readExternalPolicy();
  function derivePolicy(supplied) {
    const saved = value.policy ?? {};
    const result = {...saved, ...supplied};
    for (const key of ['enabled', 'benmo', ...FEATURES]) {
      if (saved[key] === false || supplied[key] === false) result[key] = false;
    }
    for (const key of FEATURES) if (result[key] === undefined || result.enabled === false || result.benmo === false) result[key] = false;
    result.benmo = FEATURES.some(key => result[key] === true);
    return result;
  }
  const policy = () => renderPolicy?.policy ?? derivePolicy(readExternalPolicy());
  const enabledKinds = () => { const current = policy(); return renderPolicy?.kinds ?? Object.keys(KINDS).filter(key => current[key]); };
  const enabledTabs = () => { const current = policy(), kinds = enabledKinds(); return renderPolicy?.tabs ?? Object.keys(TABS).filter(key => key === 'records' ? kinds.length > 0 : current[key]); };
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
  const configBlocked = () => loading || loadFailed || !!narrativeRecovery || invalidated || (typeof value.narrativeConfigWriteBlocked === 'boolean' ? value.narrativeConfigWriteBlocked : blocked()) || !policy()[state.tab];
  const previewBlocked = () => loading || loadFailed || !!narrativeRecovery || invalidated || externalPolicy().transient === true || (typeof value.narrativePreviewBlocked === 'boolean' ? value.narrativePreviewBlocked : blocked()) || !policy()[state.tab];
  const blocked = () => loading || loadFailed || !!narrativeRecovery || summaryDraftHidden() || invalidated || externalPolicy().transient === true || value.writeBlocked === true || !policy()[activeKind()];
  const button = (label, action, attrs = '', tone = 'tertiary') => `<button type="button" class="ui-button ui-button--${tone}" data-action="${action}" ${(action === 'save' && state.route === 'narrative-settings' ? configBlocked() : ['generate-narrative','preview-narrative'].includes(action) ? previewBlocked() : blocked()) && ['save', 'delete-narrative', 'delete-record', 'toggle-excluded', 'restore-excluded', 'new', 'generate', 'generate-narrative', 'preview-narrative', 'save-narrative-budget', 'start-narrative', 'continue-narrative', 'retry-narrative', 'skip-narrative', 'pause-narrative', 'confirm-narrative-review', 'regenerate-narrative', 'manual-summary', 'start-backfill'].includes(action) ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const bookTheme = () => ['paper-letter','purple-glow'].includes(surfaceTheme(app));
  const textEntry = (label, action, attrs = '') => button(bookTheme() && ['settings-summary','settings-tracking','settings-narrative'].includes(action) ? '设置' : label, action, attrs).replace('ui-button ui-button--tertiary', 'benmo-text-entry');
  const icon = (label, action, file, attrs = '') => `<button type="button" class="ui-icon-button ui-button--tertiary" aria-label="${esc(label)}" data-action="${action}" ${attrs}><img class="lt-icon" data-icon="${file}" src="${new URL(`./icons/${file}.svg`, import.meta.url)}" alt=""></button>`;
  const selectButton = (id, label, current, action) => action === 'kind'
    ? button(label, action, `data-id="${esc(id)}" aria-pressed="${id === current}"`)
    : button(label, action, `data-id="${esc(id)}" ${id === current ? 'aria-current="page"' : ''}`).replace('ui-button ui-button--tertiary', 'ui-button lt-type');

  function readDraft() {
    const form = app.querySelector('form');
    if (form && state.route === 'narrative-generate' && narrativeRange) {
      for (const [key, raw] of new FormData(form)) if (['startFloor', 'endFloor', 'batchSize', 'jointBudget'].includes(key)) narrativeRange[key] = String(raw);
      return;
    }
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
    if (main && !loading && !loadFailed) state.scrolls[context()] = main.scrollTop;
    readDraft();
  }
  const dirty = () => { readDraft(); return !!draft && !same(draft, baseline); };
  function snapshotNavigation() {
    remember();
    return {tab: state.tab, kind: state.kind, route: draft ? returnRoute : state.route, selected: state.selected, selections: {...state.selections}, scrolls: {...state.scrolls}, expanded: [...state.expanded], summaryHistoryExpanded: state.summaryHistoryExpanded};
  }
  function normalize(validateSelection = true) {
    const tabs = enabledTabs(), kinds = enabledKinds();
    if (!tabs.length) return false;
    if (!tabs.includes(state.tab) || (state.tab === 'records' && !kinds.includes(state.kind))) {
      if (!tabs.includes(state.tab)) state.tab = tabs[0];
      if (state.tab === 'records') state.kind = kinds[0];
      state.route = 'list'; state.selected = state.selections[state.kind] ?? null;
      draft = baseline = original = null; narrativeRecovery = narrativeDraftTarget = null; dialog = null; epoch++;
    }
    if (validateSelection && state.tab === 'records' && state.route === 'detail' && !selectedRecord()) { state.route = 'list'; state.selected = null; }
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
  function backfillActions() {
    const count = missingRows().length, running = backfillRunning();
    return `${controller.startSummaryBackfill ? button('补齐缺失', 'start-backfill', running || !count ? 'disabled' : '', 'secondary') : ''}${running && controller.stopSummaryBackfill ? button('停止补缺', 'stop-backfill', backfillStatus().status === 'stopping' ? 'disabled' : '') : ''}`;
  }
  function backfillControls() {
    return `<section class="pending-strip" aria-label="摘要任务状态"><p class="meta" role="status">缺少${missingRows().length}条</p><div class="actions compact-actions">${backfillActions()}</div></section>${backfillProgress()}`;
  }
  function summaryToolbar(count) {
    if (bookTheme()) return `<section class="summary-toolbar summary-toolbar--compact" aria-label="摘要任务状态"><div class="summary-toolbar-main"><p class="meta" role="status">${count}条摘要 · 缺少${missingRows().length}条</p><div class="actions compact-actions summary-toolbar-actions">${textEntry('摘要设置', 'settings-summary')}${backfillActions()}</div></div>${backfillProgress()}</section>`;
    return `<div class="summary-toolbar"><div class="summary-toolbar-main"><span class="meta">当前聊天 · ${count} 条摘要</span>${textEntry('摘要设置', 'settings-summary')}</div>${backfillControls()}</div>`;
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
    const action = (label, accessibleLabel, name, file, attrs) => bookTheme()
      ? `<button type="button" class="benmo-text-entry" aria-label="${esc(accessibleLabel)}" data-action="${name}" ${attrs}>${label}</button>`
      : icon(accessibleLabel, name, file, attrs);
    return `<article class="card summary-card"><header class="summary-card-header"><span class="meta">第 ${esc(row.floor)} 楼</span><div class="summary-card-actions">${action('编辑', '编辑摘要', 'edit-summary', 'edit', `data-id="${esc(row.id)}"`)}${action('重试', '重新生成摘要', 'generate', 'refresh', `data-id="${esc(row.floor)}" ${running ? 'disabled aria-busy="true"' : blocked() ? 'disabled' : ''}`)}</div></header><p id="${esc(bodyId)}" class="reading ${expanded ? '' : 'summary-collapsed'}">${esc(row.body)}</p>${row.error ? `<p class="lt-error" role="alert">${esc(row.error)}</p>` : ''}${textEntry(expanded ? '收起' : '展开全文', 'expand', `data-id="${esc(row.id)}" aria-expanded="${expanded}" aria-controls="${esc(bodyId)}"`)}</article>`;
  }
  function summaryView() {
    const current = summaryCurrentRows(), history = summaryHistoryRecords(), count = current.filter(row => row.id && row.body && !row.nativeHidden).length;
    return `${summaryToolbar(count)}<div class="section" aria-label="当前摘要">${current.map(summaryCurrentRow).join('')}${current.length ? '' : '<p class="meta">暂无最新摘要。</p>'}</div><section class="section benmo-summary-history" aria-label="历史摘要">${springHeading('历史摘要')}<button type="button" class="record-open" data-action="toggle-summary-history" aria-expanded="${state.summaryHistoryExpanded}" aria-controls="benmo-summary-history"><strong>历史摘要</strong><span class="meta">${history.length} 条 · ${state.summaryHistoryExpanded ? '收起' : '展开'}</span></button><div id="benmo-summary-history" class="${state.summaryHistoryExpanded ? 'section' : ''}" ${state.summaryHistoryExpanded ? '' : 'hidden'}>${state.summaryHistoryExpanded ? history.map(summaryCard).join('') : ''}</div></section>`;
  }
  function patchSummaryDisclosure(control, id) {
    // Keep navigation state authoritative. The next full render must compare
    // against the patched DOM even if its old markup string happens to match.
    surfacePatched = true;
    if (loading || loadFailed || state.tab !== 'records' || state.kind !== 'summary' || state.route !== 'list' || dialog) return false;
    const main = app.querySelector('.lt-main');
    if (!main?.contains?.(control)) return false;
    if (control.dataset.action === 'expand') {
      const body = control.closest('.summary-card')?.querySelector('.reading');
      if (!body || body.id !== `benmo-summary-body-${id}`) return false;
      const expanded = state.expanded.has(id);
      body.className = `reading ${expanded ? '' : 'summary-collapsed'}`;
      control.textContent = expanded ? '收起' : '展开全文';
      control.setAttribute('aria-expanded', String(expanded));
      main.scrollTop = state.scrolls[context()] ?? 0;
      return true;
    }
    const body = app.querySelector('#benmo-summary-history'), label = control.querySelector('.meta');
    if (!body || !label || !main.contains(body)) return false;
    const history = summaryHistoryRecords(), expanded = state.summaryHistoryExpanded;
    const previousPolicy = renderPolicy, external = readExternalPolicy();
    renderPolicy = {external, policy: derivePolicy(external)};
    restoreRevalidationControls();
    try {
      body.innerHTML = expanded ? history.map(summaryCard).join('') : '';
      body.className = expanded ? 'section' : '';
      if (expanded) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
      control.setAttribute('aria-expanded', String(expanded));
      label.textContent = `${history.length} 条 · ${expanded ? '收起' : '展开'}`;
      main.scrollTop = state.scrolls[context()] ?? 0;
    } finally { renderPolicy = previousPolicy; syncRevalidationControls(); }
    return true;
  }
  // Decorative headings are hidden in every other appearance. They contain no
  // controls or source data; the existing fields keep their accessible labels.
  const springHeading = label => `<div class="benmo-spring-heading" hidden aria-hidden="true">${esc(label)}</div>`;
  const formActions = () => `<div class="wk-editor-footer">${state.route === 'narrative-edit' ? button('删除', 'delete-narrative', acting ? 'disabled' : '', 'danger') : button('取消', 'cancel')}${button(acting ? '保存中…' : '保存', 'save', acting ? 'disabled aria-busy="true"' : '', 'primary')}</div>`;
  function summarySettings() {
    const automatic=value.summary?.automatic?.message;
    return `<p class="meta" role="status" data-latest-automatic-status ${automatic?'':'hidden'}>${automatic?`自动生成：${esc(automatic)}`:''}</p><form id="benmo-edit-form" class="section">${springHeading('摘要处理')}<section class="card"><label class="ui-field"><span>最近多少楼使用原文</span><input class="ui-input" type="number" name="recentFloors" aria-label="最近多少楼使用原文" min="1" step="1" required value="${esc(draft.recentFloors)}" inputmode="numeric"></label><p class="meta">启用压缩前，请关闭预设中按 X 楼删除正文或只保留摘要的正则，以免重复处理。</p></section>${springHeading('最新摘要提示词')}<section class="card"><label class="ui-field"><span>最新摘要提示词</span><textarea class="lt-textarea lt-prompt-editor" name="prompt" rows="7" required>${esc(draft.prompt)}</textarea></label><div class="actions">${button('恢复默认提示词', 'default-prompt')}</div></section></form>`;
  }
  function trackingSettings() {
    const excluded = value.tracking?.exclusions?.[state.kind] ?? {ids:[]};
    const paused = (excluded.ids ?? []).map(id => {
      const row = records().find(row => row.id === id);
      const label = row?.name || excluded.labels?.[id]?.[0] || id;
      return `<div class="section"><p class="reading meta">${esc(label)}${row ? '' : ' · 当前记录已不在列表中'}</p><div class="actions">${button('恢复追踪', 'restore-excluded', `data-id="${esc(id)}" aria-label="恢复${esc(label)}的追踪"`)}</div></div>`;
    }).join('');
    return `<form id="benmo-edit-form" class="section">${springHeading(`${KINDS[state.kind]}要求`)}<section class="card"><label class="ui-field"><span>${KINDS[state.kind]}要求</span><textarea class="lt-textarea lt-prompt-editor" name="prompt" rows="10" maxlength="20000" required>${esc(draft.prompt)}</textarea></label><div class="actions">${button('恢复默认提示词', 'default-tracking-prompt')}</div></section>${springHeading('名称排除名单')}<section class="card"><label class="ui-field"><span>名称排除名单 · 仅当前聊天</span><textarea class="lt-textarea" name="exclusionNames" rows="5" aria-describedby="tracking-exclusion-help" placeholder="一行一个名称或别名">${esc(draft.exclusionNames)}</textarea></label><p class="meta" id="tracking-exclusion-help">每行一个名称或别名，完整匹配。</p><p class="meta">排除后停止自动追踪与召回，已有资料保留；恢复只影响后续，不回补历史。</p></section>${paused ? `<section class="card"><h2>已暂停的记录</h2><p class="meta">恢复立即生效；名称排除名单仍独立生效。</p>${paused}</section>` : ''}</form>`;
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
    return `<section class="card record-detail" data-tracking-excluded="${row.excluded === true}"><div class="row"><h2>${esc(row.name)}</h2><span class="tag">${row.excluded ? '已暂停追踪' : row.pinned ? '常驻' : '触发'}</span></div>${row.excluded ? `<p class="meta">自动追踪与召回已暂停，已有资料保留。恢复后只处理后续，不回补历史。${!recordPaused(row) ? '名称或别名命中排除，请检查名称排除名单及同名暂停记录。' : ''}</p>` : ''}<div class="actions">${button(recordPaused(row) ? '恢复此记录追踪' : '暂停此记录追踪', 'toggle-excluded')}${row.excluded ? textEntry('追踪设置', 'settings-tracking') : ''}</div><dl class="detail-fields">${fields}${state.kind === 'npc' ? detailField('最后实际出场／缺席', `第 ${row.lastAppearanceTurn ?? '—'} 个 AI 回合／${row.absentTurns ?? '—'} 回合`) : ''}${customFields.map((field, index) => detailField(field.name, field.value, {long: true, groupStart: index === 0})).join('')}</dl></section><div class="detail-actions">${button('删除', 'delete-record', '', 'danger')}${button('编辑', 'edit', '', 'primary')}</div>`;
  }
  function recordCustomFields() {
    return `<section class="section benmo-custom-fields"><h2>本记录自定义字段</h2>${draft.customFields.map(field => `<section class="custom-field-row" data-field-id="${esc(field.id)}"><div class="custom-field-heading"><label class="ui-field"><span>字段名</span><input class="ui-input" name="${esc(`record-field-${field.id}-name`)}" value="${esc(field.name)}" maxlength="80" required placeholder="如：${state.kind === 'item' ? '耐久' : '擅长技能'}"></label>${button('移除', 'remove-field', `data-id="${esc(field.id)}" aria-label="移除此字段"`)}</div><label class="ui-field"><span>追踪要求</span><textarea class="lt-textarea lt-prompt-editor" name="${esc(`record-field-${field.id}-requirement`)}" rows="2" maxlength="1000" required placeholder="说明需要记录什么、何时更新">${esc(field.requirement)}</textarea></label><label class="ui-field"><span>当前内容</span><textarea class="lt-textarea" name="${esc(`record-field-${field.id}-value`)}" rows="2" maxlength="2000">${esc(field.value)}</textarea></label></section>`).join('')}${button('＋ 添加字段', 'add-field', '', 'secondary')}</section>`;
  }
  function editor() {
    if (state.kind === 'summary') return `<form id="benmo-edit-form" class="section"><p class="summary-origin">来源：第 ${esc(draft.floor)} 楼 · 当前选中版本</p>${!draft.id ? '<p class="meta">保存后用于该楼层的摘要展示与压缩，原文保留。</p>' : ''}<label class="ui-field"><span>摘要正文</span><textarea class="lt-textarea" name="body" rows="10" required>${esc(draft.body)}</textarea></label></form>`;
    return `<form id="benmo-edit-form" class="section">${springHeading('基本资料')}<div class="two-cols benmo-basic-fields">${FIELDS[state.kind].map(([key, label]) => `<label class="ui-field"><span>${label}</span>${MULTILINE.has(key) ? `<textarea class="lt-textarea" name="${key}" rows="2" maxlength="600">${esc(draft[key])}</textarea>` : `<input class="ui-input" name="${key}" value="${esc(draft[key])}" ${key === 'name' ? 'required maxlength="160"' : 'maxlength="2000"'}>`}</label>`).join('')}</div><fieldset class="lt-modes" aria-label="召回方式"><legend class="ui-field__label">召回方式</legend>${[['resident', '常驻'], ['trigger', '触发']].map(([mode, label]) => `<label class="lt-mode"><input type="radio" name="mode" value="${mode}" ${draft.pinned === (mode === 'resident') ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>${recordCustomFields()}</form>`;
  }
  const rangesText = ranges => (ranges ?? []).map(range => Number(range.start) === Number(range.end) ? `第 ${range.start} 楼` : `第 ${range.start}—${range.end} 楼`).join('、') || '未读取';
  const narrativeRun = () => value.narrative?.run ?? {};
  const narrativeBusy = () => narrativeRun().status === 'running' || narrativeJobs.size > 0 || NARRATIVES.some(kind => narrativeStatus(kind).status === 'running');
  function narrativeRunStatus() {
    const run = narrativeRun(), range = run.range;
    const label = {running: ({preparing:'正在读取材料…', generating:'生成中…', saving:'正在保存…'}[run.stage] ?? '生成中…'), 'awaiting-review': '等待入库前检查', paused: '已暂停', failed: '生成未完成', complete: '生成完成'}[run.status] ?? '';
    return label ? `${label}${run.status === 'complete' && narrativeStatus().addedCount === 0 ? ' · 本批无新增条目' : ''}${range ? ` · 第 ${range.startFloor ?? range.start}—${range.endFloor ?? range.end} 楼` : ''}` : narrativeBusy() ? '生成中…' : '';
  }
  function narrativeRunActions() {
    const run = narrativeRun();
    if (narrativeBusy()) return button(run.pauseRequested ? '等待本批完成' : '本批完成后暂停', 'pause-narrative', run.pauseRequested ? 'disabled' : '');
    if (run.status === 'awaiting-review') return `${button('跳过本批', 'skip-narrative')}${button('确认入库', 'confirm-narrative-review', acting ? 'disabled' : '', 'primary')}`;
    if (run.status === 'failed') return `${button('重试未完成项', 'retry-narrative', '', 'secondary')}${button('跳过本批', 'skip-narrative')}`;
    if (run.status === 'paused') return button('继续生成', 'continue-narrative', '', 'secondary');
    return '';
  }
  function narrativeUsage() {
    const run = narrativeRun(), active = ['running','paused','failed','awaiting-review'].includes(run.status) && run.kinds?.includes(state.tab);
    const joint = active && run.kinds.length > 1 ? run.usage : null;
    const single = active && run.kinds.length === 1 ? run.usage : null;
    return joint ? `<p class="meta">联合用量：输入 ${esc(joint.inputTokens)} ＋ 输出预留 ${esc(joint.outputReserve)} ＝ 总计 ${esc(joint.totalTokens)} / 上限 ${esc(joint.budget)} token${joint.estimated ? '（估算）' : ''}</p>` : single ? `<p class="meta">请求输入：${single.estimated ? '约 ' : ''}${esc(single.inputTokens)} token · 输出预留：${esc(single.outputReserve)} token</p>` : '';
  }
  function narrativeView() {
    const kind = state.tab, preferences = narrativePreferences(), info = narrativeStatus(), result = narrativeResults();
    const floor = narrativeData().progress?.[kind]?.lastProcessedFloor;
    const entries = kind === 'self' ? result.flatMap(character => character.entries ?? []) : result;
    const hasEntries = entries.length > 0;
    const bodyTokens = estimateNarrativeTokens(entries.map(entry => entry.text).join('\n\n'));
    const entryMarkup = entry => `<article class="record benmo-narrative-entry"><div class="row"><span class="meta">${esc(rangesText(entry.sources))}</span>${button('编辑', 'edit-narrative', `data-id="${esc(entry.id)}"`)}</div><p class="reading">${esc(entry.text)}</p></article>`;
    return `<div class="row"><span class="meta">${Number.isSafeInteger(floor) ? `已处理至第 ${floor} 楼` : hasEntries ? '当前聊天' : '尚未生成'} · 约 ${bodyTokens} token</span><div class="actions">${textEntry('设置', 'settings-narrative')}${button('生成', 'generate-narrative', '', 'secondary')}</div></div>${narrativeRunStatus() ? `<p class="meta" role="status">${esc(narrativeRunStatus())}</p><div class="actions">${narrativeRunActions()}</div>` : ''}${info.error && info.error !== (error || value.error) ? `<p class="lt-error" role="alert">${esc(info.error)}</p>` : ''}<div class="section">${kind === 'self' ? result.filter(character => character.entries?.length).map(character => { const selected = preferences.characters?.find(row => row.id === character.id); return `<section class="section benmo-narrative-group"><div class="row"><h2>${esc(character.name)}</h2><span class="meta">${selected ? selected.inject ? '每轮注入' : '未选择注入' : '保留的历史自述'}</span></div>${character.entries.map(entryMarkup).join('')}</section>`; }).join('') : result.map(entryMarkup).join('')}${hasEntries ? '' : `<p class="meta">暂无${TABS[kind]}</p>`}</div>${narrativeUsage()}`;
  }
  function clearNarrativePreview() { generationPreview.invalidate({close:true}); }
  const activeNarrativeKinds = () => ['running','paused','failed','awaiting-review'].includes(narrativeRun().status) ? narrativeRun().kinds ?? narrativeKinds ?? [state.tab] : narrativeKinds ?? [state.tab];
  function narrativeHistory() {
    const kinds = activeNarrativeKinds(), data = narrativeData(), latest = data.latestGeneration ?? {};
    const records = kinds.flatMap(kind => {
      const rows = data.generationRecords?.[kind] ?? [];
      if (rows.length) return rows.map(row => ({...row,kind}));
      const range = data.progress?.[kind]?.sourceSnapshot?.requestedRange;
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start) return [];
      return [{kind,legacy:true,startFloor:range.start,endFloor:range.end}];
    });
    const validLatest = kinds.every(kind => !narrativeStatus(kind).sourceStale && latest[kind]?.baseline && latest[kind]?.recordId && data.generationRecords?.[kind]?.at(-1)?.id === latest[kind].recordId);
    const jointLatest = kinds.length === 1 || (latest.self?.pairId && latest.self.pairId === latest.outline?.pairId && same(latest.self.range,latest.outline.range));
    return `<details class="lt-summary-history ui-disclosure"><summary>总结记录与重新生成</summary>${records.map(row => `<div class="lt-summary-history-row ui-disclosure-body"><span>${kinds.length > 1 ? `${TABS[row.kind]} · ` : ''}${row.legacy ? '旧数据最近处理范围 · ' : ''}${esc(row.startFloor ?? row.range?.start)}—${esc(row.endFloor ?? row.range?.end)} 楼${row.legacy && narrativeStatus(row.kind).sourceStale ? ' · 来源已变化' : ''}${row.legacy ? ' · 无可用重做基版' : ''}</span>${!row.legacy && validLatest && jointLatest && row.id === latest[row.kind]?.recordId && row.kind === kinds[0] ? button('重新生成', 'regenerate-narrative', `data-id="${esc(row.id)}" ${narrativeBusy() || ['paused','failed','awaiting-review'].includes(narrativeRun().status) ? 'disabled' : ''}`) : ''}</div>`).join('') || '<p class="lt-meta ui-disclosure-body">暂无总结记录</p>'}</details>`;
  }
  function narrativePreviewPanel() {
    if (!previewState.previewOpen) return '';
    const requestPreview=previewState.preview;if (!requestPreview) return '';
    const tasks=requestPreview.tasks??[], kinds=requestPreview.kinds??activeNarrativeKinds();
    const jointBudget=kinds.length>1||tasks.some(task=>task.usage?.joint);
    const tabs=summaryPreviewTabs([['memory','记忆'],['original','上下文'],['materials','角色'],['prompt','提示词']],previewState.previewView,id=>`data-action="narrative-preview-tab" data-id="${id}"`);
    const groups=narrativeMaterialGroups(tasks);
    const cardRows=card=>card?[['description','角色描述'],['personality','性格'],['scenario','初始情境']].filter(([key])=>card[key]).map(([key,label])=>[`${card.name?`${card.name} · `:''}${label}`,card[key],true]):[];
    const promptReading=part=>part.field==='card'?groups.filter(group=>group.field==='card').flatMap(group=>cardRows(group.value)):null;
    const materialRows=group=>{
      const data=group.value;
      if(group.field==='memory')return data.map((row,index)=>summaryPreviewSource([narrativeMemoryTime(row),row.title??`记忆 ${index+1}`].filter(Boolean).join('｜'),row.body??row.text??'')).join('')||'<p class="lt-meta">本项未发送记忆总结</p>';
      if(group.field==='original')return data.map(row=>summaryPreviewSource(`第 ${row.floor} 楼 · ${row.speaker??''}`,row.text)).join('')||'<p class="lt-meta">本项未发送历史正文</p>';
      if(group.field==='card')return cardRows(data).map(([label,text])=>summaryPreviewSource(label,text,'',{lineBreaks:true})).join('');
      if(group.field==='supplement')return data?summaryPreviewSource('补充背景',data):'';
      return group.kind==='self'?data.map(row=>summaryPreviewSource(`${row.name} · 历史自述`,(row.entries??[]).join('\n\n'))).join(''):summaryPreviewSource('现有大纲',data.join('\n\n'));
    };
    // Role fields retain display-only line-break handling; all other prompt parts
    // display the exact outgoing text. Neither projection changes messages.
    const visible=groups.filter(group=>previewState.previewView==='materials'?['card','supplement','previous'].includes(group.field):group.field===previewState.previewView);
    const body=previewState.previewView==='prompt'?(requestPreview.request?.previewParts??requestPreview.request?.messages??[]).map((part,index)=>summaryPreviewPrompt({...part,name:part.name??`消息 ${index+1}`},'',promptReading(part))).join(''):visible.map(group=>{
      const rows=materialRows(group);
      return rows&&kinds.length>1?summaryPreviewStage(group.kind?TABS[group.kind]:`核心${group.name}`,rows):rows;
    }).join('');
    const usage=requestPreview.usage;
    return summaryPreviewPanel(tabs,body+(usage?`<p class="lt-meta">${usage.estimated?'预计输入约':'输入 '}${esc(usage.inputTokens)} token · 输出预留 ${esc(usage.outputReserve)} token${jointBudget?` · 总计 ${esc(usage.totalTokens)} / 联合预算 ${esc(usage.budget)} token`:` · 材料预算 ${esc(usage.budget)} token`}</p>`:''));
  }
  function narrativeReview() {
    const review = narrativeRun().review;
    if (!review) return '<p class="meta" role="status">检查内容暂不可用，请重新读取。</p>';
    return `<section class="lt-summary-candidate ui-section"><h2>入库前检查</h2>${(review.kinds ?? activeNarrativeKinds()).map(kind => {
      const rows = review.results?.[kind] ?? [];
      const entries = kind === 'self' ? rows.map(row => `<section class="ui-section"><h3>${esc(row.name)}</h3>${(row.entries ?? []).map(entry => `<p class="reading">${esc(entry.text ?? entry)}</p>`).join('')}</section>`).join('') : rows.map(entry => `<p class="reading">${esc(entry.text ?? entry)}</p>`).join('');
      return `<section class="ui-section"><h2>${TABS[kind]}</h2>${entries || '<p class="meta">本批无新增条目</p>'}</section>`;
    }).join('')}</section>`;
  }
  function narrativeFooter() {
    if (narrativeRun().status === 'awaiting-review' || narrativeBusy() || ['paused','failed','awaiting-review'].includes(narrativeRun().status)) return narrativeRunActions();
    return button('开始生成', 'start-narrative', narrativePlanning || !narrativeRange || blocked() ? 'disabled' : '', 'primary');
  }
  function narrativeConnection(locked = false) {
    const kinds = activeNarrativeKinds(), live = ['running','paused','failed'].includes(narrativeRun().status) ? value.narrative?.requestPreview : null;
    const progress = kinds.map(kind => { const floor = narrativeData().progress?.[kind]?.lastProcessedFloor; return `<span>${kind==='self'?'自述':'大纲'}：${Number.isSafeInteger(floor) ? `第 ${floor} 楼` : '未生成'}</span>`; }).join('');
    return `<div class="lt-summary-connection" data-preview-open="${previewState.previewOpen}"><div class="lt-summary-access ui-status-grid"><div class="ui-status-cell" data-selected="${previewState.previewOpen}"><span>发送内容</span>${button(previewState.previewOpen ? '收起' : '预览','preview-narrative',`${locked && !live || previewState.previewBusy ? 'disabled' : ''} ${previewState.previewBusy ? 'aria-busy="true"' : ''}`)}</div><div class="ui-status-cell"><span>总结进度</span><span class="ui-progress-text">${progress}</span></div><div class="ui-status-cell"><span>设置</span>${button('打开','settings-narrative',configBlocked() ? 'disabled' : '')}</div></div>${narrativePreviewPanel()}</div>`;
  }
  function narrativeGeneration() {
    const run = narrativeRun(), kinds = activeNarrativeKinds(), locked = narrativeBusy() || ['paused','failed','awaiting-review'].includes(run.status);
    if (run.status === 'awaiting-review') return narrativeReview();
    if (['running','paused','failed'].includes(run.status)) return `<section class="ui-section"><h2>${kinds.map(kind => TABS[kind]).join('与')}</h2><p class="meta" role="status">${esc(narrativeRunStatus())}</p>${run.error ? `<p class="lt-error" role="alert">${esc(run.error)}</p>` : ''}${narrativeUsage()}</section>${narrativeHistory()}${narrativeConnection(true)}`;
    if (narrativePlanning && !narrativeRange) return '<p class="meta" role="status">正在读取生成范围…</p>';
    if (!narrativeRange) return button('重新读取范围', 'generate-narrative');
    const other = state.tab === 'self' ? 'outline' : 'self';
    const choice = (name,attribute,label,checked,disabled=false) => `<label class="ui-choice ui-choice--control-only ui-hit-owner"><input class="ui-input" type="checkbox" name="${name}" ${attribute} ${checked ? 'checked' : ''} ${previewBlocked() || acting || locked || disabled ? 'disabled' : ''}><span>${label}</span><span class="ui-hit-area" aria-hidden="true"></span></label>`;
    const number = (key,label,min=0) => `<label class="ui-field"><span>${label}</span><input class="ui-input" type="number" min="${min}" step="1" inputmode="numeric" name="${key}" value="${esc(narrativeRange[key])}" ${locked || previewBlocked() ? 'disabled' : ''}></label>`;

    return `<form id="benmo-narrative-generate-form" class="lt-summary-main"><section class="lt-summary-section ui-section"><h2>楼层范围</h2><div class="lt-summary-range ui-field-grid">${number('startFloor','开始楼')}${number('endFloor','结束楼')}</div></section><section class="lt-summary-section ui-section"><h2>生成选项</h2><div class="lt-summary-choices ui-choice-group" data-ui-interaction-profile="compact-group-candidate">${choice('narrativeTogether','data-narrative-together',`同时生成${TABS[other]}`,kinds.length > 1,!policy()[other])}${choice('narrativeReview','data-narrative-review','入库前检查',narrativeRange.reviewBeforeCommit)}${choice('narrativeBatching','data-narrative-batching','批量生成',narrativeRange.batching)}</div>${!policy()[other] ? `<p class="meta">${TABS[other]}已关闭，暂不可同时生成。</p>` : ''}${narrativeRange.batching ? number('batchSize','每隔多少楼总结',1) : ''}${kinds.length > 1 ? `${narrativeSharedSource()}${number('jointBudget','联合预算（token）',1)}<div class="actions">${button('保存预算','save-narrative-budget',locked || acting ? 'disabled' : '')}</div>` : ''}</section>${narrativeHistory()}${narrativeConnection(locked)}<div data-narrative-draft-status ${narrativeDraftStatus() ? '' : 'hidden'}>${narrativeDraftStatus()}</div></form>`;
  }
  function narrativeSharedSource() {
    const kinds = activeNarrativeKinds();
    return `<p class="meta" data-narrative-shared-source>共同剧情资料：${kinds.some(kind => narrativePreferences(kind).autoSource === 'cumulative') ? '本批原文（古法固定）' : `${narrativeSourceChoice(narrativePreferences(kinds[0])) === 'memory' ? '记忆' : '本批原文'}（跟随${TABS[kinds[0]]}设置）`}</p>`;
  }
  function narrativeDraftStatus() {
    return `${narrativeRunStatus() ? `<p class="meta" role="status">${esc(narrativeRunStatus())}</p>` : ''}${narrativeRun().error ? `<p class="lt-error" role="alert">${esc(narrativeRun().error)}</p>` : ''}${Number(narrativeRange?.startFloor) > Number(narrativeRange?.endFloor) ? '<p class="meta" role="status">暂无新内容，可选择其他楼层范围。</p>' : ''}`;
  }
  const generationDraftVisible = () => state.route === 'narrative-generate' && narrativeRange && !loading && !loadFailed && !narrativeBusy() && !['paused','failed','awaiting-review'].includes(narrativeRun().status);
  // Like summary parameter editing, keep raw drafts and update only dependent
  // chrome. Replacing the form and restoring focus closes Android's keyboard.
  function syncNarrativeDraft({receipt = false} = {}) {
    if (disposed || suspended || !generationDraftVisible()) return;
    const replaceRegion = (selector, markup) => {
      const node = app.querySelector(selector);
      if (!node) return;
      const staging = app.ownerDocument.createElement('div'); staging.innerHTML = markup;
      const next = staging.children[0];
      if (!node.isEqualNode(next)) node.parentNode.replaceChild(next, node);
    };
    replaceRegion('.lt-summary-connection', narrativeConnection());
    if (activeNarrativeKinds().length > 1) replaceRegion('[data-narrative-shared-source]', narrativeSharedSource());
    const status = app.querySelector('[data-narrative-draft-status]');
    if (status) { const markup = narrativeDraftStatus(); status.innerHTML = markup; status.hidden = !markup; }
    if (receipt) {
      const history = app.querySelector('.lt-summary-history'), opened = history?.open;
      replaceRegion('.lt-summary-history', narrativeHistory());
      const updated = app.querySelector('.lt-summary-history'); if (updated) updated.open = opened;
      const errors = app.querySelector('[data-narrative-errors]');
      if (errors) { const markup = narrativeErrors(); errors.innerHTML = markup; errors.hidden = !markup; }
    }
    for (const node of app.querySelectorAll('#benmo-narrative-generate-form input')) {
      node.disabled = previewBlocked() || (node.type === 'checkbox' && (acting || (node.dataset.narrativeTogether !== undefined && !policy()[state.tab === 'self' ? 'outline' : 'self'])));
    }
    for (const action of ['start-narrative','save-narrative-budget','preview-narrative','settings-narrative']) {
      const node = app.querySelector(`[data-action="${action}"]`);
      if (node) node.disabled = (action === 'settings-narrative' ? configBlocked() : action === 'preview-narrative' ? previewBlocked() : blocked()) || (action === 'start-narrative' ? narrativePlanning : action === 'preview-narrative' ? previewState.previewBusy : action === 'save-narrative-budget' && acting);
    }
    renderedMarkup = null;
  }
  function narrativeErrors() { return error || value.error ? `<p class="lt-error" role="alert">${esc(error || value.error)}</p>${button('重新读取', 'reload')}` : ''; }
  const narrativeScope = () => narrativeKinds?.length > 1 ? {kinds: [...narrativeKinds]} : {kind: narrativeKinds?.[0] ?? state.tab};
  async function openNarrativeGeneration() {
    if (previewBlocked() || !NARRATIVES.includes(state.tab)) return;
    const pending = narrativeRun();
    narrativeKinds = ['running','paused','failed','awaiting-review'].includes(pending.status) && pending.kinds?.length ? [...pending.kinds] : [state.tab];
    remember(); epoch++; const operationEpoch = epoch; clearDraft(); clearNarrativePreview(); state.route = 'narrative-generate'; error = ''; narrativePlanning = true; narrativeRange = null; render();
    try { const plan = await controller.previewNarrative(narrativeScope()); if (disposed || suspended || epoch !== operationEpoch) return; const preferences = narrativeData().preferences?.run ?? {}; narrativeRange = {batching: false, reviewBeforeCommit: false, startFloor: String(plan.startFloor ?? ''), endFloor: String(plan.endFloor ?? plan.latestFloor ?? ''), batchSize: String(plan.batchSize ?? preferences.batchSize ?? 10), jointBudget: String(plan.jointBudget ?? preferences.jointBudget ?? Math.max(...NARRATIVES.map(kind => narrativePreferences(kind).budget ?? 30000)))}; }
    catch (failure) { if (!disposed && !suspended && epoch === operationEpoch) error = failure.message || '读取生成范围失败，请重试'; }
    finally { if (!disposed && !suspended && epoch === operationEpoch) { narrativePlanning = false; render(); } }
  }
  function narrativeOptions() {
    readDraft(); const keys = narrativeRange?.batching ? ['startFloor','endFloor','batchSize'] : ['startFloor','endFloor'];
    const options = Object.fromEntries(keys.map(key => [key, Number(narrativeRange?.[key])]));
    if (keys.some(key => !String(narrativeRange?.[key] ?? '').trim() || !Number.isSafeInteger(options[key])) || options.startFloor < 0 || options.endFloor < options.startFloor) throw new Error('请填写有效的楼层范围');
    if (!narrativeRange.batching) options.batchSize = options.endFloor - options.startFloor + 1;
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) throw new Error('请填写有效的每批楼数');
    if (narrativeKinds?.length > 1) {
      options.jointBudget = narrativeJointBudget();
    }
    return {...options, ...(narrativeRange.reviewBeforeCommit ? {reviewBeforeCommit:true} : {}), ...narrativeScope()};
  }
  function narrativeJointBudget() {
    const budget = Number(narrativeRange?.jointBudget);
    if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('请填写有效的联合预算');
    return budget;
  }
  function narrativeSwitch(key, label, checked, action = 'toggle-narrative-setting') {
    return `<div class="row"><span class="ui-field__label">${esc(label)}</span><button type="button" class="ui-switch" role="switch" aria-label="${esc(label)}" aria-checked="${checked === true}" data-action="${action}" data-id="${esc(key)}"><span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__knob" aria-hidden="true"></span></span></button></div>`;
  }
  function narrativeSettings() {
    const self = state.tab === 'self';
    const sources = draft.autoSource === 'cumulative' ? '<p class="meta">古法固定读取本批清洗原文。</p>' : `<fieldset class="lt-modes" aria-label="剧情资料来源"><legend class="ui-field__label">剧情资料来源</legend>${[['memory','读取记忆'],['original','读取本批原文']].map(([source,label])=>`<label class="lt-mode"><input type="radio" name="narrativeSource" data-narrative-source value="${source}" ${narrativeSourceChoice(draft)===source?'checked':''}>${label}</label>`).join('')}</fieldset>`;
    return `<form id="benmo-edit-form" class="section"><section class="card"><h2>读取材料</h2>${onOpenCleaning ? button('总结文本清洗','narrative-cleaning') : ''}${sources}${self ? `${narrativeSwitch('readCard', '读取角色卡基础设定', draft.readCard)}` : ''}<label class="ui-field"><span>补充背景</span><textarea class="lt-textarea" name="background" rows="5" placeholder="可粘贴本条路线或世界设定">${esc(draft.background)}</textarea></label></section>${self ? `<section class="card"><h2>指定角色与注入</h2><p class="meta">所有角色一起生成；可分别选择是否注入。</p>${draft.characters.map(character => `<section class="section"><div class="custom-field-heading"><label class="ui-field"><span>角色姓名</span><input class="ui-input" name="${esc(`narrative-character-${character.id}`)}" value="${esc(character.name)}" maxlength="160" required></label>${button('移除', 'remove-narrative-character', `data-id="${esc(character.id)}" aria-label="移除此指定角色"`)}</div>${narrativeSwitch(character.id, `${character.name || '此角色'}的自述每轮注入`, character.inject, 'toggle-narrative-injection')}</section>`).join('')}${button('＋ 添加角色', 'add-narrative-character', '', 'secondary')}</section>` : ''}<details class="card"><summary>高级设置</summary><div class="two-cols"><label class="ui-field"><span>材料预算（token）</span><input class="ui-input" name="budget" type="number" min="1" step="1" inputmode="numeric" required value="${esc(draft.budget)}"></label><label class="ui-field"><span>注入深度</span><input class="ui-input" name="depth" type="number" min="0" max="10000" step="1" inputmode="numeric" required value="${esc(draft.depth)}"></label></div></details><section class="card"><label class="ui-field"><span>${TABS[state.tab]}内容提示词</span><textarea class="lt-textarea lt-prompt-editor" name="prompt" rows="12" maxlength="20000" required>${esc(draft.prompt)}</textarea></label><div class="actions">${button('恢复默认提示词', 'default-narrative-prompt')}</div></section></form>`;
  }
  function narrativeEditor() {
    return `<form id="benmo-edit-form" class="section"><p class="summary-origin">来源：${esc(rangesText(draft.sources))}</p><label class="ui-field"><span>${TABS[state.tab]}正文</span><textarea class="lt-textarea" name="text" rows="10" required>${esc(draft.text)}</textarea></label></form>`;
  }
  function narrativeSettingsDraft(preferences, kind = state.tab) {
    const next = {...preferences, readMemory: narrativeSourceChoice(preferences) === 'memory', readOriginal: narrativeSourceChoice(preferences) === 'original', background: preferences.background ?? '', budget: String(preferences.budget ?? 30000), depth: String(preferences.depth ?? 9999), prompt: preferences.prompt || controller.defaultNarrativePrompts?.[kind] || ''};
    if (preferences.autoSource === 'cumulative') { next.readMemory = preferences.readMemory; next.readOriginal = preferences.readOriginal; }
    if (kind === 'self') { next.readCard = preferences.readCard !== false; next.characters = clone(preferences.characters ?? []); }
    return next;
  }
  function startNarrativeSettings() {
    remember(); epoch++; returnRoute = state.route === 'narrative-generate' ? 'narrative-generate' : 'list'; clearNarrativePreview(); original = clone(narrativePreferences());
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
  async function refreshNarrativeRange(operationEpoch) {
    if (state.route !== 'narrative-generate' || !narrativeRange || narrativeRun().status !== 'complete' || disposed || suspended || epoch !== operationEpoch) return;
    // A recovered run may belong to the other tab. Once it finishes, this
    // origin page must again represent its own single/combined selection.
    if (narrativeKinds?.length === 1 && narrativeKinds[0] !== state.tab) narrativeKinds = [state.tab];
    const plan = await controller.previewNarrative({...narrativeScope(), ...(narrativeRange.batching ? {batchSize:Number(narrativeRange.batchSize)} : {})});
    if (!disposed && !suspended && epoch === operationEpoch) { narrativeRange = {...narrativeRange,startFloor:String(plan.startFloor),endFloor:String(plan.endFloor)}; render(); }
  }
  async function generateNarrative(options) {
    if (blocked() || narrativeBusy() || ['paused','failed','awaiting-review'].includes(narrativeRun().status)) return;
    clearNarrativePreview(); const operationEpoch = epoch, token = {}; narrativeJobs.set('run', token); remember(); render();
    try {
      const preferences=narrativeData().preferences??{},savedBudget=preferences.run?.jointBudget??Math.max(preferences.self?.budget??30000,preferences.outline?.budget??30000);
      if (options.kinds?.length > 1 && options.jointBudget!==savedBudget) {
        apply(await controller.saveNarrativeRunPreferences({jointBudget: options.jointBudget}));
        if (disposed || suspended || epoch !== operationEpoch || blocked()) return;
      }
      const next = await controller.startNarrative(options); if (!disposed && narrativeJobs.get('run') === token) { apply(next); await refreshNarrativeRange(operationEpoch); } }
    catch (failure) { if (!disposed && !suspended && epoch === operationEpoch) error = failure.message || '生成未完成，请重试'; }
    finally { if (narrativeJobs.get('run') === token) narrativeJobs.delete('run'); if (!disposed && !suspended && epoch === operationEpoch) { remember(); render(); } }
  }
  function content() {
    if (state.route === 'narrative-generate') return narrativeGeneration();
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
    if (state.route === 'narrative-generate') return `${TABS[state.tab]}生成`;
    if (state.route === 'narrative-settings') return `${TABS[state.tab]}设置`;
    if (state.route === 'narrative-edit') return `编辑${TABS[state.tab]}`;
    if (state.route === 'tracking-settings') return `${KINDS[state.kind]}设置`;
    if (state.route === 'summary-settings') return '最新摘要设置';
    if (state.route === 'detail') return state.kind === 'item' ? '物品详情' : '角色详情';
    if (state.route === 'edit') return state.kind === 'summary' ? draft?.id ? '编辑最新摘要' : '手动补录摘要' : `${returnRoute === 'list' && !original ? '新建' : '编辑'}${state.kind === 'item' ? '物品' : '角色'}`;
    return '本末';
  }
  let renderedMarkup = null, surfacePatched = false;
  function render() {
    if (disposed || suspended) return;
    restoreRevalidationControls();
    // Only this synchronous render shares a policy projection. Actions, new
    // notifications and any continuation after an await read live authority.
    const previousPolicy = renderPolicy, external = readExternalPolicy(), current = derivePolicy(external);
    const kinds = Object.keys(KINDS).filter(key => current[key]);
    renderPolicy = {external, policy: current, kinds, tabs: Object.keys(TABS).filter(key => key === 'records' ? kinds.length > 0 : current[key])};
    try {
    if (externalPolicy().transient && !loading && !loadFailed) { syncWriteControls(); return; }
    renderedPolicy = JSON.stringify(policy());
    if (initializing && loading && enabledTabs().length) normalize(false);
    if (!loading && !loadFailed && !normalize()) { stopSummaryVisibility(); app.innerHTML = ''; renderedMarkup = null; redirectToSettings(); return; }
    if (!loading && !loadFailed && state.tab === 'records' && state.kind === 'summary') startSummaryVisibility(); else stopSummaryVisibility();
    const focused = app.getRootNode().activeElement;
    const focusName = focused?.name, focusValue = focused?.value, focusData = focused?.dataset ? JSON.stringify({...focused.dataset}) : null;
    const subpage = state.route !== 'list';
    const markup = `<section class="lantai ${state.route === 'narrative-generate' ? 'lt-summary-workspace' : 'workshop'} benmo ui-workspace ui-graphic-controls" data-ui-theme="${surfaceTheme(app)}" data-benmo-route="${state.route}" data-benmo-tab="${state.tab}" data-benmo-kind="${state.kind}">${subpage ? `<header class="lt-header ui-header ${state.route === 'narrative-generate' ? 'ui-header--centered' : 'subpage-header'}">${icon(draft && returnRoute === 'detail' ? '返回记录详情' : `返回${state.tab === 'records' ? KINDS[state.kind] : TABS[state.tab]}`, 'back', 'back')}<h1 class="ui-page-title">${pageTitle()}</h1>${icon('关闭兰台', 'close', 'close')}</header>` : `<header class="lt-header lt-header--root ui-header"><div class="lt-root-top">${rootTitle('benmo')}${icon('关闭兰台', 'close', 'close')}</div><nav class="ui-tablist" aria-label="本末分区">${enabledTabs().map(id => selectButton(id, TABS[id], state.tab, 'tab')).join('')}</nav></header>`}<main class="lt-main ui-main${state.route === 'narrative-generate' ? ' lt-summary-main ui-main--summary' : ''}" tabindex="-1">${state.route === 'narrative-generate' ? `<div data-narrative-errors ${error || value.error ? '' : 'hidden'}>${narrativeErrors()}</div>` : narrativeErrors()}${loading ? '<p class="wk-empty" role="status" aria-live="polite">正在读取本末记录…</p>' : loadFailed ? '' : content()}</main><footer class="lt-footer${state.route === 'narrative-generate' ? ' ui-action-footer' : ''}">${state.route === 'narrative-generate' ? narrativeFooter() : draft ? formActions() : mainNavigation({policy: policy(), current: 'benmo', actions: {memory: 'area', time: 'area', workshop: 'area', benmo: 'area', settings: 'area'}, attributes: Object.fromEntries(['memory', 'time', 'workshop', 'benmo', 'settings'].map(area => [area, `data-id="${area}"`]))})}</footer>${dialog ? `<div class="wk-dialog" role="dialog" aria-modal="true" aria-label="确认操作"><div class="wk-dialog-box"><p>${esc(dialog.pending ? '正在处理，请稍候…' : dialog.text)}</p>${(dialog.details ?? []).map(item => `<section class="section"><label class="ui-field"><span>后台新内容</span><textarea class="lt-textarea" rows="3" readonly aria-label="后台${esc(item.label)}">${esc(item.latest)}</textarea></label><label class="ui-field"><span>你的草稿</span><textarea class="lt-textarea" rows="3" readonly aria-label="草稿${esc(item.label)}">${esc(item.local)}</textarea></label></section>`).join('')}<div class="wk-dialog-actions">${button(dialog.cancelLabel ?? '取消', 'cancel-dialog', dialog.pending ? 'disabled' : '')}${button(dialog.pending ? '处理中…' : dialog.confirmLabel ?? '确认', 'confirm-dialog', dialog.pending ? 'disabled aria-busy="true"' : '', dialog.confirmTone ?? 'primary')}</div></div></div>` : ''}</section>`;
  // Repeated runtime receipts must not replace an unchanged surface.
  const beforeMain=app.querySelector('.lt-main'),markupChanged=markup !== renderedMarkup || surfacePatched;
  if (markupChanged) { replaceSurfaceMarkup(app, markup, renderedMarkup); renderedMarkup = markup; surfacePatched = false; }
    const main = app.querySelector('.lt-main');
    try { onRenderCommit(markupChanged,beforeMain!==main); } catch {}
    if (main) main.scrollTop = state.scrolls[context()] ?? 0;
    if (dialog) {
      for (const node of app.querySelectorAll('.lt-header,.lt-main,.lt-footer')) node.inert = true;
      app.querySelector('[data-action="cancel-dialog"]')?.focus({preventScroll: true});
    } else if (focused) {
      const next = [...app.querySelectorAll('[data-action],input,textarea')].find(node => focusName ? node.name === focusName && (node.type !== 'radio' || node.value === focusValue) : focusData && JSON.stringify({...node.dataset}) === focusData);
      next?.focus?.({preventScroll: true});
    }
    } finally { renderPolicy = previousPolicy; syncRevalidationControls(); }
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
    if (!draft || (state.route === 'narrative-settings' ? configBlocked() : blocked()) || composing || !app.querySelector('form')?.reportValidity()) return;
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
  app.addEventListener('change', event => {
    if (event.target?.dataset?.narrativeSource !== undefined) {
      if (state.route !== 'narrative-settings' || configBlocked() || acting || composing || disposed || suspended || draft.autoSource === 'cumulative' || !['memory','original'].includes(event.target.value)) return;
      remember(); draft.readMemory = event.target.value === 'memory'; draft.readOriginal = !draft.readMemory; render(); return;
    }
    const control = event.target.closest('[data-narrative-together], [data-narrative-batching], [data-narrative-review]');
    if (!control || control.disabled || disposed || suspended || composing || acting || dialog || previewBlocked() || narrativePlanning || narrativeBusy() || ['running','paused','failed','awaiting-review'].includes(narrativeRun().status) || state.route !== 'narrative-generate' || !narrativeRange) return;
    clearNarrativePreview();
    if (control.dataset.narrativeReview !== undefined) { remember(); epoch++; narrativeRange.reviewBeforeCommit = control.checked === true; error = ''; render(); return; }
    if (control.dataset.narrativeBatching !== undefined) {
      remember(); epoch++; narrativeRange.batching = control.checked === true; error = ''; render(); return;
    }
    const together = control.checked === true;
    if (together && !NARRATIVES.every(kind => policy()[kind])) return;
    remember(); epoch++; narrativeKinds = together ? [state.tab, ...NARRATIVES.filter(kind => kind !== state.tab)] : [state.tab]; error = ''; render();
  }, {signal: lifetime.signal});
  app.addEventListener('input', event => {
    if (state.route !== 'narrative-generate' || !event.target?.name || !['startFloor','endFloor','batchSize','jointBudget'].includes(event.target.name)) return;
    if(changeGenerationDraft(narrativeRange,params=>{params[event.target.name]=event.target.value;},clearNarrativePreview)){narrativePlanning=false;epoch++;syncNarrativeDraft();}
  }, {signal: lifetime.signal});
  app.addEventListener('submit', event => event.preventDefault(), {signal: lifetime.signal});
  app.addEventListener('compositionstart', () => { composing = true; }, {signal: lifetime.signal});
  app.addEventListener('compositionend', () => { composing = false; }, {signal: lifetime.signal});
  function restoreRevalidationControls() {
    for (const [node, disabled] of revalidationControls) node.disabled = disabled;
    revalidationControls.clear();
  }
  function syncRevalidationControls() {
    restoreRevalidationControls();
    if (!revalidating || disposed || suspended) return;
    for (const node of app.querySelectorAll('[data-action]')) if (revalidationActions.has(node.dataset.action)) {
      revalidationControls.set(node, node.disabled === true); node.disabled = true;
    }
  }
  function syncWriteControls() {
    if (disposed || suspended) return;
    for (const node of app.querySelectorAll('[data-action="delete-narrative"]')) node.disabled = blocked() || acting;
    for (const node of app.querySelectorAll('[data-action="save"]')) {
      node.disabled = (state.route === 'narrative-settings' ? configBlocked() : blocked()) || acting;
      if (acting) node.setAttribute('aria-busy', 'true'); else node.removeAttribute('aria-busy');
      node.textContent = acting ? '保存中…' : '保存';
    }
    syncRevalidationControls();
  }
  app.addEventListener('click', async event => {
    const control = event.target.closest('[data-action]');
    if (!control || control.disabled || disposed || suspended || (initializing && !isCurrent())) return;
    const action = control.dataset.action, id = control.dataset.id;
    if (revalidating && revalidationActions.has(action)) return;
    if (loading && !['close', 'area', 'back'].includes(action)) return;
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
      if (action === 'reload') { acting = ownsAction = true; remember(); const token = epoch; loading = !draft; loadFailed = false; error = ''; render(); try { const next = await readValue(true); if (!disposed && token === epoch) { remember(); apply(next); invalidated = false; recoverNarrativeDraft(); } } catch (failure) { if (!disposed && token === epoch) { loadFailed = true; throw failure; } } finally { loading = false; if (!disposed && token === epoch) render(); } return; }
      if (action === 'tab' && enabledTabs().includes(id)) { leave(() => { remember(); epoch++; state.tab = id; state.route = 'list'; clearDraft(); if(!revalidating&&controller.snapshot)apply(controller.snapshot()); render(); }); return; }
      if (action === 'kind' && enabledKinds().includes(id)) { leave(() => { remember(); epoch++; state.kind = id; state.route = 'list'; state.selected = state.selections[id] ?? null; clearDraft(); if(!revalidating&&controller.snapshot)apply(controller.snapshot()); render(); }); return; }
      if (action === 'narrative-cleaning' && state.route === 'narrative-settings' && onOpenCleaning) { remember(); clearNarrativePreview(); await onOpenCleaning(); return; }
      if (action === 'narrative-preview-tab' && ['memory','original','materials','prompt'].includes(id)) { remember(); generationPreview.view(id); render(); return; }
      if (action === 'preview-narrative' && state.route === 'narrative-generate' && !previewBlocked() && !previewState.previewBusy) {
        remember();
        if (previewState.previewOpen) { generationPreview.toggle(); render(); return; }
        const current = controller.snapshot?.().narrative;
        const live = current && Object.hasOwn(current,'requestPreview') ? current.requestPreview : value.narrative?.requestPreview;
        if (current && Object.hasOwn(current,'requestPreview') && !live) clearNarrativePreview();
        if (narrativeBusy() || ['paused','failed','awaiting-review'].includes(narrativeRun().status)) {
          if (!live) return;
          previewState.preview = clone(live); previewState.previewOpen = true; previewState.previewBusy = false; render(); return;
        }
        if (previewState.preview) { previewState.previewOpen = true; render(); return; }
        const options = narrativeOptions(), token = epoch; error = '';
        const work=generationPreview.prepare(()=>controller.previewNarrativeRequest(options),()=>!disposed&&!suspended&&token===epoch);render();
        try { await work; } finally { if (!disposed&&!suspended&&token===epoch) syncNarrativeDraft({receipt:true}); }
        return;
      }
      if (action === 'regenerate-narrative' && state.route === 'narrative-generate' && !narrativeBusy() && !['paused','failed','awaiting-review'].includes(narrativeRun().status)) {
        remember();
        if (activeNarrativeKinds().some(kind => narrativeStatus(kind).sourceStale)) return;
        const latest = narrativeData().latestGeneration?.[activeNarrativeKinds()[0]], record = narrativeData().generationRecords?.[activeNarrativeKinds()[0]]?.at(-1);
        if (!latest || latest.recordId !== id || record?.id !== id) return;
        const options = {...narrativeScope(), regenerateLatest:true, reviewBeforeCommit:narrativeRange?.reviewBeforeCommit === true};
        if (activeNarrativeKinds().length > 1) options.jointBudget = narrativeJointBudget();
        confirm('重新生成最新一次结果？将从生成前的内容重新处理该范围，确认入库前保留当前内容。', () => { dialog = null; clearNarrativePreview(); void generateNarrative(options); }, {confirmLabel:'重新生成'}); return;
      }
      if (action === 'settings-narrative' && NARRATIVES.includes(state.tab) && !configBlocked()) { startNarrativeSettings(); return; }
      if (action === 'edit-narrative' && NARRATIVES.includes(state.tab)) { startNarrativeEdit(id); return; }
      if (action === 'generate-narrative') { await openNarrativeGeneration(); return; }
      if (action === 'save-narrative-budget' && state.route === 'narrative-generate' && narrativeKinds?.length > 1 && !blocked() && !narrativeBusy()) {
        readDraft(); const jointBudget = narrativeJointBudget(); acting = ownsAction = true; error = ''; render();
        const next = await controller.saveNarrativeRunPreferences({jointBudget});
        if (!disposed) { remember(); apply(next); if (!suspended && epoch === actionEpoch) { render(); toast('联合预算已保存'); } }
        return;
      }
      if (action === 'start-narrative' && state.route === 'narrative-generate' && !blocked() && !narrativePlanning && !narrativeBusy() && !['paused','failed','awaiting-review'].includes(narrativeRun().status)) {
        const options = narrativeOptions();
        narrativePlanning = true; error = ''; render();
        let plan;
        try { plan = await controller.previewNarrative(options); }
        finally { if (!disposed && !suspended && epoch === actionEpoch) { narrativePlanning = false; render(); } }
        if (disposed || suspended || epoch !== actionEpoch || blocked() || narrativeBusy() || ['paused','failed','awaiting-review'].includes(narrativeRun().status)) return;
        const kinds = [...narrativeKinds];
        if (!same(kinds, plan.kinds ?? kinds) || kinds.some(kind => !policy()[kind])) throw new Error('选定功能已变化，请重新选择生成范围');
        if (plan.restart) confirm(`第 ${options.startFloor}—${options.endFloor} 楼与已处理范围重叠。生成后将替换本次选定的${kinds.map(kind => TABS[kind]).join('与')}全部内容，包括手动编辑的内容。${kinds.includes('self') ? '所有已配置角色一起重新生成。' : ''}`, () => { if (kinds.some(kind => !policy()[kind])) throw new Error('选定功能已变化，请重新开始生成并确认替换范围'); dialog = null; void generateNarrative({...options, restart:true}); }, {confirmLabel:'替换并生成'});
        else await generateNarrative(options);
        return;
      }
      if (['pause-narrative','continue-narrative','retry-narrative','skip-narrative','confirm-narrative-review'].includes(action) && !blocked()) {
        const methods = {'pause-narrative':'pauseNarrative','continue-narrative':'continueNarrative','retry-narrative':'retryNarrative','skip-narrative':'skipNarrative','confirm-narrative-review':'confirmNarrativeReview'};
        if (action === 'confirm-narrative-review' && narrativeRun().status !== 'awaiting-review') return;
        const perform = async () => { if (action === 'confirm-narrative-review') acting = ownsAction = true; dialog = null; if (state.route === 'narrative-generate' && narrativeRun().kinds?.length) narrativeKinds = [...narrativeRun().kinds]; const next = await controller[methods[action]](); if (!disposed) { apply(next); await refreshNarrativeRange(actionEpoch); if (!suspended) { remember(); render(); } } };
        if (action === 'skip-narrative') confirm('跳过本批未完成的生成并继续？本批不会记为生成成功。', () => { void perform().catch(failure => { if (!disposed && !suspended && epoch === actionEpoch) { error = failure.message || '生成未完成，请重试'; render(); } }); }, {confirmLabel:'跳过本批'}); else await perform();
        return;
      }
      if (action === 'cancel-narrative' && NARRATIVES.includes(state.tab)) {
        const kind = state.tab, token = epoch; const next = await controller.cancelNarrative(kind); narrativeJobs.delete(kind);
        if (!disposed) { apply(next); if (!suspended && epoch === token) { remember(); render(); } } return;
      }
      if (action === 'default-narrative-prompt' && state.route === 'narrative-settings') { remember(); draft.prompt = controller.defaultNarrativePrompts?.[state.tab] ?? ''; render(); return; }
      if (action === 'toggle-narrative-setting' && state.route === 'narrative-settings' && id === 'readCard') { remember(); draft[id] = !draft[id]; render(); return; }
      if (action === 'toggle-narrative-injection' && state.route === 'narrative-settings') { remember(); const character = draft.characters?.find(row => row.id === id); if (character) { character.inject = !character.inject; render(); } return; }
      if (action === 'add-narrative-character' && state.route === 'narrative-settings' && state.tab === 'self') { remember(); draft.characters.push({id: crypto.randomUUID(), name: '', inject: true}); render(); return; }
      if (action === 'remove-narrative-character' && state.route === 'narrative-settings' && state.tab === 'self') { remember(); draft.characters = draft.characters.filter(row => row.id !== id); render(); return; }
      if (action === 'settings-tracking' && FIELDS[state.kind]) { startEdit(null, state.route === 'detail' ? 'detail' : 'list', 'tracking-settings'); return; }
      if (action === 'default-tracking-prompt' && state.route === 'tracking-settings') { remember(); draft.prompt = controller.defaultTrackingPrompts?.[state.kind] ?? ''; render(); return; }
      if (action === 'settings-summary' && state.kind === 'summary') { startEdit(null, 'list', 'summary-settings'); return; }
      if (action === 'default-prompt' && state.route === 'summary-settings') { remember(); draft.prompt = controller.defaultPrompt ?? ''; render(); return; }
      if (action === 'expand') { remember(); state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); if (!patchSummaryDisclosure(control, id)) render(); return; }
      if (action === 'toggle-summary-history' && state.kind === 'summary') { remember(); state.summaryHistoryExpanded = !state.summaryHistoryExpanded; if (!patchSummaryDisclosure(control)) render(); return; }
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
      if (action === 'delete-narrative' && state.route === 'narrative-edit' && draft && !blocked()) {
        const kind = state.tab, entryId = draft.id, previous = clone(original), token = epoch, target = clone(narrativeDraftTarget);
        confirm(`删除这条${TABS[kind]}？`, async () => {
          if (blocked() || epoch !== token || !same(target, value.target)) throw new Error('聊天或资料已变化，请重新读取后修改');
          const remove = entries => entries.filter(entry => entry.id !== entryId);
          const entries = kind === 'self' ? previous.map(character => ({...character, entries: remove(character.entries)})) : remove(previous);
          const next = await controller.saveNarrativeEntries(kind, entries, {original: previous});
          if (disposed) return;
          apply(next);
          if (epoch !== token || suspended) return;
          state.route = returnRoute; clearDraft(); dialog = null; render(); toast('已删除');
        }, {confirmLabel: '删除', confirmTone: 'danger'}); return;
      }
      if (action === 'delete-record' && state.route === 'detail' && !blocked()) {
        const row = selectedRecord(), kind = state.kind, token = epoch; if (!row) return;
        confirm(`删除“${row.name}”这条${kind === 'item' ? '物品' : '角色'}记录？`, async () => {
          const next = await controller.deleteRecord(kind, row.id); if (disposed) return; apply(next);
          if (epoch !== token || suspended) return;
          state.selected = null; state.selections[kind] = null; state.route = 'list'; dialog = null; render(); toast('已删除');
        }, {confirmTone: 'danger'}); return;
      }
      if (action === 'save' && !(state.route === 'narrative-settings' ? configBlocked() : blocked())) { acting = ownsAction = true; syncWriteControls(); await save(); }
    } catch (failure) {
      if (!disposed && !suspended && actionEpoch === epoch) { remember(); dialog = null; error = failure.message || '操作未完成，请重试'; value = {...value, writeBlocked: controller.snapshot?.().writeBlocked ?? value.writeBlocked}; acting = false; if (action === 'preview-narrative' && generationDraftVisible()) syncNarrativeDraft({receipt:true}); else render(); }
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
  let unsubscribe;
  function subscribe() { unsubscribe = controller.subscribe?.(next => {
    if (disposed) return;
    // A navigation check may publish loading before it has new confirmed data.
    // Keep the last readable projection and patch only its temporary write lock.
    if (revalidating && next.dataStatus !== 'ready') { syncRevalidationControls(); return; }
    const livePreview = next.narrative?.requestPreview && ['running','paused','failed'].includes(next.narrative?.run?.status);
    if ((previewState.preview || previewState.previewBusy) && (!same(value.target,next.target) || !livePreview && !same(value.narrative?.narrative,next.narrative?.narrative) || (previewState.preview && next.narrative && Object.hasOwn(next.narrative,'requestPreview') && !next.narrative.requestPreview))) clearNarrativePreview();
    if (previewState.previewOpen && next.narrative?.requestPreview && ['running','paused','failed'].includes(next.narrative?.run?.status)) previewState.preview = clone(next.narrative.requestPreview);
    value = next;
    reconcileGenerating();
    reconcileBackfill();
    // Ready receipts still retire stale reply/backfill tokens and invalidate
    // preview state. Only their DOM work waits for navigation to finish.
    if (revalidating) { syncRevalidationControls(); return; }
    const automaticStatus=app.querySelector('[data-latest-automatic-status]');
    if(automaticStatus){const message=value.summary?.automatic?.message;automaticStatus.textContent=message?`自动生成：${message}`:'';automaticStatus.hidden=!message;}
    // A background receipt must never rebuild an active input or its baseline.
    if (generationDraftVisible() && app.querySelector('#benmo-narrative-generate-form') && policy()[state.tab] && !dialog && !suspended) { readDraft(); syncNarrativeDraft({receipt:true}); }
    else if (!draft && !acting && !dialog && !suspended) { remember(); render(); }
    else for (const node of app.querySelectorAll('[data-action="save"],[data-action="delete-narrative"],[data-action="delete-record"],[data-action="toggle-excluded"],[data-action="restore-excluded"]')) node.disabled = (state.route === 'narrative-settings' && node.dataset.action === 'save' ? configBlocked() : blocked()) || acting;
  }); }
  function startSummaryVisibility() {
    if (disposed || suspended || loading || loadFailed || observingSummaryVisibility || !controller.observeSummaryVisibility) return;
    observingSummaryVisibility = true;
    summaryVisibilityDisposer = controller.observeSummaryVisibility({document: app.ownerDocument});
  }
  function stopSummaryVisibility() {
    const dispose = summaryVisibilityDisposer;
    summaryVisibilityDisposer = null; observingSummaryVisibility = false;
    dispose?.();
  }
  const readValue = refresh => prepare ? prepare({refresh}) : refresh ? controller.load({refresh: true}) : controller.ensure ? controller.ensure() : controller.load();
  onMountCommit(); render();
  const loadingRoot = app.children?.[0], loadingMarkup = renderedMarkup;
  try { apply(await readValue(false)); }
  catch (failure) { loadFailed = true; error = failure.message || '读取未完成，请重试'; }
  if (!isCurrent()) { disposed = true; lifetime.abort(); stopSummaryVisibility(); clearTimeout(redirectTimer); if (loadingRoot) { if (app.children?.[0] === loadingRoot) loadingRoot.remove(); } else if (app.innerHTML === loadingMarkup) app.innerHTML = ''; return null; }
  initializing = false; loading = false; subscribe(); onMountCommit(); render();
  return {
    back() { if (!dialog && !acting) back(); },
    blocking() { return acting || dirty() || !!dialog; },
    snapshotNavigation,
    refreshAvailability() { if (JSON.stringify(policy()) !== renderedPolicy || externalPolicy().transient) { remember(); if (generationDraftVisible() && policy()[state.tab]) syncNarrativeDraft({receipt:true}); else render(); } },
    invalidate(message) { remember(); clearNarrativePreview(); epoch++; invalidated = true; error = message; value = {...value, writeBlocked: true}; render(); },
    suspend() { if (disposed || suspended) return; remember(); clearNarrativePreview(); suspended = true; epoch++; app.inert = true; stopSummaryVisibility(); },
    loading() { if (disposed) return; remember(); loading = true; loadFailed = false; error = ''; suspended = false; app.inert = false; render(); },
    fail(failure) { if (disposed) return; loading = false; loadFailed = true; error = failure?.message || '读取未完成，请重试'; suspended = false; app.inert = false; render(); },
    failed() { return loadFailed; },
    resume(next, {kind,checking=false} = {}) {
      if (disposed) return;
      remember(); restoreRevalidationControls(); revalidating=checking;
      const priorRoute=state.route, priorTab=state.tab, priorKind=state.kind, wasUnavailable=loading||loadFailed;
      if (next) { apply(next); invalidated=false; }
      if (kind && Object.hasOwn(KINDS,kind) && policy()[kind] && !draft && (state.tab!=='records'||state.kind!==kind)) { state.tab='records'; state.kind=kind; state.route='list'; state.selected=state.selections[kind]??null; }
      loading=false; loadFailed=false; suspended=false; app.inert=false;
      if (!wasUnavailable && priorRoute===state.route && priorTab===state.tab && priorKind===state.kind && JSON.stringify(policy())===renderedPolicy && (checking||draft)) { syncWriteControls(); return; }
      render();
    },
    dispose() { if (disposed) return; disposed = true; epoch++; stopSummaryVisibility(); unsubscribe?.(); lifetime.abort(); clearTimeout(toastTimer); clearTimeout(redirectTimer); app.innerHTML = ''; },
  };
}
