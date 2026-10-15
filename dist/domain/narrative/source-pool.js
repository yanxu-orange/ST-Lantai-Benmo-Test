// Sources have one owner in the narrative document. References carry their own
// selected range; pool entries are immutable evidence, not a current-chat cache.
import {assertNarrativeSource, resolveNarrativeSource, narrativeMemoryRefs, exact, same} from './core.js';
export {resolveNarrativeSource} from './core.js';
export function visitNarrativeSources(domain, visit) {
  const progress = value => { if (value) value.sourceSnapshot = visit(value.sourceSnapshot); };
  for (const kind of ['self', 'outline']) {
    progress(domain.progress[kind]);
    const latest = domain.latestGeneration?.[kind];
    if (latest) { latest.sourceSnapshot = visit(latest.sourceSnapshot); progress(latest.baseline.progress); }
    progress(domain.pendingRun?.review?.progress?.[kind]);
  }
  if (domain.pendingRun?.summarySnapshot) domain.pendingRun.summarySnapshot = visit(domain.pendingRun.summarySnapshot);
}
// Crossing owners is an ownership boundary: do not install caller/host aliases.
export function importNarrativeSource(owner, snapshot, from = owner) {
  return assertNarrativeSource(resolveNarrativeSource(snapshot,from));
}
export function importNarrativeProgress(owner, progress, from) {
  if (progress === null) return null;
  // Preserve field order and detach mutable metadata without cloning a legacy
  // inline prefix twice. Newly owned pool arrays are detached by the importer.
  const result = structuredClone({...progress, sourceSnapshot: null});
  result.sourceSnapshot = importNarrativeSource(owner, progress.sourceSnapshot, from);
  delete result.memorySnapshot;
  return result;
}
// Small semantic projections are used only for legacy bindings and detached
// tickets. They borrow pool arrays and never expand/clone a whole document.
export function semanticProgress(progress, owner) {
  return progress === null ? null : {...progress, sourceSnapshot: resolveNarrativeSource(progress.sourceSnapshot, owner)};
}
export function semanticLatest(latest, owner) {
  return latest == null ? latest : {...latest, sourceSnapshot: resolveNarrativeSource(latest.sourceSnapshot, owner), baseline: {...latest.baseline, progress: semanticProgress(latest.baseline.progress, owner)}};
}
export function validateNarrativePool(owner) {
  if(owner.sourcePool!==undefined&&!Array.isArray(owner.sourcePool))throw new Error('旧叙事来源池无效');
}
export function compactNarrativePool(owner) {
  visitNarrativeSources(owner,snapshot=>importNarrativeSource(owner,snapshot));
  delete owner.sourcePool;
}
// Legacy material snapshots are reduced in memory; only a normal successful save writes this form.
export function normalizeNarrativeStorage(domain) {
  const progress=value=>{if(value){value.sourceSnapshot={requestedRange:{...value.sourceSnapshot.requestedRange}};delete value.memorySnapshot;}};
  for(const kind of ['self','outline']){
    progress(domain.progress?.[kind]);
    const latest=domain.latestGeneration?.[kind];
    if(latest){latest.sourceSnapshot={requestedRange:{...latest.sourceSnapshot.requestedRange}};progress(latest.baseline?.progress);}
    progress(domain.pendingRun?.review?.progress?.[kind]);
    const binding=domain.pendingRun?.review?.bindings?.categories?.[kind];
    if(binding){binding.progress=null;binding.latestGeneration=null;binding.memory=null;binding.memoryIds=[];binding.readMemory=false;}
    for(const operation of domain.rollback?.[kind]?.operations??[])if(operation.progress)delete operation.progress.memory;
  }
  if(domain.pendingRun?.summarySnapshot)domain.pendingRun.summarySnapshot={requestedRange:{...domain.pendingRun.summarySnapshot.requestedRange}};
  delete domain.sourcePool;delete domain.rollbackUnavailable;
  return domain;
}
