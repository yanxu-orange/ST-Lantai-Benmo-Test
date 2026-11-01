const KEY='yanxu_storybar_theme';
const ATTRIBUTE='data-lantai-storybar-theme';
const MODES=['day','night','snow','spring'];
const LABELS={day:'日间',night:'夜间',snow:'雪山白鼬',spring:'春日'};
const NEXT_SYMBOL={day:'☾',night:'雪',snow:'春',spring:'☀'};
export function mountStorybarTheme({document:doc=globalThis.document,storage,MutationObserver:Observer=globalThis.MutationObserver}={}){
  let preference='day',store=storage;
  try{store??=doc?.defaultView?.localStorage;const stored=store?.getItem(KEY);preference=MODES.includes(stored)?stored:'day';}catch{/* Storage may be disabled. */}
  const fourModes=bar=>bar.getAttribute?.('data-lantai-storybar-palettes')==='four';
  const effective=bar=>fourModes(bar)||preference==='night'?preference:'day';
  function paintBar(bar){
    const mode=effective(bar),four=fourModes(bar);
    bar.setAttribute('data-theme',mode);
    const button=bar.querySelector?.('[data-lantai-storybar-toggle]');
    if(button){
      button.textContent=four?NEXT_SYMBOL[mode]:mode==='night'?'☀':'☾';
      if(four){const next=MODES[(MODES.indexOf(mode)+1)%MODES.length],label=`当前${LABELS[mode]}，切换到${LABELS[next]}配色`;button.setAttribute('title',label);button.setAttribute('aria-label',label);}
    }
  }
  function paintWithin(node){
    if(node?.matches?.('[data-lantai-storybar]'))paintBar(node);
    for(const bar of node?.querySelectorAll?.('[data-lantai-storybar]')??[])paintBar(bar);
  }
  const paint=()=>{doc?.documentElement?.setAttribute?.(ATTRIBUTE,preference);paintWithin(doc);};
  paint();
  const click=event=>{
    const button=event.target?.closest?.('[data-lantai-storybar-toggle]');
    const bar=button?.closest?.('[data-lantai-storybar]');
    if(!bar)return;
    event.preventDefault();event.stopPropagation();preference=fourModes(bar)?MODES[(MODES.indexOf(preference)+1)%MODES.length]:effective(bar)==='night'?'day':'night';paint();
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
