// Host-owned short notices survive ordinary page disposal. They carry identity
// and counts only; opening an unrelated editor is left to the host's safe gate.
export function createManagementNotifications({document:doc,controller,styles,openTask,duration=3500}={}){
 let node=null,timer=null,ticket=0,disposed=false;
 const clear=()=>{ticket++;if(timer!==null)clearTimeout(timer);timer=null;node?.remove();node=null;};
 const release=controller.subscribeNotices(async notice=>{
  clear();const turn=ticket;
  const css=await styles().catch(()=>null);if(disposed||turn!==ticket||!css)return;
  node=doc.createElement('lantai-benmo-notice');node.id=notice.id??'lantai-benmo-notice';
  const shadow=node.attachShadow({mode:'open'}),style=doc.createElement('style');
  style.textContent=css+`\n:host{position:fixed;inset:auto;top:max(var(--ui-space-control),env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);height:auto;display:block;padding:0;background:transparent;backdrop-filter:none;z-index:10001;pointer-events:none}.lt-notice{pointer-events:auto;display:flex;align-items:center;gap:var(--ui-space-inline);padding:var(--ui-space-control);border:1px solid var(--ui-color-border-default);border-radius:var(--ui-shape-overlay-radius);background:var(--ui-color-surface-raised);color:var(--ui-color-text-primary);box-shadow:var(--ui-elevation-low-shadow);font-family:var(--ui-type-ui-family);font-size:var(--ui-type-ui-body-size)}.lt-notice p{margin:0}`;
  const content=doc.createElement('div');content.className='lt-notice';content.setAttribute('role','status');
  const message=doc.createElement('p');message.textContent=notice.message??(notice.phase==='started'?`已开始重建，共 ${notice.count} 条`:notice.phase==='complete'?`重建完成，共 ${notice.count} 条`:'重建未完成，请查看');content.append(message);
  if(notice.phase!=='started'&&notice.action!==false){
   const button=doc.createElement('button');button.type='button';button.className='ui-button ui-button--tertiary';button.textContent=notice.phase==='complete'?'查看结果':'查看问题';
   button.addEventListener('pointerdown',event=>event.preventDefault());
   button.addEventListener('click',async()=>{const shown=await openTask(notice.taskId);if(disposed||turn!==ticket)return;if(shown)clear();else message.textContent='请从原记忆入口查看，当前编辑已保留';});content.append(button);
  }
  shadow.append(style,content);doc.body.append(node);timer=setTimeout(clear,duration);
 });
 return{dispose(){disposed=true;release();clear();}};
}
