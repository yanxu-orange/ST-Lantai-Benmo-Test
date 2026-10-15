import {storedSourceMessages,sourceFingerprint,assertStoredSourceMessages} from '../summary/source.js';
import {migrateTimeSources} from '../time/persistence.js';
// Older event batches also owned a selected-but-unsent trailing user turn.
// Convert only intact envelopes; keep exclusions and holes inside the actual
// range, and leave malformed evidence for normal validation to reject.
function trimSummaryTail(source) {
  const requested=source?.requestedRange,actual=source?.actualRange,rows=source?.rawMessages;
  if(!requested||!actual||actual.start!==requested.start||!Number.isSafeInteger(actual.start)||actual.start<0||!Number.isSafeInteger(actual.end)||actual.end<actual.start||!Number.isSafeInteger(requested.end)||requested.end<=actual.end||!Array.isArray(rows)||rows.length!==requested.end-requested.start+1||rows.some((row,index)=>row.floor!==requested.start+index)||!Array.isArray(source.sentFloors)||source.sentFloors.some(row=>row.floor<actual.start||row.floor>actual.end)||source.fingerprint!==sourceFingerprint(rows))return false;
  assertStoredSourceMessages(rows);assertStoredSourceMessages(source.sentFloors);
  source.requestedRange={...actual};
  source.rawMessages=rows.filter(row=>row.floor<=actual.end);
  source.sentFloors=source.sentFloors.filter(row=>row.floor>=actual.start&&row.floor<=actual.end);
  if(Array.isArray(source.excludedFloors))source.excludedFloors=source.excludedFloors.filter(row=>row.floor>=actual.start&&row.floor<=actual.end);
  if(Array.isArray(source.replyIds))source.replyIds=source.replyIds.filter(row=>row.floor>=actual.start&&row.floor<=actual.end);
  source.fingerprint=sourceFingerprint(source.rawMessages);
  return true;
}
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
  for(const batch of root.summary?.batches??[]){
    const oldRows=batch.sourceSnapshot?.rawMessages;
    if(JSON.stringify(batch.requestedRange)===JSON.stringify(batch.sourceSnapshot?.requestedRange)&&JSON.stringify(batch.actualRange)===JSON.stringify(batch.sourceSnapshot?.actualRange)&&trimSummaryTail(batch.sourceSnapshot)){
      batch.requestedRange={...batch.actualRange};
      const positions=root.summary.sourcePositions?.[batch.id];
      if(Array.isArray(positions)&&positions.length===oldRows.length)root.summary.sourcePositions[batch.id]=positions.filter((_,index)=>oldRows[index].floor<=batch.actualRange.end);
    }
  }
  if(root.summary?.pending)trimSummaryTail(root.summary.pending.sourceSnapshot);
  const tracking=root.tracking;
  // Old tail-history guards used the selected end too. Only rewrite a boundary
  // proven by its retained snapshot; never reconstruct lost history.
  const oldEnds=new Map((tracking?.snapshots??[]).map(row=>[row.id,row.sourceSnapshot.requestedRange?.end??row.sourceSnapshot.assistantFloor]));
  const trimmed=new Set();
  for(const row of tracking?.snapshots??[])if(row.sourceSnapshot.kind==='batch'&&trimSummaryTail(row.sourceSnapshot))trimmed.add(row.id);
  for(const checkpoint of tracking?.tailHistory?.checkpoints??[]){
    if(!oldEnds.has(checkpoint.snapshotId)||![...trimmed].some(id=>oldEnds.get(id)===checkpoint.throughFloor))continue;
    checkpoint.throughFloor=Math.max(...tracking.snapshots.filter(row=>oldEnds.get(row.id)<=checkpoint.throughFloor).map(row=>row.sourceSnapshot.actualRange?.end??row.sourceSnapshot.assistantFloor));
  }
  if(root.time)migrateTimeSources(root.time);
  if(root.tracking)delete root.tracking.rollbackUnavailable;
  for(const record of root.latest?.records??[])delete record.stale;
  return root;
}
