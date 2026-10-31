// Latest summaries, workshop cards and world briefings share one floor transaction. Collection
// updates only wrappers/controls; every async body calculation settles before
// the synchronous body commit and the one optional public Helper rescan.
const coordinators = new WeakMap();
let scopeSerial = 0;
export const floorOf = message => {
  const value = message.getAttribute('mesid');
  return value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
};
export function createDisplayBody(doc, className, raw = '') {
  const body = doc.createElement('div'), scopeId = `lantai-display-${++scopeSerial}`;
  body.className = className;
  body.setAttribute('data-lantai-render-scope', scopeId);
  body.textContent = raw; body.hidden = !raw;
  return { body, className, scope: `[data-lantai-render-scope="${scopeId}"]`, raw,
    outputKey: 'null', html: false, frontend: false, formatKey: null };
}
export async function prepareDisplayBody(entry, raw, snapshot) {
  const formatKey = JSON.stringify([snapshot?.key ?? null, raw]);
  if (entry.formatKey === formatKey) return { entry, raw, formatKey, unchanged: true };
  let output = null;
  try { output = raw && snapshot ? await snapshot.format(raw, { scope: entry.scope }) : null; }
  catch { /* Formatting failure is a readable-text fallback, never a task error. */ }
  if (!output || typeof output.html !== 'string' || !Array.isArray(output.styles)
    || output.styles.some(css => typeof css !== 'string')) output = null;
  return { entry, raw, formatKey, output, outputKey: JSON.stringify(output) };
}
export function commitDisplayBodies(updates, snapshot, doc) {
  let refresh = false;
  const checks = [];
  for (const row of updates) {
    const { entry, raw, formatKey, output, outputKey, unchanged } = row;
    let changed = false;
    if (!unchanged) {
      changed = entry.outputKey !== outputKey;
      if (changed) {
        refresh ||= entry.frontend;
        entry.outputKey = outputKey;
        entry.html = !!output;
        entry.frontend = false;
        if (output) {
          // Only the formatter's sanitized markup reaches the HTML parser.
          // Scoped CSS is appended as text, never interpolated into innerHTML.
          entry.body.innerHTML = output.html;
          for (const css of output.styles) {
            const style = doc.createElement('style'); style.textContent = css; entry.body.append(style);
          }
          entry.body.className = `${entry.className} ${entry.className.replace(/-body$/, '-formatted')}`;
        } else {
          entry.body.textContent = raw; entry.body.className = entry.className;
        }
      } else if (!entry.html && entry.raw !== raw) entry.body.textContent = raw;
      entry.raw = raw; entry.body.hidden = !raw; entry.formatKey = formatKey;
    }
    if (entry.html) {
      const check = snapshot?.captureTakeover?.(entry.body);
      entry.frontend = check?.required === true;
      refresh ||= changed && entry.frontend;
      if (entry.frontend) checks.push({ check, fallback() {
        entry.body.textContent = entry.raw; entry.body.className = entry.className;
        entry.html = false; entry.frontend = false;
      } });
    }
  }
  return { refresh, checks };
}

export function createFloorDisplayCoordinator({ document: doc = globalThis.document, runtime, formatter, getTarget,
  MutationObserver: Observer = globalThis.MutationObserver } = {}) {
  let scheduled = false, stopped = false, unsubscribe = null, observer = null;
  const participants = new Set(), groups = new WeakMap(), cleanups = new Map();
  const targetKey = () => {try{return JSON.stringify(getTarget?getTarget():runtime.inspect?.().target??null);}catch{return JSON.stringify(null);}};
  const ownership = plan => plan.message.isConnected !== false && floorOf(plan.message) === plan.floor
    && targetKey() === plan.target && (!plan.ownsChat || plan.ownsChat());
  function requestCleanup(plan) {
    if (!ownership(plan)) return;
    cleanups.set(plan.message, plan); schedule();
  }
  function transact(message, plans, cleanup) {
    let group = groups.get(message);
    if (!group) { group = { pending: null, applied: null }; groups.set(message, group); }
    if (plans.some(plan => plan.busy)) { group.pending = null; return; }
    const source = plans[0] ?? cleanup;
    if (!source || !ownership(source) || plans.some(plan => !ownership(plan))) { group.pending = null; cleanups.delete(message); return; }
    const snapshot = formatter?.capture(source.floor) ?? null;
    for (const plan of plans) plan.bind?.(snapshot);
    const key = JSON.stringify([plans.map(plan => [plan.id, plan.content]), snapshot?.key ?? null]);
    if (group.pending?.key === key && group.pending.valid() || group.applied === key && !cleanup) return;
    const job = { key }; group.pending = job;
    // Equal content can carry a newer runtime proof. Reuse only a live job;
    // a superseded proof must not swallow the already-collected replacement.
    const valid = job.valid = () => {
      try { return group.pending === job && ownership(source)
        && (!snapshot || snapshot.isCurrent()) && plans.every(plan => ownership(plan) && plan.current()); }
      catch { return false; }
    };
    void (async () => {
      const prepared = await Promise.all(plans.map(plan => plan.prepare(snapshot)));
      if (!valid()) return;
      let refresh = !!cleanup;
      const checks = [];
      // No await or public host call inside this commit: neither tail can be
      // rescanned while another card's asynchronous formatting is unfinished.
      for (let index = 0; index < plans.length; index++) {
        const result = plans[index].commit(prepared[index], snapshot);
        refresh ||= result.refresh; checks.push(...result.checks);
      }
      group.applied = key;
      if (cleanups.get(message) === cleanup) cleanups.delete(message);
      if (!refresh || !snapshot || !valid()) return;
      let failed = false;
      try { await snapshot.refresh(); } catch { failed = true; }
      if (!valid()) return;
      const fallback = checks.filter(row => failed || !row.check());
      if (!fallback.length) return;
      const needsCleanup = failed || fallback.some(row => row.check.needsCleanup?.());
      for (const row of fallback) row.fallback();
      // Failure cleanup is bounded to one public retry. The applied key stays
      // cached so ordinary runtime/observer publications cannot create a loop.
      if (needsCleanup && valid()) try { await snapshot.refresh(); } catch { /* Raw text remains readable. */ }
    })().catch(() => { /* A display cannot fail generation or storage. */ })
      .finally(() => { if (group.pending === job) group.pending = null; });
  }
  function render() {
    scheduled = false;
    if (stopped && !cleanups.size) return;
    const target = targetKey(), messages = [...(doc?.querySelectorAll?.('#chat .mes[mesid]') ?? [])];
    const floors = messages.map(floorOf).filter(floor => Number.isSafeInteger(floor) && floor >= 0);
    const byMessage = new Map();
    for (const participant of participants) for (const plan of participant({ messages, floors, target })) {
      const bucket = byMessage.get(plan.message) ?? []; bucket.push(plan); byMessage.set(plan.message, bucket);
    }
    for (const [message, cleanup] of cleanups) if (!ownership(cleanup)) cleanups.delete(message);
    for (const message of new Set([...byMessage.keys(), ...cleanups.keys()])) {
      transact(message, byMessage.get(message) ?? [], cleanups.get(message));
    }
  }
  function schedule() {
    if (scheduled || stopped && !cleanups.size) return;
    scheduled = true; queueMicrotask(render);
  }
  const touchesChat = record => {
    if (record.target?.closest?.('.lantai-latest-summary') || record.target?.closest?.('.lantai-workshop-results') || record.target?.closest?.('.lantai-world-briefing') || record.target?.closest?.('.lantai-round-record')) return false;
    return !!record.target?.closest?.('#chat') || [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])]
      .some(node => node.id === 'chat' || node.querySelector?.('#chat'));
  };
  function start() {
    if (unsubscribe) return;
    stopped = false; unsubscribe = runtime.subscribe(schedule);
    const root = doc?.body ?? doc?.documentElement ?? doc?.querySelector?.('#chat');
    observer = Observer && root ? new Observer(records => { if (records.some(touchesChat)) schedule(); }) : null;
    observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });
  }
  return {
    requestCleanup,
    requestRefresh:schedule,
    useFormatter(value) { if (!formatter && value) { formatter = value; schedule(); } },
    register(collect) {
      participants.add(collect); start(); schedule();
      return () => {
        participants.delete(collect);
        if (!participants.size) { stopped = true; unsubscribe?.(); unsubscribe = null; observer?.disconnect(); observer = null; }
        schedule();
      };
    },
  };
}

// Explicitly shared by memory-host; the default also coordinates separately
// mounted displays for the same runtime/document (including embedded hosts).
export function getFloorDisplayCoordinator(options) {
  let documents = coordinators.get(options.runtime);
  if (!documents) { documents = new WeakMap(); coordinators.set(options.runtime, documents); }
  const doc = options.document ?? globalThis.document;
  let coordinator = documents.get(doc);
  if (!coordinator) { coordinator = createFloorDisplayCoordinator(options); documents.set(doc, coordinator); }
  coordinator.useFormatter(options.formatter);
  return coordinator;
}
