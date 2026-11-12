import {createMemoryDiagnostics, eventResultReference, cumulativeResultReference} from '../../domain/memory/diagnostics.js';
import {matchesStoredSummarySource} from '../../domain/summary/source.js';
import {matchesStoredCumulativeSource} from '../../domain/cumulative/source.js';
import {cumulativeGenerationSupported} from './cumulative-runtime.js';
import {latestSourceMetadata} from './latest-source-metadata.js';

export function createHostMemoryDiagnostics({version, document, getTarget} = {}) {
  if (!/-test\./.test(version)) return null;
  try {
    const storage = document.defaultView?.localStorage;
    return storage ? createMemoryDiagnostics({storage, getTarget}) : null;
  } catch {
    return null;
  }
}

export function startSendDiagnostic(diagnostics, target, args, getContext) {
  try {
    const [messages,,,type = 'normal'] = args;
    if (!diagnostics?.enabled(target) || !cumulativeGenerationSupported(messages, type)) return null;
    const chat = getContext().chat;
    const floor = Array.isArray(chat) && chat.length ? chat.length - 1 : null;
    const anchor = floor === null ? null : chat[floor];
    const reply = anchor && !anchor.is_user && !anchor.is_system ? anchor : null;
    const update = diagnostics.startSend(target, {
      floor, swipeId: reply?.swipe_id ?? null,
      replyId: reply ? latestSourceMetadata(reply).replyId : null, type, status:'preparing'
    });
    return update && (fields => { try { update(fields); } catch { /* display only */ } });
  } catch {
    return null;
  }
}

export function inspectDiagnosticMaterials({row, attempts=[], root, readSource}) {
  const event = row.kind === 'event';
  const related = row.attemptGroup ? attempts.filter(item=>item.kind===row.kind&&item.batchId===row.batchId&&item.attemptGroup===row.attemptGroup) : [];
  const matchingTask = batch => batch.taskId.endsWith(':'+row.taskId) || related.some(item=>item.continuation&&batch.taskId.endsWith(':'+item.taskId)
    && row.results.length && row.results.every(ref=>batch.eventIds.includes(ref.id)));
  const owner = event ? root.summary?.batches.find(batch => batch.id === row.batchId && matchingTask(batch))
    : root.cumulative?.versions.find(version => version.taskId === row.taskId && row.results.some(result => result.id === version.id));
  const records = event ? root.events : root.cumulative?.versions ?? [];
  const results = row.results.map(ref => {
    const value = records.find(item => item.id === ref.id);
    if (!value) return {...ref, status:'deleted'};
    const live = (event ? eventResultReference : cumulativeResultReference)(value);
    return {...ref, status:live.fingerprint === ref.fingerprint ? 'matching' : 'changed', title:value.title, body:value.body};
  });
  const savedSource = owner?.sourceSnapshot;
  const recordedFloors = new Set([row,...related].flatMap(attempt=>attempt.stages.flatMap(item=>item.sentFloors)));
  let source = [], sourceStatus = 'unknown';
  if (savedSource && recordedFloors.size) {
    try {
      const current = readSource(savedSource.requestedRange);
      const matches = event ? matchesStoredSummarySource : matchesStoredCumulativeSource;
      if (matches(savedSource, current)) {
        source = current.messages.filter(item => recordedFloors.has(item.floor)).map(({floor, role, text}) => ({floor, role, text}));
        // The existing locator proves ownership, not unchanged text or the
        // historical cleaned request. This is only a live source comparison.
        sourceStatus = 'current';
      } else sourceStatus = 'changed';
    } catch { sourceStatus = 'unavailable'; }
  }
  return {source, sourceStatus, results};
}
