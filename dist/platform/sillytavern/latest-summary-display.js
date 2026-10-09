import { placeFloorBackgroundDisplay } from './floor-background-display-order.js';

// Append after the complete source floor content. No mes/mes_text rewriting,
// host chat-data mutation, scrolling, or dependence on the settings page.
export function mountLatestSummaryDisplay({
  document: doc = globalThis.document, runtime,
  MutationObserver: Observer = globalThis.MutationObserver,
} = {}) {
  let disposed = false, scheduled = false;
  const rendered = new WeakMap();
  const targetKey = () => JSON.stringify(runtime.inspect?.().target ?? null);
  const floorOf = message => {
    const value = message.getAttribute('mesid');
    return value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  };
  function render() {
    scheduled = false;
    if (disposed) return;
    const target = targetKey();
    const messages = [...(doc?.querySelectorAll?.('#chat .mes[mesid]') ?? [])];
    const floors = messages.map(floorOf)
      .filter(floor => Number.isSafeInteger(floor) && floor >= 0);
    const infoByFloor = runtime.floorInfos?.(floors);
    for (const message of messages) {
      const floor = floorOf(message);
      const info = Number.isSafeInteger(floor) && floor >= 0
        ? infoByFloor ? infoByFloor.get(floor) : runtime.floorInfo(floor) : null;
      let box = message.querySelector('.lantai-latest-summary');
      if (!info) { box?.remove(); continue; }
      const parent = message.querySelector('.mes_block') ?? message;
      if (!box) {
        box = doc.createElement('div');
        box.className = 'lantai-latest-summary';
      }
      // Keep both extension tails after complete host content, in fixed order.
      placeFloorBackgroundDisplay(parent, box);
      const previous = rendered.get(box), signature = JSON.stringify(info), replyId = info.replyId;
      if (previous?.signature === signature && previous.target === target) continue;
      const wasOpen = previous?.target === target && previous.replyId === replyId
        ? box.querySelector('details')?.open : undefined;
      box.replaceChildren();
      const details = doc.createElement('details');
      details.open = wasOpen ?? (!!info.body || ['running', 'failed'].includes(info.status));
      const heading = doc.createElement('summary');
      heading.textContent = '最新摘要';
      details.append(heading);
      if (info.body) {
        const body = doc.createElement('div');
        body.className = 'lantai-latest-summary-body';
        body.textContent = info.body;
        details.append(body);
      }
      const actions = doc.createElement('div');
      actions.className = 'lantai-latest-summary-actions';
      const status = doc.createElement('span');
      status.className = 'lantai-latest-summary-status';
      status.setAttribute('role', 'status');
      const actionStatus = info.status === 'running' ? '正在生成…' : info.error || (!info.body ? '尚未生成' : '');
      status.textContent = [info.stale ? '正文已编辑，可按需更新摘要' : '', actionStatus]
        .filter(Boolean).join(' · ');
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'menu_button';
      retry.textContent = info.body ? '重新生成' : info.status === 'failed' ? '重试' : '生成摘要';
      retry.disabled = info.status === 'running';
      retry.addEventListener('click', () => {
        // A rendered button can survive until the next host mutation frame.
        // Never let an old chat/swipe/floor button act on the replacement.
        if (disposed || retry.disabled || message.isConnected === false || box.isConnected === false
          || floorOf(message) !== floor || targetKey() !== target) return;
        const current = runtime.floorInfo(floor);
        if (!current || current.replyId !== replyId || current.status === 'running') return;
        try { Promise.resolve(runtime.generate(floor)).catch(() => {}); }
        catch { /* Runtime owns generation failure reporting. */ }
      });
      actions.append(status, retry);
      details.append(actions);
      box.append(details);
      rendered.set(box, { signature, target, replyId });
    }
  }
  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(render);
  };
  const touchesChat = record => {
    if (record.target?.closest?.('.lantai-latest-summary')
      || record.target?.closest?.('.lantai-workshop-results')) return false;
    if (record.target?.closest?.('#chat')) return true;
    return [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])]
      .some(node => node.id === 'chat' || node.querySelector?.('#chat'));
  };
  const unsubscribe = runtime.subscribe(schedule);
  // Observe the stable host parent so replacing #chat itself also remounts the
  // floor summaries. Ignore unrelated UI and our own internal text updates.
  const observationRoot = doc?.body ?? doc?.documentElement ?? doc?.querySelector?.('#chat');
  const observer = Observer && observationRoot ? new Observer(records => {
    if (records.some(touchesChat)) schedule();
  }) : null;
  observer?.observe(observationRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });
  const style = doc?.createElement?.('style');
  if (style) {
    // Keep the host button's visual treatment, but override .menu_button's
    // width:min-content: Chinese labels otherwise collapse to a vertical stack.
    // Wrap the action group/status on narrow floors, never the action label.
    style.textContent = `
      .lantai-latest-summary{margin-block-start:.6em;padding-block-start:.4em;border-block-start:1px solid currentColor;font-size:.9em}
      .lantai-latest-summary-body{white-space:pre-wrap;overflow-wrap:anywhere}
      .lantai-latest-summary-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-control,.5em);min-inline-size:0}
      .lantai-latest-summary-status{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere}
      .lantai-latest-summary button{display:inline-flex;width:max-content;white-space:nowrap;flex-shrink:0}
      .lantai-latest-summary summary{cursor:pointer}
    `;
    doc.head?.append(style);
  }
  schedule();
  return {
    dispose() {
      disposed = true;
      unsubscribe();
      observer?.disconnect();
      style?.remove();
      for (const node of doc?.querySelectorAll?.('.lantai-latest-summary') ?? []) node.remove();
    },
  };
}
