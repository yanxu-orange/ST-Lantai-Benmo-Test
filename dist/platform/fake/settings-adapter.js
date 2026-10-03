import { createSillyTavernSettingsAdapter } from '../sillytavern/settings-adapter.js';
import { SETTINGS_KEY } from '../../shared/settings/model.js';

// Memory-backed persistence with the same confirmation/lifecycle boundary as
// the ST adapter. Explicit hooks simulate uncertain saves without networking.
export function createFakeSettingsAdapter({ namespace, save, read } = {}) {
  const handlers = new Set();
  const state = { disk: namespace === undefined ? undefined : structuredClone(namespace), saves: 0,
    context: { extensionSettings: {}, eventTypes: { SETTINGS_UPDATED: 'settings-updated' },
      eventSource: { on: (_, listener) => handlers.add(listener), removeListener: (_, listener) => handlers.delete(listener) } } };
  if (namespace !== undefined) state.context.extensionSettings[SETTINGS_KEY] = structuredClone(namespace);
  const emit = () => { for (const handler of [...handlers]) handler(); };
  const adapter = createSillyTavernSettingsAdapter({ getContext: () => state.context,
    saveHost: async () => {
      state.saves++;
      if (save) await save(state);
      else state.disk = structuredClone(state.context.extensionSettings[SETTINGS_KEY]);
      emit();
    },
    readServerNamespace: async () => read ? await read(state) : structuredClone(state.disk),
  });
  return Object.freeze({ ...adapter,
    external(value) {
      state.disk = structuredClone(value);
      if (value === undefined) delete state.context.extensionSettings[SETTINGS_KEY];
      else state.context.extensionSettings[SETTINGS_KEY] = structuredClone(value);
      emit();
    },
    state,
    listenerCount: () => handlers.size,
    emitUnrelatedSave: emit,
  });
}
