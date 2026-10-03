import { getSillyTavernContext, detectCapabilities } from '../platform/sillytavern/context.js';
import { PROBE_EVENT_NAMES, subscribeHostEvents } from '../platform/sillytavern/events.js';
import { probeGlobalSettings, probeChatMetadata } from '../platform/sillytavern/storage.js';
import { createPromptProbe } from '../platform/sillytavern/prompt.js';
import { readChatIdentity } from '../shared/runtime/identity.js';
import { createGuardedTask } from '../shared/runtime/task.js';

const MAX_EVENTS = 100;
const SCENARIOS = new Set(['normal', 'streaming', 'non-streaming', 'regenerate', 'swipe', 'continue', 'stopped', 'aborted', 'quiet', 'chat-switch']);

export function createRuntimeProbe(host = globalThis.SillyTavern) {
  const getContext = () => getSillyTavernContext(host);
  const prompt = createPromptProbe(getContext);
  let subscription = null;
  let entries = [];
  let disposed = false;
  const record = (entry) => {
    entries.push(entry);
    if (entries.length > MAX_EVENTS) entries = entries.slice(-MAX_EVENTS);
  };

  return Object.freeze({
    snapshot() {
      const context = getContext();
      return {
        at: new Date().toISOString(),
        extension: disposed ? 'disposed' : 'started',
        capabilities: detectCapabilities(context),
        identity: readChatIdentity(context),
        eventAvailability: Object.fromEntries(PROBE_EVENT_NAMES.map(
          name => [name, Boolean(context?.eventTypes?.[name])],
        )),
        events: entries.map(entry => ({ ...entry })),
        traceActive: Boolean(subscription),
        note: 'Host facts require manual runs on SillyTavern 1.18.x and latest stable.',
      };
    },
    markScenario(name) {
      if (!SCENARIOS.has(name)) return { status: 'invalid-scenario' };
      if (!subscription) return { status: 'trace-inactive' };
      record({ scenario: name, at: new Date().toISOString() });
      return { status: 'marked' };
    },
    startTrace() {
      if (disposed) return { status: 'disposed' };
      subscription?.dispose();
      entries = [];
      const result = subscribeHostEvents(getContext(), record);
      subscription = result.status === 'available' ? result : null;
      return { status: result.status, eventCount: result.observed.length };
    },
    stopTrace() {
      subscription?.dispose();
      subscription = null;
      return entries.map(entry => ({ ...entry }));
    },
    async testSettings() {
      if (disposed) return { status: 'disposed' };
      return probeGlobalSettings(getContext);
    },
    async testChatMetadata() {
      if (disposed) return { status: 'disposed' };
      return probeChatMetadata(getContext);
    },
    testPromptClear() {
      if (disposed) return { status: 'disposed' };
      let set;
      let clear;
      try {
        set = prompt.setTemporary();
      } finally {
        clear = prompt.clear();
      }
      return { status: clear.status === 'cleared' && set?.status === 'set' ? 'cleared' : 'unavailable' };
    },
    async testStaleGuard() {
      if (disposed) return { status: 'disposed' };
      const task = createGuardedTask(getContext);
      let committed = false;
      const result = await task.run(async () => {
        await Promise.resolve();
        return true;
      }, () => { committed = true; });
      return { ...result, committed };
    },
    async testDelayedTargetGuard(delayMs = 5000) {
      if (disposed) return { status: 'disposed' };
      const task = createGuardedTask(getContext);
      let committed = false;
      const result = await task.run(
        () => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(delayMs, 30000)))),
        () => { committed = true; },
      );
      return { ...result, committed };
    },
    async testQuietGeneration() {
      if (disposed) return { status: 'disposed' };
      const context = getContext();
      if (typeof context?.generateQuietPrompt !== 'function') {
        return { status: 'unavailable' };
      }
      const task = createGuardedTask(getContext);
      try {
        // Deliberately discard generated text: no chat content or provider
        // response enters probe logs. User must invoke this method manually.
        const result = await task.run(
          () => context.generateQuietPrompt({ quietPrompt: 'Reply with the single word OK.' }),
          () => {},
        );
        return { status: result.status, taskId: result.taskId };
      } catch (error) {
        return { status: 'failed', errorName: error?.name ?? 'Error' };
      }
    },
    secretCapability() {
      return {
        status: detectCapabilities(getContext()).secrets ? 'available-unverified' : 'unavailable',
        reason: 'Secret write/use/delete requires a disposable credential and explicit host gate.',
      };
    },
    dispose() {
      if (disposed) return;
      subscription?.dispose();
      subscription = null;
      prompt.clear();
      disposed = true;
    },
  });
}
