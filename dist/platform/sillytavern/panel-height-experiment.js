// Session-only height comparison. No scroll, viewport or navigation changes.
export function createPanelHeightExperiment({document:doc,getShadow}={}){
 let reduction=0,style=null,disposed=false,lastPage=null;
 const allowed=new Set([0,1,24]);
 function apply(){
  if(disposed)return;
  const shadow=getShadow?.();if(!shadow)return;
  if(style?.parentNode!==shadow){style?.remove();style=null;}
  if(!reduction){style?.remove();style=null;return;}
  if(!style){style=doc.createElement('style');style.setAttribute('data-panel-height-experiment','');shadow.append(style);}
  style.textContent=`#lt-host-content .lantai{height:calc(min(100%,850px) - ${reduction}px)!important;}
#lt-host-content .lantai.workshop:not(.benmo){height:calc(min(100%,900px) - ${reduction}px)!important;}
@media(max-width:480px){#lt-host-content .lantai.workshop:not(.benmo){height:calc(100% - ${reduction}px)!important;}}
#lt-host-content .lantai.benmo{height:calc(min(100%,940px) - ${reduction}px)!important;}`;
 }
 return {
  inspect:()=>({reduction,scrollWindowEnabled:false}),
  set(value){if(disposed||!allowed.has(value))return false;reduction=value;apply();return true;},
  apply,
  capture(){
   try{
   // One explicit settings-entry read, before the target page is hidden.
   const shadow=getShadow?.(),panels=[...(shadow?.querySelectorAll?.('#lt-host-content .lantai')??[])];
   const panel=panels.find(node=>!node.closest?.('[hidden]'));
   const area=panel?.classList?.contains('benmo')?'本末':panel?.classList?.contains('workshop')?'工坊':panel?.classList?.contains('lt-time')?'时间':'记忆或其他页面';
   if(!panel?.getBoundingClientRect){lastPage={area,reduction,height:null,boxSizing:null};return;}
   const height=panel.getBoundingClientRect().height;
   const computed=doc.defaultView?.getComputedStyle?.(panel);
   lastPage={area,reduction,height:Number.isFinite(height)?height:null,boxSizing:computed?.boxSizing??null};
   }catch{lastPage={area:'上个页面',reduction,height:null,boxSizing:null};}
  },
  measure:()=>lastPage?{...lastPage}:null,
  dispose(){disposed=true;style?.remove();style=null;}
 };
}
