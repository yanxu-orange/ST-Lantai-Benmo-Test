import {summaryOf} from './data.js';
import {effectiveBatchPositions} from './source-positions.js';

// Deletion evidence comes from retained host objects, never from a shorter
// transcript, edited text, an event payload (ST supplies length), or a range.
export function locateDeletedMessages(before,after) {
  if(!Array.isArray(before)||!Array.isArray(after)||after.length>=before.length)return null;
  const indices=new Map(before.map((message,index)=>[message,index]));
  if(indices.size!==before.length||new Set(after).size!==after.length)return null;
  let previous=-1;const floorMap=[];
  for(let floor=0;floor<after.length;floor++){
    const old=indices.get(after[floor]);if(old===undefined||old<=previous)return null;
    floorMap.push([old,floor]);previous=old;
  }
  const kept=new Set(floorMap.map(([floor])=>floor));
  return {removedFloors:before.map((_,floor)=>floor).filter(floor=>!kept.has(floor)),floorMap};
}
export function affectedSummaryDeletion(root,deletion) {
  const summary=summaryOf(root),removed=new Set(deletion.removedFloors),before=new Map(deletion.before.messages.map(message=>[message.floor,message]));
  const normal=new Map(),merged=new Map(),batchIds=[],unresolved=[];
  for(const batch of summary.batches){
    const positions=effectiveBatchPositions(batch,summary);
    let affected=false;
    for(let index=0;index<positions.length;index++){
      const position=positions[index];if(!position)continue;
      const actual=before.get(position.floor),original=batch.sourceSnapshot.rawMessages[index];
      if(!actual||actual.identity!==position.identity){unresolved.push(batch.id);continue;}
      // requestedRange may contain an unsummarized trailing user message.
      if(removed.has(position.floor)&&original.floor<=batch.actualRange.end)affected=true;
    }
    if(!affected)continue;
    batchIds.push(batch.id);
    for(const id of batch.eventIds){
      const member=root.events.find(event=>event.id===id);if(!member)continue;
      const active=member.supersededBy?root.events.find(event=>event.id===member.supersededBy):member;
      if(!active||active.supersededBy)continue;
      (active.mergedFrom?merged:normal).set(active.id,structuredClone(active));
    }
  }
  if(summary.excludedFloors.some(record=>record.identity!==null&&before.get(record.floor)?.identity!==record.identity))unresolved.push('excluded-floor');
  return {normal:[...normal.values()],merged:[...merged.values()],batchIds,unresolved:[...new Set(unresolved)]};
}
