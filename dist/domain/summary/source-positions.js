import {assertRawSummarySource,sourceFingerprint} from './source.js';

const copy=value=>structuredClone(value);
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const fail=()=>{throw new Error('删除前后来源位置无法可靠确认，请重新查看');};

// The ledger and cards retain their original evidence. Only this optional overlay
// follows a proven host deletion; null is deleted or unlinked, never a reused
// floor and never proof for deleting a memory. The proposal reports unlinking.
export function effectiveBatchPositions(batch,summary) {
  return copy(Object.hasOwn(summary.sourcePositions??{},batch.id)?summary.sourcePositions[batch.id]:batch.sourceSnapshot.rawMessages.map(({floor,identity})=>({floor,identity})));
}

export function effectiveBatchRanges(batch,summary) {
  const positions=effectiveBatchPositions(batch,summary);
  if(!positions.length||positions.some(position=>position===null))return null;
  const actualEnd=batch.sourceSnapshot.rawMessages.findIndex(message=>message.floor===batch.actualRange.end);
  if(actualEnd<0||positions.some((position,index)=>index&&position.floor!==positions[index-1].floor+1))return null;
  return {requestedRange:{start:positions[0].floor,end:positions.at(-1).floor},actualRange:{start:positions[0].floor,end:positions[actualEnd].floor}};
}

export function positionedSummarySnapshot(batch,summary) {
  const ranges=effectiveBatchRanges(batch,summary);if(!ranges)return null;
  const positions=effectiveBatchPositions(batch,summary),source=copy(batch.sourceSnapshot);
  const byFloor=new Map(source.rawMessages.map((message,index)=>[message.floor,positions[index]]));
  source.rawMessages=source.rawMessages.map(message=>({...message,...byFloor.get(message.floor)}));
  source.sentFloors=source.sentFloors.map(message=>({...message,...byFloor.get(message.floor)}));
  source.excludedFloors=source.excludedFloors.map(record=>byFloor.has(record.floor)?{...record,...byFloor.get(record.floor)}:record);
  return {...source,...ranges,fingerprint:sourceFingerprint(source.rawMessages)};
}

function deletionMapping(deletion) {
  const before=assertRawSummarySource(deletion?.before),after=assertRawSummarySource(deletion?.after);
  const removed=deletion?.removedFloors,pairs=deletion?.floorMap;
  if(!Array.isArray(removed)||!removed.length||removed.some((floor,index)=>!Number.isSafeInteger(floor)||floor<0||index&&floor<=removed[index-1])||!Array.isArray(pairs))fail();
  if(before.messages.some((message,index)=>message.floor!==index)||after.messages.some((message,index)=>message.floor!==index)||removed.at(-1)>=before.messages.length||before.messages.length-removed.length!==after.messages.length)fail();
  const deleted=new Set(removed),survivors=before.messages.filter(message=>!deleted.has(message.floor));
  if(pairs.length!==survivors.length)fail();
  // The host proves object continuity. This check also rejects reordered maps,
  // invented deletions and concurrent durable source changes before rebasing.
  const evidence=({role,system,text,date,swipeId=null})=>({role,system,text,date,swipeId});
  for(let index=0;index<survivors.length;index++)if(!same(pairs[index],[survivors[index].floor,index])||!same(evidence(survivors[index]),evidence(after.messages[index])))fail();
  return {before,after,removed,deleted,map:new Map(pairs)};
}

export function rebaseSummaryPositions(root,deletion) {
  const {before,after,removed,deleted,map}=deletionMapping(deletion);
  if(root.summary===undefined)return root;
  const summary=root.summary,sourcePositions={...(summary.sourcePositions??{})};
  const move=position=>{
    if(position===null)return null;
    const message=before.messages[position.floor];
    if(!message||message.identity!==position.identity)return null;
    if(deleted.has(position.floor))return null;
    const current=after.messages[map.get(position.floor)];if(!current)fail();
    return {floor:current.floor,identity:current.identity};
  };
  for(const batch of summary.batches){
    const previous=effectiveBatchPositions(batch,summary),next=previous.map(move);
    if(!same(previous,next))Object.defineProperty(sourcePositions,batch.id,{value:next,enumerable:true,configurable:true,writable:true});
  }
  // Starts are insertion boundaries; completed/end floors are inclusive.
  const start=floor=>floor-removed.filter(deletedFloor=>deletedFloor<floor).length;
  const end=floor=>floor-removed.filter(deletedFloor=>deletedFloor<=floor).length;
  const preferences=copy(summary.preferences);
  const oldManual=preferences.manual;
  preferences.manual={...oldManual,startFloor:start(oldManual.startFloor),endFloor:oldManual.endFloor===null?null:end(oldManual.endFloor)};
  if(preferences.manual.endFloor!==null&&preferences.manual.endFloor<preferences.manual.startFloor)preferences.manual.endFloor=null;
  preferences.auto.startFloor=start(preferences.auto.startFloor);
  const last=summary.progress.lastProcessedFloor===null?null:end(summary.progress.lastProcessedFloor);
  const progress={...summary.progress,startFloor:start(summary.progress.startFloor),lastProcessedFloor:last===null||last<0?null:last};
  const excludedFloors=summary.excludedFloors.flatMap(record=>{
    const message=before.messages[record.floor];
    if(!message)return record.identity===null?[{...record,floor:start(record.floor)}]:[];
    if(record.identity!==null&&record.identity!==message.identity)return [];
    const moved=move({floor:record.floor,identity:message.identity});return moved?[moved]:[];
  });
  const next={...summary,preferences,progress,excludedFloors,...(Object.keys(sourcePositions).length?{sourcePositions}:{})};
  return same(summary,next)?root:{...root,summary:next};
}
