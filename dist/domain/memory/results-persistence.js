import {storedSourceMessages,sourceFingerprint} from '../summary/source.js';
import {migrateTimeSources} from '../time/persistence.js';
// Operates only on an owned root copy. Reading never writes the host chat.
export function normalizeResultSources(root) {
  const narrative=root.narrative;
  if(narrative){
    const progress=value=>{if(!value)return;value.sourceSnapshot={requestedRange:{...value.sourceSnapshot.requestedRange}};delete value.memorySnapshot;};
    for(const kind of ['self','outline']){
      progress(narrative.progress?.[kind]);
      const latest=narrative.latestGeneration?.[kind];
      if(latest){latest.sourceSnapshot={requestedRange:{...latest.sourceSnapshot.requestedRange}};progress(latest.baseline.progress);}
      progress(narrative.pendingRun?.review?.progress?.[kind]);
      const binding=narrative.pendingRun?.review?.bindings?.categories?.[kind];
      if(binding){binding.progress=null;binding.latestGeneration=null;binding.memory=null;binding.memoryIds=[];binding.readMemory=false;}
      for(const operation of narrative.rollback?.[kind]?.operations??[])if(operation.progress)delete operation.progress.memory;
    }
    if(narrative.pendingRun?.summarySnapshot)narrative.pendingRun.summarySnapshot={requestedRange:{...narrative.pendingRun.summarySnapshot.requestedRange}};
    if(narrative.pendingRun?.sentFloors)narrative.pendingRun.sentFloors=storedSourceMessages(narrative.pendingRun.sentFloors);
    delete narrative.sourcePool;delete narrative.rollbackUnavailable;
  }
  // Source envelopes are plugin-owned, never arbitrary generated result fields.
  const normalize=value=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value)normalize(item);return;}
    if(Array.isArray(value.rawMessages)&&('fingerprint'in value||'requestedRange'in value||'assistantFloor'in value)){
      const legacy=value.rawMessages.some(row=>Object.hasOwn(row,'text'))||value.sentFloors?.some(row=>Object.hasOwn(row,'text'));
      if(legacy){value.rawMessages=storedSourceMessages(value.rawMessages);
        if(Array.isArray(value.sentFloors))value.sentFloors=storedSourceMessages(value.sentFloors);
        if('fingerprint'in value)value.fingerprint=sourceFingerprint(value.rawMessages);
      }
      return;
    }
    for(const [key,item] of Object.entries(value)){
      // Outcome text and user settings are not source envelopes.
      if(['preferences','settingsEvidence','changes','record','patch','entries','results','generatedCandidates'].includes(key))continue;
      normalize(item);
    }
  };
  for(const key of ['summary','cumulative','latest','tracking','workshop'])normalize(root[key]);
  if(root.time)migrateTimeSources(root.time);
  if(root.tracking)delete root.tracking.rollbackUnavailable;
  for(const record of root.latest?.records??[])delete record.stale;
  return root;
}
