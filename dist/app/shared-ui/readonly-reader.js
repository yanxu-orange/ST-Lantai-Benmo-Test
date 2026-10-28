const fallback='.ui-reader[open]{display:grid;grid-template-rows:auto minmax(0,1fr);max-block-size:calc(100dvh - 2 * var(--ui-space-group,1rem));max-inline-size:calc(100vw - 2 * var(--ui-space-group,1rem))}.ui-reader-body{min-block-size:0;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}';
// One transient, host-owned reading layer. It never acquires editing authority.
export function createReadonlyReader({document:doc=globalThis.document,styles,getTheme=()=>null}={}){
 let serial=0,active=null;
 function close(){serial++;if(!active)return;const a=active;active=null;try{a.dialog.close?.();}catch{}a.host.remove();if(a.isCurrent()){a.origin?.focus?.({preventScroll:true});doc.defaultView?.scrollTo?.(a.x,a.y);}}
 async function open({title,text,origin,isCurrent=()=>true}){close();const ticket=serial,theme=getTheme();let css='';try{css=await styles(theme);}catch{}if(ticket!==serial||!isCurrent())return false;
  const host=doc.createElement('lantai-readonly-reader'),shadow=host.attachShadow({mode:'open'}),style=doc.createElement('style'),dialog=doc.createElement('dialog');
  style.textContent=fallback+'\n'+(css??'');dialog.className='lantai ui-dialog ui-reader';dialog.setAttribute('data-ui-theme',theme);dialog.setAttribute('aria-label',title);
  const header=doc.createElement('header');header.className='ui-header ui-reader-header';const heading=doc.createElement('h1');heading.className='ui-page-title';heading.textContent=title;
  const button=doc.createElement('button');button.type='button';button.className='ui-button ui-button--tertiary';button.textContent='关闭';button.addEventListener('click',close);header.append(heading,button);
  const body=doc.createElement('article');body.className='ui-briefing-body ui-reader-body';body.tabIndex=0;body.textContent=text;dialog.append(header,body);shadow.append(style,dialog);doc.body.append(host);
  active={host,dialog,origin,isCurrent,x:doc.defaultView?.scrollX??0,y:doc.defaultView?.scrollY??0};dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');button.focus?.({preventScroll:true});return true;
 }
 return {open,close,check(){if(active&&!active.isCurrent())close();},dispose:close};
}
