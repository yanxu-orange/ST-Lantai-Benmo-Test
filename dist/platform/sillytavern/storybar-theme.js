const KEY='yanxu_storybar_theme';
const ATTRIBUTE='data-lantai-storybar-theme';
export function mountStorybarTheme({document:doc=globalThis.document,storage,MutationObserver:Observer=globalThis.MutationObserver}={}){
  let preference='day',store=storage;
  try{store??=doc?.defaultView?.localStorage;preference=store?.getItem(KEY)==='night'?'night':'day';}catch{/* Storage may be disabled. */}
  function paintBar(bar){
    bar.setAttribute('data-theme',preference);
    const button=bar.querySelector?.('[data-lantai-storybar-toggle]');
    if(button)button.textContent=preference==='night'?'☀':'☾';
  }
  function paintWithin(node){
    if(node?.matches?.('[data-lantai-storybar]'))paintBar(node);
    for(const bar of node?.querySelectorAll?.('[data-lantai-storybar]')??[])paintBar(bar);
  }
  const paint=()=>{doc?.documentElement?.setAttribute?.(ATTRIBUTE,preference);paintWithin(doc);};
  paint();
  const click=event=>{
    const button=event.target?.closest?.('[data-lantai-storybar-toggle]');
    if(!button||!button.closest?.('[data-lantai-storybar]'))return;
    event.preventDefault();event.stopPropagation();preference=preference==='night'?'day':'night';paint();
    try{store?.setItem(KEY,preference);}catch{/* Keep the current page usable. */}
  };
  doc?.addEventListener?.('click',click,true);
  const target=doc?.querySelector?.('#chat')??doc?.body;
  const observer=typeof Observer==='function'&&target?new Observer(records=>{
    for(const record of records)for(const node of record.addedNodes??[])if(node.nodeType===1)paintWithin(node);
  }):null;
  observer?.observe(target,{childList:true,subtree:true});
  return {dispose(){observer?.disconnect();doc?.removeEventListener?.('click',click,true);}};
}
