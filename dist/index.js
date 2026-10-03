import { createRuntimeProbe } from './probe/runtime-probe.js';
import { createMemoryHost } from './platform/sillytavern/memory-host.js';

const NAME = 'LantaiRuntimeProbe';
let probe;
let memoryHost;

function activate() {
  unload();
  probe = createRuntimeProbe();
  globalThis[NAME] = probe;
  memoryHost = createMemoryHost();
  globalThis.addEventListener?.('beforeunload', unload, { once: true });
}

function unload() {
  memoryHost?.dispose();
  memoryHost = undefined;
  probe?.dispose();
  if (globalThis[NAME] === probe) delete globalThis[NAME];
  globalThis.removeEventListener?.('beforeunload', unload);
  probe = undefined;
}

activate();

// Diagnostic entry in the browser console: LantaiRuntimeProbe.snapshot()
// The probe performs no writes or model calls on startup.
export { probe, unload };
export function onEnable() { activate(); }
export function onDisable() { unload(); }
export function onDelete() { unload(); }
