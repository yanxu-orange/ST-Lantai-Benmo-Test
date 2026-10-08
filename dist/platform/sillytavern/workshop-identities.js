// UUID metadata is separate from message text and display formatting.
export const WORKSHOP_REPLY_KEY = 'lantai_workshop_reply';
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const idOf = extra => typeof extra?.[WORKSHOP_REPLY_KEY] === 'string' && extra[WORKSHOP_REPLY_KEY] ? extra[WORKSHOP_REPLY_KEY] : null;

export function prepareWorkshopIdentities(chat, {makeId = () => crypto.randomUUID(),allowPendingLast=false} = {}) {
  if (!Array.isArray(chat)) throw new Error('聊天尚未就绪');
  const slots = [], selected = [];
  // Validate all structures before mutating any message.
  chat.forEach((message, floor) => {
    if (!message || message.is_user !== false || typeof message.mes !== 'string' || message.extra?.type || message.extra?.tool_invocations) return;
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes];
    const current = message.swipe_id ?? 0;
    if(allowPendingLast&&floor===chat.length-1&&current===swipes.length)return;
    if (!Number.isSafeInteger(current) || current < 0 || current >= swipes.length || swipes.some(text => typeof text !== 'string')) throw new Error('回复仍在生成或切换，请稍后重试');
    swipes.forEach((text, index) => {
      const info = message.swipe_info?.[index];
      const extra = object(info?.extra) ? info.extra : (swipes.length === 1 && object(message.extra) ? message.extra : {});
      const slot = {message, floor, index, text, extra, id: idOf(extra), current: index === current};
      slots.push(slot);if(slot.current) selected.push(slot);
    });
  });
  const owners = new Map(), retained = new Set();
  for(const slot of slots)if(slot.id){const set=owners.get(slot.id)??new Set();set.add(slot.message);owners.set(slot.id,set);}
  const issued = new Set(slots.flatMap(slot => slot.id ? [slot.id] : []));
  for (const slot of slots) {
    // ST appends new swipes, including cloned metadata. Keep the earliest
    // existing slot ID within one message and give appended copies fresh IDs.
    // A copied whole message has ambiguous ownership, so neither copy borrows
    // the other message's manual edits. Old result records remain retained.
    const previousId=slot.id;
    if (!slot.id || owners.get(slot.id)?.size > 1 || retained.has(slot.id)) {
      const id = makeId();
      if (typeof id !== 'string' || !id || issued.has(id)) throw new Error('回复身份生成失败');
      issued.add(id);slot.id = id;
    }
    if(previousId)retained.add(previousId);
  }
  let changed = false;
  for (const slot of slots) {
    const message = slot.message;
    if (!Array.isArray(message.swipe_info)) {message.swipe_info=[];changed=true;}
    if (!object(message.swipe_info[slot.index])) {message.swipe_info[slot.index]={send_date:message.send_date,gen_started:message.gen_started,gen_finished:message.gen_finished};changed=true;}
    const info=message.swipe_info[slot.index];
    if (!object(info.extra)) {info.extra={...slot.extra};changed=true;}
    if(idOf(info.extra)!==slot.id){info.extra[WORKSHOP_REPLY_KEY]=slot.id;changed=true;}
    if(slot.current){
      if(!object(message.extra)){message.extra={};changed=true;}
      if(idOf(message.extra)!==slot.id){message.extra[WORKSHOP_REPLY_KEY]=slot.id;changed=true;}
    }
  }
  return {changed,selected:selected.map(slot=>({replyId:slot.id,floor:slot.floor,swipeId:slot.index,text:slot.message.mes}))};
}

export function assertWorkshopProof(rows, proof) {
  if (!Array.isArray(proof)) throw new Error('工坊回复确认信息无效');
  for (const item of proof) {
    const message = rows[item.floor + 1];
    if (!Number.isSafeInteger(item.floor) || item.floor < 0 || !Number.isSafeInteger(item.swipeId) || item.swipeId < 0
      || typeof item.replyId !== 'string' || !item.replyId || (message?.swipe_id ?? 0) !== item.swipeId
      || idOf(message?.extra) !== item.replyId || idOf(message?.swipe_info?.[item.swipeId]?.extra) !== item.replyId) {
      throw new Error('工坊回复身份尚未保存确认');
    }
  }
}
