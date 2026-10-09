import {summaryOf} from '../summary/data.js';
import {assertRawSummarySource,matchesStoredSummarySource} from '../summary/source.js';
import {positionedSummarySnapshot} from '../summary/source-positions.js';
import {cumulativeOf} from '../cumulative/data.js';
import {matchesStoredCumulativeSource} from '../cumulative/source.js';

const assistant=message=>message?.role==='assistant'&&!message.system;
const sameMessage=(left,right)=>['floor','identity','role','system','date'].every(key=>left[key]===right[key])&&(left.swipeId??null)===(right.swipeId??null);

function validEventSentEvidence(source) {
  if(!Array.isArray(source.sentFloors)||!source.sentFloors.length||!Array.isArray(source.excludedFloors)||typeof source.includeUser!=='boolean')return false;
  const originals=new Map(source.rawMessages.map(message=>[message.floor,message]));
  const excluded=new Set(source.excludedFloors.map(message=>message.floor)),seen=new Set();
  return source.sentFloors.every(message=>{
    const original=originals.get(message?.floor);
    if(!original||!sameMessage(message,original)||seen.has(message.floor)||excluded.has(message.floor)||message.system
      ||!['assistant','user'].includes(message.role)||!source.includeUser&&message.role==='user'
      ||message.floor>source.actualRange.end||typeof message.text!=='string'||!message.text.trim())return false;
    seen.add(message.floor);return true;
  });
}

function eventCoverage(root,raw,floors) {
  const summary=summaryOf(root),events=new Map();
  for(const event of root.events??[])events.set(event.id,events.has(event.id)?null:event);
  for(const batch of summary.batches) {
    if(!batch.hideOriginal||!batch.eventIds.length||!batch.eventIds.every(id=>{
      const event=events.get(id);return event&&!event.supersededBy&&typeof event.body==='string'&&event.body.trim();
    }))continue;
    // Positioning deliberately rewrites identities. Validate original membership
    // first, so it cannot turn a corrupt sent-floor claim into valid evidence.
    if(!validEventSentEvidence(batch.sourceSnapshot))continue;
    const source=positionedSummarySnapshot(batch,summary);
    if(!source||!matchesStoredSummarySource(source,raw))continue;
    const originals=new Map(source.rawMessages.map(message=>[message.floor,message]));
    const excluded=new Set(source.excludedFloors.map(message=>message.floor));
    for(const message of source.sentFloors) {
      const original=originals.get(message.floor);
      if(assistant(message)&&original&&sameMessage(message,original)&&!excluded.has(message.floor)
        &&message.floor<=source.actualRange.end&&typeof message.text==='string'&&message.text.trim())floors.add(message.floor);
    }
  }
}

// Hidden segments retain their original coordinates across deletion and restore.
// Match the host's durable role/id/date locator, never the old floor on its own.
function locator(message) {
  try {
    const value=JSON.parse(message.identity);
    if(!Array.isArray(value)||value.length!==3||value[0]!==message.floor||value[2]!==message.date
      ||!(value[1]===null||typeof value[1]==='string'&&value[1]||Number.isSafeInteger(value[1]))
      ||value[1]===null&&(typeof value[2]!=='string'||!value[2]))return null;
    return {id:value[1],date:value[2],role:message.role};
  }catch{return null;}
}

function uniqueOriginals(messages) {
  const exact=new Map(),byId=new Map(),byDate=new Map();
  const add=(map,key,message)=>map.set(key,map.has(key)?null:message);
  for(const message of messages) {
    if(!assistant(message))continue;
    const key=locator(message);if(!key)continue;
    add(exact,JSON.stringify([key.role,key.id,key.date]),message);
    if(key.id!==null)add(byId,JSON.stringify([key.role,key.id]),message);
    if(key.date!==null)add(byDate,JSON.stringify([key.role,key.date]),message);
  }
  return key=>key.id===null?byDate.get(JSON.stringify([key.role,key.date])):
    key.date===null?byId.get(JSON.stringify([key.role,key.id])):
    exact.get(JSON.stringify([key.role,key.id,key.date]));
}

function cumulativeCoverage(root,raw,floors) {
  const cumulative=cumulativeOf(root);
  if(!cumulative.currentVersionId||!cumulative.hiddenSegments?.length)return;
  // cumulativeOf validates the complete current ancestor chain. Only the actual
  // sent messages of snapshots that still match this reply/text/swipe qualify.
  // coverageRanges, generation settings and regeneration task IDs are not proof.
  const represented=new Set();
  for(const version of cumulative.versions) {
    if(!matchesStoredCumulativeSource(version.sourceSnapshot,raw))continue;
    for(const message of version.sourceSnapshot.sentFloors)if(assistant(message))represented.add(message.floor);
  }
  if(!represented.size)return;
  const findOriginal=uniqueOriginals(raw.messages);
  for(const segment of cumulative.hiddenSegments)for(const message of segment.messages) {
    if(message.role!=='assistant')continue;
    const key=locator(message),original=key&&findOriginal(key);
    if(original&&represented.has(original.floor))floors.add(original.floor);
  }
}

// A read-only UI classification. This is deliberately not send-replacement
// authority and must never change the independent hiding ledger or host chat.
export function latestArchivedFloors(root,raw) {
  const floors=new Set();
  try{raw=assertRawSummarySource(raw);}catch{return floors;}
  try{eventCoverage(root,raw,floors);}catch{/* Missing or invalid event evidence stays current. */}
  try{cumulativeCoverage(root,raw,floors);}catch{/* Independent cumulative evidence may be unavailable. */}
  return floors;
}
