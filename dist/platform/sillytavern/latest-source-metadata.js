import {WORKSHOP_REPLY_KEY} from './workshop-identities.js';

const specialKeys=['reasoning','reasoning_content','thinking','tool_calls','function_call','tool_invocations','image','images','media','file','files','attachments','audio','video'];
const nonTextKeys=specialKeys.filter(key=>!['reasoning','reasoning_content','thinking'].includes(key));
const present=value=>value!==undefined&&value!==null&&value!==false&&value!==''&&(!Array.isArray(value)||value.length>0);
export const pendingProjection=message=>{
  const slot=message?.swipe_info?.[message.swipe_id??0]?.extra?.[WORKSHOP_REPLY_KEY],active=message?.extra?.[WORKSHOP_REPLY_KEY];
  return typeof slot==='string'&&!!slot&&typeof active==='string'&&!!active&&slot!==active;
};
// Latest generation and physical-deletion evidence must agree on live reply
// ownership. A pending swipe never borrows the previous projection's UUID.
export function latestSourceMetadata(message){
  const swipes=message?.swipes,current=message?.swipe_id??0;
  const pending=Array.isArray(swipes)&&swipes.length&&typeof swipes[current]!=='string'||pendingProjection(message);
  // Keep specialPayload unchanged for shared ownership/retention consumers.
  // Compression may discard reasoning, but never protocol or multimodal data.
  const latestTextOnly=!nonTextKeys.some(key=>present(message?.[key])||present(message?.extra?.[key]))&&!present(message?.extra?.type);
  return {latestTextOnly,replyId:pending?null:message?.extra?.[WORKSHOP_REPLY_KEY]??null,specialPayload:!!(specialKeys.some(key=>present(message?.[key])||present(message?.extra?.[key]))||present(message?.extra?.type))};
}
