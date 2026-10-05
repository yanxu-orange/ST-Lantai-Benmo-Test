import { DEFAULT_THEME, isTheme } from './styles/theme.js';
const messages = {
  APPEARANCE_UNAVAILABLE: '当前无法读取或保存外观设置。',
  APPEARANCE_STYLE_UNAVAILABLE: '皮肤资源未能加载，已保留当前皮肤；请重新读取外观后重试。',
  APPEARANCE_INVALID: '外观设置格式无法识别，未覆盖已有设置。',
  APPEARANCE_CONFLICT: '外观设置已变化，请重新读取后选择。',
  APPEARANCE_UNCONFIRMED: '外观保存状态待确认，请重新读取；已确认的皮肤仍然保留。',
};
export function createAppearanceSession({ adapter, prepareTheme = async () => {}, canSave = () => true }) {
  let disposed = false, baseline = null, pending = null;
  let state = { status: 'idle', theme: DEFAULT_THEME, error: null, message: '', confirmationRequired: false };
  const listeners = new Set();
  const inspect = () => Object.freeze({ ...state });
  const notify = () => { for (const listener of [...listeners]) { try { listener(inspect()); } catch { /* View isolation. */ } } };
  const fail = error => { const code = Object.hasOwn(messages,error?.code) ? error.code : 'APPEARANCE_UNAVAILABLE'; const confirmationRequired = state.confirmationRequired || code === 'APPEARANCE_UNCONFIRMED'; state = { ...state, status: confirmationRequired ? 'unconfirmed' : 'error', confirmationRequired, error: code, message: messages[code] }; };
  function run(action, status) {
    if (disposed || pending) return pending ?? Promise.resolve(false);
    state = { ...state, status, error: null, message: '' }; notify();
    pending = Promise.resolve().then(action).then(async root => {
      await prepareTheme(root.theme);
      if (disposed) return false;
      baseline = root; state = { status: 'ready', theme: root.theme, error: null, confirmationRequired: false, message: status === 'saving' ? '外观已保存。' : '' }; return true;
    }).catch(error => { if (!disposed) fail(error); return false; }).finally(() => { pending = null; if (!disposed) notify(); });
    return pending;
  }
  return Object.freeze({
    inspect,
    read: () => run(() => adapter.read(), 'loading'),
    select(theme) {
      if (!isTheme(theme) || !baseline || state.status !== 'ready' || disposed || pending) return Promise.resolve(false);
      if (theme === state.theme) return Promise.resolve(true);
      return run(async () => {
        if (!canSave()) throw Object.assign(new Error(), { code: 'APPEARANCE_CONFLICT' });
        await prepareTheme(theme);
        return adapter.save(theme, baseline, { isCurrent: () => !disposed && canSave() });
      }, 'saving');
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; adapter.dispose(); listeners.clear(); },
  });
}
