import { SUMMARY_PROMPT_GROUPS, MERGE_PROMPT_FIELDS, SUMMARY_MODE_DESCRIPTIONS, summaryPromptDefault } from '../shared/settings/summary-prompts.js';
import { BUILTIN_SUMMARY_CLEANING_SHORTCUTS } from '../domain/summary/cleaning.js';
import { createDefaultEventWords } from '../shared/settings/default-event-words.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const button = (label, action, extra = '', secondary = false) => `<button type="button" class="ui-button ui-button--${secondary ? 'secondary' : 'tertiary'}" data-ss-action="${action}" ${extra}>${label}</button>`;
const icon = (name, label, action, extra = '') => `<button type="button" class="ui-icon-button ui-button--tertiary" data-ss-action="${action}" aria-label="${escape(label)}" ${extra}><img class="lt-icon" src="${new URL(`./icons/${name}.svg`, import.meta.url)}" alt=""></button>`;
const switchControl = (checked, action, label, extra = '') => `<button type="button" class="ui-switch" role="switch" aria-checked="${checked}" aria-label="${escape(label)}" data-ss-action="${action}" ${extra}><span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__knob"></span></span></button>`;
const labels = { exclude: '排除', extract: '提取', replace: '替换' };
const routeLink = (label, action) => `<button type="button" class="ui-button ui-button--tertiary ui-row lt-summary-link" data-ss-action="${action}"><span>${label}</span><span aria-hidden="true">›</span></button>`;
const field = (label, attr, value, textarea = false) => `<label class="ui-field lt-stack"><span class="ui-field__label">${label}</span>${textarea ? `<textarea class="lt-textarea" ${attr} rows="7" aria-label="${label}">${escape(value)}</textarea>` : `<input class="ui-input" ${attr} value="${escape(value)}" aria-label="${label}">`}</label>`;

export function mountSummarySettingsView(container, controller, { readonlyContent } = {}) {
  if (container?.container) { ({ container, controller, readonlyContent } = container); }
  let disposed = false, editingText = false, composing = false, pendingRender = false, renderedRoute = null, dragging = null;
  const state = () => controller.inspect();
  function remember(details = true) {
    const main = container.querySelector('.lt-main');
    if (main && renderedRoute) controller.setScroll(renderedRoute, main.scrollTop);
    if (details) for (const detail of container.querySelectorAll('details[data-ss-open]')) controller.setOpen(detail.dataset.ssOpen, detail.open);
  }
  function prompt(item, s, stage = 1) {
    const opened = s.opened[item.key] ? ' open' : '';
    if (item.readonly) {
      let text = item.defaultText;
      if (item.kind === 'words') text = JSON.stringify(s.draft.eventWords.filter(word => word.enabled).map(({ name, definition }) => ({ name, definition })), null, 2);
      else if (typeof readonlyContent === 'function') text = readonlyContent(item, { mode: s.draft.generationMode, stage, settings: s.draft });
      else if (item.kind === 'drafts') text = '尚待生成。';
      return `<details class="lt-summary-prompt" data-ss-open="${item.key}"${opened}><summary>${escape(item.name)}<span class="lt-meta">只读</span></summary><pre class="lt-summary-readonly" tabindex="0">${escape(text)}</pre></details>`;
    }
    const dirty = Object.hasOwn(s.promptDrafts, item.key), text = dirty ? s.promptDrafts[item.key] : s.draft.promptOverrides[item.key] ?? summaryPromptDefault(item.key);
    return `<details class="lt-summary-prompt" data-ss-open="${item.key}"${opened}><summary>${escape(item.name)}</summary><form data-ss-form="prompt" data-key="${item.key}" class="lt-summary-prompt-body"><textarea class="lt-textarea" data-ss-field="prompt" data-key="${item.key}" aria-label="${escape(item.name)}" rows="8">${escape(text)}</textarea><p class="lt-status" data-ss-dirty="${item.key}">${dirty ? '尚未保存' : ''}</p><div class="lt-summary-editor-actions">${button('恢复默认', 'restore-prompt', `data-key="${item.key}"`)}${button('取消', 'cancel-prompt', `data-key="${item.key}"`)}<button type="submit" class="ui-button ui-button--secondary" ${dirty ? '' : 'disabled'}>保存</button></div></form></details>`;
  }
  function custom(s) {
    const list = [...s.draft.customPrompts];
    for (const item of Object.values(s.customDrafts)) if (!list.some(saved => saved.id === item.id)) list.push(item);
    return list.length ? list.map(saved => {
      const item = s.customDrafts[saved.id] ?? saved, id = escape(item.id);
      return `<details class="lt-summary-prompt" data-ss-open="custom:${id}" ${s.opened[`custom:${item.id}`] ? 'open' : ''}><summary>${escape(saved.name || '新建自定义提示词')}</summary><form data-ss-form="custom" data-id="${id}" class="lt-summary-prompt-body">${field('名称', `data-ss-field="custom" data-id="${id}" data-field="name"`, item.name)}<label class="ui-field lt-stack"><span class="ui-field__label">插入位置</span><select class="ui-input" data-ss-field="custom" data-id="${id}" data-field="position"><option value="before" ${item.position === 'before' ? 'selected' : ''}>AI 任务之前</option><option value="after" ${item.position === 'after' ? 'selected' : ''}>AI 任务之后</option></select></label>${field('提示词内容', `data-ss-field="custom" data-id="${id}" data-field="content"`, item.content, true)}<div class="lt-summary-editor-actions">${button('删除', 'delete-custom', `data-id="${id}"`)}${button('取消', 'cancel-custom', `data-id="${id}"`)}<button class="ui-button ui-button--secondary" type="submit">保存</button></div></form></details>`;
    }).join('') : '<p class="lt-status">暂无自定义提示词</p>';
  }
  function settings(s) {
    return `<section class="lt-summary-section"><h2>总结内容</h2><div class="lt-stack"><h3 class="ui-field__label">不参与总结的楼层</h3><div class="lt-entry"><input class="ui-input" data-ss-floor type="number" min="0" step="1" aria-label="输入要排除的楼层" placeholder="输入楼层">${button('添加', 'add-floor', '', true)}</div><div class="lt-tags">${s.excludedFloors.map(value => typeof value === 'number' ? value : value.floor).sort((a, b) => a - b).map(n => `<span class="ui-tag lt-summary-floor"><span>${n}</span>${icon('close', `移除第 ${n} 楼`, 'remove-floor', `data-floor="${n}"`)}</span>`).join('')}</div></div><div class="lt-summary-divider">${routeLink('总结文本清洗', 'cleaning')}</div></section><section class="lt-summary-section"><fieldset class="lt-summary-modes"><legend>生成次数</legend><div>${[['fast', '一次生成'], ['quality', '两次生成'], ['enhanced', '三次生成']].map(([mode, name]) => `<label class="lt-mode"><input type="radio" name="summary-mode" value="${mode}" ${s.draft.generationMode === mode ? 'checked' : ''}>${name}</label>`).join('')}</div><p class="lt-meta">${SUMMARY_MODE_DESCRIPTIONS[s.draft.generationMode]}</p></fieldset></section><section class="lt-summary-section"><h2>总结记忆提示词</h2>${SUMMARY_PROMPT_GROUPS[s.draft.generationMode].map(group => `<section class="lt-summary-prompt-group"><h3>${group.title}</h3>${group.items.map(item => prompt(item, s, group.stage)).join('')}</section>`).join('')}</section><section class="lt-summary-section"><h2>合并记忆提示词</h2><div class="lt-summary-prompt-group"><h3>记忆合并</h3>${MERGE_PROMPT_FIELDS.map(item => prompt(item, s)).join('')}</div></section><section class="lt-summary-section"><div class="lt-summary-heading"><h2>自定义提示词</h2>${button('＋ 新建', 'new-custom')}</div>${custom(s)}</section><section class="lt-summary-section"><h2>事件词库</h2>${routeLink('事件词库管理', 'library')}</section>`;
  }
  function library(s) {
    const words = s.libraryDraft ?? [];
    return `<section class="lt-summary-section"><div class="lt-summary-heading"><p class="lt-meta">${JSON.stringify(words) === JSON.stringify(createDefaultEventWords()) ? '默认词库' : '自定义词库'} · ${words.length} 条</p>${button('恢复默认', 'restore-words')}</div><div class="lt-summary-heading"><h2>事件词条</h2><div>${button('＋ 新增事件词', 'new-word')}${button('多选', 'multi-words', `aria-pressed="${s.libraryMulti}"`)}</div></div>${s.libraryMulti ? `<div class="lt-summary-heading"><p class="lt-status">已选 ${s.librarySelection.length} 条</p><div>${button('启用', 'enable-words')}${button('停用', 'disable-words')}${button('删除', 'delete-words')}</div></div>` : ''}<div class="lt-stack">${words.map((word, index) => {
      const id = escape(word.id), open = s.libraryOpen === word.id;
      return `<article class="lt-summary-word"><div class="lt-summary-word-heading">${s.libraryMulti ? `<input type="checkbox" data-ss-word-select="${id}" aria-label="选择${escape(word.name || '新事件词')}" ${s.librarySelection.includes(word.id) ? 'checked' : ''}>` : ''}<button type="button" class="ui-button ui-button--tertiary" data-ss-action="open-word" data-id="${id}" aria-expanded="${open}"><span>${index + 1}</span> ${escape(word.name || '新事件词')}</button>${switchControl(word.enabled, 'word-enabled', `${word.enabled ? '停用' : '启用'}${word.name || '新事件词'}`, `data-id="${id}"`)}</div>${open ? `<div class="lt-summary-word-editor lt-stack">${field('事件词', `data-ss-field="word" data-id="${id}" data-field="name"`, word.name)}${field('解释', `data-ss-field="word" data-id="${id}" data-field="definition"`, word.definition, true)}<div class="lt-summary-editor-actions">${button('上移', 'move-word-up', `data-id="${id}" ${index === 0 ? 'disabled' : ''}`)}${button('下移', 'move-word-down', `data-id="${id}" ${index === words.length - 1 ? 'disabled' : ''}`)}${button('删除', 'delete-word', `data-id="${id}"`)}</div></div>` : `<p class="lt-meta lt-summary-word-description">${escape(word.definition)}</p>`}</article>`;
    }).join('')}</div></section>`;
  }
  function cleaning(s) {
    return `<div class="lt-summary-heading">${button(s.quickOpen ? '收起快捷添加' : '快捷添加', 'quick', `aria-expanded="${s.quickOpen}"`)}${button('新建', 'new-rule')}</div>${s.quickOpen ? ['exclude', 'extract'].map(action => `<section class="lt-summary-section"><h2>快捷${labels[action]}</h2>${BUILTIN_SUMMARY_CLEANING_SHORTCUTS.map((rule, index) => ({ ...rule, index })).filter(rule => rule.action === action).map(rule => `<div class="lt-summary-heading"><span>${escape(rule.name)}</span>${button('添加', 'shortcut', `data-index="${rule.index}"`)}</div>`).join('')}</section>`).join('') : ''}<section class="lt-stack" data-ss-rules>${s.draft.summaryCleaning.rules.map(rule => `<article class="lt-summary-rule" data-ss-rule="${escape(rule.id)}"><div class="lt-summary-rule-heading"><button type="button" class="ui-icon-button ui-button--tertiary lt-summary-drag" data-ss-drag="${escape(rule.id)}" aria-label="拖动排序${escape(rule.name)}"><svg class="lt-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h8M8 12h8M8 17h8"/><circle cx="5" cy="7" r=".8"/><circle cx="5" cy="12" r=".8"/><circle cx="5" cy="17" r=".8"/></svg></button><span>${escape(rule.name)}</span>${switchControl(rule.enabled, 'toggle-rule', `${rule.enabled ? '停用' : '启用'}${rule.name}`, `data-id="${escape(rule.id)}"`)}</div><div class="lt-summary-rule-actions">${button(labels[rule.action] + (rule.enabled ? '中' : ''), 'cycle-rule', `data-id="${escape(rule.id)}" ${rule.action === 'replace' ? 'disabled' : ''}`)}${button('编辑', 'edit-rule', `data-id="${escape(rule.id)}"`)}${button('删除', 'delete-rule', `data-id="${escape(rule.id)}"`)}</div></article>`).join('')}</section>`;
  }
  function rule(s) {
    const item = s.ruleDraft;
    return `<form data-ss-form="rule" class="lt-stack">${field('正则名字', 'data-ss-field="rule" data-field="name"', item.name)}<label class="ui-field lt-stack"><span class="ui-field__label">动作</span><select class="ui-input" data-ss-field="rule" data-field="action">${Object.entries(labels).map(([value, name]) => `<option value="${value}" ${item.action === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>${field('正则表达式', 'data-ss-field="rule" data-field="pattern" spellcheck="false"', item.pattern, true)}<label class="ui-field lt-stack" data-ss-extract ${item.action === 'extract' ? '' : 'hidden'}><span class="ui-field__label">提取分组</span><input class="ui-input" type="number" min="0" step="1" data-ss-field="rule" data-field="captureGroup" value="${escape(item.captureGroup)}" aria-label="提取分组"></label><div data-ss-replace ${item.action === 'replace' ? '' : 'hidden'}>${field('替换文字', 'data-ss-field="rule" data-field="replacement"', item.replacement, true)}</div></form>`;
  }
  function patchStatus(s) {
    const slot = container.querySelector('[data-ss-message]');
    if (slot) { slot.textContent = s.message; slot.hidden = !s.message; slot.className = s.error ? 'lt-error' : 'lt-status'; slot.setAttribute('role', s.error ? 'alert' : 'status'); }
    for (const form of container.querySelectorAll('[data-ss-form=prompt]')) {
      const dirty = Object.hasOwn(s.promptDrafts, form.dataset.key);
      const p = form.querySelector('[data-ss-dirty]'); if (p) p.textContent = dirty ? '尚未保存' : '';
      const save = form.querySelector('[type=submit]'); if (save) save.disabled = !dirty;
    }
  }
  function render() {
    if (disposed) return;
    if (composing) { pendingRender = true; return; }
    remember(false);
    const s = state(), previousRoute = renderedRoute;
    if (editingText) { patchStatus(s); return; }
    const active = container.ownerDocument?.activeElement ?? container.getRootNode()?.activeElement;
    const focused = container.getRootNode()?.activeElement ?? active;
    const focusData = focused && container.contains(focused) ? { field: focused.dataset.ssField, key: focused.dataset.key, id: focused.dataset.id, subfield: focused.dataset.field, action: focused.dataset.ssAction } : null;
    const selection = focused?.selectionStart != null ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const title = s.route === 'settings' ? '事件总结设置' : s.route === 'library' ? '事件词库' : s.route === 'cleaning' ? '总结文本清洗' : s.ruleId ? '编辑清洗规则' : '新建清洗规则';
    const locked = s.status !== 'ready', content = !s.draft ? '<p class="lt-status">正在读取设置…</p>' : s.route === 'settings' ? settings(s) : s.route === 'library' ? library(s) : s.route === 'cleaning' ? cleaning(s) : s.ruleDraft ? rule(s) : '';
    container.innerHTML = `<section class="lantai lt-summary-settings" aria-label="${title}"><header class="lt-header">${icon('back', '返回', 'back')}<h1 class="ui-page-title">${title}</h1>${icon('close', '关闭兰台本末', 'close')}</header><main class="lt-main" tabindex="-1">${content}<p data-ss-message role="${s.error ? 'alert' : 'status'}" class="${s.error ? 'lt-error' : 'lt-status'}" ${s.message ? '' : 'hidden'}>${escape(s.message)}</p>${s.status === 'error' || s.status === 'unconfirmed' ? button('重新读取已保存设置', 'read', '', true) : ''}</main><footer class="lt-footer" ${s.route === 'library' || s.route === 'rule' ? '' : 'hidden'}>${s.route === 'library' ? '<button type="button" class="ui-button ui-button--primary" data-ss-action="save-library">保存</button>' : s.route === 'rule' ? `<div class="lt-summary-editor-actions">${button('取消', 'cancel-rule')}<button type="button" class="ui-button ui-button--primary" data-ss-action="save-rule">保存</button></div>` : ''}</footer></section>`;
    if (locked) for (const control of container.querySelectorAll('main input,main textarea,main select,main button,footer button')) control.disabled = true;
    const reload = container.querySelector('[data-ss-action=read]'); if (reload) reload.disabled = ['saving', 'loading'].includes(s.status);
    renderedRoute = s.route; container.querySelector('.lt-main').scrollTop = s.scroll[s.route] ?? 0;
    if (focusData && s.route === previousRoute) {
      const controls = [...container.querySelectorAll('input,textarea,select,button')];
      const next = controls.find(node => focusData.field ? node.dataset.ssField === focusData.field && node.dataset.key === focusData.key && node.dataset.id === focusData.id && node.dataset.field === focusData.subfield : focusData.action && node.dataset.ssAction === focusData.action && node.dataset.id === focusData.id && node.dataset.key === focusData.key);
      next?.focus({ preventScroll: true }); if (selection && next?.setSelectionRange) { try { next.setSelectionRange(...selection); } catch { /* Number fields do not have a caret API. */ } }
    }
  }
  function write(target) {
    if (composing || !target.dataset.ssField) return;
    editingText = true;
    try {
      const type = target.dataset.ssField;
      if (type === 'prompt') controller.editPrompt(target.dataset.key, target.value);
      if (type === 'custom') controller.editCustom(target.dataset.id, target.dataset.field, target.value);
      if (type === 'word') controller.editWord(target.dataset.id, target.dataset.field, target.value);
      if (type === 'rule') controller.editRule(target.dataset.field, target.value);
    } finally { editingText = false; }
    if (target.dataset.ssField === 'rule' && target.dataset.field === 'action') {
      container.querySelector('[data-ss-extract]').hidden = target.value !== 'extract'; container.querySelector('[data-ss-replace]').hidden = target.value !== 'replace';
    }
  }
  function input(event) { if (!event.isComposing) write(event.target); }
  function change(event) { const t = event.target; if (t.name === 'summary-mode') controller.setMode(t.value); else if (t.hasAttribute('data-ss-word-select')) controller.selectWord(t.dataset.ssWordSelect, t.checked); else write(t); }
  function submit(event) { event.preventDefault(); if (composing) return; const form = event.target; if (form.dataset.ssForm === 'prompt') controller.savePrompt(form.dataset.key); if (form.dataset.ssForm === 'custom') controller.saveCustom(form.dataset.id); if (form.dataset.ssForm === 'rule') controller.saveRule(); }
  function click(event) {
    const b = event.target.closest('button[data-ss-action]'); if (!b || b.disabled) return;
    const a = b.dataset.ssAction, id = b.dataset.id, key = b.dataset.key, s = state();
    const actions = { back: () => controller.back(), close: () => controller.close(), read: () => controller.read(), cleaning: () => controller.navigate('cleaning'), library: () => controller.navigate('library'),
      'restore-prompt': () => controller.restorePrompt(key), 'cancel-prompt': () => controller.cancelPrompt(key), 'new-custom': () => controller.newCustom(), 'cancel-custom': () => controller.cancelCustom(id), 'delete-custom': () => controller.deleteCustom(id),
      'open-word': () => controller.openWord(id), 'new-word': () => controller.newWord(), 'word-enabled': () => controller.editWord(id, 'enabled', !s.libraryDraft.find(word => word.id === id).enabled),
      'move-word-up': () => controller.moveWord(id, -1), 'move-word-down': () => controller.moveWord(id, 1), 'delete-word': () => controller.deleteWords([id]), 'restore-words': () => controller.restoreWords(), 'multi-words': () => controller.toggleWordMulti(),
      'enable-words': () => controller.toggleSelectedWords(true), 'disable-words': () => controller.toggleSelectedWords(false), 'delete-words': () => controller.deleteWords(s.librarySelection), 'save-library': () => controller.saveLibrary(),
      quick: () => controller.toggleQuick(), shortcut: () => controller.addShortcut(Number(b.dataset.index)), 'new-rule': () => controller.beginRule(), 'edit-rule': () => controller.beginRule(id), 'toggle-rule': () => controller.toggleRule(id),
      'cycle-rule': () => controller.cycleRule(id), 'delete-rule': () => controller.deleteRule(id), 'cancel-rule': () => controller.cancelRule(), 'save-rule': () => controller.saveRule(),
      'remove-floor': () => controller.removeFloor(Number(b.dataset.floor)), 'add-floor': async () => { const input = container.querySelector('[data-ss-floor]'); const value = input.value; if (await controller.addFloor(value)) { const next = container.querySelector('[data-ss-floor]'); if (next) next.value = ''; } } };
    actions[a]?.();
  }
  function toggle(event) { if (event.target.dataset.ssOpen) controller.setOpen(event.target.dataset.ssOpen, event.target.open); }
  function pointerDown(event) { const handle = event.target.closest('[data-ss-drag]'); if (!handle || event.button !== 0 || handle.disabled) return; event.preventDefault(); dragging = { node: handle.closest('[data-ss-rule]'), handle, pointerId: event.pointerId }; dragging.node.classList.add('is-dragging'); handle.setPointerCapture(event.pointerId); }
  function pointerMove(event) { if (!dragging || dragging.pointerId !== event.pointerId) return; event.preventDefault(); const list = container.querySelector('[data-ss-rules]'); const next = [...list.children].filter(row => row !== dragging.node).find(row => { const rect = row.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; }) ?? null; if (dragging.node.nextElementSibling !== next) list.insertBefore(dragging.node, next); }
  function pointerUp(event) { if (!dragging || dragging.pointerId !== event.pointerId) return; const ids = [...container.querySelector('[data-ss-rules]').children].map(row => row.dataset.ssRule); if (dragging.handle.hasPointerCapture(event.pointerId)) dragging.handle.releasePointerCapture(event.pointerId); dragging = null; controller.reorderRules(ids); }
  function pointerCancel() { dragging = null; render(); }
  function keydown(event) { const h = event.target.closest('[data-ss-drag]'); if (!h || !['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const ids = state().draft.summaryCleaning.rules.map(rule => rule.id), i = ids.indexOf(h.dataset.ssDrag), to = i + (event.key === 'ArrowUp' ? -1 : 1); if (to < 0 || to >= ids.length) return; [ids[i], ids[to]] = [ids[to], ids[i]]; controller.reorderRules(ids); }
  const startComposition = () => { composing = true; };
  const endComposition = event => { composing = false; write(event.target); if (pendingRender) { pendingRender = false; render(); } };
  const events = { input, change, submit, click, toggle, pointerdown: pointerDown, pointermove: pointerMove, pointerup: pointerUp, pointercancel: pointerCancel, keydown, compositionstart: startComposition, compositionend: endComposition };
  for (const [name, handler] of Object.entries(events)) container.addEventListener(name, handler, name === 'toggle');
  const off = controller.subscribe(render); render();
  return Object.freeze({ dispose() { if (disposed) return; remember(); disposed = true; off(); for (const [name, handler] of Object.entries(events)) container.removeEventListener(name, handler, name === 'toggle'); } });
}
