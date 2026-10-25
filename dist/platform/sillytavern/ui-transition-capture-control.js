// A host-owned control: navigation never rebuilds it or opens another page.
export function mountUITransitionCaptureControl(shadow,{diagnostic,start=()=>diagnostic.start()}={}){
 const doc=shadow.ownerDocument,bar=doc.createElement('div');
 bar.setAttribute('data-interface-capture','');bar.setAttribute('role','group');bar.setAttribute('aria-label','界面诊断');
 const mark=doc.createElement('button'),download=doc.createElement('button');
 for(const button of [mark,download]){button.type='button';button.className='ui-button ui-button--secondary';}
 mark.setAttribute('data-interface-capture-mark','');download.setAttribute('data-interface-capture-export','');
 download.textContent='导出记录';bar.append(mark,download);shadow.append(bar);
 let disposed=false;
 function update(){
  if(disposed)return;
  const state=diagnostic.inspect(),recording=state.status==='recording';
  bar.hidden=!state.hasData;mark.disabled=state.capturePending===true;
  mark.textContent=recording?(state.capturePending?'正在保留现场…':'刚才闪了'):'重新记录';
  download.hidden=recording||!state.hasData;
 }
 function clickMark(event){
  event.stopPropagation();if(mark.disabled)return;
  const state=diagnostic.inspect();
  if(state.status==='recording')diagnostic.mark();else start();
  update();
 }
 function clickDownload(event){event.stopPropagation();if(!diagnostic.download())download.textContent='导出失败，重试';}
 mark.addEventListener('click',clickMark);download.addEventListener('click',clickDownload);
 const unsubscribe=diagnostic.subscribe(update);update();
 return {dispose(){if(disposed)return;disposed=true;unsubscribe();mark.removeEventListener('click',clickMark);download.removeEventListener('click',clickDownload);bar.remove();}};
}
