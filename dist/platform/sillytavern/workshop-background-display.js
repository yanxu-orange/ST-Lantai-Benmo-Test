import { placeFloorBackgroundDisplay } from './floor-background-display-order.js';
import { floorOf, getFloorDisplayCoordinator, createDisplayBody, prepareDisplayBody, commitDisplayBodies } from './floor-display-coordinator.js';

let displaySerial = 0;
const taskKey = task => JSON.stringify([task.kind ?? 'tracking', task.id]);
const bodyKey = info => JSON.stringify(info.tasks.map(task => [taskKey(task), task.body ?? '']));
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const busy = info => info.batchRunning === true || info.tasks.some(task => task.status === 'running');
// Results are independent floor-tail nodes, never rewritten into story mes.
export function mountWorkshopBackgroundDisplay({ document: doc = globalThis.document, runtime, formatter, coordinator, onOpenSchedule,
  MutationObserver: Observer = globalThis.MutationObserver } = {}) {
  let disposed = false;
  const rendered = new WeakMap(), mounted = new Set();
  const targetKey = () => JSON.stringify(runtime.inspect?.().target ?? null);
  const shared = coordinator ?? getFloorDisplayCoordinator({ document: doc, runtime, formatter, MutationObserver: Observer });
  function cleanup(state) {
    if ([...state.entries.values()].some(entry => entry.frontend)) shared.requestCleanup({ ...state, ownsChat: state.snapshot?.ownsChat });
  }
  function release(box) {
    const state = rendered.get(box); if (state) cleanup(state);
    box.remove(); mounted.delete(box); rendered.delete(box);
  }
  function collect({ messages, floors, target }) {
    if (disposed) return [];
    const plans = [], batch = runtime.workshopFloorInfos?.(floors);
    for (const box of mounted) if (box.isConnected === false) release(box);
    for (const message of messages) {
      const floor = floorOf(message), info = Number.isSafeInteger(floor) && floor >= 0
        ? batch ? batch.get(floor) : runtime.workshopFloorInfo(floor) : null;
      let box = message.querySelector('.lantai-workshop-results');
      if (!info?.tasks?.length) { if (box) release(box); continue; }
      const parent = message.querySelector('.mes_block') ?? message;
      if (!box) { box = doc.createElement('div'); box.className = 'lantai-workshop-results'; }
      placeFloorBackgroundDisplay(parent, box);
      let state = rendered.get(box);
      if (!state || state.target !== target || state.replyId !== info.replyId) {
        if (state) cleanup(state);
        box.replaceChildren();
        state = { id: `workshop-${++displaySerial}`, target, replyId: info.replyId, message, floor, entries: new Map() };
        rendered.set(box, state); mounted.add(box);
      }
      const current = () => !disposed && message.isConnected !== false && box.isConnected !== false && floorOf(message) === floor
        && targetKey() === target && rendered.get(box) === state && runtime.workshopFloorInfo(floor)?.replyId === state.replyId;
      const keys = new Set(info.tasks.map(taskKey));
      for (const [key, entry] of state.entries) if (!keys.has(key)) {
        if (entry.frontend) shared.requestCleanup({ ...state, ownsChat: state.snapshot?.ownsChat });
        entry.detail.remove(); state.entries.delete(key);
      }
      for (const task of info.tasks) {
        const key = taskKey(task); let entry = state.entries.get(key);
        if (!entry) {
          const detail = doc.createElement('details'); detail.setAttribute('data-task', task.id);
          const heading = doc.createElement('summary'), display = createDisplayBody(doc, 'lantai-workshop-result-body', task.body ?? '');
          const actions = doc.createElement('div'); actions.className = 'lantai-workshop-result-actions';
          const status = doc.createElement('span'); status.className = 'lantai-workshop-result-status'; status.setAttribute('role', 'status');
          const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'menu_button';
          retry.addEventListener('click', () => {
            if (!current() || retry.disabled) return;
            const now = runtime.workshopFloorInfo(floor), row = now?.tasks?.find(row => taskKey(row) === key);
            if (!row || row.status === 'running') return;
            try { Promise.resolve(runtime.generate(floor, { workshopOnly: true, taskId: task.id })).catch(() => {}); }
            catch { /* Runtime reports errors. */ }
          });
          const manage = doc.createElement('button'); manage.type='button';manage.className='menu_button';manage.textContent='查看日程与候选';
          manage.addEventListener('click',()=>{if(current()&&!manage.hidden)onOpenSchedule?.();});
          actions.append(status, retry, manage); detail.append(heading, display.body, actions); box.append(detail);
          entry = { ...display, detail, heading, status, retry, manage }; state.entries.set(key, entry);
        }
        text(entry.heading, task.name);
        text(entry.status, task.status === 'running' ? '正在生成…' : task.error || (!task.body ? '尚未生成' : ''));
        text(entry.retry, task.body ? '重新生成' : task.status === 'failed' ? '重试' : '生成'); entry.retry.disabled = task.status === 'running'||task.canRetry===false;entry.retry.hidden=task.canRetry===false;entry.manage.hidden=task.openSchedule!==true||typeof onOpenSchedule!=='function';
        // Tracking remains plain text and never enters the Helper formatter.
        if (task.kind !== 'workshop') { text(entry.body, task.body ?? ''); entry.body.hidden = !task.body; }
      }
      const content = bodyKey(info);
      plans.push({ ...state, ownsChat: () => !state.snapshot?.ownsChat || state.snapshot.ownsChat(), bind: snapshot => { state.snapshot ??= snapshot; }, content, busy: busy(info),
        current: () => { const now = runtime.workshopFloorInfo(floor); return current() && !!now && !busy(now) && bodyKey(now) === content; },
        prepare: snapshot => Promise.all(info.tasks.filter(task => task.kind === 'workshop')
          .map(task => prepareDisplayBody(state.entries.get(taskKey(task)), task.body ?? '', snapshot))),
        commit(updates, snapshot) { state.snapshot = snapshot; return commitDisplayBodies(updates, snapshot, doc); },
      });
    }
    return plans;
  }
  const unregister = shared.register(collect);
  const style = doc?.createElement?.('style');
  if (style) { style.textContent = `
.lantai-workshop-results{margin-block-start:.6em;padding-block-start:.4em;font-size:.9em}
.lantai-workshop-result-body{white-space:pre-wrap;overflow-wrap:anywhere}
.lantai-workshop-result-formatted{white-space:normal}
.lantai-workshop-result-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-control,.5em);min-inline-size:0}
.lantai-workshop-result-status{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere}
.lantai-workshop-results button{display:inline-flex;width:max-content;white-space:nowrap;flex-shrink:0}
.lantai-workshop-results summary{cursor:pointer}
.lantai-workshop-results > details > summary{display:list-item;box-sizing:border-box;inline-size:100%;min-block-size:44px;padding:10px .25em;cursor:pointer}
.lantai-workshop-results > details + details{margin-block-start:4px}
`; doc.head?.append(style); }
  return { dispose() {
    disposed = true;
    for (const box of mounted) release(box);
    unregister(); style?.remove();
  } };
}
