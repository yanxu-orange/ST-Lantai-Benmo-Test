const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Page state only. The runtime owns chat identity, durable writes, generation,
// cancellation and late-result checks. Opening or editing this page never runs AI.
export function createLatestSummarySettingsController({
  service, isCurrent = () => true, onBack = () => {}, onClose = () => {},
} = {}) {
  const listeners = new Set();
  let disposed = false, busy = false, baseline = null;
  const state = {
    status: 'loading', draft: null, promptDraft: null, recentFloorsDraft: null,
    records: [], runtimeStatus: 'idle', clearConfirmation: false,
    opened: {}, scroll: {}, error: null, message: '', noticeSequence: 0,
  };
  const inspect = () => copy(state);
  const notify = () => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try { listener(inspect()); } catch { /* Isolate view subscribers. */ }
    }
  };
  const current = () => {
    try { return !disposed && isCurrent() === true; } catch { return false; }
  };
  function fail(error) {
    state.error = error?.code ?? 'LATEST_SUMMARY_SETTINGS_ERROR';
    state.status = /UNCONFIRMED/.test(state.error) ? 'unconfirmed' : 'error';
    state.message = state.status === 'unconfirmed'
      ? '保存结果尚未确认，请重新读取，不要重复提交。'
      : error?.message ?? '最新摘要状态已变化，请重新读取。';
    state.clearConfirmation = false;
  }
  function adopt(value) {
    if (!value?.preferences) throw new Error('未能读取最新摘要设置。');
    baseline = copy(value.preferences);
    state.draft = copy(baseline);
    state.records = copy(value.records ?? []);
    state.runtimeStatus = value.status ?? 'idle';
  }
  function editable() {
    if (busy || disposed || state.status !== 'ready' || !baseline) return false;
    if (!current() || !same(service.inspect()?.preferences, baseline)) {
      fail(new Error('聊天或最新摘要设置已变化，请重新读取。'));
      notify();
      return false;
    }
    return true;
  }
  async function read(preserveDrafts = true) {
    if (busy || disposed) return false;
    busy = true;
    state.status = 'loading';
    state.error = null;
    state.message = '';
    state.clearConfirmation = false;
    notify();
    try {
      const value = await service.read();
      if (!current()) throw new Error('聊天已变化，请重新打开最新摘要。');
      adopt(value ?? service.inspect());
      if (!preserveDrafts) {
        state.promptDraft = null;
        state.recentFloorsDraft = null;
      }
      state.status = 'ready';
      return true;
    } catch (error) {
      if (!disposed) fail(error);
      return false;
    } finally {
      busy = false;
      notify();
    }
  }
  async function commit(operation, applied = () => {}, message = '已保存') {
    if (!editable()) return false;
    busy = true;
    state.status = 'saving';
    state.error = null;
    state.message = '';
    notify();
    try {
      await operation();
      if (!current()) throw new Error('聊天已变化，请重新打开最新摘要。');
      adopt(service.inspect());
      applied();
      state.status = 'ready';
      state.message = message;
      state.noticeSequence++;
      return true;
    } catch (error) {
      if (!disposed) fail(error);
      return false;
    } finally {
      busy = false;
      notify();
    }
  }
  function save(change, applied) {
    if (!editable() || state.clearConfirmation) return Promise.resolve(false);
    const next = copy(baseline);
    try { change(next); }
    catch (error) {
      state.error = 'INVALID_SETTINGS';
      state.message = error.message;
      notify();
      return Promise.resolve(false);
    }
    return commit(() => service.savePreferences(next), applied);
  }
  const off = service.subscribe?.(value => {
    if (disposed || busy || !baseline) return;
    const snapshot = value?.preferences ? value : service.inspect();
    if (!current() || !same(snapshot?.preferences, baseline)) {
      fail(new Error('聊天或最新摘要设置已变化，请重新读取。'));
    } else {
      state.records = copy(snapshot.records ?? []);
      state.runtimeStatus = snapshot.status ?? 'idle';
    }
    notify();
  });
  const controller = {
    inspect,
    init: () => baseline ? Promise.resolve(editable()) : read(false),
    read: () => read(true),
    toggleEnabled() {
      return save(next => { next.enabled = !next.enabled; });
    },
    editRecentFloors(value) {
      if (!editable() || state.clearConfirmation) return false;
      state.recentFloorsDraft = value;
      state.error = null;
      state.message = '';
      return true;
    },
    saveRecentFloors() {
      const value = state.recentFloorsDraft ?? state.draft?.recentFloors;
      return save(next => {
        const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
        if (!Number.isSafeInteger(n) || n < 1) throw new Error('请输入大于或等于1的整数楼层数。');
        next.recentFloors = n;
      }, () => { state.recentFloorsDraft = null; });
    },
    editPrompt(value) {
      if (typeof value !== 'string' || !editable() || state.clearConfirmation) return false;
      state.promptDraft = value;
      state.error = null;
      state.message = '';
      return true;
    },
    restorePrompt() {
      if (!controller.editPrompt(service.defaultPrompt ?? '')) return false;
      notify();
      return true;
    },
    cancelPrompt() {
      if (!editable() || state.clearConfirmation) return false;
      state.promptDraft = null;
      state.error = null;
      state.message = '';
      notify();
      return true;
    },
    savePrompt() {
      return save(next => { next.prompt = state.promptDraft ?? next.prompt; }, () => { state.promptDraft = null; });
    },
    requestClear() {
      if (!editable()) return false;
      state.clearConfirmation = true;
      state.error = null;
      state.message = '';
      notify();
      return true;
    },
    cancelClear() {
      if (busy || disposed) return false;
      state.clearConfirmation = false;
      notify();
      return true;
    },
    confirmClear() {
      if (!state.clearConfirmation) return Promise.resolve(false);
      return commit(() => service.clear(), () => { state.clearConfirmation = false; }, '已清空最新摘要结果与状态');
    },
    back() {
      if (busy || disposed) return false;
      if (state.clearConfirmation) { controller.cancelClear(); return false; }
      state.promptDraft = null;
      state.recentFloorsDraft = null;
      onBack();
      return true;
    },
    close() { onClose(); },
    setScroll(key, value) { state.scroll[key] = value; },
    setOpen(key, value) { state.opened[key] = !!value; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; off?.(); listeners.clear(); },
  };
  return Object.freeze(controller);
}
