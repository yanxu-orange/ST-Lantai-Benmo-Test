import { placeFloorBackgroundDisplay } from './floor-background-display-order.js';

// Results are independent floor-tail nodes, never rewritten into story mes.
export function mountWorkshopBackgroundDisplay({document:doc=globalThis.document,runtime,MutationObserver:Observer=globalThis.MutationObserver}={}) {
  let disposed=false,scheduled=false;
  const rendered=new WeakMap(),targetKey=()=>JSON.stringify(runtime.inspect?.().target??null);
  const floorOf=node=>{const text=node.getAttribute('mesid');return text!==null&&/^\d+$/.test(text)?Number(text):NaN;};
  function render(){
    scheduled=false;if(disposed)return;
    const target=targetKey(),messages=[...(doc?.querySelectorAll?.('#chat .mes[mesid]')??[])];
    const floors=messages.map(floorOf).filter(Number.isSafeInteger),batch=runtime.workshopFloorInfos?.(floors);
    for(const message of messages){
      const floor=floorOf(message),info=Number.isSafeInteger(floor)?batch?batch.get(floor):runtime.workshopFloorInfo(floor):null;
      let box=message.querySelector('.lantai-workshop-results');
      if(!info?.tasks?.length){box?.remove();continue;}
      const parent=message.querySelector('.mes_block')??message;
      if(!box){box=doc.createElement('div');box.className='lantai-workshop-results';}
      placeFloorBackgroundDisplay(parent,box);
      const previous=rendered.get(box),signature=JSON.stringify(info),replyId=info.replyId;
      if(previous?.target===target&&previous.signature===signature)continue;
      const opens=new Map();
      if(previous?.target===target&&previous.replyId===info.replyId)for(const detail of box.querySelectorAll('details'))opens.set(detail.getAttribute('data-task'),detail.open);
      box.replaceChildren();
      for(const task of info.tasks){
        const detail=doc.createElement('details');detail.setAttribute('data-task',task.id);detail.open=opens.get(task.id)??false;
        const heading=doc.createElement('summary');heading.textContent=task.name;detail.append(heading);
        if(task.body){const body=doc.createElement('div');body.className='lantai-workshop-result-body';body.textContent=task.body;detail.append(body);}
        const actions=doc.createElement('div');actions.className='lantai-workshop-result-actions';
        const status=doc.createElement('span');status.className='lantai-workshop-result-status';status.setAttribute('role','status');status.textContent=task.status==='running'?'正在生成…':task.error||(!task.body?'尚未生成':'');
        const retry=doc.createElement('button');retry.type='button';retry.className='menu_button';retry.textContent=task.body?'重新生成':task.status==='failed'?'重试':'生成';retry.disabled=task.status==='running';
        retry.addEventListener('click',()=>{
          if(disposed||retry.disabled||message.isConnected===false||box.isConnected===false||floorOf(message)!==floor||targetKey()!==target)return;
          const current=runtime.workshopFloorInfo(floor),currentTask=current?.tasks?.find(row=>row.id===task.id);
          if(!currentTask||current.replyId!==replyId||currentTask.status==='running')return;
          try{Promise.resolve(runtime.generate(floor,{workshopOnly:true,taskId:task.id})).catch(()=>{});}catch{/* Runtime reports errors. */}
        });
        actions.append(status,retry);detail.append(actions);box.append(detail);
      }
      rendered.set(box,{target,signature,replyId:info.replyId});
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
.lantai-workshop-result-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-control,.5em);min-inline-size:0}
.lantai-workshop-result-status{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere}
.lantai-workshop-results button{display:inline-flex;width:max-content;white-space:nowrap;flex-shrink:0}
.lantai-workshop-results summary{cursor:pointer}
`;doc.head?.append(style);}
  schedule();
  return {dispose(){disposed=true;unsubscribe?.();observer?.disconnect();style?.remove();for(const node of doc?.querySelectorAll?.('.lantai-workshop-results')??[])node.remove();}};
}
