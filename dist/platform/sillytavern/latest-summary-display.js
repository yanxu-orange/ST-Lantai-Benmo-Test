import { placeFloorBackgroundDisplay } from './floor-background-display-order.js';
import { floorOf, getFloorDisplayCoordinator, createDisplayBody, prepareDisplayBody, commitDisplayBodies } from './floor-display-coordinator.js';

let displaySerial = 0;
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const busy = info => info.batchRunning === true || info.status === 'running';
// Independent floor-tail UI. Source mes/mes_text and saved summaries are never
// rewritten; only the rendered body participates in display formatting.
export function mountLatestSummaryDisplay({
  document: doc = globalThis.document, runtime, formatter, coordinator,getMode=()=>null,
  MutationObserver: Observer = globalThis.MutationObserver,
} = {}) {
  let disposed = false;
  const rendered = new WeakMap(), mounted = new Set();
  const targetKey = () => JSON.stringify(runtime.inspect?.().target ?? null);
  const shared = coordinator ?? getFloorDisplayCoordinator({ document: doc, runtime, formatter, MutationObserver: Observer });
  function release(box) {
    const state = rendered.get(box);
    if (state?.entry.frontend) shared.requestCleanup({ ...state, ownsChat: state.snapshot?.ownsChat });
    box.remove(); mounted.delete(box); rendered.delete(box);
  }
  function collect({ messages, floors, target }) {
    if (disposed) return [];
    const plans = [], infoByFloor = runtime.floorInfos?.(floors);
    for (const box of mounted) if (box.isConnected === false) release(box);
    for (const message of messages) {
      const floor = floorOf(message);
      const info = Number.isSafeInteger(floor) && floor >= 0
        ? getMode()==null?(infoByFloor?infoByFloor.get(floor):runtime.floorInfo(floor)):null : null;
      let box = message.querySelector('.lantai-latest-summary');
      if (!info) { if (box) release(box); continue; }
      const parent = message.querySelector('.mes_block') ?? message;
      if (!box) { box = doc.createElement('div'); box.className = 'lantai-latest-summary'; }
      placeFloorBackgroundDisplay(parent, box);
      let state = rendered.get(box);
      if (!state || state.target !== target || state.replyId !== info.replyId) {
        if (state?.entry.frontend) shared.requestCleanup({ ...state, ownsChat: state.snapshot?.ownsChat });
        box.replaceChildren();
        const details = doc.createElement('details');
        details.open = !!info.body || ['running', 'failed', 'cancelled'].includes(info.status);
        const heading = doc.createElement('summary'); heading.textContent = '最新摘要';
        const entry = createDisplayBody(doc, 'lantai-latest-summary-body', info.body ?? '');
        const actions = doc.createElement('div'); actions.className = 'lantai-latest-summary-actions';
        const status = doc.createElement('span'); status.className = 'lantai-latest-summary-status'; status.setAttribute('role', 'status');
        const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'menu_button';
        state = { id: `latest-${++displaySerial}`, target, replyId: info.replyId, message, floor, entry, status, retry };
        const owned = state;
        retry.addEventListener('click', () => {
          if (disposed || retry.disabled || message.isConnected === false || box.isConnected === false
            || floorOf(message) !== floor || targetKey() !== target || rendered.get(box) !== owned) return;
          const current = runtime.floorInfo(floor);
          if (!current || current.replyId !== owned.replyId || current.status === 'running') return;
          try { Promise.resolve(runtime.generate(floor)).catch(() => {}); }
          catch { /* Runtime owns generation failure reporting. */ }
        });
        actions.append(status, retry); details.append(heading, entry.body, actions); box.append(details);
        rendered.set(box, state); mounted.add(box);
      }
      const actionStatus = info.status === 'running' ? '正在生成…' : info.error || (!info.body ? '尚未生成' : '');
      text(state.status, [info.stale ? '正文已编辑，可按需更新摘要' : '', actionStatus].filter(Boolean).join(' · '));
      text(state.retry, info.retryLabel ?? (info.body ? '重新生成' : info.status === 'failed' ? '重试' : '生成摘要'));
      state.retry.disabled = info.status === 'running';
      const raw = info.body ?? '';
      plans.push({ ...state, ownsChat: () => !state.snapshot?.ownsChat || state.snapshot.ownsChat(), bind: snapshot => { state.snapshot ??= snapshot; }, content: raw, busy: busy(info),
        current: () => {
          if (disposed || box.isConnected === false || rendered.get(box) !== state) return false;
          const now = runtime.floorInfo(floor);
          return !!now && now.replyId === state.replyId && !busy(now) && (now.body ?? '') === raw;
        },
        prepare: snapshot => prepareDisplayBody(state.entry, raw, snapshot),
        commit(update, snapshot) { state.snapshot = snapshot; return commitDisplayBodies([update], snapshot, doc); },
      });
    }
    return plans;
  }
  const unregister = shared.register(collect);
  const style = doc?.createElement?.('style');
  if (style) {
    style.textContent = `
      .lantai-latest-summary{margin-block-start:.6em;padding-block-start:.4em;font-size:.9em}
      .lantai-latest-summary-body{white-space:pre-wrap;overflow-wrap:anywhere}
      .lantai-latest-summary-formatted{white-space:normal}
      .lantai-latest-summary-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-control,.5em);min-inline-size:0}
      .lantai-latest-summary-status{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere}
      .lantai-latest-summary button{display:inline-flex;width:max-content;white-space:nowrap;flex-shrink:0}
      .lantai-latest-summary summary{cursor:pointer}
      .lantai-latest-summary > details > summary{display:list-item;box-sizing:border-box;inline-size:100%;min-block-size:44px;padding:10px .25em;cursor:pointer}
    `;
    doc.head?.append(style);
  }
  return { dispose() {
    disposed = true;
    for (const box of mounted) release(box);
    unregister(); style?.remove();
  } };
}
