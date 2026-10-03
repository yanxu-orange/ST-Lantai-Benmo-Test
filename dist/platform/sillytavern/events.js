export const PROBE_EVENT_NAMES = Object.freeze([
  'CHAT_CHANGED', 'CHAT_CREATED', 'MESSAGE_SENT', 'GENERATION_STARTED',
  'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
  'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED',
  'IMPERSONATE_READY',
]);

export function subscribeHostEvents(context, record, names = PROBE_EVENT_NAMES) {
  const source = context?.eventSource;
  const off = source?.removeListener ?? source?.off;
  if (!source || typeof source.on !== 'function' || typeof off !== 'function') {
    return { status: 'unavailable', observed: [], dispose() {} };
  }
  const registered = [];
  for (const name of names) {
    const type = context.eventTypes?.[name];
    if (!type) continue;
    const handler = () => record({ event: name, at: new Date().toISOString() });
    source.on(type, handler);
    registered.push([type, handler]);
  }
  let disposed = false;
  return {
    status: 'available',
    observed: registered.map(([type]) => type),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [type, handler] of registered) off.call(source, type, handler);
    },
  };
}
