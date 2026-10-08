import { trackSettingsSave, waitForSettingsSaves, hasSettingsSaves } from './pending-settings-saves.js';
import { getSillyTavernContext } from './context.js';
import { SETTINGS_KEY, SettingsError, emptySettings, assertSettings, equalSettings, settingsFingerprint } from '../../shared/settings/model.js';

// The settings endpoint contains host data. Project only this namespace and
// never expose/log its surrounding payload. Saving uses ST's own exported API.
export function createSillyTavernSettingsAdapter({ getContext = getSillyTavernContext,
  fetchImpl = globalThis.fetch, saveHost, loadHostModule = () => import('/script.js'), readServerNamespace, onTiming } = {}) {
  let disposed = false, confirmed = null, marker = null, epoch = 0, aiEpoch = 0, generationEpoch = 0,recallEpoch=0,cumulativeEpoch=0,timeEpoch=0,workshopEpoch=0,controlsEpoch=0;
  let observed = null, lastAi = null, lastGeneration = null,lastRecall=null,lastCumulative=null,lastTime=null,lastWorkshop=null,lastControls=null, notificationActive = false;
  const listeners = new Set(), events = [], notificationQueue = [];
  // Opt-in diagnostics only. Never include settings, URLs, headers or errors.
  // Content-Length is optional server-reported bytes, not decoded payload size.
  const timingStart = () => typeof onTiming === 'function' ? performance.now() : null;
  function timingEnd(phase, start, ok, responseBytes = null) {
    if (start === null) return;
    try { onTiming(Object.freeze({ phase, durationMs: Math.max(0, performance.now() - start), count: 1, ok, responseBytes })); }
    catch { /* Diagnostics cannot fail a read or save. */ }
  }
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
  function observe(acceptLocal = false) {
    let snapshot;
    try { snapshot = local(); }
    catch (error) {
      if (observed !== 'invalid') { observed = 'invalid'; epoch++; aiEpoch++; generationEpoch++;recallEpoch++;cumulativeEpoch++;timeEpoch++;workshopEpoch++;controlsEpoch++; confirmed = null; announce(); }
      throw error instanceof SettingsError ? error : new SettingsError();
    }
    const fingerprint = snapshot.absent ? 'absent' : settingsFingerprint(snapshot.root);
    let ticketEpoch = epoch;
    if (observed !== fingerprint) {
      const nextAi = settingsFingerprint({ revision: snapshot.root.domainRevisions.ai, value: snapshot.root.ai, credentials: snapshot.root.credentials }), nextGeneration = settingsFingerprint({ revision: snapshot.root.domainRevisions.eventGeneration, value: snapshot.root.eventGeneration });
      observed = fingerprint; epoch++; ticketEpoch = epoch;
      if (nextAi !== lastAi) { aiEpoch++; lastAi = nextAi; }
      if (nextGeneration !== lastGeneration) { generationEpoch++; lastGeneration = nextGeneration; }
      const nextRecall=settingsFingerprint({revision:snapshot.root.domainRevisions.recall,value:snapshot.root.recall});
      if(nextRecall!==lastRecall){recallEpoch++;lastRecall=nextRecall;}
      const nextCumulative=settingsFingerprint({revision:snapshot.root.domainRevisions.cumulativeGeneration??0,value:snapshot.root.cumulativeGeneration??null});
      if(nextCumulative!==lastCumulative){cumulativeEpoch++;lastCumulative=nextCumulative;}
      const nextTime=settingsFingerprint({revision:snapshot.root.domainRevisions.timeReminders??0,value:snapshot.root.timeReminders??null});
      if(nextTime!==lastTime){timeEpoch++;lastTime=nextTime;}
      const nextWorkshop=settingsFingerprint({revision:snapshot.root.domainRevisions.workshop??0,value:snapshot.root.workshop??null});
      if(nextWorkshop!==lastWorkshop){workshopEpoch++;lastWorkshop=nextWorkshop;}
      const nextControls=settingsFingerprint({revision:snapshot.root.domainRevisions.controls??0,value:snapshot.root.controls??null});
      if(nextControls!==lastControls){controlsEpoch++;lastControls=nextControls;}
      confirmed = acceptLocal ? snapshot.root : null;
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
    const start = timingStart(); let ok = false, responseBytes = null;
    try {
      if (readServerNamespace) { const raw = await readServerNamespace(); ok = true; return raw; }
      const ctx = capabilities();
      const response = await fetchImpl('/api/settings/get', { method: 'POST', headers: ctx.getRequestHeaders(),
        cache: 'no-store', body: '{}' });
      if (!response?.ok) throw new Error();
      if (start !== null) {
        // Missing/unusable size stays unknown; do not copy or stringify payloads.
        try { const length = response.headers?.get?.('content-length');
          if (typeof length === 'string' && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) responseBytes = Number(length);
        } catch { /* Optional header metadata is not an authority. */ }
      }
      const data = await response.json();
      if (typeof data?.settings !== 'string') throw new Error();
      const settings = JSON.parse(data.settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || (settings.extension_settings !== undefined && (!settings.extension_settings || typeof settings.extension_settings !== 'object' || Array.isArray(settings.extension_settings)))) throw new Error();
      ok = true; return settings.extension_settings?.[SETTINGS_KEY];
    } catch { throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED'); }
    finally { timingEnd('settings-read', start, ok, responseBytes); }
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
  async function read({ waitForPendingSaves = false } = {}) {
    capabilities();
    const ticket = observe();
    if (marker?.inFlight) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
    const previousMarker = marker;
    if (waitForPendingSaves) {
      while (hasSettingsSaves(ticket.ctx.extensionSettings)) { await waitForSettingsSaves(ticket.ctx.extensionSettings); unchanged(ticket); }
    }
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
    epochs() { observe(); return Object.freeze({ epoch, ai: aiEpoch, eventGeneration: generationEpoch,recall:recallEpoch,cumulativeGeneration:cumulativeEpoch,timeReminders:timeEpoch,workshop:workshopEpoch,controls:controlsEpoch }); },
    async commit(value, expectedRevision, expectedEpoch, { isCurrent, requireConfirmation = false } = {}) {
      if (isCurrent !== undefined && typeof isCurrent !== 'function') throw new SettingsError();
      const guard = () => {
        if (isCurrent === undefined) return true;
        try { return isCurrent() === true; } catch { return false; }
      };
      const next = assertSettings(value);
      let ticket = observe();
      if (!confirmed || marker) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
      if (confirmed.revision !== expectedRevision || ticket.epoch !== expectedEpoch || next.revision !== expectedRevision + 1) throw new SettingsError('SETTINGS_CONFLICT');
      const fields=['ai','eventGeneration','recall','cumulativeGeneration','timeReminders','workshop','controls'];
      const changed=fields.filter(field=>(next.domainRevisions[field]??0)!==(confirmed.domainRevisions[field]??0));
      if(changed.length!==1||(next.domainRevisions[changed[0]]??0)!==(confirmed.domainRevisions[changed[0]]??0)+1
        ||fields.some(field=>field!==changed[0]&&!equalSettings(next[field],confirmed[field]))
        ||changed[0]!=='ai'&&!equalSettings(next.credentials,confirmed.credentials))throw new SettingsError('SETTINGS_CONFLICT');
      const save = await saver();
      if (changed[0] === 'ai' || requireConfirmation) {
        while (hasSettingsSaves(ticket.ctx.extensionSettings)) {
          await waitForSettingsSaves(ticket.ctx.extensionSettings); unchanged(ticket);
          if (!guard()) throw new SettingsError('SETTINGS_CONFLICT');
        }
      }
      capabilities(); unchanged(ticket);
      if (!guard()) throw new SettingsError('SETTINGS_CONFLICT');
      unchanged(ticket);
      if (!confirmed || marker) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
      if (changed[0] !== 'ai' && !requireConfirmation) {
        // Ordinary edits become current immediately. ST owns background disk
        // persistence; its async completion must not lock unrelated settings.
        const previous = ticket.ctx.extensionSettings[SETTINGS_KEY];
        ticket.ctx.extensionSettings[SETTINGS_KEY] = next;
        ticket = observe(true);
        const saveStart = timingStart();
        try {
          unchanged(ticket);
          if (!guard()) throw new SettingsError('SETTINGS_CONFLICT');
          unchanged(ticket);
          const pending = save();
          trackSettingsSave(ticket.ctx.extensionSettings, pending);
          Promise.resolve(pending).then(
            () => timingEnd('host-save', saveStart, true),
            () => timingEnd('host-save', saveStart, false),
          );
        } catch (error) {
          // A synchronous rejection never reached normal host persistence.
          // Restore only our own still-current value, never an external edit.
          if (ticket.ctx.extensionSettings[SETTINGS_KEY] === next) {
            if (previous === undefined) delete ticket.ctx.extensionSettings[SETTINGS_KEY];
            else ticket.ctx.extensionSettings[SETTINGS_KEY] = previous;
            observe(true);
          }
          timingEnd('host-save', saveStart, false);
          throw error instanceof SettingsError ? error : new SettingsError('SETTINGS_UNAVAILABLE');
        }
        unchanged(ticket);
        return { status: 'committed', root: next };
      }
      // Mark before staging. No reader can treat the pending namespace as saved.
      const record = { inFlight: true }; marker = record;
      ticket.ctx.extensionSettings[SETTINGS_KEY] = next;
      ticket = observe(); record.stagedFingerprint = ticket.fingerprint; announce();
      try {
        unchanged(ticket);
        if (!guard() || marker !== record) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
        unchanged(ticket);
        if (marker !== record || confirmed) throw new SettingsError('SETTINGS_COMMIT_UNCONFIRMED');
        const saveStart = timingStart(); let saveOk = false;
        try { await save(); saveOk = true; } catch { /* Only server confirmation proves success. */ }
        finally { timingEnd('host-save', saveStart, saveOk); }
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
