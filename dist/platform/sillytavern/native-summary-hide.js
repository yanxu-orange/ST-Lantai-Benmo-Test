import {sameTarget} from '../../domain/memory/repository.js';

// A committed batch requests one native write, never a replay on load/send.
// The host updates its own DOM and persists the chat; do not edit is_system here.
export function createNativeSummaryHider({repository,captureSource,getContext,verifyHidden,loadHostModule=()=>import('/scripts/chats.js')}={}) {
  return async function hideSource({target,source,isCurrent=()=>true}={}) {
    const context=getContext(),chat=context?.chat;
    const rows=source?.rawMessages,sent=source?.sentFloors;
    if(!Array.isArray(chat)||!Array.isArray(rows)||!Array.isArray(sent))throw new Error('原文隐藏来源不可用');
    const floors=[...new Set(sent.map(row=>row.floor))].sort((a,b)=>a-b);
    if(floors.length!==sent.length||floors.some(floor=>!Number.isSafeInteger(floor)||floor<0||!rows.some(row=>row.floor===floor)))throw new Error('原文隐藏范围无效');
    const objects=new Map(rows.map(row=>[row.floor,chat[row.floor]]));
    const check=()=>{
      if(!isCurrent()||!sameTarget(target,repository.captureTarget())||getContext()?.chat!==chat)throw new Error('原文隐藏目标已变化');
      const current=captureSource(target),byFloor=new Map(current.messages.map(row=>[row.floor,row]));
      if(current.epoch!==source.epoch||rows.some(row=>chat[row.floor]!==objects.get(row.floor)||JSON.stringify(byFloor.get(row.floor))!==JSON.stringify(row)))throw new Error('原文隐藏来源已变化');
    };
    check();
    if(!floors.length)return {status:'hidden',count:0};
    const host=await loadHostModule();check();
    if(typeof host?.hideChatMessageRange!=='function')throw new Error('酒馆原生隐藏接口不可用');
    // Coalesce only selected neighboring floors. Exclusions remain untouched.
    const ranges=[];
    for(const floor of floors){const last=ranges.at(-1);if(last&&floor===last[1]+1)last[1]=floor;else ranges.push([floor,floor]);}
    for(const [start,end] of ranges){
      check();
      await host.hideChatMessageRange(start,end,false);
      check();
      if(floors.filter(floor=>floor>=start&&floor<=end).some(floor=>chat[floor]?.is_system!==true))throw new Error('酒馆未确认原文隐藏');
    }
    if(typeof verifyHidden!=='function'||await verifyHidden(target,rows.filter(row=>floors.includes(row.floor)))!==true)throw new Error('原文隐藏保存未确认');
    check();
    return {status:'hidden',count:floors.length};
  };
}
