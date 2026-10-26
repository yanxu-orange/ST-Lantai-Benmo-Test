export const PANEL_HEIGHT_KEY='lantai_benmo_panel_height_reduction';
// H=min(available space,850px); minimum=min(H,max(.6H,320px)).
// Percentages resolve against the same containing block as each panel.
export const PANEL_HEIGHT='max(min(min(100%,850px),max(min(60%,510px),320px)),calc(min(100%,850px) - var(--lt-panel-height-reduction,0px)))';
const valid=value=>Number.isSafeInteger(value)&&value>=0;
export function createPanelHeightPreference({document:doc,getShadow,storage}={}){
 let reduction=0,store=storage,style=null,disposed=false,message='';
 try{store??=doc?.defaultView?.localStorage;const raw=store?.getItem(PANEL_HEIGHT_KEY);if(raw!=null&&raw.trim()!==''&&valid(Number(raw)))reduction=Number(raw);}catch{/* Browser storage may be unavailable. */}
 function apply(){
  if(disposed)return;
  const shadow=getShadow?.();if(!shadow)return;
  if(style?.parentNode!==shadow){style?.remove();style=null;}
  if(!style){style=doc.createElement('style');style.setAttribute('data-panel-height-preference','');shadow.append(style);}
  const css=`:host{--lt-panel-height-reduction:${reduction}px;--lt-panel-height:${PANEL_HEIGHT};}`;
  if(style.textContent!==css)style.textContent=css;
 }
 return {
  inspect:()=>({reduction,message}),
  set(value){
   if(disposed)return false;
   if(!valid(value)){message='请输入不小于 0 的整数。';return false;}
   reduction=value;apply();message='';
   try{if(!store?.setItem)throw Error();store.setItem(PANEL_HEIGHT_KEY,String(value));}
   catch{message='已应用；当前浏览器无法保存。';}
   return true;
  },
  apply,
  dispose(){disposed=true;style?.remove();style=null;}
 };
}
