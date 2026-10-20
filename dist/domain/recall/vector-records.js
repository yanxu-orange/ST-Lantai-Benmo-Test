import {rollbackValueProof} from '../narrative/rollback-proof.js';
import {activeEvents} from '../memory/event-model.js';
import {CARD_TEXT_VERSION,eventCardText} from './multichannel.js';
import {RECALL_REQUEST_LIMITS} from '../../shared/ai/recall-provider.js';

// Reuse the existing browser SHA-256 implementation. Only generated memory
// material is versioned here; neither chat input nor query vectors are stored.
export const vectorContentVersion=text=>rollbackValueProof([CARD_TEXT_VERSION,text]);
export const vectorOwner=target=>JSON.stringify([target.chatId,target.rootId]);
export const vectorIdentity=config=>JSON.stringify([CARD_TEXT_VERSION,config.endpoint.replace(/\/+$/u,''),config.model,config.protocol??'openai']);
export const vectorDocuments=events=>activeEvents(events).filter(event=>event.mode==='trigger').map(event=>{
 const text=eventCardText(event);return{id:event.id,text,version:vectorContentVersion(text)};
});
export function validStoredVector(row){
 const vector=ArrayBuffer.isView(row?.vector)?Array.from(row.vector):row?.vector;
 return row&&typeof row.id==='string'&&!!row.id&&row.id.length<=200&&/^[a-f0-9]{64}$/u.test(row.version)
  &&Number.isSafeInteger(row.dimensions)&&row.dimensions>0&&row.dimensions<=RECALL_REQUEST_LIMITS.dimensions
  &&Array.isArray(vector)&&vector.length===row.dimensions&&vector.every(value=>typeof value==='number'&&Number.isFinite(value))
  &&Number.isFinite(Math.hypot(...vector))&&Math.hypot(...vector)>0&&typeof row.modelIdentityVerified==='boolean';
}
