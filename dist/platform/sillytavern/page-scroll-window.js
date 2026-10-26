// Bounded page-commit override. Two frame callbacks are not a paint guarantee.
// Keep CSS outside observed business content; existing views own scroll positions.
export function createPageScrollWindow({document:doc,getShadow,onChange=()=>{},requestFrame=fn=>doc.defaultView?.requestAnimationFrame?.(fn),cancelFrame=id=>doc.defaultView?.cancelAnimationFrame?.(id)}={}){
 let style=null,frame=null,token=0,active=false,disposed=false,windows=0,restores=0,lastReason='idle';
 const snapshot=()=>({active,windows,restores,lastReason});
 const notify=()=>{try{onChange(snapshot());}catch{}};
 function restore(reason='cancel'){
  token++;if(frame!==null){try{cancelFrame(frame);}catch{}frame=null;}
  const wasActive=active;active=false;if(style)style.textContent='';
  if(wasActive)restores++;lastReason=reason;notify();
 }
 function begin(){
  if(disposed||doc.hidden||doc.visibilityState==='hidden')return false;
  const shadow=getShadow();if(!shadow)return false;
  restore('superseded');
  if(!style||style.parentNode!==shadow){style?.remove();style=doc.createElement('style');style.setAttribute('data-page-scroll-window','');shadow.append(style);}
  style.textContent='#lt-host-content .workshop > .lt-main,#lt-host-content .benmo > .lt-main{overflow-x:hidden!important;overflow-y:hidden!important;}';
  active=true;windows++;lastReason='commit';const current=++token;notify();
  try{
   frame=requestFrame(()=>{if(current!==token||!active)return;frame=null;
    try{frame=requestFrame(()=>{if(current!==token||!active)return;frame=null;restore('two-frames');});if(frame===undefined||frame===null)restore('unavailable');}
    catch{restore('unavailable');}
   });
   if(frame===undefined||frame===null)restore('unavailable');
  }catch{restore('unavailable');}
  return active;
 }
 const hidden=()=>{if(doc.hidden||doc.visibilityState==='hidden')restore('background');};
 const pagehide=()=>restore('background');
 doc.addEventListener?.('visibilitychange',hidden);doc.defaultView?.addEventListener?.('pagehide',pagehide);
 return {begin,restore,snapshot,dispose(){if(disposed)return;restore('dispose');disposed=true;style?.remove();style=null;doc.removeEventListener?.('visibilitychange',hidden);doc.defaultView?.removeEventListener?.('pagehide',pagehide);}};
}
