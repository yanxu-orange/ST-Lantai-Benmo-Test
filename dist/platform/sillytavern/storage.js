import { createTargetGuard } from '../../shared/runtime/identity.js';

const KEY = 'lantai_benmo_runtime_probe';

// Writes only a dedicated ephemeral key and restores it. The host object is
// reacquired for every write; no chatMetadata reference survives an await.
export async function probeGlobalSettings(getContext) {
  const context = getContext();
  if (!context?.extensionSettings || typeof context.saveSettingsDebounced !== 'function') {
    return { status: 'unavailable' };
  }
  const settings = context.extensionSettings;
  const had = Object.hasOwn(settings, KEY);
  const previous = settings[KEY];
  const marker = { probe: true, nonce: Math.random().toString(36).slice(2) };
  try {
    settings[KEY] = marker;
    context.saveSettingsDebounced();
    if (settings[KEY] !== marker) throw new Error('readback failed');
    return { status: 'memory-readback-save-called' };
  } finally {
    if (had) settings[KEY] = previous;
    else delete settings[KEY];
    context.saveSettingsDebounced();
  }
}

export async function probeChatMetadata(getContext) {
  const guard = createTargetGuard(getContext);
  if (!guard.identity) return { status: 'unavailable', reason: 'chat identity absent' };
  const initial = getContext();
  const save = initial?.saveMetadata ?? initial?.saveMetadataDebounced;
  if (!initial?.chatMetadata || typeof save !== 'function') {
    return { status: 'unavailable', reason: 'metadata save absent' };
  }
  const had = Object.hasOwn(initial.chatMetadata, KEY);
  const previous = initial.chatMetadata[KEY];
  const marker = { probe: true, nonce: Math.random().toString(36).slice(2) };
  if (!guard.isCurrent()) return { status: 'stale' };
  const current = getContext();
  current.chatMetadata[KEY] = marker;
  try {
    await (current.saveMetadata ?? current.saveMetadataDebounced).call(current);
    if (!guard.isCurrent()) return { status: 'stale', reason: 'chat changed during save' };
    if (getContext().chatMetadata[KEY] !== marker) {
      throw new Error('metadata readback failed');
    }
    return { status: 'memory-readback-save-called' };
  } finally {
    // Never restore into another chat. A changed target requires manual
    // inspection of the harmless probe key in the original chat.
    if (guard.isCurrent()) {
      const fresh = getContext();
      if (had) fresh.chatMetadata[KEY] = previous;
      else delete fresh.chatMetadata[KEY];
      await (fresh.saveMetadata ?? fresh.saveMetadataDebounced).call(fresh);
    }
  }
}
