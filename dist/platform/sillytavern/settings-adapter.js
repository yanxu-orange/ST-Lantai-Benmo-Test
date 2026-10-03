import { getSillyTavernContext } from './context.js';
import { SETTINGS_KEY, SettingsError, emptySettings, assertSettings, equalSettings, settingsFingerprint } from '../../shared/settings/model.js';

// The settings endpoint contains host data. Project only this namespace and
// never expose/log its surrounding payload. Saving uses ST's own exported API.
export function createSillyTavernSettingsAdapter({ getContext = getSillyTavernContext,
  fetchImpl = globalThis.fetch, saveHost, loadHostModule = () => import('/script.js'), readServerNamespace } = {}) {
  let disposed = false, confirmed = null, marker = null, epoch = 0, aiEpoch = 0, generationEpoch = 0;
  let observed = null, lastAi = null, lastGeneration = null, notificationActive = false;
  const listeners = new Set(), events = [], notificationQueue = [];
  function context() {
    if (disposed) throw new SettingsError('SETTINGS_UNAVAILABLE');
    let ctx;
    try { ctx = getContext(); } catch { throw new SettingsError('SETTINGS_UNAVAILABLE'); }
    if (!ctx?.extensionSettings || typeof ctx.extensionSettings !== 'object') throw new SettingsError('SETTINGS_UNAVAILABLE');
    return ctx;
  }
  function announce() {
    notificationQueue.push({ state: Object.freeze({ epoch, confirmed: !!confirmed && !marker, revision: confirmed?.revision ?? null }), recipients: [...listeners] });
    if (notificationActive) return;
    notificationActive = true;
    try {
      while (notificationQueue.length) {
        const { state, recipients } = notificationQueue.shift();
        for (const listener of recipients) if (listeners.has(listener)) {
          try { listener(state); } catch { /* Views do not own persistence. */ }
        }
      }
    } finally { notificationActive = false; }
  }
  function local() {
    const ctx = context(), raw = ctx.extensionSettings[SETTINGS_KEY];
    return { ctx, root: raw === undefined ? emptySettings() : assertSettings(raw), absent: raw === undefined };
  }
  function observe() {
    let snapshot;
    try { snapshot = local(); }
    catch (error) {
      if (observed !== 'invalid') { observed = 'invalid'; epoch++; aiEpoch++; generationEpoch++; confirmed = null; announce(); }
      throw error instanceof SettingsError ? error : new SettingsError();
    }
    const fingerprint = snapshot.absent ? 'absent' : settingsFingerprint(snapshot.root);
    let ticketEpoch = epoch;
    if (observed !== fingerprint) {
      const nextAi = settingsFingerprint({ revision: snapshot.root.domainRevisions.ai, value: snapshot.root.ai, credentials: snapshot.root.credentials }), nextGeneration = settingsFingerprint({ revision: snapshot.root.domainRevisions.eventGeneration, value: snapshot.root.eventGeneration });
      observed = fingerprint; epoch++; ticketEpoch = epoch;
      if (nextAi !== lastAi) { aiEpoch++; lastAi = nextAi; }
      if (nextGeneration !== lastGeneration) { generationEpoch++; lastGeneration = nextGeneration; }
      confirmed = null;
      announce();
    }
    return { ...snapshot, fingerprint, epoch: ticketEpoch };
  }
  function capabilities() {
    const ctx = context(), source = ctx.eventSource;
    if (typeof source?.on !== 'function' || typeof (source.removeListener ?? source.off) !== 'function'
      || !ctx.eventTypes?.SETTINGS_UPDATED) throw new SettingsError('SETTINGS_UNAVAILABLE');
    if (!readServerNamespace && (typeof fetchImpl !== 'function' || typeof ctx.getRequestHeaders !== 'function')) throw new SettingsError('SETTINGS_UNAVAILABLE');
    return ctx;
  }
  async function server() {
    try {
      if (readServerNamespace) return await readServerNamespace();
      const ctx = capabilities();
      const response = await fetchImpl('/api/settings/get', { method: 'POST', headers: ctx.getRequestHeaders(),
        cache: 'no-store', body: '{}' });
      if (!response?.ok) throw new Error();
      const data = await response.json();
      if (typeof data?.settings !== 'string') throw new Error();
      const settings = JSON.parse(data.settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || (settings.extension_settings !== undefined && (!settings.extension_settings || typeof settings.extension_settings !== 'object' || Array.isArray(settings.extension_settings)))) throw new Error();
      return settings.extension_settings?.[SETTINGS_KEY];
    } catch { throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED'); }
  }
  async function saver() {
    if (saveHost !== undefined) {
      if (typeof saveHost !== 'function') throw new SettingsError('SETTINGS_UNAVAILABLE');
      return saveHost;
    }
    try {
      const host = await loadHostModule();
      if (typeof host?.saveSettings !== 'function') throw new Error();
      return host.saveSettings;
    } catch { throw new SettingsError('SETTINGS_UNAVAILABLE'); }
  }
  function unchanged(ticket) {
    const latest = observe();
    if (latest.fingerprint !== ticket.fingerprint || latest.epoch !== ticket.epoch) throw new SettingsError('SETTINGS_CONFLICT');
    return latest;
  }
  function install(raw, root, ticket) {
    const latest = unchanged(ticket);
    // Replace only our namespace, never another extension or a host setting.
    if (raw === undefined) delete latest.ctx.extensionSettings[SETTINGS_KEY];
    else latest.ctx.extensionSettings[SETTINGS_KEY] = raw;
    const installed = observe();
    const expected = raw === undefined ? 'absent' : settingsFingerprint(root);
    if (installed.fingerprint !== expected) throw new SettingsError('SETTINGS_CONFLICT');
    marker = null; confirmed = root; announce();
    const final = observe();
    if (marker || confirmed !== root || final.fingerprint !== expected || final.epoch !== installed.epoch) throw new SettingsError('SETTINGS_CONFLICT');
    return root;
  }
  async function read() {
    capabilities();
    const ticket = observe();
    if (marker?.inFlight) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
    const previousMarker = marker;
    const raw = await server();
    const root = raw === undefined ? assertSettings(emptySettings()) : assertSettings(raw);
    // A save starting during readback cannot be mistaken for confirmed data.
    if (marker !== previousMarker || marker?.inFlight) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
    unchanged(ticket);
    const ownPending = previousMarker && ticket.fingerprint === previousMarker.stagedFingerprint;
    if (!ownPending && !ticket.absent && !equalSettings(root, ticket.root) && root.revision <= ticket.root.revision) throw new SettingsError('SETTINGS_CONFLICT');
    return install(raw, root, ticket);
  }
  const initial = capabilities(), source = initial.eventSource;
  const updated = () => { try { observe(); } catch { /* Invalid settings remain unavailable. */ } };
  source.on(initial.eventTypes.SETTINGS_UPDATED, updated);
  events.push(() => (source.removeListener ?? source.off).call(source, initial.eventTypes.SETTINGS_UPDATED, updated));
  return Object.freeze({
    read,
    peek() {
      observe();
      if (!confirmed || marker) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
      return confirmed;
    },
    epochs() { observe(); return Object.freeze({ epoch, ai: aiEpoch, eventGeneration: generationEpoch }); },
    async commit(value, expectedRevision, expectedEpoch, { isCurrent } = {}) {
      if (isCurrent !== undefined && typeof isCurrent !== 'function') throw new SettingsError();
      const guard = () => {
        if (isCurrent === undefined) return true;
        try { return isCurrent() === true; } catch { return false; }
      };
      const next = assertSettings(value);
      let ticket = observe();
      if (!confirmed || marker) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
      if (confirmed.revision !== expectedRevision || ticket.epoch !== expectedEpoch || next.revision !== expectedRevision + 1) throw new SettingsError('SETTINGS_CONFLICT');
      const aiDelta = next.domainRevisions.ai - confirmed.domainRevisions.ai;
      const generationDelta = next.domainRevisions.eventGeneration - confirmed.domainRevisions.eventGeneration;
      if (!((aiDelta === 1 && generationDelta === 0 && equalSettings(next.eventGeneration, confirmed.eventGeneration))
        || (generationDelta === 1 && aiDelta === 0 && equalSettings(next.ai, confirmed.ai) && equalSettings(next.credentials, confirmed.credentials)))) throw new SettingsError('SETTINGS_CONFLICT');
      const save = await saver();
      capabilities(); unchanged(ticket);
      if (!guard()) throw new SettingsError('SETTINGS_CONFLICT');
      unchanged(ticket);
      if (!confirmed || marker) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
      // Mark before staging. No reader can treat the pending namespace as saved.
      const record = { inFlight: true }; marker = record;
      ticket.ctx.extensionSettings[SETTINGS_KEY] = next;
      ticket = observe(); record.stagedFingerprint = ticket.fingerprint; announce();
      try {
        unchanged(ticket);
        if (!guard() || marker !== record) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
        unchanged(ticket);
        if (marker !== record || confirmed) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
        try { await save(); } catch { /* Only server confirmation proves success. */ }
        unchanged(ticket);
        const raw = await server();
        const actual = raw === undefined ? assertSettings(emptySettings()) : assertSettings(raw);
        unchanged(ticket);
        if (!guard() || marker !== record || !equalSettings(actual, next)) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
        unchanged(ticket);
        if (marker !== record || confirmed) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
        record.inFlight = false;
        const root = install(raw, actual, ticket);
        return { status: 'committed', root };
      } catch {
        record.inFlight = false;
        // Preserve the marker and any external namespace. A later read must
        // reconcile actual server authority before old cached data can write.
        if (marker === record) confirmed = null;
        announce();
        throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
      }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Observer must be a function');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true; confirmed = null; epoch++;
      for (const off of events.splice(0)) off();
      listeners.clear();
    },
  });
}
