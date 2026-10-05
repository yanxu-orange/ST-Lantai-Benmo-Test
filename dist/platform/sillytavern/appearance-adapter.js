import { getSillyTavernContext } from './context.js';
import { DEFAULT_THEME, isTheme } from '../../app/styles/theme.js';

// Presentation has its own namespace: theme saves must never invalidate AI,
// generation, recall, cumulative or credential authority in lantai_benmo.
export const APPEARANCE_KEY = 'lantai_benmo_appearance';
const defaults = () => ({ schema: 1, revision: 0, theme: DEFAULT_THEME });
const fingerprint = value => value === undefined ? 'absent' : JSON.stringify([value.schema, value.revision, value.theme]);
const failure = code => Object.assign(new Error(code), { code });
export function assertAppearance(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 3 || !['schema','revision','theme'].every(key => Object.hasOwn(value,key))
    || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isTheme(value.theme)) {
    throw failure('APPEARANCE_INVALID');
  }
  return Object.freeze({ schema: 1, revision: value.revision, theme: value.theme });
}
export function createAppearanceAdapter({ getContext = getSillyTavernContext, fetchImpl = globalThis.fetch,
  saveHost, loadHostModule = () => import('/script.js'), readServerNamespace } = {}) {
  let confirmed = null, marker = null, disposed = false, epoch = 0, observed, off;
  function local() {
    const ctx = !disposed && getContext();
    if (!ctx?.extensionSettings || typeof ctx.extensionSettings !== 'object') throw failure('APPEARANCE_UNAVAILABLE');
    const raw = ctx.extensionSettings[APPEARANCE_KEY];
    const root = raw === undefined ? assertAppearance(defaults()) : assertAppearance(raw), key = fingerprint(raw);
    if (key !== observed) { observed = key; epoch++; }
    if (!off && ctx.eventTypes?.SETTINGS_UPDATED && typeof ctx.eventSource?.on === 'function'
      && typeof (ctx.eventSource.removeListener ?? ctx.eventSource.off) === 'function') {
      const source = ctx.eventSource, type = ctx.eventTypes.SETTINGS_UPDATED;
      const updated = () => { try { local(); } catch { observed = undefined; epoch++; } };
      off = () => (source.removeListener ?? source.off).call(source, type, updated); source.on(type, updated);
    }
    return { ctx, raw, root, fingerprint: key, epoch };
  }
  const unchanged = ticket => {
    const current = local();
    if (ticket.ctx.extensionSettings !== current.ctx.extensionSettings || ticket.fingerprint !== current.fingerprint || ticket.epoch !== current.epoch) throw failure('APPEARANCE_CONFLICT');
    return current;
  };
  async function server() {
    try {
      if (readServerNamespace) return await readServerNamespace();
      const { ctx } = local();
      if (typeof fetchImpl !== 'function' || typeof ctx.getRequestHeaders !== 'function') throw new Error();
      const response = await fetchImpl('/api/settings/get', { method: 'POST', headers: ctx.getRequestHeaders(), cache: 'no-store', body: '{}' });
      if (!response?.ok) throw new Error();
      const payload = await response.json();
      if (typeof payload?.settings !== 'string') throw new Error();
      const settings = JSON.parse(payload.settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || (settings.extension_settings !== undefined && (!settings.extension_settings || typeof settings.extension_settings !== 'object' || Array.isArray(settings.extension_settings)))) throw new Error();
      return settings.extension_settings?.[APPEARANCE_KEY];
    } catch { throw failure('APPEARANCE_UNCONFIRMED'); }
  }
  async function saver() {
    if (saveHost !== undefined) {
      if (typeof saveHost !== 'function') throw failure('APPEARANCE_UNAVAILABLE');
      return saveHost;
    }
    try { const host = await loadHostModule(); if (typeof host?.saveSettings !== 'function') throw new Error(); return host.saveSettings; }
    catch { throw failure('APPEARANCE_UNAVAILABLE'); }
  }
  function install(raw, root, ticket) {
    const { ctx } = unchanged(ticket);
    if (raw === undefined) delete ctx.extensionSettings[APPEARANCE_KEY];
    else ctx.extensionSettings[APPEARANCE_KEY] = root;
    const installed = local();
    confirmed = { root, fingerprint: fingerprint(raw), epoch: installed.epoch }; marker = null;
    return root;
  }
  async function read() {
    const ticket = local(), previous = marker;
    if (marker?.inFlight) throw failure('APPEARANCE_UNCONFIRMED');
    const raw = await server(), root = raw === undefined ? assertAppearance(defaults()) : assertAppearance(raw);
    if (marker !== previous || marker?.inFlight) throw failure('APPEARANCE_UNCONFIRMED');
    unchanged(ticket);
    if (!(previous && ticket.fingerprint === previous.stagedFingerprint)
      && ticket.raw !== undefined && fingerprint(root) !== fingerprint(ticket.root) && root.revision <= ticket.root.revision) throw failure('APPEARANCE_CONFLICT');
    return install(raw, root, ticket);
  }
  return Object.freeze({
    read,
    async save(theme, expected, { isCurrent = () => true } = {}) {
      if (!isTheme(theme)) throw failure('APPEARANCE_INVALID');
      let ticket = local();
      if (!confirmed || marker) throw failure('APPEARANCE_UNCONFIRMED');
      if (fingerprint(expected) !== fingerprint(confirmed.root) || ticket.fingerprint !== confirmed.fingerprint || ticket.epoch !== confirmed.epoch) throw failure('APPEARANCE_CONFLICT');
      const guard = () => { try { return !disposed && isCurrent() === true; } catch { return false; } };
      // Use this window's observed appearance. Other windows need a refresh;
      // local conflict checks and post-save confirmation remain in place.
      const save = await saver(); unchanged(ticket);
      if (!guard()) throw failure('APPEARANCE_CONFLICT');
      unchanged(ticket);
      if (theme === ticket.root.theme) return confirmed.root;
      const next = assertAppearance({ schema: 1, revision: ticket.root.revision + 1, theme });
      const record = { inFlight: true }; marker = record;
      ticket.ctx.extensionSettings[APPEARANCE_KEY] = next;
      ticket = local(); record.stagedFingerprint = ticket.fingerprint; confirmed = null;
      try {
        unchanged(ticket);
        if (!guard()) throw failure('APPEARANCE_UNCONFIRMED');
        try { await save(); } catch { /* Only server readback confirms persistence. */ }
        unchanged(ticket);
        const raw = await server(), actual = assertAppearance(raw);
        unchanged(ticket);
        if (!guard() || marker !== record || fingerprint(actual) !== fingerprint(next)) throw failure('APPEARANCE_UNCONFIRMED');
        return install(raw, actual, ticket);
      } catch {
        record.inFlight = false;
        // Do not roll back a potentially saved host value. Explicit reread is
        // required before either theme save or the settings UI's API save.
        throw failure('APPEARANCE_UNCONFIRMED');
      }
    },
    dispose() { disposed = true; confirmed = null; off?.(); off = null; },
  });
}
