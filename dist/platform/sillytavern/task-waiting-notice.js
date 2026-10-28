// A host-level, non-modal waiting notice. It never owns the chat input or focus.
export function createTaskWaitingNotice({document:doc,styles}={}){
 let node=null,serial=0,active=null,disposed=false,dismissed=false;
 const remove=()=>{node?.remove();node=null;};
 async function show({token,symbol='😿',title='世界还在努力生长……',message='世界动态正在生成，请先等等，再开始下一轮故事。',dismissLabel='先关掉，我偏要继续'}={}){
  if(disposed||active===token)return;active=token;dismissed=false;const ticket=++serial;remove();const css=await styles().catch(()=>null);if(disposed||ticket!==serial||active!==token||dismissed||!css||typeof doc.createElement!=='function')return;
  node=doc.createElement('lantai-task-wait');node.id='lantai-world-wait';const shadow=node.attachShadow({mode:'open'}),style=doc.createElement('style');style.textContent=css+'\n:host{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;z-index:10001;background:transparent;padding:var(--ui-space-overlay)}.ui-dialog{pointer-events:auto;inline-size:min(100%,32rem);box-sizing:border-box;font-family:var(--ui-type-ui-family);display:grid;gap:var(--ui-space-control);text-align:center}.ui-dialog p,.ui-dialog h2{margin:0}.ui-dialog h2{text-wrap:balance;line-height:var(--ui-type-ui-section-title-line)}.ui-dialog .task-symbol{font-size:4em;line-height:1}';
  const content=doc.createElement('section');content.className='ui-dialog';content.setAttribute('role','status');content.setAttribute('aria-label',title);const icon=doc.createElement('p');icon.className='task-symbol';icon.setAttribute('aria-hidden','true');icon.textContent=symbol;const heading=doc.createElement('h2');heading.textContent=title;const text=doc.createElement('p');text.textContent=message;const button=doc.createElement('button');button.type='button';button.className='ui-button ui-button--secondary';button.textContent=dismissLabel;button.addEventListener('click',()=>{dismissed=true;remove();});content.append(icon,heading,text,button);shadow.append(style,content);doc.body.append(node);
 }
 function hide(token){if(active!==token)return;serial++;active=null;dismissed=false;remove();}
 return {show,hide,clear(){serial++;active=null;remove();},dispose(){disposed=true;serial++;active=null;dismissed=false;remove();}};
}
