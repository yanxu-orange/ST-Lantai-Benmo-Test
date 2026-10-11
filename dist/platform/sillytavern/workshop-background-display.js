import { placeFloorBackgroundDisplay } from './floor-background-display-order.js';

const taskKey=task=>JSON.stringify([task.kind??'tracking',task.id]);
const bodyKey=info=>JSON.stringify(info.tasks.map(task=>[taskKey(task),task.body??'']));
const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
// Results are independent floor-tail nodes, never rewritten into story mes.
export function mountWorkshopBackgroundDisplay({document:doc=globalThis.document,runtime,formatter,MutationObserver:Observer=globalThis.MutationObserver}={}) {
  let disposed=false,scheduled=false;
  const rendered=new WeakMap(),targetKey=()=>JSON.stringify(runtime.inspect?.().target??null);
  const floorOf=node=>{const value=node.getAttribute('mesid');return value!==null&&/^\d+$/.test(value)?Number(value):NaN;};
  const busy=info=>info.batchRunning===true||info.tasks.some(task=>task.status==='running');
  function release(box){
    const state=rendered.get(box);
    if(state){state.pending=null;}
    box.remove();
    // A public rescan releases the Helper's references to removed pre nodes.
    // Never refresh a stale chat/reply merely to clean up an old detached tail.
    if(!state||state.released||(!state.cleanup&&![...state.entries.values()].some(entry=>entry.html)))return;
    state.released=true;
    if(targetKey()!==state.target||state.message.isConnected===false||floorOf(state.message)!==state.floor
      ||state.snapshot?.ownsChat&&!state.snapshot.ownsChat())return;
    const snapshot=formatter?.capture(state.floor);if(!snapshot?.isCurrent())return;
    try{Promise.resolve(snapshot.refresh()).catch(()=>{});}catch{/* Host teardown may already be underway. */}
  }
  function render(){
    scheduled=false;if(disposed)return;
    const target=targetKey(),messages=[...(doc?.querySelectorAll?.('#chat .mes[mesid]')??[])];
    const floors=messages.map(floorOf).filter(Number.isSafeInteger),batch=runtime.workshopFloorInfos?.(floors);
    for(const message of messages){
      const floor=floorOf(message),info=Number.isSafeInteger(floor)?batch?batch.get(floor):runtime.workshopFloorInfo(floor):null;
      let box=message.querySelector('.lantai-workshop-results');
      if(!info?.tasks?.length){if(box)release(box);continue;}
      const parent=message.querySelector('.mes_block')??message;
      if(!box){box=doc.createElement('div');box.className='lantai-workshop-results';}
      placeFloorBackgroundDisplay(parent,box);
      const replyId=info.replyId;
      let state=rendered.get(box);
      if(!state||state.target!==target||state.replyId!==info.replyId){
        const cleanup=state?.target===target&&(state.cleanup||[...state.entries.values()].some(entry=>entry.html));
        if(state)state.pending=null;
        const snapshot=state?.snapshot;
        box.replaceChildren();state={target,replyId,message,floor,snapshot,entries:new Map(),applied:null,pending:null,cleanup:!!cleanup};rendered.set(box,state);
      }
      const current=()=>!disposed&&message.isConnected!==false&&box.isConnected!==false&&floorOf(message)===floor
        &&targetKey()===target&&rendered.get(box)===state&&runtime.workshopFloorInfo(floor)?.replyId===replyId;
      const keys=new Set(info.tasks.map(taskKey)),running=busy(info);
      for(const [key,entry] of state.entries)if(!keys.has(key)){state.cleanup||=entry.html;entry.detail.remove();state.entries.delete(key);}
      for(const task of info.tasks){
        const key=taskKey(task);let entry=state.entries.get(key);
        if(!entry){
          const detail=doc.createElement('details');detail.setAttribute('data-task',task.id);
          const heading=doc.createElement('summary'),body=doc.createElement('div');body.className='lantai-workshop-result-body';body.textContent=task.body??'';body.hidden=!task.body;
          const actions=doc.createElement('div');actions.className='lantai-workshop-result-actions';
          const status=doc.createElement('span');status.className='lantai-workshop-result-status';status.setAttribute('role','status');
          const retry=doc.createElement('button');retry.type='button';retry.className='menu_button';
          retry.addEventListener('click',()=>{
            if(!current()||retry.disabled)return;
            const now=runtime.workshopFloorInfo(floor),row=now?.tasks?.find(row=>taskKey(row)===key);
            if(!row||row.status==='running')return;
            try{Promise.resolve(runtime.generate(floor,{workshopOnly:true,taskId:task.id})).catch(()=>{});}catch{/* Runtime reports errors. */}
          });
          actions.append(status,retry);detail.append(heading,body,actions);box.append(detail);
          entry={detail,heading,body,status,retry,html:false,formatKey:null};state.entries.set(key,entry);
        }
        text(entry.heading,task.name);
        text(entry.status,task.status==='running'?'正在生成…':task.error||(!task.body?'尚未生成':''));
        text(entry.retry,task.body?'重新生成':task.status==='failed'?'重试':'生成');entry.retry.disabled=task.status==='running';
        // Tracking and placeholder rows always stay plain. Existing workshop
        // HTML is not torn down on intermediate per-task/status publications.
        if(task.kind!=='workshop'){text(entry.body,task.body??'');entry.body.hidden=!task.body;}
      }
      if(running){state.pending=null;continue;}
      const snapshot=formatter?.capture(floor)??null,content=bodyKey(info);
      const desired=JSON.stringify([content,snapshot?.key??null]);
      if(state.applied===desired||state.pending?.key===desired)continue;
      const job={key:desired};state.pending=job;
      const valid=()=>current()&&state.pending===job&&(!snapshot||snapshot.isCurrent())&&(()=>{
        const now=runtime.workshopFloorInfo(floor);return !!now&&!busy(now)&&bodyKey(now)===content;
      })();
      void (async()=>{
        const updates=await Promise.all(info.tasks.filter(task=>task.kind==='workshop').map(async task=>{
          const entry=state.entries.get(taskKey(task)),raw=task.body??'',formatKey=JSON.stringify([snapshot?.key??null,raw]);
          if(entry.formatKey===formatKey)return {entry,raw,formatKey,unchanged:true};
          const html=raw&&snapshot?await snapshot.format(raw):null;
          return {entry,raw,formatKey,html};
        }));
        if(!valid())return;
        let refresh=state.cleanup;
        for(const {entry,raw,formatKey,html,unchanged} of updates){
          if(unchanged)continue;
          // Depth/rule changes invalidate the calculation, not necessarily
          // the DOM. Preserve existing runtimes if sanitized output is equal,
          // including an earlier failed takeover's readable fallback.
          if(entry.output===html){
            if(!entry.html&&entry.raw!==raw)entry.body.textContent=raw;
            entry.raw=raw;entry.body.hidden=!raw;entry.formatKey=formatKey;continue;
          }
          entry.output=html;entry.raw=raw;
          refresh||=entry.html||!!html;
          // html comes ONLY from the adapter's host-sanitized output. Never
          // insert a regex replacement or generated result directly as HTML.
          if(html){entry.body.innerHTML=html;entry.body.className='lantai-workshop-result-body lantai-workshop-result-formatted';}
          else{entry.body.textContent=raw;entry.body.className='lantai-workshop-result-body';}
          entry.body.hidden=!raw;entry.html=!!html;entry.formatKey=formatKey;
        }
        state.cleanup=false;state.applied=desired;state.snapshot=snapshot;
        const checks=updates.filter(row=>row.entry.html).map(row=>({...row,check:snapshot?.captureTakeover?.(row.entry.body)}));
        // One real, public floor refresh AFTER the entire settled batch. This
        // also resets existing story frontends; the user accepted that tradeoff.
        if(refresh&&snapshot&&valid()){
          let failed=false;try{await snapshot.refresh();}catch{failed=true;}
          if(!valid())return;
          const fallback=checks.filter(row=>failed||row.check&&!row.check());
          if(fallback.length){
            const cleanup=failed||fallback.some(row=>row.check?.needsCleanup?.());
            for(const {entry,raw} of fallback){entry.body.textContent=raw;entry.body.className='lantai-workshop-result-body';entry.html=false;}
            // One cleanup retry at most. Mark the state applied before it so
            // observer/runtime publications cannot create a refresh loop.
            if(cleanup&&valid())try{await snapshot.refresh();}catch{/* Raw text remains readable. */}
          }
        }
      })().catch(()=>{/* A failed display must not affect generation/storage. */}).finally(()=>{if(state.pending===job)state.pending=null;});
    }
  }
  const schedule=()=>{if(disposed||scheduled)return;scheduled=true;queueMicrotask(render);};
  const touches=record=>{
    if(record.target?.closest?.('.lantai-workshop-results')||record.target?.closest?.('.lantai-latest-summary'))return false;
    return !!record.target?.closest?.('#chat')||[...(record.addedNodes??[]),...(record.removedNodes??[])].some(node=>node.id==='chat'||node.querySelector?.('#chat'));
  };
  const unsubscribe=runtime.subscribe(schedule),root=doc?.body??doc?.documentElement??doc?.querySelector?.('#chat');
  const observer=Observer&&root?new Observer(records=>{if(records.some(touches))schedule();}):null;
  observer?.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['mesid']});
  const style=doc?.createElement?.('style');
  if(style){style.textContent=`
.lantai-workshop-results{margin-block-start:.6em;padding-block-start:.4em;border-block-start:1px solid currentColor;font-size:.9em}
.lantai-workshop-result-body{white-space:pre-wrap;overflow-wrap:anywhere}
.lantai-workshop-result-formatted{white-space:normal}
.lantai-workshop-result-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-control,.5em);min-inline-size:0}
.lantai-workshop-result-status{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere}
.lantai-workshop-results button{display:inline-flex;width:max-content;white-space:nowrap;flex-shrink:0}
.lantai-workshop-results summary{cursor:pointer}
`;doc.head?.append(style);}
  schedule();
  return {dispose(){disposed=true;unsubscribe?.();observer?.disconnect();style?.remove();for(const node of doc?.querySelectorAll?.('.lantai-workshop-results')??[])release(node);}};
}
