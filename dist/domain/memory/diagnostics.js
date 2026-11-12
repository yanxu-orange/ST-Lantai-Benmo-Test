import {sameTarget} from './repository.js';
import {SUMMARY_PROMPT_GROUPS, migrateSummaryPromptOverrides} from '../../shared/settings/summary-prompts.js';
import {CUMULATIVE_PROMPT_FIELDS} from '../../shared/settings/cumulative-prompts.js';

const limit = { sends: 200, summaries: 50 };
const maxChars = 350_000;
const token = value => typeof value === 'string' && value.length <= 256 ? value : null;
const floor = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ids = values => Array.isArray(values) ? values.map(token).filter(Boolean) : [];
const decision = value => /^[a-z][a-z0-9-]{0,62}$/.test(value ?? '') ? value : null;
const modelId = value => typeof value==='string' && /^[a-z0-9][a-z0-9._:/@+-]{0,127}$/i.test(value) && !value.includes('://') ? value : null;
const stageNames = new Set(['fast','qualitySummary','qualityIndexes','enhancedSummary','enhancedKeywords','aliases','summary']);
const pending = new Set(['preparing','selected','running','awaiting-user','committing']);

// Fingerprints identify generated results and static prompt instructions only.
export function diagnosticFingerprint(parts) {
  let hash = 2166136261;
  for (const char of JSON.stringify(parts)) {
    hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  }
  return 'v1-' + (hash >>> 0).toString(16).padStart(8, '0');
}

export function summaryPromptVersion(request, {kind, overrides = {}} = {}) {
  const effective = kind === 'event' ? migrateSummaryPromptOverrides(overrides) : overrides;
  const templates = kind === 'event' ? Object.values(SUMMARY_PROMPT_GROUPS).flat().flatMap(group=>group.items) : CUMULATIVE_PROMPT_FIELDS;
  const unboundTracking = effective.informationTracking ?? templates.find(item=>item.key==='informationTracking')?.defaultText;
  return diagnosticFingerprint(request.previewParts
    .filter(part => part.role === 'system' && part.name !== '本次信息追踪启用范围')
    .map(({key, content}) => [key, key==='informationTracking'&&unboundTracking!==undefined ? unboundTracking : content]));
}

export function eventResultReference(event) {
  return {id: event.id, fingerprint: diagnosticFingerprint([event.title, event.body,event.startTime,event.endTime,event.people,event.places])};
}

export function cumulativeResultReference(version) {
  return {id: version.id, fingerprint: diagnosticFingerprint([version.body,version.startTime,version.endTime])};
}

const empty = () => ({enabled: false, generation: null, sends: [], summaries: []});
const range = value => {
  const start = floor(value?.start), end = floor(value?.end);
  return start !== null && end !== null && start <= end ? {start, end} : null;
};
const resultReference = item => token(item?.id) ? {id: item.id, fingerprint: token(item.fingerprint)} : null;
const stage = item => ({
  name: stageNames.has(item?.name) ? item.name : null, startedAt: token(item?.startedAt), status: decision(item?.status),
  requestedModel: modelId(item?.requestedModel), reportedModel: modelId(item?.reportedModel), promptVersion: token(item?.promptVersion),
  sentFloors: Array.isArray(item?.sentFloors) ? item.sentFloors.map(floor).filter(value => value !== null) : []
});
const summary = item => ({
  id: token(item.id), kind: item.kind === 'event' ? 'event' : 'cumulative',
  taskId: token(item.taskId), attempt: floor(item.attempt), status: decision(item.status),
  attemptGroup: token(item.attemptGroup), continuation: item.continuation===true,
  requestedRange: range(item.requestedRange), startedAt: token(item.startedAt), endedAt: token(item.endedAt),
  origin: decision(item.origin), previousVersionId: token(item.previousVersionId), batchId: token(item.batchId),
  stages: Array.isArray(item.stages) ? item.stages.slice(0, 3).map(stage) : [],
  results: Array.isArray(item.results) ? item.results.map(resultReference).filter(Boolean) : []
});
const candidate = item => ({
  id: token(item?.id), rank: floor(item?.rank), reasons: ids(item?.reasons).filter(decision),
  channels: ids(item?.channels).filter(decision), excludedReason: decision(item?.excludedReason)
});
const send = item => ({
  id: token(item.id), floor: floor(item.floor), swipeId: floor(item.swipeId), replyId: token(item.replyId), type: decision(item.type),
  startedAt: token(item.startedAt), status: decision(item.status),
  candidates: Array.isArray(item.candidates) ? item.candidates.slice(0, 80).map(candidate).filter(row => row.id) : [],
  candidateCount: floor(item.candidateCount), selected: ids(item.selected), adopted: ids(item.adopted),
  cumulativeInjection: item.cumulativeInjection ? {
    versionId: token(item.cumulativeInjection.versionId), status: decision(item.cumulativeInjection.status)
  } : null
});
const normalizers = { summaries: summary, sends: send };
const storageKey = target => typeof target?.chatId === 'string' && typeof target?.rootId === 'string'
  ? 'lantai.diagnostics.v1:' + JSON.stringify([target.chatId, target.rootId]) : null;

export function createMemoryDiagnostics({storage, getTarget, now = () => new Date().toISOString(),
  uuid = () => globalThis.crypto.randomUUID()} = {}) {
  const listeners = new Set(), active = new Map();
  let disposed = false, error = false, notificationPending = false;
  function notify() {
    if (notificationPending) return;
    notificationPending = true;
    queueMicrotask(() => {
      notificationPending = false;
      if (!disposed) for (const listener of listeners) try { listener(); } catch { /* display only */ }
    });
  }
  function read(key) {
    if (!key || disposed) return empty();
    try {
      const value = JSON.parse(storage.getItem(key) ?? 'null');
      if (!value || typeof value.generation !== 'string') return empty();
      return {
        enabled: value.enabled === true,
        generation: value.generation,
        ...Object.fromEntries(Object.keys(limit).map(kind => [
          kind, Array.isArray(value[kind]) ? value[kind].slice(-limit[kind]).filter(item => item && token(item.id)).map(normalizers[kind]) : []
        ]))
      };
    } catch {
      error = true;
      return empty();
    }
  }
  function write(key, value) {
    if (!key || disposed) return false;
    try {
      let json = JSON.stringify(value);
      while (json.length > maxChars && (value.sends.length || value.summaries.length)) {
        const kind = !value.summaries.length || value.sends[0]?.startedAt <= value.summaries[0]?.startedAt
          ? 'sends' : 'summaries';
        value[kind].shift();
        json = JSON.stringify(value);
      }
      storage.setItem(key, json);
      error = false;
      return true;
    } catch {
      error = true;
      return false;
    } finally {
      notify();
    }
  }
  function isCurrent(target) {
    try { return sameTarget(target, getTarget()); } catch { return false; }
  }
  function start(target, kind, initial) {
    const key = storageKey(target), bucket = read(key);
    if (!bucket.enabled || !isCurrent(target)) return null;
    const previous = kind==='summaries' && initial.continuation
      ? bucket.summaries.findLast(item=>item.kind===initial.kind&&item.batchId===initial.batchId&&item.attemptGroup===initial.attemptGroup) : null;
    const attempt = previous ? (previous.attempt??0)+1 : initial.attempt;
    const id = uuid(), row = normalizers[kind]({...initial, id, attempt, attemptGroup:initial.attemptGroup??initial.taskId, startedAt: now()});
    bucket[kind].push(row);
    bucket[kind] = bucket[kind].slice(-limit[kind]);
    if (!write(key, bucket)) return null;
    const {generation} = bucket;
    if (pending.has(row.status)) active.set(id,target);
    return patch => {
      if (patch.status && !pending.has(patch.status)) active.delete(id);
      if (!isCurrent(target)) return false;
      const latest = read(key);
      if (!latest.enabled || latest.generation !== generation) return false;
      const index = latest[kind].findIndex(item => item.id === id);
      if (index < 0) return false;
      latest[kind][index] = normalizers[kind]({...latest[kind][index], ...patch, id});
      return write(key, latest);
    };
  }
  return Object.freeze({
    inspect(target) {
      const {enabled, summaries, sends} = read(storageKey(target));
      const project = row => pending.has(row.status) && !sameTarget(active.get(row.id),target) ? {...row,status:'unconfirmed'} : row;
      return {enabled, summaries:summaries.map(project), sends:sends.map(project), error};
    },
    enabled(target) { return isCurrent(target) && read(storageKey(target)).enabled; },
    setEnabled(target, enabled) {
      const key = storageKey(target);
      if (!key || !isCurrent(target)) return false;
      const current = read(key);
      return write(key, {...current, enabled: enabled === true, generation: uuid()});
    },
    clear(target) {
      const key = storageKey(target);
      if (!key || !isCurrent(target)) return false;
      return write(key, {...empty(), enabled: read(key).enabled, generation: uuid()});
    },
    startSummary: (target, initial) => start(target, 'summaries', initial),
    startSend: (target, initial) => start(target, 'sends', initial),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; listeners.clear(); active.clear(); }
  });
}

export function exportMemoryDiagnostics(snapshot, start, end) {
  const requested = range({start, end});
  if (!requested) return null;
  const overlaps = row => row.requestedRange && row.requestedRange.start <= end && row.requestedRange.end >= start;
  return {
    formatVersion: 1, range: requested,
    summaries: snapshot.summaries.filter(overlaps),
    sends: snapshot.sends.filter(row => row.floor !== null && row.floor >= start && row.floor <= end)
  };
}

export function beginSummaryDiagnostics(diagnostics, kind, ctx, {continuationId=null}={}) {
  try {
    const {snapshot} = ctx;
    const update = diagnostics?.startSummary(ctx.target, {
      kind, taskId: snapshot.operationId, attempt: ctx.attempt, status: 'running',
      attemptGroup:continuationId??snapshot.operationId, continuation:!!continuationId,
      requestedRange: snapshot.source.requestedRange, origin: snapshot.origin,
      previousVersionId: snapshot.baseSnapshot?.versionId, batchId: snapshot.batchId
    });
    if (!update) return null;
    const stages = [];
    const record = fields => { try { update(fields); } catch { /* optional observation */ } };
    return {
      stage(name, request, hasOriginalInput) {
        const entry = {name, startedAt: new Date().toISOString(), status: 'prepared'};
        stages.push(entry);
        record({stages});
        return {
          onDispatch({model}) {
            entry.requestedModel = model;
            entry.sentFloors = hasOriginalInput ? snapshot.source.sentFloors.map(row => row.floor) : [];
            const overrides=(kind==='event' ? snapshot.settings : snapshot.settings.generation).promptOverrides;
            entry.promptVersion = summaryPromptVersion(request,{kind,overrides});
            entry.status = 'dispatched';
            record({stages});
          },
          onResponseModel(model) { entry.reportedModel=model; record({stages}); },
          end(status) { entry.status = status; record({stages}); }
        };
      },
      results(values) {
        try { record({results: values.map(kind === 'event' ? eventResultReference : cumulativeResultReference)}); }
        catch { /* optional observation */ }
      },
      status(value) {
        record({status: value, endedAt: pending.has(value) ? null : new Date().toISOString()});
      }
    };
  } catch {
    return null;
  }
}
