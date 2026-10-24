// Host-only paint ownership. Business sections retain all text, actions, focus,
// drafts and lifecycle; these empty nodes never impersonate a workspace.
const paint = ['background-color','background-image','background-position','background-size','background-repeat','background-origin','background-clip','background-attachment','border-top','border-right','border-bottom','border-left','border-radius','box-shadow'];
const pseudoGeometry = ['top','right','bottom','left','width','height','opacity','transform'];
function set(node, name, value) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name,value);
}
function copyPaint(node, style, extra = []) {
  for (const name of [...paint,...extra]) set(node,name,style.getPropertyValue(name));
}
export function createPersistentDecoration({container, getStyle = (node,pseudo) => node.ownerDocument.defaultView.getComputedStyle(node,pseudo), ResizeObserver: Observer = container.ownerDocument.defaultView?.ResizeObserver} = {}) {
  const doc=container.ownerDocument, frame=doc.createElement('div'), head=doc.createElement('div'), top=doc.createElement('div'), before=doc.createElement('div'), after=doc.createElement('div');
  frame.setAttribute('data-host-decoration','');frame.setAttribute('aria-hidden','true');frame.inert=true;
  head.setAttribute('data-decoration-header','');top.setAttribute('data-decoration-title','');
  before.setAttribute('data-decoration-before','');after.setAttribute('data-decoration-after','');
  head.append(before,top,after);frame.append(head);container.append(frame);frame.hidden=true;
  let root=null, header=null, title=null, signature='', disposed=false;
  function geometry() {
    if(disposed||!root?.isConnected||root.closest('[hidden]')||!root.getBoundingClientRect)return;
    const bounds=root.getBoundingClientRect(),base=container.getBoundingClientRect(),h=header.getBoundingClientRect(),t=title?.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    for(const [name,value] of Object.entries({left:bounds.left-base.left,top:bounds.top-base.top,width:bounds.width,height:bounds.height}))set(frame,name,`${value}px`);
    // Frame coordinates include its border; preserve the source header's inset.
    const borderLeft=parseFloat(frame.style.getPropertyValue('border-left'))||0,borderTop=parseFloat(frame.style.getPropertyValue('border-top'))||0;
    for(const [name,value] of Object.entries({left:h.left-bounds.left-borderLeft,top:h.top-bounds.top-borderTop,width:h.width,height:h.height}))set(head,name,`${value}px`);
    top.hidden=!title;
    if(t)for(const [name,value] of Object.entries({left:t.left-h.left,top:t.top-h.top,width:t.width,height:t.height}))set(top,name,`${value}px`);
    frame.hidden=false;
  }
  const resize=Observer?new Observer(geometry):null;
  const view=doc.defaultView,forcedColors=view?.matchMedia?.('(forced-colors: active)');
  let refreshFrame=null;
  // Media can change paint without resizing a header (notably forced colours).
  // One event-driven refresh also covers responsive theme rules; never poll.
  function refreshPaint() {
    signature='';
    if(disposed||refreshFrame!==null)return;
    if(view?.requestAnimationFrame)refreshFrame=view.requestAnimationFrame(()=>{refreshFrame=null;if(root&&!root.closest('[hidden]'))sync(root);});
    else if(root&&!root.closest('[hidden]'))sync(root);
  }
  view?.addEventListener?.('resize',refreshPaint);forcedColors?.addEventListener?.('change',refreshPaint);
  function sync(next) {
    if(disposed||!next?.getBoundingClientRect)return;
    const nextHeader=[...next.children].find(node=>node.matches('header.lt-header'));
    if(!nextHeader){next.removeAttribute('data-host-paint-delegated');resize?.disconnect();root=header=title=null;signature='';frame.hidden=true;return;}
    const nextTitle=nextHeader.querySelector('.lt-root-top');
    const nextSignature=JSON.stringify([next.className,[...next.attributes].filter(a=>a.name.startsWith('data-')&&a.name!=='data-host-paint-delegated').map(a=>[a.name,a.value]),nextHeader.className,!!nextTitle]);
    if(next!==root||nextHeader!==header||nextTitle!==title||signature!==nextSignature||!next.hasAttribute('data-host-paint-delegated')) {
      resize?.disconnect();root=next;header=nextHeader;title=nextTitle;signature=nextSignature;
      // Read the theme's actual paint, including child/selection header grammar.
      // The marker is restored synchronously, before a rendering opportunity.
      root.removeAttribute('data-host-paint-delegated');
      try {
        copyPaint(frame,getStyle(root));copyPaint(head,getStyle(header));
        if(title)copyPaint(top,getStyle(title));
        for(const [node,pseudo] of [[before,'::before'],[after,'::after']]) {
          const style=getStyle(header,pseudo);node.hidden=['none','normal',''].includes(style.content);
          copyPaint(node,style,pseudoGeometry);
        }
      } catch {
        // Presentation projection must never make a readable/error view blank.
        root.removeAttribute('data-host-paint-delegated');root=header=title=null;frame.hidden=true;signature='';return;
      }
      root.setAttribute('data-host-paint-delegated','');
      for(const node of [root,header,title].filter(Boolean))resize?.observe(node);
    }
    geometry();
  }
  return {sync,dispose(){disposed=true;resize?.disconnect();view?.removeEventListener?.('resize',refreshPaint);forcedColors?.removeEventListener?.('change',refreshPaint);if(refreshFrame!==null)view?.cancelAnimationFrame?.(refreshFrame);root?.removeAttribute('data-host-paint-delegated');frame.remove();}};
}
