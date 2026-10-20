import { assertTaskRoutes, defaultTaskRoutes, assertTaskRouting, taskRoutingView, SETTINGS_DOMAINS, settingsDomainValue, assertCredential, aiConfig, equalSettings, frozenSettingsCopy, publicSettings, SettingsError } from './model.js';

export function createSettingsRepository(adapter) {
  let queue = Promise.resolve();
  function update(field, value, { expectedEpoch: requestedEpoch, isCurrent, requireConfirmation = false, credentials = [] } = {}) {
    if ((requestedEpoch !== undefined && (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 0))
      || (isCurrent !== undefined && typeof isCurrent !== 'function')) throw new SettingsError();
    const guard = () => {
      if (isCurrent === undefined) return true;
      try { return isCurrent() === true; } catch { return false; }
    };
    const draft = SETTINGS_DOMAINS[field].validate(value);
    if (!Array.isArray(credentials) || field !== 'ai' && credentials.length) throw new SettingsError();
    let replacements;
    try { replacements = credentials.map(item => {
      if (!item || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'presetId') || !Object.hasOwn(item, 'value')
        || !draft.presets?.some(preset => preset.id === item.presetId)) throw new SettingsError();
      return { presetId: item.presetId, value: assertCredential(item.value) };
    }); } catch { throw new SettingsError(); }
    if (new Set(replacements.map(item => item.presetId)).size !== replacements.length) throw new SettingsError();
    // Controls carry their confirmed domain epoch. Queue that exact intent even
    // when an unrelated save has temporarily staged the shared namespace.
    // The queued peek still rejects failed/unconfirmed writes without rereading.
    const queuedControls = field === 'controls' && requestedEpoch !== undefined;
    let previous = null;
    if (!queuedControls) {
      try { previous = adapter.peek(); }
      catch (error) {
        // An API draft already owns its original domain epoch. Its queued
        // fresh read can reconcile lost authority and validate that same
        // epoch together; an outer recovery read would immediately repeat it.
        if (field !== 'ai' || requestedEpoch === undefined || error?.code !== 'SETTINGS_COMMIT_UNCONFIRMED') throw error;
      }
    }
    const expectedEpoch = requestedEpoch ?? adapter.epochs()[field];
    const work = queue.then(async () => {
      // API edits use this window's confirmed authority, just like ordinary
      // settings. Lost authority still requires reconciliation; never write a
      // stale cached root. The adapter retains pending-save ordering and final
      // server confirmation for an actual API write.
      let root;
      if (requireConfirmation) root = await adapter.read({ waitForPendingSaves: true });
      else if (field === 'ai') {
        try { root = adapter.peek(); }
        catch (error) {
          if (error?.code !== 'SETTINGS_COMMIT_UNCONFIRMED') throw error;
          root = await adapter.read({ waitForPendingSaves: true });
        }
      } else root = adapter.peek();
      const epochs = adapter.epochs();
      if (!guard()) throw new SettingsError('SETTINGS_CONFLICT');
      // Caller guards can synchronously mutate host settings without an event.
      // Re-observe authority after the callback, including the no-op path.
      let current, currentEpochs;
      try { ({ root: current, epochs: currentEpochs } = adapter.snapshot()); }
      catch { throw new SettingsError('SETTINGS_CONFLICT'); }
      if (currentEpochs.epoch !== epochs.epoch || currentEpochs[field] !== expectedEpoch
        || !equalSettings(current, root) || (previous && !equalSettings(root[field], previous[field]))) throw new SettingsError('SETTINGS_CONFLICT');
      const nextCredentials = field === 'ai' ? draft.presets.flatMap(preset => {
        const credential = replacements.find(item => item.presetId === preset.id) ?? root.credentials.find(item => item.presetId === preset.id);
        return credential ? [credential] : [];
      }) : root.credentials;
      if (equalSettings(settingsDomainValue(root, field, 'no-op'), draft) && equalSettings(root.credentials, nextCredentials)) return { status: 'committed', root: publicSettings(root), changed: false };
      const next = { ...root, revision: root.revision + 1,
        domainRevisions: { ...root.domainRevisions, [field]: (root.domainRevisions[field]??0) + 1 }, [field]: draft, credentials: nextCredentials };
      const result = await adapter.commit(next, root.revision, epochs.epoch, { isCurrent: guard, requireConfirmation });
      return { ...result, root: publicSettings(result.root), changed: true };
    });
    queue = work.catch(() => {});
    return work;
  }
  function readSettings(preferConfirmed=false) {
    // Share the write queue; never expose a staged namespace during a save.
    const work=queue.then(async()=>{
      if(preferConfirmed){try{return publicSettings(adapter.peek());}catch{/* Recover invalidated or uncertain authority below. */}}
      return publicSettings(await adapter.read());
    });
    queue=work.catch(()=>{});return work;
  }
  return Object.freeze({
    read:()=>readSettings(),
    ensure:()=>readSettings(true),
    saveAi: (value, options) => update('ai', value, options),
    saveTaskRoutes(routes, options = {}) {
      // Capture only confirmed authority; the existing queue and AI epoch guard
      // reject interleaved preset edits rather than overwriting them.
      const { root, epochs } = adapter.snapshot();
      if (root.ai.taskRouting) throw new SettingsError('SETTINGS_CONFLICT');
      const unchangedLegacy = !Object.hasOwn(root.ai, 'taskRoutes') && equalSettings(assertTaskRoutes(routes), defaultTaskRoutes());
      return update('ai', unchangedLegacy ? root.ai : { ...root.ai, taskRoutes: routes }, { ...options, expectedEpoch: options.expectedEpoch ?? epochs.ai, credentials: [] });
    },
    captureTaskRouting() { const {root,epochs}=adapter.snapshot(); return frozenSettingsCopy({...taskRoutingView(root.ai),epoch:epochs.ai}); },
    saveTaskRouting(routes, options = {}) {
      const {root,epochs}=adapter.snapshot();
      if (routes?.summary === null) throw new SettingsError('TASK_ROUTE_UNRESOLVED');
      return update('ai',{...root.ai,taskRouting:assertTaskRouting(routes)},{...options,expectedEpoch:options.expectedEpoch??epochs.ai,credentials:[]});
    },
    saveEventGeneration: (value, options) => update('eventGeneration', value, options),
    saveRecall: (value,options)=>update('recall',value,options),
    saveCumulativeGeneration:(value,options)=>update('cumulativeGeneration',value,options),
    saveScheduleTracking:(value,options)=>update('scheduleTracking',value,options),
    captureScheduleTracking(){const {root,epochs}=adapter.snapshot();return frozenSettingsCopy({config:settingsDomainValue(root,'scheduleTracking'),epoch:epochs.scheduleTracking});},
    matchesScheduleTracking(snapshot){try{return snapshot?.epoch===adapter.epochs().scheduleTracking&&equalSettings(snapshot.config,settingsDomainValue(adapter.peek(),'scheduleTracking'));}catch{return false;}},
    saveTrackingPrompts:(value,options)=>update('trackingPrompts',value,options),
    captureTrackingPrompts(){const {root, epochs}=adapter.snapshot();return frozenSettingsCopy({prompts:settingsDomainValue(root,'trackingPrompts'),epoch:epochs.trackingPrompts});},
    matchesTrackingPrompts(snapshot){try{return snapshot?.epoch===adapter.epochs().trackingPrompts&&equalSettings(snapshot.prompts,settingsDomainValue(adapter.peek(),'trackingPrompts'));}catch{return false;}},
    saveControls:(value,options)=>update('controls',value,options),
    captureControls(){const {root, epochs}=adapter.snapshot();return frozenSettingsCopy({controls:settingsDomainValue(root,'controls'),epoch:epochs.controls});},
    matchesControls(snapshot){try{const root=adapter.peek();return snapshot?.epoch===adapter.epochs().controls&&equalSettings(snapshot.controls,settingsDomainValue(root,'controls'));}catch{return false;}},
    saveWorkshop:(value,options)=>update('workshop',value,options),
    captureWorkshop(){const {root, epochs}=adapter.snapshot();return frozenSettingsCopy({workshop:settingsDomainValue(root,'workshop'),epoch:epochs.workshop});},
    matchesWorkshop(snapshot){try{const root=adapter.peek();return snapshot?.epoch===adapter.epochs().workshop&&equalSettings(snapshot.workshop,settingsDomainValue(root,'workshop'));}catch{return false;}},
    saveTimeReminders:(value,options)=>update('timeReminders',value,options),
    captureTimeReminders(){const {root, epochs}=adapter.snapshot();return frozenSettingsCopy({reminders:settingsDomainValue(root,'timeReminders'),epoch:epochs.timeReminders});},
    matchesTimeReminders(snapshot){try{const root=adapter.peek();return snapshot?.epoch===adapter.epochs().timeReminders&&equalSettings(snapshot.reminders,settingsDomainValue(root,'timeReminders'));}catch{return false;}},
    captureCumulativeGeneration(){const {root, epochs}=adapter.snapshot();return frozenSettingsCopy({generation:settingsDomainValue(root,'cumulativeGeneration'),epoch:epochs.cumulativeGeneration});},
    matchesCumulativeGeneration(snapshot){try{const root=adapter.peek();return snapshot?.epoch===adapter.epochs().cumulativeGeneration&&equalSettings(snapshot.generation,settingsDomainValue(root,'cumulativeGeneration'));}catch{return false;}},
    captureRecall(){const {root, epochs}=adapter.snapshot();return frozenSettingsCopy({recall:settingsDomainValue(root,'recall'),epoch:epochs.recall});},
    matchesRecall(snapshot){try{const root=adapter.peek();return snapshot?.epoch===adapter.epochs().recall&&equalSettings(snapshot.recall,root.recall);}catch{return false;}},
    captureEventGeneration() {
      const { root, epochs } = adapter.snapshot();
      return frozenSettingsCopy({ generation: root.eventGeneration, epoch: epochs.eventGeneration });
    },
    matchesEventGeneration(snapshot) {
      try { const root=adapter.peek();return snapshot?.epoch===adapter.epochs().eventGeneration&&equalSettings(snapshot.generation,root.eventGeneration); }
      catch { return false; }
    },
    captureAi() {
      const { root, epochs } = adapter.snapshot();
      return frozenSettingsCopy({ ai: root.ai, credentialPresetIds: root.credentials.map(item => item.presetId), epoch: epochs.ai });
    },
    getAiConfig: taskGroup => { const { root, epochs } = adapter.snapshot(); return aiConfig(root, epochs.ai, taskGroup); },
    resolvePresetCredential({ presetId, expectedEpoch }) {
      try {
        const root = adapter.peek(), epoch = adapter.epochs().ai;
        if (epoch !== expectedEpoch || !root.ai.presets.some(item => item.id === presetId)) throw new Error();
        const value = assertCredential(root.credentials.find(item => item.presetId === presetId)?.value);
        if (adapter.peek() !== root || adapter.epochs().ai !== epoch) throw new Error();
        return value;
      } catch { throw new SettingsError('SETTINGS_CONFLICT'); }
    },
    resolveCredential(config, { taskGroup } = {}) {
      try {
        const root = adapter.peek(), current = aiConfig(root, adapter.epochs().ai, taskGroup);
        if (current.source !== 'plugin' || config?.source !== 'plugin' || config?.credentialId !== current.credentialId
          || config.capability !== current.capability
          || config.protocol !== current.protocol
          || config?.credentialEpoch !== current.credentialEpoch || config.model !== current.model
          || new URL(config.endpoint).toString().replace(/\/$/, '') !== new URL(current.endpoint).toString().replace(/\/$/, '')) throw new SettingsError('SETTINGS_CONFLICT');
        if (adapter.peek() !== root || adapter.epochs().ai !== current.credentialEpoch) throw new SettingsError('SETTINGS_CONFLICT');
        const value = root.credentials.find(item => item.presetId === current.credentialId)?.value;
        return assertCredential(value);
      } catch { throw new SettingsError('SETTINGS_CONFLICT'); }
    },
    getGenerationSettings() {
      const { root, epochs } = adapter.snapshot();
      return frozenSettingsCopy({ epoch: epochs.epoch, generationEpoch: epochs.eventGeneration, ...root.eventGeneration });
    },
    getEpoch: () => { adapter.peek(); return adapter.epochs().epoch; },
    subscribe: listener => adapter.subscribe(listener),
    dispose: () => adapter.dispose(),
  });
}
