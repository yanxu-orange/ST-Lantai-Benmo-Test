import { getSillyTavernContext } from './context.js';

const CUSTOM = 'api_key_custom';
const EVENTS = ['SECRET_WRITTEN', 'SECRET_DELETED', 'SECRET_ROTATED', 'SECRET_EDITED'];

export class SecretReferenceError extends Error {
  constructor(code = 'SECRET_REFERENCES_UNAVAILABLE') {
    super(code);
    this.name = 'SecretReferenceError';
    this.code = code;
  }
}

// This projection intentionally never enumerates, clones, or reads value on a
// host record. /read can contain unmasked credentials on some installations.
function project(state) {
  const records = state?.[CUSTOM];
  if (!Array.isArray(records)) throw new SecretReferenceError();
  const ids = new Set();
  let activeCount = 0;
  const references = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new SecretReferenceError();
    const id = record.id, label = record.label, active = record.active;
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || /[\u0000-\u001f\u007f]/u.test(id)
      || typeof label !== 'string' || typeof active !== 'boolean' || ids.has(id)) throw new SecretReferenceError();
    ids.add(id);
    if (active && ++activeCount > 1) throw new SecretReferenceError();
    references.push(Object.freeze({ id, label, active }));
  }
  return references;
}

// Loading the exported in-memory state does not refresh it or invoke any Secret
// endpoint. The directory is local visibility, not cross-client freshness proof.
export async function createSillyTavernSecretReferences({ getState,
  getContext = getSillyTavernContext, eventSource, eventTypes,
  loadHostModule = () => import('/scripts/secrets.js') } = {}) {
  let available = true;
  if (getState === undefined) {
    try {
      const host = await loadHostModule();
      if (!host || !Object.hasOwn(host, 'secret_state')) throw new Error();
      getState = () => host.secret_state;
    } catch { available = false; }
  }
  if (eventSource === undefined || eventTypes === undefined) {
    try {
      const context = getContext();
      eventSource ??= context?.eventSource;
      eventTypes ??= context?.eventTypes;
    } catch { available = false; }
  }
  const remove = eventSource?.removeListener ?? eventSource?.off;
  if (typeof getState !== 'function' || typeof eventSource?.on !== 'function' || typeof remove !== 'function'
    || EVENTS.some(name => typeof eventTypes?.[name] !== 'string' || !eventTypes[name])) available = false;
  let disposed = false, epoch = 0, fingerprint = null;
  const detach = [];
  // Ignore all event arguments, including any payload containing credentials.
  const changed = () => { if (!disposed) epoch++; };
  if (available) {
    try {
      for (const name of EVENTS) {
        const type = eventTypes[name];
        eventSource.on(type, changed);
        detach.push(() => remove.call(eventSource, type, changed));
      }
    } catch {
      available = false;
      for (const release of detach.splice(0)) { try { release(); } catch { /* Capability remains unavailable. */ } }
    }
  }
  function observe() {
    let references = [], code = null;
    try {
      if (!available || disposed) throw new SecretReferenceError();
      references = project(getState());
    } catch { code = 'SECRET_REFERENCES_UNAVAILABLE'; }
    const next = code ?? JSON.stringify(references);
    if (next !== fingerprint) { fingerprint = next; epoch++; }
    return Object.freeze({ available: code === null, code, epoch, references: Object.freeze(references) });
  }
  function capture(id) {
    const snapshot = observe();
    if (!snapshot.available) throw new SecretReferenceError();
    const reference = typeof id === 'string' && snapshot.references.find(item => item.id === id);
    if (!reference) throw new SecretReferenceError('SECRET_REFERENCE_MISSING');
    return Object.freeze({ epoch: snapshot.epoch, id: reference.id, label: reference.label, active: reference.active });
  }
  return Object.freeze({
    observe,
    capture,
    matches(ticket) {
      try {
        const current = capture(ticket?.id);
        return current.epoch === ticket.epoch && current.label === ticket.label && current.active === ticket.active;
      } catch { return false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of detach.splice(0)) { try { release(); } catch { /* No host mutation fallback. */ } }
      epoch++;
    },
  });
}
