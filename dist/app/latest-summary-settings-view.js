import { DEFAULT_THEME, normalizeTheme } from './styles/theme.js';
import {
  cumulativeEscape as esc, cumulativeButton as button,
  cumulativeIcon as icon, mountCumulativeSurface,
} from './cumulative-view.js';

export function latestSummarySettingsMarkup(state, theme = DEFAULT_THEME) {
  const disabled = state.status !== 'ready' || state.clearConfirmation;
  const draft = state.draft ?? {};
  const disabledAttr = disabled ? 'disabled' : '';
  const count = (state.records ?? []).length;
  const runtimeMessage = state.runtimeStatus === 'running' ? '正在生成摘要…'
    : state.runtimeStatus === 'failed' ? '摘要生成失败，请在来源楼层重试。' : '';
  return `<section class="lantai lt-summary-settings ui-workspace ui-graphic-controls" data-ui-theme="${normalizeTheme(theme)}">
    <header class="lt-header ui-header ui-header--centered">${icon('back', '返回记忆', 'back')}<h1 class="ui-page-title">最新摘要</h1>${icon('close', '关闭兰台本末', 'close')}</header>
    <main class="lt-main lt-summary-settings-main ui-main ui-main--settings" tabindex="-1" ${state.clearConfirmation ? 'inert' : ''}>
      <p class="lt-error" role="alert" ${state.error ? '' : 'hidden'}>${esc(state.message)}</p>
      ${state.status === 'loading' ? '<p class="lt-status" role="status">正在读取最新摘要…</p>' : ''}
      <section class="lt-summary-section">
        <div class="lt-summary-heading"><h2>启用最新摘要</h2><button type="button" class="ui-switch" role="switch" aria-label="启用最新摘要" aria-checked="${draft.enabled === true}" data-cu-action="toggle-enabled" ${disabledAttr}><span class="ui-switch__track" aria-hidden="true"><span class="ui-switch__knob"></span></span></button></div>
        <p class="lt-meta">启用后从新完成的 AI 楼层开始生成，不自动补齐历史楼层。</p><p class="lt-meta">启用压缩前，请关闭预设中按 X 楼删除正文或只保留摘要的正则，以免重复处理。</p>
        <label class="ui-field"><span class="ui-field__label">最近多少楼使用原文</span><input class="ui-input" type="number" min="1" step="1" inputmode="numeric" data-cu-field="recent-floors" value="${esc(state.recentFloorsDraft ?? draft.recentFloors ?? 6)}" ${disabledAttr}></label>
        <div class="lt-summary-editor-actions">${button('保存', 'save-recent-floors', disabled, 'primary')}</div>
      </section>
      <section class="lt-summary-section"><h2>摘要提示词</h2><div class="lt-summary-prompt-group ui-disclosure"><details class="lt-summary-prompt ui-disclosure" data-cu-open="prompt"><summary><span class="lt-summary-label"><span class="lt-summary-label-text">最新摘要提示词</span></span></summary><div class="lt-summary-prompt-body lt-stack"><textarea class="lt-textarea" rows="9" aria-label="最新摘要提示词" data-cu-field="prompt" ${disabledAttr}>${esc(state.promptDraft ?? draft.prompt ?? '')}</textarea><div class="lt-summary-editor-actions">${button('恢复默认', 'restore-prompt', disabled)}${button('取消', 'cancel-prompt', disabled)}${button('保存', 'save-prompt', disabled, 'primary')}</div></div></details></div></section>
      <section class="lt-summary-section"><h2>当前聊天</h2><p class="lt-meta">已保存 ${state.draft ? count : '—'} 条摘要</p>${runtimeMessage ? `<p class="lt-status" role="status">${runtimeMessage}</p>` : ''}${button('清空结果与状态', 'clear', disabled)}</section>
      ${['error', 'unconfirmed'].includes(state.status) ? button('重新读取', 'read') : ''}
    </main>
    <p class="lt-saved lt-status" data-cu-toast role="status" hidden></p>
    ${state.clearConfirmation ? `<footer class="lt-footer ui-action-footer"><p class="lt-status" role="status">清空当前聊天的全部最新摘要结果与生成状态？设置会保留，正在生成的结果也不会再写入。</p><div class="lt-summary-editor-actions">${button('取消', 'cancel-clear', state.status === 'saving')}${button('确认清空', 'confirm-clear', state.status === 'saving', 'secondary')}</div></footer>` : ''}
  </section>`;
}

export function mountLatestSummarySettingsView({ container, controller, onBack = () => {}, onClose = () => {} } = {}) {
  let composing = false;
  const compositionStart = () => { composing = true; };
  const compositionEnd = () => { composing = false; };
  // Register first, so the shared surface's deferred render sees committed IME input.
  container.addEventListener('compositionstart', compositionStart);
  container.addEventListener('compositionend', compositionEnd);
  const view = mountCumulativeSurface({
    container, controller, markup: latestSummarySettingsMarkup, scope: () => 'latest-summary-settings',
    input(node, event) {
      if (composing || event.isComposing) return;
      if (node.dataset.cuField === 'prompt') controller.editPrompt(node.value);
      if (node.dataset.cuField === 'recent-floors') controller.editRecentFloors(node.validity?.badInput ? '' : node.value);
    },
    async click(action) {
      if (composing) return;
      if (action === 'back') { if (controller.back()) onBack(); return; }
      if (action === 'close') { controller.close(); onClose(); return; }
      if (action === 'toggle-enabled') await controller.toggleEnabled();
      if (action === 'save-recent-floors') await controller.saveRecentFloors();
      if (action === 'restore-prompt') controller.restorePrompt();
      if (action === 'cancel-prompt') controller.cancelPrompt();
      if (action === 'save-prompt') await controller.savePrompt();
      if (action === 'clear') { controller.requestClear(); container.querySelector('[data-cu-action="cancel-clear"]')?.focus({ preventScroll: true }); }
      if (action === 'cancel-clear') { controller.cancelClear(); container.querySelector('[data-cu-action="clear"]')?.focus({ preventScroll: true }); }
      if (action === 'confirm-clear') await controller.confirmClear();
      if (action === 'read') await controller.read();
    },
  });
  const keydown = event => {
    if (event.key !== 'Escape' || composing || event.isComposing || !controller.inspect().clearConfirmation) return;
    event.preventDefault();
    event.stopPropagation();
    controller.cancelClear();
    container.querySelector('[data-cu-action="clear"]')?.focus({ preventScroll: true });
  };
  container.addEventListener('keydown', keydown);
  return {
    dispose() {
      view.dispose();
      container.removeEventListener('compositionstart', compositionStart);
      container.removeEventListener('compositionend', compositionEnd);
      container.removeEventListener('keydown', keydown);
    },
  };
}
