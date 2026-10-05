// Snapshots and candidates are immutable JSON-like data. Validators must be
// synchronous and include the captured target epoch, not just the chat name.
let nextTaskId = 0;
const terminal = new Set(['succeeded', 'cancelled', 'stale']);
function freezeCopy(value) {
  const copy = structuredClone(value);
  const ancestors = new Set();
  function freeze(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Task data must be plain data');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError('Task data must be plain data');
    ancestors.add(item);
    Object.values(item).forEach(freeze);
    ancestors.delete(item);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}

export function createBackgroundTaskManager() {
  const tasks = new Map(), current = new Map(), listeners = new Set();
  const notifications = [];
  let publishing = false;
  const summary = task => Object.freeze({ taskId: task.taskId, status: task.status, attempt: task.attempt,
    hasCandidate: task.hasCandidate, reviewPending: Boolean(task.review && !task.review.resuming), error: task.error });
  const inspectTask = task => Object.freeze({ ...summary(task), target: task.target, snapshot: task.snapshot,
    candidate: task.hasCandidate ? task.candidate : undefined });
  function publish(task) {
    notifications.push({ state: summary(task), recipients: [...listeners] });
    if (publishing) return;
    publishing = true;
    try {
      // Finish a transition for all observers before delivering a transition
      // caused by a re-entrant observer (for example running -> cancelled).
      while (notifications.length) {
        const { state, recipients } = notifications.shift();
        for (const listener of recipients) {
          if (!listeners.has(listener)) continue;
          try { listener(state); } catch { /* Observers cannot interrupt task execution. */ }
        }
      }
    } finally { publishing = false; }
  }
  function transition(task, status, error = null) {
    task.status = status; task.error = error;
    if (['cancelled', 'stale', 'failed'].includes(status) && task.review) {
      const review = task.review; task.review = null;
      const stopped = new Error('Review stopped'); stopped.name = 'AbortError';
      review.reject(stopped);
    }
    publish(task);
  }
  function invalidate(task, status = 'stale') {
    if (terminal.has(task.status)) return false;
    // Publish cancellation before abort callbacks can re-enter the manager.
    transition(task, status);
    task.controller.abort();
    return true;
  }
  function valid(task, checkSource = true) {
    if (terminal.has(task.status) || task.controller.signal.aborted) return false;
    if (current.get(task.key) !== task.taskId) { invalidate(task); return false; }
    try {
      if (task.validateCurrent(task.target) === true && (!checkSource || task.validateSnapshot(task.snapshot, task.target) === true)) return true;
      invalidate(task);
    } catch {
      transition(task, 'failed', 'validation-failed');
    }
    return false;
  }
  function context(task) {
    const attempt = task.attempt;
    return Object.freeze({ taskId: task.taskId, attempt, target: task.target,
      snapshot: task.snapshot, signal: task.controller.signal,
      awaitReview: candidate => awaitReview(task, attempt, candidate) });
  }
  function awaitReview(task, attempt, candidate) {
    if (task.attempt !== attempt || task.status !== 'running' || !valid(task)) {
      const stopped = new Error('Review unavailable'); stopped.name = 'AbortError';
      return Promise.reject(stopped);
    }
    const frozen = freezeCopy(candidate);
    if (task.attempt !== attempt || task.status !== 'running' || !valid(task)) {
      const stopped = new Error('Review unavailable'); stopped.name = 'AbortError';
      return Promise.reject(stopped);
    }
    const pending = new Promise((resolve, reject) => { task.review = { resolve, reject, attempt }; });
    task.candidate = frozen; task.hasCandidate = true; task.finalCandidate = false;
    // Install the waiter before observers can synchronously resume or cancel.
    transition(task, 'awaiting-user');
    return pending;
  }
  function run(task) {
    if (terminal.has(task.status)) { task.pending = Promise.resolve(inspectTask(task)); return; }
    const attempt = task.attempt;
    task.hasCandidate = false; task.candidate = undefined; task.finalCandidate = false;
    task.pending = Promise.resolve().then(async () => {
      if (!valid(task)) return;
      transition(task, 'running');
      if (task.status !== 'running' || !valid(task)) return;
      try {
        const result = await task.worker(context(task));
        if (task.attempt !== attempt || task.status !== 'running' || !valid(task)) return;
        const frozen = freezeCopy(result);
        if (task.attempt !== attempt || task.status !== 'running' || !valid(task)) return;
        task.candidate = frozen; task.hasCandidate = true; task.finalCandidate = true;
        transition(task, 'awaiting-user');
      } catch (error) {
        if (task.attempt !== attempt || task.status !== 'running' || !valid(task)) return;
        if (error?.name === 'AbortError') invalidate(task, 'cancelled');
        else transition(task, 'failed', 'worker-failed');
      }
    }).then(() => inspectTask(task));
    transition(task, 'starting');
  }
  return {
    start({ key, target, snapshot, validateCurrent, validateSnapshot, worker }) {
      if (typeof key !== 'string' || !key || [validateCurrent, validateSnapshot, worker].some(fn => typeof fn !== 'function')) throw new TypeError('Task key and callbacks are required');
      const task = { taskId: ++nextTaskId, key, target: freezeCopy(target), snapshot: freezeCopy(snapshot),
        validateCurrent, validateSnapshot, worker, controller: new AbortController(), attempt: 1,
        status: 'starting', error: null, hasCandidate: false, candidate: undefined, finalCandidate: false, review: null };
      const previous = tasks.get(current.get(key));
      // Set the new identity first so a re-entrant old observer cannot revive it.
      tasks.set(task.taskId, task); current.set(key, task.taskId);
      if (previous) invalidate(previous);
      run(task);
      return task.taskId;
    },
    inspect(taskId) { const task = tasks.get(taskId); return task ? inspectTask(task) : null; },
    list() { return Object.freeze([...tasks.values()].map(inspectTask)); },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Observer must be a function');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel(taskId) { const task = tasks.get(taskId); return task ? invalidate(task, 'cancelled') : false; },
    invalidate(key) { const task = tasks.get(current.get(key)); return task ? invalidate(task) : false; },
    resume(taskId, reviewedValue) {
      const task = tasks.get(taskId);
      if (!task || task.status !== 'awaiting-user' || !task.review || !valid(task)) return false;
      const review = task.review;
      let frozen;
      try { frozen = freezeCopy(reviewedValue); } catch { return false; }
      if (task.review !== review || task.status !== 'awaiting-user' || !valid(task)) return false;
      review.resuming = true; task.hasCandidate = false; task.candidate = undefined;
      transition(task, 'running');
      // Keep the waiter rejectable until all synchronous notification delivery
      // (including queued re-entrant transitions) finishes. Do not start the
      // next stage if a running observer cancels, replaces or invalidates it.
      queueMicrotask(() => {
        if (task.review !== review || task.attempt !== review.attempt || task.status !== 'running' || !valid(task)) return;
        task.review = null;
        review.resolve(frozen);
      });
      if (task.status !== 'running' || task.review !== review) return false;
      return true;
    },
    retry(taskId) {
      const task = tasks.get(taskId);
      if (!task || task.status !== 'failed' || task.finalCandidate || task.committing || !valid(task)) return false;
      task.attempt++; task.controller = new AbortController(); run(task);
      return true;
    },
    async confirm(taskId, guardedCommit) {
      const task = tasks.get(taskId);
      if (!task || !task.hasCandidate || !task.finalCandidate || task.review || task.committing || !['awaiting-user', 'failed'].includes(task.status)) return { taskId, status: 'rejected' };
      if (typeof guardedCommit !== 'function') throw new TypeError('Guarded commit is required');
      if (!valid(task)) return summary(task);
      const candidate = task.candidate;
      task.committing = true;
      transition(task, 'committing');
      // The repository/adapter must call isCurrent at its atomic write boundary
      // (including after queue waits) and preserve old authority on write failure.
      // It must return { status: 'committed' } only after its guarded atomic
      // write succeeds. A receipt authorizes the source change made by that
      // write; it does not refresh the original snapshot or relax pre-write checks.
      const isCurrent = () => task.committing && task.status === 'committing' && task.candidate === candidate && valid(task);
      task.pending = (async () => {
        try {
          if (!isCurrent()) return;
          const receipt = await guardedCommit(Object.freeze({ ...context(task), candidate, isCurrent }));
          // A successful write normally changes its own source revision. Check
          // task/target/cancellation here, not the pre-write source snapshot.
          if (task.status !== 'committing' || task.candidate !== candidate || !valid(task, false)) return;
          if (receipt?.status === 'committed') transition(task, 'succeeded');
          else if (valid(task)) transition(task, 'failed', 'commit-unconfirmed');
        } catch (error) {
          if (task.status !== 'committing' || !valid(task)) return;
          if (error?.name === 'AbortError') invalidate(task, 'cancelled');
          else transition(task, 'failed', 'commit-failed');
        } finally { task.committing = false; }
      })().then(() => inspectTask(task));
      return task.pending;
    },
    async settled(taskId) { const task = tasks.get(taskId); return task ? await task.pending : null; },
    forget(taskId) {
      const task = tasks.get(taskId);
      if (!task || (!terminal.has(task.status) && task.status !== 'failed') || task.committing) return false;
      if (current.get(task.key) === taskId) current.delete(task.key);
      tasks.delete(taskId);
      return true;
    },
  };
}
